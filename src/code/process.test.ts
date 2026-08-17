import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { defaultRunner, ProcessFailedError, ProcessTimeoutError } from './process';

/** Runs a snippet of JS in a child node, which is the one interpreter CI is sure to have. */
function node(source: string): { command: string; args: string[] } {
  return { command: process.execPath, args: ['-e', source] };
}

describe('defaultRunner', () => {
  test('returns what the process wrote to both streams', async () => {
    const { command, args } = node("process.stdout.write('out'); process.stderr.write('err')");
    const result = await defaultRunner.run(command, args, { timeoutMs: 10_000 });

    assert.equal(result.stdout, 'out');
    assert.equal(result.stderr, 'err');
  });

  test('a non-zero exit throws with what the process managed to say', async () => {
    const { command, args } = node("process.stderr.write('no such branch'); process.exit(3)");

    await assert.rejects(
      () => defaultRunner.run(command, args, { timeoutMs: 10_000 }),
      (error: unknown) => {
        assert.ok(error instanceof ProcessFailedError);
        assert.equal(error.message, 'no such branch');
        assert.equal(error.command, command);
        assert.equal(error.stderr.trim(), 'no such branch');
        return true;
      },
    );
  });

  /**
   * A process that fails silently is the case a bare `stderr` would report as an
   * empty error — the caller then shows the user nothing at all.
   */
  test('a silent failure still carries a readable message', async () => {
    const { command, args } = node('process.exit(4)');

    await assert.rejects(
      () => defaultRunner.run(command, args, { timeoutMs: 10_000 }),
      (error: unknown) => {
        assert.ok(error instanceof ProcessFailedError);
        assert.match(error.message, /failed/);
        return true;
      },
    );
  });

  /**
   * The reason this module exists: every git / docker call used to run unbounded,
   * so a wedged one pinned its HTTP request until the daemon was restarted. A
   * timeout has to be distinguishable from an ordinary failure, or the user is
   * told their git command failed with no output.
   */
  test('exceeding the budget is reported as a timeout, not as a failure', async () => {
    const { command, args } = node('setTimeout(() => {}, 30_000)');
    const started = Date.now();

    await assert.rejects(
      () => defaultRunner.run(command, args, { timeoutMs: 500 }),
      (error: unknown) => {
        assert.ok(error instanceof ProcessTimeoutError);
        assert.equal(error.timeoutMs, 500);
        assert.match(error.message, /timed out after 1s/);
        return true;
      },
    );
    assert.ok(Date.now() - started < 10_000, 'the call returned as soon as the child was killed');
  });

  /**
   * The probe is a variable of our own rather than `PATH`. Windows hands a child
   * a handful of variables whatever the parent passes — `PATH` among them — so
   * its absence would state the intent only on POSIX. A name nothing else could
   * have set says the same thing on both.
   */
  test('an explicit env replaces the daemon environment rather than extending it', async () => {
    const probe = 'ENGINE_LEAK_PROBE';
    process.env[probe] = 'from the daemon';
    try {
      const { command, args } = node('process.stdout.write(Object.keys(process.env).join(","))');
      const result = await defaultRunner.run(command, args, {
        timeoutMs: 10_000,
        env: { ENGINE_MARKER: 'set' },
      });

      const keys = result.stdout.split(',');
      assert.ok(keys.includes('ENGINE_MARKER'), 'the caller-supplied variable reaches the child');
      assert.ok(!keys.includes(probe), "the daemon's own environment does not leak into it");
    } finally {
      delete process.env[probe];
    }
  });

  /** A flood of stdout must fail the one command, not take the daemon's memory with it. */
  test('overflowing the output ceiling fails the command', async () => {
    const { command, args } = node("process.stdout.write('x'.repeat(100_000))");

    await assert.rejects(
      () => defaultRunner.run(command, args, { timeoutMs: 10_000, maxBuffer: 1024 }),
      (error: unknown) => error instanceof ProcessFailedError,
    );
  });
});
