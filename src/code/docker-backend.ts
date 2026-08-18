import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { insecureChildEnv } from '../config/tls';
import { type CodeEnvVar } from '../contracts';

import { networkGitRefusal } from './code-git';
import { isReadOnlyCommand, type PlanGuard, planRefusal } from './plan-mode';

/**
 * The `execute` result shape deepagents' sandbox backends return. Declared
 * locally (structural) to avoid importing the dual-published `deepagents` types
 * at the CJS/ESM seam (see the note in `deep-agent.ts`).
 */
export interface ExecuteResponse {
  output: string;
  exitCode: number | null;
  truncated: boolean;
}

/**
 * The `write` / `edit` / `delete` result shape of deepagents' backend protocol,
 * narrowed to the one field a refusal needs. Declared locally for the same
 * reason as {@link ExecuteResponse}.
 */
interface WriteOutcome {
  error?: string;
  path?: string;
}

/** Minimal shape of deepagents' `FilesystemBackend` we extend. */
type FilesystemBackendCtor = new (options: { rootDir: string; virtualMode?: boolean }) => {
  write(filePath: string, content: string): Promise<WriteOutcome>;
  edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
  ): Promise<WriteOutcome>;
  delete(filePath: string): Promise<WriteOutcome>;
};

const MAX_OUTPUT_BYTES = 200_000;
const DEFAULT_TIMEOUT_SEC = 600;
/**
 * Env var stamped on every command so the in-container process tree can be found
 * and killed on abort: `docker exec` only kills its own client, the process on
 * the other side keeps running (a `./gradlew build` would survive Stop).
 *
 * Exported because the long-lived `docker exec -i` a language server runs under
 * has exactly the same problem — and a leaked jdtls holds on to a gigabyte or two
 * of the container's memory limit.
 */
export const EXEC_MARKER_VAR = 'AGENT_ENGINE_EXEC_ID';

/** Options for one command run inside a session's container. */
export interface DockerExecOptions {
  /** Environment variables injected with `docker exec -e`. */
  env?: CodeEnvVar[];
  /** Aborts the command (and kills it inside the container). */
  signal?: AbortSignal;
  timeoutSec?: number;
  /**
   * Called with each chunk of combined stdout+stderr as it arrives, for the
   * callers that show a live log (the bootstrap step's install). Chunks are raw
   * — line buffering and throttling belong to whoever renders them. Still
   * called after the output cap is hit, so a long install keeps reporting
   * progress even once the buffered result stopped growing.
   */
  onOutput?: (chunk: string) => void;
}

/**
 * Builds a **Docker-isolated** deepagents backend for one Code session.
 *
 * The session's repository lives in a host directory (`rootDir`) that is
 * bind-mounted into a long-lived container at `/workspace`. File operations
 * (`ls`/`read_file`/`write_file`/`edit_file`/`glob`/`grep`) are inherited from
 * `FilesystemBackend` and run on the **host** path — fast, and it lets the
 * connector compute git diffs directly. Only `execute` is overridden to run the
 * command **inside the container** (`docker exec … sh -lc`), so builds/tests
 * (npm, Gradle) run in the isolated toolchain image rather than on the host, with
 * the session's environment variables and the run's abort signal applied.
 *
 * When a `guard` is supplied the backend is the enforcement point of plan mode:
 * while the guard is active every write is refused and only read-only shell
 * commands reach the container. It sits here rather than in a langchain
 * middleware because sub-agents inherit their parent's backend, whereas
 * middleware has to be handed to each of them (`buildSubAgents`) — a delegation
 * would otherwise be the hole in the guard.
 *
 * The class is defined here (not at module scope) because `FilesystemBackend`
 * is only available after the lazy `import('deepagents')` in `loadDeps`.
 */
