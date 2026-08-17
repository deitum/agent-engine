import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  diagnosticKey,
  errorsOnly,
  formatDiagnostic,
  formatDiagnosticsBlock,
  newDiagnostics,
  plural,
} from './diagnostics';
import { MAX_DIAGNOSTICS } from './lsp.constants';
import { type LspDiagnostic, LSP_SEVERITY } from './lsp.types';

/** A diagnostic with only the fields the logic reads. */
function make(message: string, line: number, extra: Partial<LspDiagnostic> = {}): LspDiagnostic {
  return {
    message,
    severity: LSP_SEVERITY.error,
    range: { start: { line, character: 0 }, end: { line, character: 10 } },
    ...extra,
  };
}

describe('diagnosticKey', () => {
  /**
   * The load-bearing property: inserting a line above an error moves it, and a
   * key that included the position would report the whole rest of the file as
   * newly broken by a one-line edit.
   */
  test('is unchanged when a diagnostic only moves', () => {
    assert.equal(
      diagnosticKey(make('cannot find symbol', 10)),
      diagnosticKey(make('cannot find symbol', 90)),
    );
  });

  test('separates different messages, codes and analysers', () => {
    assert.notEqual(diagnosticKey(make('a', 1)), diagnosticKey(make('b', 1)));
    assert.notEqual(
      diagnosticKey(make('a', 1, { code: 2339 })),
      diagnosticKey(make('a', 1, { code: 2551 })),
    );
    assert.notEqual(
      diagnosticKey(make('a', 1, { source: 'ts' })),
      diagnosticKey(make('a', 1, { source: 'eslint' })),
    );
  });

  test('ignores the whitespace a multi-line compiler message arrives with', () => {
    assert.equal(
      diagnosticKey(make('incompatible\n  types', 1)),
      diagnosticKey(make('incompatible types', 1)),
    );
  });
});

describe('errorsOnly', () => {
  test('drops warnings and hints', () => {
    const items = [
      make('real', 1),
      make('style', 2, { severity: LSP_SEVERITY.warning }),
      make('hint', 3, { severity: LSP_SEVERITY.hint }),
    ];

    assert.deepEqual(
      errorsOnly(items).map((item) => item.message),
      ['real'],
    );
  });

  /** A server that omits severity is describing an error, per the protocol. */
  test('keeps a diagnostic with no severity', () => {
    assert.equal(errorsOnly([make('x', 1, { severity: undefined })]).length, 1);
  });
});

describe('newDiagnostics', () => {
  test('finds what the edit introduced', () => {
    const before = [make('old', 5)];
    const after = [make('old', 7), make('fresh', 12)];

    assert.deepEqual(
      newDiagnostics(before, after).map((item) => item.message),
      ['fresh'],
    );
  });

  test('reports nothing when the file only shifted', () => {
    assert.deepEqual(
      newDiagnostics([make('a', 1), make('b', 2)], [make('a', 40), make('b', 41)]),
      [],
    );
  });

  /**
   * A set difference would swallow this: the error already existed once, so a
   * second copy of it would look like nothing had changed.
   */
  test('counts a duplicated error as new', () => {
    const fresh = newDiagnostics(
      [make('cannot find symbol: foo', 3)],
      [make('cannot find symbol: foo', 3), make('cannot find symbol: foo', 9)],
    );

    assert.equal(fresh.length, 1);
  });

  test('a fixed error does not turn its neighbour into a new one', () => {
    assert.deepEqual(newDiagnostics([make('a', 1), make('b', 2)], [make('b', 1)]), []);
  });
});

describe('formatDiagnostic', () => {
  /** Every editor, compiler and human counts lines from one. */
  test('reports one-based lines', () => {
    assert.match(formatDiagnostic(make('boom', 0)), /^L1\b/);
    assert.match(formatDiagnostic(make('boom', 41)), /^L42\b/);
  });

  test('carries the rule code when there is one', () => {
    assert.match(formatDiagnostic(make('Property does not exist', 5, { code: 2339 })), /\[2339\]/);
  });

  test('truncates a very long message', () => {
    const formatted = formatDiagnostic(make('x'.repeat(1000), 1));
    assert.ok(formatted.length < 300);
    assert.match(formatted, /…$/);
  });
});

describe('formatDiagnosticsBlock', () => {
  const language = 'java' as const;

  /** Silence is the reward for code that compiles — and what keeps this cheap. */
  test('says nothing when the file was clean and stayed clean', () => {
    assert.equal(formatDiagnosticsBlock({ language, before: [], after: [] }), null);
  });

  test('lists what the edit broke', () => {
    const block = formatDiagnosticsBlock({
      language,
      before: [],
      after: [make('cannot find symbol: method findByStatus(String)', 41)],
    });

    assert.match(block ?? '', /⚠ LSP \(java\): 1 error/);
    assert.match(block ?? '', /L42 {2}cannot find symbol/);
  });

  test('separates the count of new errors from the total', () => {
    const before = [make('pre-existing', 3)];
    const after = [make('pre-existing', 3), make('fresh one', 40), make('fresh two', 44)];

    const block = formatDiagnosticsBlock({ language, before, after });

    assert.match(block ?? '', /3 errors in this file, 2 from this edit/);
  });

  /**
   * A repository that did not compile before the agent arrived must not re-list
   * its own backlog on every edit — that is a permanent tax on the context.
   */
  test('collapses a backlog the edit did not touch into one line', () => {
    const backlog = Array.from({ length: 7 }, (_, index) => make(`old ${index}`, index));

    const block = formatDiagnosticsBlock({ language, before: backlog, after: backlog });

    assert.equal(block, 'LSP (java): 7 errors in this file, none of them are from this edit.');
  });

  test('says so when the edit cleared the file', () => {
    const block = formatDiagnosticsBlock({ language, before: [make('was broken', 2)], after: [] });

    assert.equal(block, '✓ LSP (java): no errors left in this file.');
  });

  test('puts the new errors first, so a cap never hides them', () => {
    const before = Array.from({ length: 20 }, (_, index) => make(`old ${index}`, index));
    const after = [...before, make('the one that matters', 500)];

    const block = formatDiagnosticsBlock({ language, before, after });
    const lines = (block ?? '').split('\n');

    assert.match(lines[1], /the one that matters/);
    assert.ok(lines.length <= MAX_DIAGNOSTICS + 3);
    assert.match(block ?? '', /…and \d+ more\./);
  });

  test('ignores warnings entirely', () => {
    const block = formatDiagnosticsBlock({
      language,
      before: [],
      after: [make('unused import', 1, { severity: LSP_SEVERITY.warning })],
    });

    assert.equal(block, null);
  });
});

describe('plural', () => {
  test('says «1 error» for one and «N errors» for anything else', () => {
    assert.equal(plural(1), '1 error');
    assert.equal(plural(2), '2 errors');
    assert.equal(plural(0), '0 errors');
    assert.equal(plural(112), '112 errors');
  });
});
