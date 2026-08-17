import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';

import { LSP_TOOLS } from '../../contracts';

import { type LspSession, type PreparedDocument } from './lsp-session';
import {
  buildLspNavigationTools,
  buildLspRenameTool,
  type EditableBackend,
  findIdentifier,
  lastSegment,
  resolvePosition,
} from './lsp-tools';
import { MAX_RENAME_FILES } from './lsp.constants';

const JAVA_SOURCE = [
  'package shop;',
  '',
  'public class OrderService {',
  '  public Order findByStatus(String status) {',
  '    return repository.findByStatus(status);',
  '  }',
  '}',
].join('\n');

/** A checkout on disk with the files a test needs. */
function checkout(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'engine-lsp-tools-'));
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
  return dir;
}

/** The tool function registered under `name`. */
type ToolFn = (args: Record<string, unknown>) => Promise<string>;

function collectTools(build: (tool: unknown) => unknown): Map<string, ToolFn> {
  const registry = new Map<string, ToolFn>();
  const factory = (fn: ToolFn, meta: { name: string }): unknown => {
    registry.set(meta.name, fn);
    return { name: meta.name };
  };
  build(factory);
  return registry;
}

/** A prepared document backed by a stub client that answers from a table. */
function prepared(
  relative: string,
  text: string,
  answers: Record<string, unknown>,
): PreparedDocument {
  const calls: { method: string; params: unknown }[] = [];
  return {
    relative,
    text,
    uri: `file:///workspace/${relative}`,
    version: 1,
    language: 'java',
    spec: { languageId: () => 'java' } as unknown as PreparedDocument['spec'],
    client: {
      request: (method: string, params: unknown) => {
        calls.push({ method, params });
        if (!(method in answers)) {
          return Promise.reject(new Error(`unexpected request: ${method}`));
        }
        const answer = answers[method];
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      },
      calls,
    } as unknown as PreparedDocument['client'],
  };
}

/** A session that always prepares the same document. */
function stubSession(document: PreparedDocument | null, status: unknown[] = []): LspSession {
  return {
    off: false,
    syncDocument: () => Promise.resolve(document),
    anyClient: () =>
      Promise.resolve(document ? { client: document.client, language: 'java' as const } : null),
    status: () => status,
  } as unknown as LspSession;
}

describe('lastSegment', () => {
  test('reduces the qualified names models pass', () => {
    assert.equal(lastSegment('OrderService.findByStatus'), 'findByStatus');
    assert.equal(lastSegment('shop.OrderService#findByStatus'), 'findByStatus');
    assert.equal(lastSegment('Ns::Class::method'), 'method');
    assert.equal(lastSegment('findByStatus'), 'findByStatus');
  });
});

describe('findIdentifier', () => {
  test('finds the first whole-word occurrence', () => {
    const position = findIdentifier(JAVA_SOURCE, 'findByStatus');

    assert.deepEqual(position, { line: 3, character: 15 });
  });

  test('does not match inside a longer identifier', () => {
    assert.equal(findIdentifier('const findByStatusAndDate = 1;', 'findByStatus'), null);
  });

  test('prefers the line the caller named', () => {
    assert.deepEqual(findIdentifier(JAVA_SOURCE, 'findByStatus', 4)?.line, 4);
  });

  test('returns null when the identifier is absent', () => {
    assert.equal(findIdentifier(JAVA_SOURCE, 'missing'), null);
  });
});