export function makeDockerBackend(
  FilesystemBackend: unknown,
  options: {
    rootDir: string;
    containerName: string;
    env?: CodeEnvVar[];
    signal?: AbortSignal;
    timeoutSec?: number;
    /** Plan-mode guard; omitted (or released) leaves the workspace writable. */
    guard?: PlanGuard;
    /**
     * Called for every command that exits non-zero, so the session can remember
     * it. A plan-mode refusal is deliberately not reported: nothing ran, and the
     * command is not what is broken.
     */
    onFailure?: (command: string, exitCode: number | null, output: string) => void;
  },
): object {
  const Base = FilesystemBackend as FilesystemBackendCtor;
  const { containerName, rootDir, env, signal, guard, onFailure } = options;
  const timeoutSec = options.timeoutSec ?? DEFAULT_TIMEOUT_SEC;

  /** The refusal a blocked call returns, or `null` while writing is allowed. */
  const blocked = (what: string): string | null => (guard?.active ? planRefusal(what) : null);

  class DockerShellBackend extends Base {
    /** deepagents treats a backend with an `execute` fn + `id` string as a sandbox. */
    get id(): string {
      return `docker-${containerName}`;
    }

    get isRunning(): boolean {
      return true;
    }

    override async write(filePath: string, content: string): Promise<WriteOutcome> {
      const refusal = blocked(`an attempt to write «${filePath}»`);
      return refusal ? { error: refusal } : super.write(filePath, content);
    }

    override async edit(
      filePath: string,
      oldString: string,
      newString: string,
      replaceAll?: boolean,
    ): Promise<WriteOutcome> {
      const refusal = blocked(`an attempt to change «${filePath}»`);
      return refusal ? { error: refusal } : super.edit(filePath, oldString, newString, replaceAll);
    }

    override async delete(filePath: string): Promise<WriteOutcome> {
      const refusal = blocked(`an attempt to delete «${filePath}»`);
      return refusal ? { error: refusal } : super.delete(filePath);
    }

    async execute(command: string): Promise<ExecuteResponse> {
      // Refused before the container is touched, so a blocked command costs
      // nothing and cannot half-run.
      const refusal = isReadOnlyCommand(command)
        ? null
        : blocked(`the command \`${command}\` mutates the workspace`);
      if (refusal) {
        return { output: refusal, exitCode: 1, truncated: false };
      }
      // Git that has to reach the host is answered here rather than inside the
      // container, where it can only fail: the credentials live on the other
      // side of the sandbox boundary, and the tools that hold them are named in
      // the refusal (see `code-git.ts`). Not recorded as a failure — the command
      // never ran, and it is not what is broken.
      const remote = networkGitRefusal(command);
      if (remote) {
        return { output: remote, exitCode: 1, truncated: false };
      }
      const result = await dockerExec(containerName, command, { env, signal, timeoutSec });
      // An abort (`exitCode: null` with the run cancelled) is the user stopping
      // the turn, not a command that does not work — recording it would teach
      // the agent to avoid a command that was never given a chance.
      if (result.exitCode !== 0 && !(result.exitCode === null && signal?.aborted)) {
        onFailure?.(command, result.exitCode, result.output);
      }
      return result;
    }
  }

  return new DockerShellBackend({ rootDir, virtualMode: true });
}

/**
 * Kills whatever inside the container carries `marker` in its environment.
 *
 * `docker exec` gives us no handle on the process on the other side of the
 * socket, so killing the client leaves the real work running. Matching the
 * {@link EXEC_MARKER_VAR} stamp through `/proc` is the one way back to it.
 * Best-effort by design: the container may already be gone, which is the outcome
 * we wanted anyway.
 */
export function killMarkedProcesses(containerName: string, marker: string): void {
  spawn(
    'docker',
    [
      'exec',
      containerName,
      'sh',
      '-c',
      `for p in /proc/[0-9]*; do grep -qz "${EXEC_MARKER_VAR}=${marker}" "$p/environ" 2>/dev/null && kill -9 "\${p##*/}" 2>/dev/null; done`,
    ],
    { stdio: 'ignore' },
  ).unref();
}

/** `-e KEY=VALUE` arguments for `docker exec`. */
export function envArgs(env: CodeEnvVar[] | undefined): string[] {
  if (!env || env.length === 0) {
    return [];
  }
  return env.flatMap((item) => ['-e', `${item.key}=${item.value}`]);
}

