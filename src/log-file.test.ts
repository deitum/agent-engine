import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

import { type FileLog, logFilePath, startFileLog } from './log-file';
import { LOG_FILE_MODE, LOG_MAX_BYTES, LOG_ROTATED_SUFFIX } from './log-file.constants';

let dir: string | undefined;
let log: FileLog | undefined;

/**
 * Every test patches the process-wide console, so restoring it is not optional:
 * a leaked patch turns the *next* file's output into this file's assertions.
 */
afterEach(() => {
  log?.stop();
  log = undefined;
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

/** A throw-away log path under a fresh temp directory. */
function tempLog(): string {
  dir = mkdtempSync(join(tmpdir(), 'engine-log-test-'));
  return join(dir, 'logs', 'engine.log');
}

const read = (path: string): string => readFileSync(path, 'utf8');

describe('logFilePath', () => {
  test('sits under the daemon home, beside everything else it writes', () => {
    assert.equal(
      logFilePath('/home/u/.agent-engine'),
      join('/home/u/.agent-engine/logs/engine.log'),
    );
  });
});

describe('startFileLog', () => {
  test('creates the directory and mirrors every console method into the file', () => {
    const path = tempLog();

    log = startFileLog(path);

    assert.equal(log?.path, path);
    console.log('a plain line');
    console.error('a failure');
    console.warn('a warning');

    const written = read(path);
    assert.match(written, /a plain line/);
    assert.match(written, /a failure/);
    assert.match(written, /a warning/);
  });

  /** A line nobody can place in time is barely a log. */
  test('stamps each line, including the continuation lines of a stack trace', () => {
    const path = tempLog();
    log = startFileLog(path);

    console.log('first\nsecond');

    const lines = read(path).trimEnd().split('\n');
    assert.equal(lines.length, 2);
    for (const line of lines) {
      assert.match(line, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z /);
    }
    assert.match(lines[0], /first$/);
    assert.match(lines[1], /second$/);
  });

  /**
   * The banner it mirrors prints the bearer token, so the log is a secret on the
   * same footing as `state.db` and is created with the same mode.
   */
  test(
    'creates a log only its owner can read',
    { skip: process.platform === 'win32' ? 'POSIX file modes only' : false },
    () => {
      const path = tempLog();
      log = startFileLog(path);

      console.log('Token: a-secret');

      assert.equal(statSync(path).mode & 0o777, LOG_FILE_MODE);
    },
  );

  /** `console.log('%s: %d', …)` is formatted by the console; the file gets the same text. */
  test('records the formatted message, not the raw arguments', () => {
    const path = tempLog();
    log = startFileLog(path);

    console.log('port %d for %s', 50880, 'the app');

    assert.match(read(path), /port 50880 for the app/);
  });

  test('appends to the log a previous run left behind', () => {
    const path = tempLog();
    log = startFileLog(path);
    console.log('first run');
    log?.stop();

    log = startFileLog(path);
    console.log('second run');

    const written = read(path);
    assert.match(written, /first run/);
    assert.match(written, /second run/);
  });

  test('rotates a log that has grown past the cap instead of growing it further', () => {
    const path = tempLog();
    // Start the daemon once to get the directory, then leave an oversized log behind.
    startFileLog(path)?.stop();
    writeFileSync(path, 'x'.repeat(LOG_MAX_BYTES + 1));

    log = startFileLog(path);
    console.log('after rotation');

    assert.equal(read(`${path}${LOG_ROTATED_SUFFIX}`).length, LOG_MAX_BYTES + 1);
    const written = read(path);
    assert.match(written, /after rotation/);
    assert.ok(!written.includes('xxx'), 'the fresh log starts empty');
  });

  test('stop() gives the console back, and stops writing', () => {
    const path = tempLog();
    log = startFileLog(path);
    console.log('while running');

    log?.stop();
    console.log('after stopping');

    const written = read(path);
    assert.match(written, /while running/);
    assert.ok(!written.includes('after stopping'), 'nothing is written once stopped');
  });

  /**
   * A home the daemon cannot write to is a reason to run without a log, never a
   * reason to fail to start — so the caller gets `undefined` and a working console.
   */
  test('gives up quietly when the path cannot be created', () => {
    const path = tempLog();
    writeFileSync(join(dir!, 'logs'), 'a file where the directory should be');

    const failed = startFileLog(path);

    assert.equal(failed, undefined);
    console.log('the console still works');
  });
});
