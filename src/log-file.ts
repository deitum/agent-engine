import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { format } from 'node:util';

import {
  LOG_DIR,
  LOG_DIR_MODE,
  LOG_FILE,
  LOG_FILE_MODE,
  LOG_MAX_BYTES,
  LOG_ROTATED_SUFFIX,
} from './log-file.constants';
import { engineHome } from './platform';

/** Default path of the log (`~/.agent-engine/logs/engine.log`). */
export const logFilePath = (home: string = engineHome()): string => join(home, LOG_DIR, LOG_FILE);

/** A running mirror of the console into a file. */
export interface FileLog {
  /** The file console output is being written to. */
  path: string;
  /**
   * Restores the console. Only the tests need it — the daemon logs until the
   * process ends, and a half-logged shutdown is worse than none.
   */
  stop: () => void;
}

/** The console methods mirrored; everything this daemon and its dependencies use. */
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

type ConsoleMethod = (typeof CONSOLE_METHODS)[number];

/** Size of a file that may not exist yet — an absent log is an empty one. */
function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Moves the current log aside if it has grown past the cap, and reports the size
 * to keep counting from.
 *
 * A failed rename is not worth losing logging over: Windows refuses to replace a
 * file another process holds open, and two daemons sharing a home is a normal
 * accident. Counting from zero again is what makes that self-limiting — the next
 * attempt is a whole `LOG_MAX_BYTES` away rather than on the very next line.
 */
function rotateIfFull(path: string): number {
  const size = fileSize(path);
  if (size < LOG_MAX_BYTES) {
    return size;
  }
  try {
    renameSync(path, `${path}${LOG_ROTATED_SUFFIX}`);
  } catch {
    /* keep appending to the file we have */
  }
  return 0;
}

/**
 * Mirrors everything written to the console into {@link logFilePath}, and returns
 * where that is so the caller can tell the user.
 *
 * `console` is patched rather than `process.stdout.write` because nothing in this
 * daemon writes to the streams directly, and a patched `write` is the kind of
 * global that breaks a dependency's progress bar rather than logging it.
 *
 * Synchronous appends: the volume is a handful of lines per turn, the file has to
 * hold the line that precedes a crash, and a write stream would be an open handle
 * the process then has to close on every exit path.
 *
 * Returns `undefined` — with a warning on the console — when the file cannot be
 * opened at all. A read-only home is a reason to run without a log, never a
 * reason for the daemon not to start.
 */
export function startFileLog(path: string = logFilePath()): FileLog | undefined {
  let size: number;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: LOG_DIR_MODE });
    size = rotateIfFull(path);
  } catch (error) {
    console.error(`Cannot write a log file at ${path}: ${String(error)}`);
    return undefined;
  }

  const original = {} as Record<ConsoleMethod, (...args: unknown[]) => void>;
  for (const method of CONSOLE_METHODS) {
    original[method] = console[method].bind(console);
  }

  // One failed append stops the mirroring for good: a disk that is full or a
  // home that was unmounted mid-run would otherwise turn every log line into two.
  let stopped = false;

  const append = (text: string): void => {
    if (stopped) {
      return;
    }
    const stamp = new Date().toISOString();
    const body = `${text
      .split('\n')
      .map((line) => `${stamp} ${line}`)
      .join('\n')}\n`;
    try {
      appendFileSync(path, body, { mode: LOG_FILE_MODE });
      size += Buffer.byteLength(body);
      if (size >= LOG_MAX_BYTES) {
        size = rotateIfFull(path);
      }
    } catch (error) {
      stopped = true;
      original.error(`Logging to ${path} stopped: ${String(error)}`);
    }
  };

  for (const method of CONSOLE_METHODS) {
    console[method] = (...args: unknown[]): void => {
      original[method](...args);
      append(format(...args));
    };
  }

  return {
    path,
    stop: () => {
      stopped = true;
      for (const method of CONSOLE_METHODS) {
        console[method] = original[method];
      }
    },
  };
}