/**
 * The daemon's TLS decision as env pairs, so it can be handed to a container
 * the same way a session's own variables are. Empty while certificates are
 * verified, which is every normal installation.
 */
function insecureEnvVars(): CodeEnvVar[] {
  return Object.entries(insecureChildEnv()).map(([key, value]) => ({ key, value }));
}

/**
 * Runs `command` inside the session's container via `docker exec` from
 * `/workspace`, combining stdout+stderr and enforcing a timeout + output cap.
 * Returns the same {@link ExecuteResponse} shape as deepagents' local sandbox.
 *
 * On abort (the user pressed Stop) the client is killed **and** the process
 * inside the container is terminated by matching the {@link MARKER_VAR} stamp.
 */
export function dockerExec(
  containerName: string,
  command: string,
  options: DockerExecOptions = {},
): Promise<ExecuteResponse> {
  const timeoutSec = options.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  const marker = randomUUID();

  return new Promise((resolve) => {
    const child = spawn(
      'docker',
      [
        'exec',
        '-w',
        '/workspace',
        '-e',
        `${EXEC_MARKER_VAR}=${marker}`,
        // The sandbox has no credentials for the git host on purpose, and a git
        // command that asks for them must fail rather than sit at a prompt until
        // the timeout — an interactive command in a `docker exec` has nobody to
        // answer it. `code-git.ts` intercepts the commands worth naming a tool
        // for; this covers the rest (a submodule update, a helper someone wired
        // into the repository).
        '-e',
        'GIT_TERMINAL_PROMPT=0',
        // Whatever the daemon decided about certificates, applied per exec so a
        // container created before the decision still obeys it.
        ...envArgs(insecureEnvVars()),
        ...envArgs(options.env),
        containerName,
        'sh',
        '-lc',
        command,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let settled = false;
    let aborted = false;
    /** Set by {@link kill}, so an exit after it need not wait for the pipes. */
    let killed = false;

    const collect = (buffer: Buffer): void => {
      options.onOutput?.(buffer.toString('utf8'));
      if (truncated) {
        return;
      }
      size += buffer.length;
      if (size > MAX_OUTPUT_BYTES) {
        chunks.push(buffer.subarray(0, buffer.length - (size - MAX_OUTPUT_BYTES)));
        truncated = true;
      } else {
        chunks.push(buffer);
      }
    };

    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    /** Kills the client and, on the other side of the socket, the command itself. */
    const kill = (reason: string): void => {
      killed = true;
      chunks.push(Buffer.from(`\n[${reason}]`));
      child.kill('SIGKILL');
      killMarkedProcesses(containerName, marker);
    };

    const timer = setTimeout(() => {
      truncated = true;
      kill(`the command was stopped after a ${timeoutSec}s timeout`);
    }, timeoutSec * 1000);
    timer.unref?.();

    const onAbort = (): void => {
      aborted = true;
      kill('stopped by the user');
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (exitCode: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        output: Buffer.concat(chunks).toString('utf8'),
        exitCode: aborted ? null : exitCode,
        truncated,
      });
    };

    child.on('error', (error) => {
      chunks.push(Buffer.from(`docker exec failed: ${error.message}`));
      finish(null);
    });
    child.on('close', (code) => finish(code));

    /**
     * After a kill, the process having exited is enough — we do not wait for
     * `close`.
     *
     * `close` fires only once every stdio pipe is closed as well, and a pipe
     * outlives the process we killed if that process left a child of its own
     * holding it. `sh -c "<command>"` does exactly that whenever the shell
     * forks rather than `exec`s, which varies by shell and therefore by
     * platform. The outcome is already decided by the time `kill` runs, so
     * waiting for the straggler only delays the answer by however long it
     * happens to run — a timeout of one second used to return after thirty.
     */
    child.on('exit', (code) => {
      if (killed) {
        finish(code);
      }
    });

    if (options.signal?.aborted) {
      onAbort();
    }
  });
}
