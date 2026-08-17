import { readFileSync } from 'node:fs';

import { LSP_TOOLS } from '../../contracts';

import { applyTextEdits, collectWorkspaceEdit } from './lsp-edits';
import {
  flattenSymbols,
  type FlatSymbol,
  formatLocations,
  formatSymbols,
  hoverText,
  type LineReader,
  toLocations,
} from './lsp-format';
import { type LspSession, type PreparedDocument } from './lsp-session';
import { MAX_RENAME_EDITS, MAX_RENAME_FILES } from './lsp.constants';
import { type LspHover, type LspPosition, type LspWorkspaceEdit } from './lsp.types';
import { fromContainerUri, toHostPath } from './paths';

/**
 * The language-server tools the coding agent is given.
 *
 * These exist for the questions `grep` answers badly: which of four overloads is
 * called here, who actually uses this method once inheritance is taken into
 * account, what does this import alias resolve to. A text search either misses
 * those or drowns them in false positives, and the agent has no way to tell which
 * happened.
 *
 * Every tool degrades to a sentence telling the agent to fall back on `grep`
 * rather than to an error, because a language server that is missing, still
 * indexing or broken is a normal state of the world and not something the agent
 * can fix.
 */

/** Signature of deepagents' `tool` factory, through the dual-package seam. */
type ToolFactory = (
  fn: (args: Record<string, unknown>) => Promise<string> | string,
  meta: { name: string; description: string; schema: unknown },
) => unknown;

/** Where a request should point, as the model is allowed to express it. */
export interface PositionArgs {
  symbol?: string;
  /** One-based, the way the model reads a file. */
  line?: number;
}

/** A resolved position, plus how it was found — the model should know. */
export interface ResolvedPosition {
  position: LspPosition;
  note: string;
}

/**
 * The last segment of a qualified name: `OrderService.findByStatus` →
 * `findByStatus`. Models routinely pass the qualified form, and every lookup
 * below matches on the bare identifier.
 */
