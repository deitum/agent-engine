import { copyFileSync, existsSync, readFileSync, statSync } from 'node:fs';

import { applyEdits, modify, parse as parseJsonc, type ParseError } from 'jsonc-parser';

import { ConnectorError } from './connector';
import {
  type IntegrationConfigPatchRequest,
  type IntegrationConfigReadRequest,
  type IntegrationConfigReadResponse,
  type IntegrationConfigWriteRequest,
  type IntegrationConfigWriteResponse,
} from './contracts';
import { expandHome, writeFileEnsured } from './skill-package';

/**
 * Reading and writing the config documents of the other agents on this machine.
 *
 * These are **the user's own files**, not ours, and that is the whole design
 * constraint. `~/.claude.json` also holds their project history; a `kilo.jsonc`
 * holds their comments and their formatting. So a change that means «add one MCP
 * server» is applied as an edit to one key ({@link patchIntegrationConfig}),
 * never as a `JSON.parse` / `JSON.stringify` round trip — that would reformat
 * the whole document and drop every comment in it, for a one-line change the
 * user asked for from a catalogue.
 *
 * Wholesale replacement exists too ({@link writeIntegrationConfig}) because the
 * screen offers a text editor, but even that keeps a copy of what it replaced.
 */

/** Suffix of the copy kept beside a file before it is replaced. */
const BACKUP_SUFFIX = '.agent-engine.bak';

/** Indentation for keys this daemon inserts, matching what these tools ship. */
const FORMATTING_OPTIONS = { tabSize: 2, insertSpaces: true, eol: '\n' } as const;

/** The file's modification time in epoch ms, or `0` when it is not there. */
function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Refuses the write when the file changed since the caller read it.
 *
 * The competing writer here is not another tab — it is the user's own editor,
 * or the agent's own `claude mcp add`. Both are likely enough during exactly the
 * task this screen is for, and silently winning the race would throw away work
 * that was never shown on our screen.
 */
function assertUnchanged(path: string, expectedMtimeMs: number | undefined): void {
  if (expectedMtimeMs === undefined) {
    return;
  }
  const actual = mtimeOf(path);
  if (actual !== expectedMtimeMs) {
    throw new ConnectorError(
      409,
      'The file changed on disk since it was read. Reload it before saving.',
    );
  }
}

/**
 * Copies the current contents aside, returning where. `null` when there was
 * nothing to copy — a config this call is about to create for the first time.
 */
function backup(path: string): string | null {
  if (!existsSync(path)) {
    return null;
  }
  const backupPath = `${path}${BACKUP_SUFFIX}`;
  copyFileSync(path, backupPath);
  return backupPath;
}

/** `POST /integrations/config/read` — the document as it stands, verbatim. */
export function readIntegrationConfig(
  request: IntegrationConfigReadRequest,
): IntegrationConfigReadResponse {
  const path = expandHome(request.path);
  if (!existsSync(path)) {
    return { path, exists: false, content: '', mtimeMs: 0 };
  }

  return {
    path,
    exists: true,
    content: readFileSync(path, 'utf8'),
    mtimeMs: mtimeOf(path),
  };
}

/** `POST /integrations/config/write` — replace the document wholesale. */
export function writeIntegrationConfig(
  request: IntegrationConfigWriteRequest,
): IntegrationConfigWriteResponse {
  const path = expandHome(request.path);
  assertUnchanged(path, request.expectedMtimeMs);

  const backupPath = backup(path);
  writeFileEnsured(path, request.content);

  return { path, mtimeMs: mtimeOf(path), backupPath };
}

/**
 * Parses a document tolerantly, so a `.jsonc` with comments and trailing commas
 * reads the way its own tool reads it.
 *
 * Only used to *validate* before a patch: the edit itself is applied to the
 * original text, not to this value.
 */
export function parseConfig(content: string, path: string): unknown {
  if (content.trim() === '') {
    return {};
  }
  const errors: ParseError[] = [];
  const value = parseJsonc(content, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    throw new ConnectorError(422, `${path} is not valid JSON — fix it before editing it here.`);
  }
  return value;
}

/**
 * `POST /integrations/config/patch` — set or remove named keys, leaving every
 * other byte of the file as it was.
 *
 * `jsonc-parser`'s `modify` returns a minimal text edit rather than a new
 * document, which is what makes «add one server to a 4000-line `.claude.json`»
 * a change of four lines. Edits are applied in order, each against the result of
 * the last, so a caller can remove one key and add another in one request.
 */
export function patchIntegrationConfig(
  request: IntegrationConfigPatchRequest,
): IntegrationConfigWriteResponse {
  const path = expandHome(request.path);
  assertUnchanged(path, request.expectedMtimeMs);

  const original = existsSync(path) ? readFileSync(path, 'utf8') : '';
  // Refuse to touch a file we cannot read: applying an edit to a broken
  // document produces a differently broken one, and the user would have no way
  // to tell which of the two breakages was theirs.
  parseConfig(original, path);

  let content = original.trim() === '' ? '{}\n' : original;
  for (const edit of request.edits ?? []) {
    if (edit.keyPath.length === 0) {
      throw new ConnectorError(400, 'An edit must name at least one key');
    }
    const edits = modify(content, edit.keyPath, edit.value === null ? undefined : edit.value, {
      formattingOptions: FORMATTING_OPTIONS,
    });
    content = applyEdits(content, edits);
  }

  const backupPath = backup(path);
  writeFileEnsured(path, content);

  return { path, mtimeMs: mtimeOf(path), backupPath };
}
