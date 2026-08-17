import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { applyTextEdits, collectWorkspaceEdit, lineStarts, offsetAt } from './lsp-edits';
import { type LspTextEdit } from './lsp.types';

/** A replacement of one span, in the protocol's zero-based coordinates. */
function edit(
  startLine: number,
  startChar: number,
  endLine: number,
  endChar: number,
  newText: string,
): LspTextEdit {
  return {
    range: {
      start: { line: startLine, character: startChar },
      end: { line: endLine, character: endChar },
    },
    newText,
  };
}

describe('offsetAt', () => {
  const text = 'one\ntwo\nthree';
  const starts = lineStarts(text);

  test('maps a position to its string index', () => {
    assert.equal(offsetAt(text, starts, { line: 0, character: 0 }), 0);
    assert.equal(offsetAt(text, starts, { line: 1, character: 0 }), 4);
    assert.equal(offsetAt(text, starts, { line: 2, character: 2 }), 10);
  });

  /** A server that computed against a slightly different revision must not corrupt the file. */
  test('clamps a position past the end of its line', () => {
    assert.equal(offsetAt(text, starts, { line: 0, character: 999 }), 3);
    assert.equal(offsetAt(text, starts, { line: 99, character: 0 }), text.length);
    assert.equal(offsetAt(text, starts, { line: -1, character: 0 }), 0);
  });

  /**
   * `character` counts UTF-16 code units, which is what JavaScript indexes by —
   * so a Cyrillic identifier needs no conversion, and getting this wrong would
   * silently cut a rename mid-character.
   */
  test('counts UTF-16 code units', () => {
    const cyrillic = 'const order = 1;';
    assert.equal(offsetAt(cyrillic, lineStarts(cyrillic), { line: 0, character: 6 }), 6);
    assert.equal(cyrillic.slice(6, 11), 'order');
  });
});

describe('applyTextEdits', () => {
  test('replaces a single span', () => {
    assert.equal(
      applyTextEdits('const a = 1;', [edit(0, 6, 0, 7, 'renamed')]),
      'const renamed = 1;',
    );
  });

  /**
   * The core of the algorithm: applying front to back would invalidate every
   * offset after the first edit that changed a length.
   */
  test('applies several edits without shifting each other', () => {
    const text = 'foo(foo, foo)';
    const edits = [
      edit(0, 0, 0, 3, 'barbar'),
      edit(0, 4, 0, 7, 'barbar'),
      edit(0, 9, 0, 12, 'barbar'),
    ];

    assert.equal(applyTextEdits(text, edits), 'barbar(barbar, barbar)');
  });

  test('handles edits across several lines', () => {
    const text = 'a = old\nb = 2\nc = old';
    const edits = [edit(0, 4, 0, 7, 'new'), edit(2, 4, 2, 7, 'new')];

    assert.equal(applyTextEdits(text, edits), 'a = new\nb = 2\nc = new');
  });

  test('handles insertions and deletions', () => {
    assert.equal(applyTextEdits('ac', [edit(0, 1, 0, 1, 'b')]), 'abc');
    assert.equal(applyTextEdits('abc', [edit(0, 1, 0, 2, '')]), 'ac');
  });

  test('renames a Cyrillic identifier without cutting it', () => {
    const text = 'const order = 1;\nreturn order;';
    const edits = [edit(0, 6, 0, 11, 'order'), edit(1, 7, 1, 12, 'order')];

    assert.equal(applyTextEdits(text, edits), 'const order = 1;\nreturn order;');
  });

  /** Overlapping ranges violate the protocol; mangling the file is worse than skipping one. */
  test('skips an edit that overlaps one already applied', () => {
    const result = applyTextEdits('abcdef', [edit(0, 0, 0, 4, 'X'), edit(0, 2, 0, 6, 'Y')]);

    assert.ok(result === 'Xef' || result === 'abY');
  });

  test('leaves the text alone when there is nothing to do', () => {
    assert.equal(applyTextEdits('unchanged', []), 'unchanged');
  });
});

describe('collectWorkspaceEdit', () => {
  const uri = 'file:///workspace/src/a.ts';

  test('reads the `changes` map form', () => {
    const collected = collectWorkspaceEdit({ changes: { [uri]: [edit(0, 0, 0, 1, 'x')] } });

    assert.ok(!('error' in collected));
    assert.equal((collected as { total: number }).total, 1);
  });

  test('reads the `documentChanges` list form', () => {
    const collected = collectWorkspaceEdit({
      documentChanges: [{ textDocument: { uri, version: 1 }, edits: [edit(0, 0, 0, 1, 'x')] }],
    });

    assert.ok(!('error' in collected));
    assert.equal((collected as { byUri: Map<string, unknown[]> }).byUri.get(uri)?.length, 1);
  });

  test('merges both forms and counts every edit', () => {
    const other = 'file:///workspace/src/b.ts';
    const collected = collectWorkspaceEdit({
      changes: { [uri]: [edit(0, 0, 0, 1, 'x'), edit(1, 0, 1, 1, 'y')] },
      documentChanges: [{ textDocument: { uri: other }, edits: [edit(0, 0, 0, 1, 'z')] }],
    });

    assert.ok(!('error' in collected));
    const result = collected as { byUri: Map<string, unknown[]>; total: number };
    assert.equal(result.total, 3);
    assert.equal(result.byUri.size, 2);
  });

  /**
   * Renaming a public Java class renames its file too. Applying only the text
   * half would leave a tree that does not compile, so the whole thing is refused
   * with something the agent can act on.
   */
  test('refuses an edit that also moves files', () => {
    const collected = collectWorkspaceEdit({
      documentChanges: [
        { textDocument: { uri }, edits: [edit(0, 0, 0, 1, 'x')] },
        { kind: 'rename' },
      ],
    });

    assert.ok('error' in collected);
    assert.match((collected as { error: string }).error, /file operations \(rename\)/);
  });

  test('is empty for nothing at all', () => {
    for (const input of [null, undefined, {}]) {
      const collected = collectWorkspaceEdit(input);
      assert.ok(!('error' in collected));
      assert.equal((collected as { total: number }).total, 0);
    }
  });

  test('ignores malformed entries rather than throwing', () => {
    const collected = collectWorkspaceEdit({
      changes: { [uri]: [{ newText: 'x' } as unknown as LspTextEdit, edit(0, 0, 0, 1, 'y')] },
    });

    assert.ok(!('error' in collected));
    assert.equal((collected as { total: number }).total, 1);
  });
});