export function lastSegment(symbol: string): string {
  const parts = symbol.split(/[.#]|::|->/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : symbol;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** First occurrence of an identifier in a document, as a position. */
export function findIdentifier(
  text: string,
  identifier: string,
  fromLine?: number,
): LspPosition | null {
  const pattern = new RegExp(`\\b${escapeRegExp(identifier)}\\b`);
  const lines = text.split('\n');
  // When a line was given, that line wins; otherwise the first occurrence does.
  const order =
    fromLine !== undefined && fromLine >= 0 && fromLine < lines.length
      ? [fromLine, ...lines.keys()].filter((line, index, all) => all.indexOf(line) === index)
      : [...lines.keys()];

  for (const line of order) {
    const match = pattern.exec(lines[line]);
    if (match) {
      return { line, character: match.index };
    }
  }
  return null;
}

/** The column of the first non-whitespace character on a line. */
function firstNonSpace(text: string, line: number): number {
  const source = text.split('\n')[line] ?? '';
  const match = /\S/.exec(source);
  return match ? match.index : 0;
}

/**
 * Turns the model's way of pointing at code into a protocol position.
 *
 * The load-bearing design decision of these tools: a model is bad at counting
 * columns and merely adequate at counting lines, so the primary way to name a
 * place is the **symbol** — resolved against the server's own outline first, and
 * against the text only as a fallback. Requiring `line`/`character` instead
 * produces tools that are technically complete and never used correctly.
 */
export async function resolvePosition(
  prepared: PreparedDocument,
  args: PositionArgs,
  documentSymbols: () => Promise<FlatSymbol[]>,
): Promise<ResolvedPosition | { error: string }> {
  const line = args.line !== undefined ? Math.max(0, Math.trunc(args.line) - 1) : undefined;
  const symbol = args.symbol?.trim();

  if (symbol) {
    const identifier = lastSegment(symbol);

    // The server's own outline is more precise than any text match: it knows
    // which occurrence is the declaration.
    const outline = await documentSymbols().catch(() => [] as FlatSymbol[]);
    const declared = outline.find((entry) => entry.name === identifier);
    if (declared && line === undefined) {
      return {
        position: declared.position,
        note: `${declared.kind} ${symbol} (${prepared.relative}:${declared.line + 1})`,
      };
    }

    const found = findIdentifier(prepared.text, identifier, line);
    if (found) {
      return { position: found, note: `${symbol} (${prepared.relative}:${found.line + 1})` };
    }
    return {
      error: `«${prepared.relative}» holds no identifier «${identifier}». Check the name or pass a line.`,
    };
  }

  if (line !== undefined) {
    return {
      position: { line, character: firstNonSpace(prepared.text, line) },
      note: `${prepared.relative}:${line + 1}`,
    };
  }

  return { error: 'Pass symbol (a name) or line (a line number) so the question has a place.' };
}

/** Reads source lines for context, caching within one tool call. */
export function makeLineReader(dir: string): LineReader {
  const cache = new Map<string, string[] | null>();
  return (relative) => {
    if (!cache.has(relative)) {
      try {
        cache.set(relative, readFileSync(toHostPath(dir, relative), 'utf8').split('\n'));
      } catch {
        cache.set(relative, null);
      }
    }
    return cache.get(relative) ?? null;
  };
}

/** The message a tool returns when no server can answer for a path. */
export function unavailableMessage(session: LspSession, path: string): string {
  const states = session
    .status()
    .filter((entry) => entry.state === 'unavailable' && entry.detail)
    .map((entry) => `${entry.language}: ${entry.detail}`);
  const reason = states.length > 0 ? ` (${states.join('; ')})` : '';
  return `Code analysis is unavailable for «${path}»${reason}. Use grep / read_file.`;
}

const PATH_PROPERTY = {
  type: 'string',
  description: 'File path from the repository root, e.g. src/main/java/App.java.',
} as const;

const SYMBOL_PROPERTY = {
  type: 'string',
  description:
    'Name of a symbol in this file (method, class, variable). May be qualified — OrderService.findByStatus. The preferred way to point at a place.',
} as const;

const LINE_PROPERTY = {
  type: 'integer',
  description:
    'Line number (1-based). Needed only when a name is not enough — when the symbol appears in the file more than once, for instance.',
} as const;

/** Schema shared by the tools that point at one place in a file. */
const POSITION_SCHEMA = {
  type: 'object',
  properties: { path: PATH_PROPERTY, symbol: SYMBOL_PROPERTY, line: LINE_PROPERTY },
  required: ['path'],
} as const;

/** Everything a tool needs to answer one call. */
interface ToolContext {
  session: LspSession;
  /** Host directory of the checkout, for reading context lines. */
  dir: string;
}

/**
 * The slice of deepagents' backend a rename writes through.
 *
 * Deliberately the backend and not `fs`: `DockerShellBackend.edit` is where plan
 * mode's guard lives, so routing the rename through it means a read-only session
 * refuses it for free, with the same message every other refused write produces.
 */
export interface EditableBackend {
  edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
  ): Promise<{ error?: string; path?: string }>;
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

function positionArgs(args: Record<string, unknown>): PositionArgs {
  const symbol = stringArg(args, 'symbol');
  const line = typeof args.line === 'number' ? args.line : undefined;
  return { ...(symbol ? { symbol } : {}), ...(line !== undefined ? { line } : {}) };
}

/**
 * Runs `fn` against a prepared document, or returns the fallback message. Every
 * navigation tool starts this way, and none of them may throw: a tool that
 * raises turns a language-server hiccup into a failed agent turn.
 */
async function withDocument(
  context: ToolContext,
  args: Record<string, unknown>,
  fn: (prepared: PreparedDocument) => Promise<string>,
): Promise<string> {
  const path = stringArg(args, 'path');
  if (!path) {
    return 'Pass path — the file path from the repository root.';
  }
  let prepared: PreparedDocument | null = null;
  try {
    prepared = await context.session.syncDocument(path);
  } catch {
    prepared = null;
  }
  if (!prepared) {
    return unavailableMessage(context.session, path);
  }
  try {
    return await fn(prepared);
  } catch (error) {
    return `The language server did not answer: ${error instanceof Error ? error.message : String(error)}. Use grep / read_file.`;
  }
}

/** Asks the server for a document's outline, flattened. */
async function outlineOf(prepared: PreparedDocument): Promise<FlatSymbol[]> {
  const result = await prepared.client.request<unknown>('textDocument/documentSymbol', {
    textDocument: { uri: prepared.uri },
  });
  return flattenSymbols(result);
}

/**
 * Resolves a position and runs a request at it, sharing the «which place did you
 * mean» handling across `find_definition`, `find_references` and `hover`.
 */
async function atPosition(
  prepared: PreparedDocument,
  args: Record<string, unknown>,
  fn: (position: LspPosition, note: string) => Promise<string>,
): Promise<string> {
  const resolved = await resolvePosition(prepared, positionArgs(args), () => outlineOf(prepared));
  if ('error' in resolved) {
    return resolved.error;
  }
  return fn(resolved.position, resolved.note);
}

/**
 * Builds the read-only navigation tools. Safe in plan mode, and deliberately
 * available there: planning against a semantic index rather than against `grep`
 * is most of the value of having the index at all.
 */
export function buildLspNavigationTools(tool: unknown, context: ToolContext): unknown[] {
  const make = tool as ToolFactory;
  const read = (): LineReader => makeLineReader(context.dir);

  return [
    make(
      (args) =>
        withDocument(context, args, (prepared) =>
          atPosition(prepared, args, async (position, note) => {
            const result = await prepared.client.request<unknown>('textDocument/definition', {
              textDocument: { uri: prepared.uri },
              position,
            });
            const locations = toLocations(result);
            return locations.length === 0
              ? `No definition was found for ${note}.`
              : `Definition of ${note}:\n${formatLocations(locations, read())}`;
          }),
        ),
      {
        name: LSP_TOOLS.definition,
        description:
          'Where a symbol is declared — semantically, through the compiler. More precise than grep: it tells overloads, import aliases and same-named symbols from different modules apart.',
        schema: POSITION_SCHEMA,
      },
    ),

    make(
      (args) =>
        withDocument(context, args, (prepared) =>
          atPosition(prepared, args, async (position, note) => {
            const result = await prepared.client.request<unknown>('textDocument/references', {
              textDocument: { uri: prepared.uri },
              position,
              context: { includeDeclaration: false },
            });
            const locations = toLocations(result);
            return locations.length === 0
              ? `No references to ${note} were found.`
              : `References to ${note}:\n${formatLocations(locations, read())}`;
          }),
        ),
      {
        name: LSP_TOOLS.references,
        description:
          'Every use of a symbol across the project. It accounts for inheritance and overrides and never confuses same-named methods of different classes — exactly where grep gives both false hits and misses. Always check with this before renaming or deleting.',
        schema: POSITION_SCHEMA,
      },
    ),

    make(
      (args) =>
        withDocument(context, args, async (prepared) => {
          const symbols = await outlineOf(prepared);
          return symbols.length === 0
            ? `No symbols were found in «${prepared.relative}».`
            : `Structure of «${prepared.relative}»:\n${formatSymbols(symbols)}`;
        }),
      {
        name: LSP_TOOLS.documentSymbols,
        description:
          'A table of contents for a file: classes, methods and fields with line numbers. Cheaper than reading the whole file when you need its shape or one particular method.',
        schema: {
          type: 'object',
          properties: { path: PATH_PROPERTY },
          required: ['path'],
        },
      },
    ),

    make(
      async (args) => {
        const query = stringArg(args, 'query').trim();
        if (!query) {
          return 'Pass query — part of the name of the symbol you are looking for.';
        }
        // A workspace query needs a live server but no particular file, so it is
        // asked of whichever language is already running for this session.
        const running = await context.session.anyClient().catch(() => null);
        if (!running) {
          return 'Symbol search is unavailable: no language server is running. Use grep.';
        }
        try {
          const result = await running.client.request<unknown>('workspace/symbol', { query });
          const symbols = flattenSymbols(result);
          return symbols.length === 0
            ? `No symbols were found for «${query}».`
            : `Symbols matching «${query}»:\n${formatSymbols(symbols, { withPath: true })}`;
        } catch (error) {
          return `The language server did not answer: ${error instanceof Error ? error.message : String(error)}. Use grep.`;
        }
      },
      {
        name: LSP_TOOLS.workspaceSymbols,
        description:
          'Find a class, method or variable by name across the project without knowing its file. Faster than glob + grep, and it returns declarations rather than any mention.',
        schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Part of a symbol name, e.g. OrderService.' },
          },
          required: ['query'],
        },
      },
    ),

    make(
      (args) =>
        withDocument(context, args, (prepared) =>
          atPosition(prepared, args, async (position, note) => {
            const result = await prepared.client.request<LspHover | null>('textDocument/hover', {
              textDocument: { uri: prepared.uri },
              position,
            });
            const text = hoverText(result);
            return text ? `${note}:\n${text}` : `The server reported nothing for ${note}.`;
          }),
        ),
      {
        name: LSP_TOOLS.hover,
        description:
          'A symbol’s signature and documentation: full type, parameters, doc string. Saves opening the declaring file for a single line.',
        schema: POSITION_SCHEMA,
      },
    ),
  ];
}

/**
 * Builds `rename_symbol` — the one language-server tool that writes.
 *
 * Registered only outside plan mode, mirroring `remember`: in a read-only turn
 * the workspace is not the agent's to change. The backend would refuse it anyway
 * (which is the belt to this braces), but a tool the model cannot use should not
 * be in its list at all — offering it and then refusing it wastes a turn.
 */
export function buildLspRenameTool(
  tool: unknown,
  context: ToolContext & { backend: EditableBackend },
): unknown {
  const make = tool as ToolFactory;

  return make(
    (args) =>
      withDocument(context, args, (prepared) =>
        atPosition(prepared, args, async (position, note) => {
          const newName = stringArg(args, 'new_name').trim();
          if (!newName) {
            return 'Pass new_name — the symbol’s new name.';
          }

          const edit = await prepared.client.request<LspWorkspaceEdit | null>(
            'textDocument/rename',
            { textDocument: { uri: prepared.uri }, position, newName },
          );
          const collected = collectWorkspaceEdit(edit);
          if ('error' in collected) {
            return collected.error;
          }
          if (collected.total === 0) {
            return `The server could not rename ${note}: it may not be a declaration, or it may come from an external library.`;
          }

          // A rename that reaches this far is a refactor the user should see
          // coming, not something to do inside one tool call.
          if (collected.byUri.size > MAX_RENAME_FILES) {
            return `This rename touches ${collected.byUri.size} files (the limit is ${MAX_RENAME_FILES}). Too broad for one operation — narrow the scope or edit piece by piece.`;
          }
          if (collected.total > MAX_RENAME_EDITS) {
            return `This rename contains ${collected.total} edits (the limit is ${MAX_RENAME_EDITS}). Too many for one operation.`;
          }

          const outside = [...collected.byUri.keys()].filter(
            (uri) => fromContainerUri(uri) === null,
          );
          if (outside.length > 0) {
            return `This rename touches files outside the repository (${outside.length}) — refused.`;
          }

          return applyRename(context, collected.byUri, note, newName);
        }),
      ),
    {
      name: LSP_TOOLS.rename,
      description:
        'Rename a symbol across the project through the compiler: it finds and rewrites every use, overrides included, and leaves same-named symbols of other classes alone. Safer than editing by grep. Worth running find_references first.',
      schema: {
        type: 'object',
        properties: {
          path: PATH_PROPERTY,
          symbol: SYMBOL_PROPERTY,
          line: LINE_PROPERTY,
          new_name: { type: 'string', description: 'The symbol’s new name.' },
        },
        required: ['path', 'new_name'],
      },
    },
  );
}

/**
 * Writes a collected rename through the backend, one document at a time.
 *
 * Each file is replaced whole — the old content as the search string, the new
 * content as the replacement. `write` cannot be used (deepagents' backend refuses
 * to overwrite an existing file), and a full-content `edit` is unambiguous by
 * construction: a file's entire text occurs in it exactly once.
 */
async function applyRename(
  context: ToolContext & { backend: EditableBackend },
  byUri: Map<string, readonly LspTextEditLike[]>,
  note: string,
  newName: string,
): Promise<string> {
  const changed: string[] = [];
  const failed: string[] = [];

  for (const [uri, edits] of byUri) {
    const relative = fromContainerUri(uri);
    if (!relative) {
      continue;
    }
    let current: string;
    try {
      current = readFileSync(toHostPath(context.dir, relative), 'utf8');
    } catch {
      failed.push(`${relative}: the file could not be read`);
      continue;
    }
    const updated = applyTextEdits(current, edits);
    if (updated === current) {
      continue;
    }
    // Through the backend, so a plan-mode session refuses this exactly the way it
    // refuses every other write.
    const result = await context.backend.edit(`/${relative}`, current, updated, false);
    if (result.error) {
      failed.push(`${relative}: ${result.error}`);
      continue;
    }
    changed.push(`${relative} (${edits.length})`);
  }

  if (changed.length === 0) {
    return failed.length > 0
      ? `The rename was not applied:\n${failed.join('\n')}`
      : 'The rename required no changes.';
  }

  const header = `Renamed ${note} → «${newName}» across ${changed.length} file(s).`;
  const body = changed.map((entry) => `- ${entry}`).join('\n');
  const tail = failed.length > 0 ? `\nFailed:\n${failed.join('\n')}` : '';
  return `${header}\n${body}${tail}`;
}

/** The shape {@link applyTextEdits} needs, kept local to avoid a wider import. */
type LspTextEditLike = Parameters<typeof applyTextEdits>[1][number];
