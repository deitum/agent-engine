import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRepetitionWatch, findRepetition, repetitionMessage } from './repetition';

/** The shape the failure actually took: one line, repeated with a blank line between copies. */
const STUCK_LINE = 'Checking `example-libs` — no. Checking `example-api` — no.\n\n';

/** Ordinary prose, long enough to clear the length threshold on its own. */
const PROSE =
  'The fee is computed on the backend. The front end only sends a request and renders the answer. ' +
  'The formulas live in a DMN table that CommissionService calls, and the parameters arrive ' +
  'from the product card along with the rate and the minimum amount. A step-by-step breakdown follows, ' +
  'from the request to the final amount, with examples on real values from the test environment.';

test('a paragraph written over and over is a repetition', () => {
  const found = findRepetition(PROSE + STUCK_LINE.repeat(8));

  assert.ok(found);
  assert.equal(found.period, STUCK_LINE.length);
  assert.equal(found.copies, 8);
  assert.equal(found.unit, STUCK_LINE);
});

/** The other shape: no newlines, so a line-based check would never see it. */
test('a sentence repeated inline is a repetition too', () => {
  const found = findRepetition(`${PROSE} ${'Checking — no. '.repeat(20)}`);

  assert.ok(found);
  assert.equal(found.copies, 20);
});

test('prose that never repeats is not', () => {
  assert.equal(findRepetition(PROSE), null);
});

/**
 * A model quoting a paragraph back once — to answer it, or to carry it into a
 * summary — is doing its job. Two copies is emphasis; the loop this guards
 * against does not stop at two.
 */
test('a paragraph written twice is not', () => {
  assert.equal(findRepetition(PROSE + PROSE), null);
});

/** Four copies of very little: a table rule, a run of dashes, an ellipsis. */
test('a short repeated run is not', () => {
  assert.equal(findRepetition(`${PROSE}\n| --- | --- | --- | --- |\n`), null);
});

test('text shorter than the reporting threshold is never a repetition', () => {
  assert.equal(findRepetition('ha '.repeat(10)), null);
});

test('the watch reports the copy that completes the repetition, and not before', () => {
  const watch = createRepetitionWatch();
  const reported: number[] = [];

  for (const token of [PROSE, ...Array<string>(6).fill(STUCK_LINE)]) {
    const found = watch.push(token);
    if (found) {
      reported.push(found.copies);
    }
  }

  // Four copies is the threshold, so the fourth, fifth and sixth each report.
  assert.deepEqual(reported, [4, 5, 6]);
});

test('a reset watch forgets what the previous call wrote', () => {
  const watch = createRepetitionWatch();
  watch.push(PROSE + STUCK_LINE.repeat(3));
  watch.reset();

  assert.equal(watch.push(STUCK_LINE), null);
});

/** The window is bounded, and text that scrolls out of it stops counting. */
test('the watch survives a turn far longer than its window', () => {
  const watch = createRepetitionWatch();
  for (let i = 0; i < 200; i += 1) {
    assert.equal(watch.push(`${PROSE} step ${i}. `), null);
  }

  assert.ok(watch.push(STUCK_LINE.repeat(5)));
});

test('the notice quotes what the model got stuck on', () => {
  const message = repetitionMessage({ period: 10, copies: 12, unit: STUCK_LINE });

  assert.match(message, /12 copies/);
  assert.match(message, /Checking `example-libs` — no/);
  // The quote is one line: the copies' own newlines would break the notice apart.
  assert.equal(message.includes('\n'), false);
});