describe('resolvePosition', () => {
  const document = prepared('src/OrderService.java', JAVA_SOURCE, {});

  /** The server's own outline knows which occurrence is the declaration. */
  test('prefers the server outline over a text match', async () => {
    const resolved = await resolvePosition(document, { symbol: 'findByStatus' }, () =>
      Promise.resolve([
        {
          name: 'findByStatus',
          kind: 'method',
          line: 3,
          position: { line: 3, character: 15 },
        },
      ]),
    );

    assert.ok('position' in resolved);
    assert.deepEqual(resolved.position, { line: 3, character: 15 });
    assert.match(resolved.note, /method findByStatus/);
  });

  test('falls back to the text when the outline has nothing', async () => {
    const resolved = await resolvePosition(document, { symbol: 'findByStatus' }, () =>
      Promise.resolve([]),
    );

    assert.ok('position' in resolved);
    assert.equal(resolved.position.line, 3);
  });

  test('survives an outline request that fails', async () => {
    const resolved = await resolvePosition(document, { symbol: 'OrderService' }, () =>
      Promise.reject(new Error('server busy')),
    );

    assert.ok('position' in resolved);
    assert.equal(resolved.position.line, 2);
  });

  test('accepts a one-based line on its own', async () => {
    const resolved = await resolvePosition(document, { line: 4 }, () => Promise.resolve([]));

    assert.ok('position' in resolved);
    // Line 4 as a human counts is index 3, and the column skips the indent.
    assert.deepEqual(resolved.position, { line: 3, character: 2 });
  });

  test('a line narrows an ambiguous symbol', async () => {
    const resolved = await resolvePosition(document, { symbol: 'findByStatus', line: 5 }, () =>
      Promise.resolve([]),
    );

    assert.ok('position' in resolved);
    assert.equal(resolved.position.line, 4);
  });

  test('explains what it needs when given neither', async () => {
    const resolved = await resolvePosition(document, {}, () => Promise.resolve([]));

    assert.ok('error' in resolved);
    assert.match(resolved.error, /symbol.*line/);
  });

  test('says so when the symbol is not in the file', async () => {
    const resolved = await resolvePosition(document, { symbol: 'nope' }, () => Promise.resolve([]));

    assert.ok('error' in resolved);
    assert.match(resolved.error, /holds no identifier «nope»/);
  });
});

