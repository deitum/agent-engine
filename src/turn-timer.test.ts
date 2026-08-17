import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createTurnTimer } from './turn-timer';

/** A clock the test advances by hand, so the assertions are on exact numbers. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let value = 1_000;
  return {
    now: () => value,
    advance: (ms) => {
      value += ms;
    },
  };
}

describe('createTurnTimer', () => {
  test('writes nothing at all without the flag', () => {
    const lines: string[] = [];
    const timer = createTurnTimer('chat', { log: (line) => lines.push(line), env: {} });

    timer.mark('deps');
    timer.note('tools', 14);
    timer.done();

    assert.equal(timer.enabled, false);
    assert.deepEqual(lines, []);
  });

  test('records phases as deltas and notes verbatim, in one line', () => {
    const lines: string[] = [];
    const clock = fakeClock();
    const timer = createTurnTimer('chat', {
      now: clock.now,
      log: (line) => lines.push(line),
      env: { AGENT_ENGINE_DEBUG_TIMING: '1' },
    });

    clock.advance(200);
    timer.mark('deps');
    clock.advance(50);
    timer.mark('mcp');
    clock.advance(750);
    timer.note('firstToken', `${timer.since()}ms`);
    timer.note('tools', 14);
    timer.done();

    assert.deepEqual(lines, [
      '[timing] chat deps=200ms mcp=50ms firstToken=1000ms tools=14 total=1000ms',
    ]);
  });

  test('writes the line once, however many times a turn ends', () => {
    const lines: string[] = [];
    const timer = createTurnTimer('chat', {
      log: (line) => lines.push(line),
      env: { AGENT_ENGINE_DEBUG_TIMING: '1' },
    });

    timer.done();
    timer.done();

    assert.equal(lines.length, 1);
  });
});
