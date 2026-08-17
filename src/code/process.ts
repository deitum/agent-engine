import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Time budgets for the child processes a Code workspace shells out to.
 *
 * Every one of these used to run unbounded, so a stalled registry, an
 * unreachable git host or a `du` walking a network mount would pin the HTTP
 * request forever with no way out but restarting the daemon. The numbers are
 * generous on purpose — they exist to end a hang, not to police slow hardware.
 */
export const PROCESS_TIMEOUTS = {
  /** `docker version` / `docker inspect` — local socket calls. */
  probe: 10_000,
  /** `du -sk` over a checkout. */
  diskUsage: 15_000,
  /** Ordinary git plumbing against a local checkout. */
  git: 120_000,
  /** Anything talking to the git host: clone, fetch, push. */
  gitNetwork: 10 * 60_000,
  /** `docker pull` of a toolchain image, cold. */
  dockerPull: 15 * 60_000,
  /** `docker run` / `start` / `rm` on an already-pulled image. */
  dockerLifecycle: 2 * 60_000,
} as const;

/** Default stdout ceiling; a `git diff` over a large change can be big. */
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

export interface RunOptions {
  /** Hard budget; the process is SIGKILLed past it. */
  timeoutMs: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

/**
 * A child process that exceeded its {@link RunOptions.timeoutMs}. Distinguished
 * from an ordinary non-zero exit so callers can say «timed out»
 * instead of reporting an empty stderr as a git failure.
 */
export class ProcessTimeoutError extends Error {
  constructor(
    readonly command: string,
    readonly timeoutMs: number,
  ) {
    super(`«${command}» timed out after ${Math.round(timeoutMs / 1000)}s.`);
    this.name = 'ProcessTimeoutError';
  }
}

/** A non-zero exit, carrying whatever the process managed to write. */
export class ProcessFailedError extends Error {
  constructor(
    readonly command: string,
    readonly stderr: string,
    readonly stdout: string,
  ) {
    super(stderr.trim() || stdout.trim() || `«${command}» failed.`);
    this.name = 'ProcessFailedError';
  }
}

/**
 * The seam every git / docker invocation goes through.
 *
 * Exists for two reasons: it makes the timeout non-optional (the reason the
 * budgets above are enforced at all), and it lets a test inject a fake `docker`
 * while letting real `git` run against a temporary checkout — which is what
 * makes {@link CodeWorkspaces} testable without a Docker daemon.
 */
export interface ProcessRunner {
  run(command: string, args: string[], options: RunOptions): Promise<RunResult>;
}

/**
 * True for the error `execFile` reports when it killed the child for exceeding
 * `timeout`. Node signals this with `killed`, not with a distinct code.
 */
function isTimeoutError(error: unknown): boolean {
  return (error as { killed?: boolean } | null)?.killed === true;
}

/** Runs the process for real. The default for every {@link ProcessRunner} slot. */
export const defaultRunner: ProcessRunner = {
  async run(command, args, options) {
    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        timeout: options.timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
        ...(options.env ? { env: options.env } : {}),
      });
      return { stdout, stderr };
    } catch (error) {
      if (isTimeoutError(error)) {
        throw new ProcessTimeoutError(command, options.timeoutMs);
      }
      const { stderr = '', stdout = '' } = (error ?? {}) as { stderr?: string; stdout?: string };
      throw new ProcessFailedError(command, stderr, stdout);
    }
  },
};