describe('navigation tools', () => {
  const dir = checkout({ 'src/OrderService.java': JAVA_SOURCE });
  const location = {
    uri: 'file:///workspace/src/OrderService.java',
    range: { start: { line: 3, character: 15 }, end: { line: 3, character: 27 } },
  };

  const tools = (document: PreparedDocument | null, status: unknown[] = []): Map<string, ToolFn> =>
    collectTools((tool) =>
      buildLspNavigationTools(tool, { session: stubSession(document, status), dir }),
    );

  test('find_definition reports the location with its source line', async () => {
    const document = prepared('src/OrderService.java', JAVA_SOURCE, {
      'textDocument/documentSymbol': [],
      'textDocument/definition': [location],
    });

    const answer = await tools(document).get(LSP_TOOLS.definition)!({
      path: 'src/OrderService.java',
      symbol: 'findByStatus',
    });

    assert.match(answer, /src\/OrderService\.java:4/);
    assert.match(answer, /public Order findByStatus/);
  });

  test('find_definition understands the LocationLink form', async () => {
    const document = prepared('src/OrderService.java', JAVA_SOURCE, {
      'textDocument/documentSymbol': [],
      'textDocument/definition': [
        {
          targetUri: location.uri,
          targetRange: { start: { line: 2, character: 0 }, end: { line: 6, character: 1 } },
          targetSelectionRange: location.range,
        },
      ],
    });

    const answer = await tools(document).get(LSP_TOOLS.definition)!({
      path: 'src/OrderService.java',
      symbol: 'findByStatus',
    });

    // The selection range, not the whole declaration span.
    assert.match(answer, /:4 {2}public Order findByStatus/);
  });

  test('find_references deduplicates repeated locations', async () => {
    const document = prepared('src/OrderService.java', JAVA_SOURCE, {
      'textDocument/documentSymbol': [],
      'textDocument/references': [location, location, location],
    });

    const answer = await tools(document).get(LSP_TOOLS.references)!({
      path: 'src/OrderService.java',
      symbol: 'findByStatus',
    });

    assert.match(answer, /Found: 1/);
  });

  test('an empty result is a sentence, not an empty string', async () => {
    const document = prepared('src/OrderService.java', JAVA_SOURCE, {
      'textDocument/documentSymbol': [],
      'textDocument/references': [],
    });

    const answer = await tools(document).get(LSP_TOOLS.references)!({
      path: 'src/OrderService.java',
      symbol: 'findByStatus',
    });

    assert.match(answer, /were found/);
  });

  test('document_symbols renders the outline', async () => {
    const document = prepared('src/OrderService.java', JAVA_SOURCE, {
      'textDocument/documentSymbol': [
        {
          name: 'OrderService',
          kind: 5,
          range: { start: { line: 2, character: 0 }, end: { line: 6, character: 1 } },
          selectionRange: { start: { line: 2, character: 13 }, end: { line: 2, character: 25 } },
          children: [
            {
              name: 'findByStatus',
              kind: 6,
              range: { start: { line: 3, character: 2 }, end: { line: 5, character: 3 } },
              selectionRange: {
                start: { line: 3, character: 15 },
                end: { line: 3, character: 27 },
              },
            },
          ],
        },
      ],
    });

    const answer = await tools(document).get(LSP_TOOLS.documentSymbols)!({
      path: 'src/OrderService.java',
    });

    assert.match(answer, /L3 {2}class OrderService/);
    assert.match(answer, /L4 {2}method OrderService\.findByStatus/);
  });

  test('hover flattens whatever shape the server used', async () => {
    const document = prepared('src/OrderService.java', JAVA_SOURCE, {
      'textDocument/documentSymbol': [],
      'textDocument/hover': { contents: { kind: 'markdown', value: 'Order findByStatus(String)' } },
    });

    const answer = await tools(document).get(LSP_TOOLS.hover)!({
      path: 'src/OrderService.java',
      symbol: 'findByStatus',
    });

    assert.match(answer, /Order findByStatus\(String\)/);
  });

  /** A missing server is a normal state of the world, not an agent-visible failure. */
  test('points at grep when no server can answer', async () => {
    const answer = await tools(null, [
      { language: 'java', state: 'unavailable', detail: 'the container image has no JDK' },
    ]).get(LSP_TOOLS.definition)!({ path: 'src/OrderService.java', symbol: 'x' });

    assert.match(answer, /no JDK/);
    assert.match(answer, /grep/);
  });

  test('a server error becomes advice rather than an exception', async () => {
    const document = prepared('src/OrderService.java', JAVA_SOURCE, {
      'textDocument/documentSymbol': [],
      'textDocument/definition': new Error('server is still indexing'),
    });

    const answer = await tools(document).get(LSP_TOOLS.definition)!({
      path: 'src/OrderService.java',
      symbol: 'findByStatus',
    });

    assert.match(answer, /server is still indexing/);
    assert.match(answer, /grep/);
  });

  test('workspace_symbols needs a query', async () => {
    const document = prepared('src/OrderService.java', JAVA_SOURCE, {});

    assert.match(await tools(document).get(LSP_TOOLS.workspaceSymbols)!({}), /Pass query/);
  });

  test('workspace_symbols lists results with their file', async () => {
    const document = prepared('src/OrderService.java', JAVA_SOURCE, {
      'workspace/symbol': [
        {
          name: 'OrderService',
          kind: 5,
          location: {
            uri: 'file:///workspace/src/OrderService.java',
            range: { start: { line: 2, character: 13 }, end: { line: 2, character: 25 } },
          },
        },
      ],
    });

    const answer = await tools(document).get(LSP_TOOLS.workspaceSymbols)!({ query: 'Order' });

    assert.match(answer, /src\/OrderService\.java:3 {2}class OrderService/);
  });
});

