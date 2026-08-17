import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createMcpCallMemo } from './mcp-call-memo';

test('a call made twice with the same arguments comes back from the memo', () => {
  const memo = createMcpCallMemo();
  memo.remember(
    'mcp_grep',
    { repository: 'example-libs', query: 'class CommissionService' },
    '0 matches',
  );

  const repeat = memo.recall('mcp_grep', {
    repository: 'example-libs',
    query: 'class CommissionService',
  });

  assert.ok(repeat);
  assert.match(repeat, /already called/);
  assert.match(repeat, /0 matches/);
});

/** The model does not write its arguments in a stable order; two spellings are one call. */
test('argument order does not make two calls out of one', () => {
  const memo = createMcpCallMemo();
  memo.remember('mcp_grep', { workspace: 'acme', repository: 'example-ui' }, 'found');

  assert.ok(memo.recall('mcp_grep', { repository: 'example-ui', workspace: 'acme' }));
});

test('nested arguments are compared by value, not by spelling', () => {
  const memo = createMcpCallMemo();
  memo.remember('search', { filter: { b: [1, { y: 2, x: 1 }], a: true } }, 'ok');

  assert.ok(memo.recall('search', { filter: { a: true, b: [1, { x: 1, y: 2 }] } }));
});

test('a different argument is a different call', () => {
  const memo = createMcpCallMemo();
  memo.remember('mcp_grep', { repository: 'example-libs' }, '0 matches');

  assert.equal(memo.recall('mcp_grep', { repository: 'example-api' }), undefined);
});

test('the same arguments to a different tool are a different call', () => {
  const memo = createMcpCallMemo();
  memo.remember('mcp_grep', { repository: 'example-ui' }, '0 matches');

  assert.equal(memo.recall('list_directory_content', { repository: 'example-ui' }), undefined);
});

/**
 * A model repeating a call that failed is usually retrying a timeout — which is
 * a call that has to actually run. Only successes are remembered, so a failure
 * is simply never in here.
 */
test('nothing is recalled for a call that was never remembered', () => {
  const memo = createMcpCallMemo();

  assert.equal(memo.recall('mcp_grep', { repository: 'example-ui' }), undefined);
});

/** A memo entry is a second copy of an output the history already holds. */
test('an oversized result is not kept', () => {
  const memo = createMcpCallMemo();
  memo.remember('get_file_content', { file_path: 'huge.ts' }, 'x'.repeat(20_001));

  assert.equal(memo.recall('get_file_content', { file_path: 'huge.ts' }), undefined);
});

test('the memo forgets the least recently called first', () => {
  const memo = createMcpCallMemo();
  for (let i = 0; i < 64; i += 1) {
    memo.remember('mcp_grep', { query: `q${i}` }, `result ${i}`);
  }
  // Calling the oldest again makes it the newest, so the next eviction is q1.
  memo.remember('mcp_grep', { query: 'q0' }, 'result 0');
  memo.remember('mcp_grep', { query: 'q64' }, 'result 64');

  assert.ok(memo.recall('mcp_grep', { query: 'q0' }));
  assert.equal(memo.recall('mcp_grep', { query: 'q1' }), undefined);
  assert.ok(memo.recall('mcp_grep', { query: 'q64' }));
});