describe('rename_symbol', () => {
  /** A backend that records writes, standing in for `DockerShellBackend`. */
  function recordingBackend(dir: string, refusal?: string): EditableBackend & { writes: string[] } {
    const writes: string[] = [];
    return {
      writes,
      edit: (filePath, oldString, newString) => {
        if (refusal) {
          return Promise.resolve({ error: refusal });
        }
        const target = join(dir, filePath.replace(/^\//, ''));
        const current = readFileSync(target, 'utf8');
        if (current !== oldString) {
          return Promise.resolve({ error: 'the file contents changed' });
        }
        writeFileSync(target, newString, 'utf8');
        writes.push(filePath);
        return Promise.resolve({ path: filePath });
      },
    };
  }

  const renameEdit = {
    changes: {
      'file:///workspace/src/OrderService.java': [
        {
          range: { start: { line: 3, character: 15 }, end: { line: 3, character: 27 } },
          newText: 'findByState',
        },
      ],
    },
  };

  function renameTool(
    dir: string,
    answers: Record<string, unknown>,
    backend: EditableBackend,
  ): ToolFn {
    const document = prepared('src/OrderService.java', JAVA_SOURCE, answers);
    return collectTools((tool) =>
      buildLspRenameTool(tool, { session: stubSession(document), dir, backend }),
    ).get(LSP_TOOLS.rename)!;
  }

  test('applies the edit and reports what changed', async () => {
    const dir = checkout({ 'src/OrderService.java': JAVA_SOURCE });
    try {
      const backend = recordingBackend(dir);
      const answer = await renameTool(
        dir,
        { 'textDocument/documentSymbol': [], 'textDocument/rename': renameEdit },
        backend,
      )({ path: 'src/OrderService.java', symbol: 'findByStatus', new_name: 'findByState' });

      assert.match(answer, /Renamed/);
      assert.match(answer, /src\/OrderService\.java \(1\)/);
      assert.match(readFileSync(join(dir, 'src/OrderService.java'), 'utf8'), /findByState\(String/);
      assert.deepEqual(backend.writes, ['/src/OrderService.java']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * The point of routing through the backend: plan mode refuses the write, and
   * the agent sees the same refusal every other write produces.
   */
  test('a backend refusal is surfaced, and nothing is written', async () => {
    const dir = checkout({ 'src/OrderService.java': JAVA_SOURCE });
    try {
      const answer = await renameTool(
        dir,
        { 'textDocument/documentSymbol': [], 'textDocument/rename': renameEdit },
        recordingBackend(dir, 'Plan mode: the edit was refused'),
      )({ path: 'src/OrderService.java', symbol: 'findByStatus', new_name: 'findByState' });

      assert.match(answer, /was not applied/);
      assert.match(answer, /Plan mode/);
      assert.equal(readFileSync(join(dir, 'src/OrderService.java'), 'utf8'), JAVA_SOURCE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('needs a new name', async () => {
    const dir = checkout({ 'src/OrderService.java': JAVA_SOURCE });
    try {
      const answer = await renameTool(
        dir,
        { 'textDocument/documentSymbol': [] },
        recordingBackend(dir),
      )({
        path: 'src/OrderService.java',
        symbol: 'findByStatus',
      });

      assert.match(answer, /Pass new_name/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('explains a rename the server would not do', async () => {
    const dir = checkout({ 'src/OrderService.java': JAVA_SOURCE });
    try {
      const answer = await renameTool(
        dir,
        { 'textDocument/documentSymbol': [], 'textDocument/rename': null },
        recordingBackend(dir),
      )({ path: 'src/OrderService.java', symbol: 'findByStatus', new_name: 'x' });

      assert.match(answer, /could not rename/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A refactor this wide is the user's call, not something to do inside a tool. */
  test('refuses a rename that reaches too far', async () => {
    const dir = checkout({ 'src/OrderService.java': JAVA_SOURCE });
    try {
      const changes: Record<string, unknown[]> = {};
      for (let index = 0; index <= MAX_RENAME_FILES; index += 1) {
        changes[`file:///workspace/src/File${index}.java`] = [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            newText: 'x',
          },
        ];
      }

      const answer = await renameTool(
        dir,
        { 'textDocument/documentSymbol': [], 'textDocument/rename': { changes } },
        recordingBackend(dir),
      )({ path: 'src/OrderService.java', symbol: 'findByStatus', new_name: 'x' });

      assert.match(answer, new RegExp(`the limit is ${MAX_RENAME_FILES}`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses to touch anything outside the repository', async () => {
    const dir = checkout({ 'src/OrderService.java': JAVA_SOURCE });
    try {
      const answer = await renameTool(
        dir,
        {
          'textDocument/documentSymbol': [],
          'textDocument/rename': {
            changes: {
              'file:///usr/lib/jvm/List.java': [
                {
                  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
                  newText: 'x',
                },
              ],
            },
          },
        },
        recordingBackend(dir),
      )({ path: 'src/OrderService.java', symbol: 'findByStatus', new_name: 'x' });

      assert.match(answer, /outside the repository/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses an edit that also moves files', async () => {
    const dir = checkout({ 'src/OrderService.java': JAVA_SOURCE });
    try {
      const answer = await renameTool(
        dir,
        {
          'textDocument/documentSymbol': [],
          'textDocument/rename': { documentChanges: [{ kind: 'rename' }] },
        },
        recordingBackend(dir),
      )({ path: 'src/OrderService.java', symbol: 'OrderService', new_name: 'OrderLookup' });

      assert.match(answer, /file operations/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
