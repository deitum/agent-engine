import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';

import { PACKAGE_VERSION } from './package.constants';

const CLI = join(__dirname, 'cli.js');

/** Where a daemon started with this suite's `HOME` writes its log. */
const logPath = (home: string): string => join(home, '.agent-engine', 'logs', 'engine.log');

/** A literal string as a pattern — Windows paths are full of regex metacharacters. */
const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A throw-away `$HOME` for every spawned daemon.
 *
 * `cli.js` is the real entry point, so it builds the real workspace roots under
 * `~/.agent-engine` and sweeps them at startup. Pointing `HOME` at a temp dir keeps
 * the suite off the machine's actual workspaces.
 */
let home: string;
let running: Daemon[] = [];

before(() => {
  home = mkdtempSync(join(tmpdir(), 'engine-cli-test-home-'));
});

afterEach(async () => {
  for (const daemon of running) {
    daemon.child.kill('SIGKILL');
    await daemon.exited;
  }
  running = [];
});

after(() => {
  rmSync(home, { recursive: true, force: true });
});

interface Daemon {
  child: ChildProcess;
  /** Everything the process has written to stdout and stderr so far. */
  output: () => string;
  /** Resolves with the exit code once the process is gone. */
  exited: Promise<number | null>;
  /** Resolves once `pattern` shows up in the output, or rejects on a timeout. */
  waitFor: (pattern: RegExp, timeoutMs?: number) => Promise<string>;
}

/** A port nothing is listening on, taken by binding and releasing it. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** Starts `dist/cli.js` with a minimal environment and tracks it for cleanup. */
function spawnCli(args: string[], env: Record<string, string> = {}): Daemon {
  const child = spawn(process.execPath, [CLI, ...args], {
    env: { PATH: process.env.PATH ?? '', HOME: home, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));

  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));

  const daemon: Daemon = {
    child,
    output: () => output,
    exited,
    waitFor: async (pattern, timeoutMs = 15_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (pattern.test(output)) {
          return output;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`timed out waiting for ${String(pattern)}; saw:\n${output}`);
    },
  };
  running.push(daemon);
  return daemon;
}

/**
 * Starts the daemon on a free port and waits until it is actually listening —
 * and until it has finished saying so. The wait is on the **last** line of the
 * banner rather than the first: several tests read the token out of it, and one
 * chunk of stdout does not have to carry every line, so waiting on «is running»
 * failed those assertions at random.
 */
async function startDaemon(
  args: string[] = [],
  env: Record<string, string> = {},
): Promise<{ daemon: Daemon; port: number }> {
  const port = await freePort();
  const daemon = spawnCli(args, { PORT: String(port), ...env });
  await daemon.waitFor(/Keep it running while you use the app/);
  return { daemon, port };
}

async function ping(port: number, token?: string): Promise<{ authorized?: boolean }> {
  const response = await fetch(`http://127.0.0.1:${port}/ping`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return (await response.json()) as { authorized?: boolean };
}

/**
 * The banner is the daemon's entire user interface: whoever ran the command has
 * a terminal in front of them and needs to know which build answered, that it is
 * up, that they are done here, and where to look when something later goes wrong.
 */
describe('the startup banner', () => {
  test('names the version, says the connector is up, and points at the log file', async () => {
    const { daemon } = await startDaemon(['token']);

    assert.match(
      daemon.output(),
      new RegExp(`agent-engine v${literal(PACKAGE_VERSION)} is running`),
    );
    assert.match(daemon.output(), /The connector is running — go back to the app\./);
    assert.match(daemon.output(), new RegExp(`Logs: \\s*${literal(logPath(home))}`));
  });

  test('the banner itself is in the log file, so a closed terminal loses nothing', async () => {
    const { daemon, port } = await startDaemon(['logged-token']);

    const logged = readFileSync(logPath(home), 'utf8');
    assert.match(logged, /Token: logged-token/, 'the run is recorded');
    assert.match(logged, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z /m, 'each line is stamped');
    assert.equal((await ping(port, 'logged-token')).authorized, true, 'and the daemon still runs');
    assert.match(daemon.output(), /Token: logged-token/, 'the console still gets it too');
  });
});

describe('the token the daemon listens with', () => {
  test('is the one passed as an argument, and it is printed for the user to copy', async () => {
    const { daemon, port } = await startDaemon(['argv-token']);

    assert.match(daemon.output(), /Token: argv-token/);
    assert.match(daemon.output(), new RegExp(`URL: \\s*http://127\\.0\\.0\\.1:${port}`));
    assert.equal((await ping(port, 'argv-token')).authorized, true);
    assert.equal((await ping(port)).authorized, false, '/ping answers without a token too');
  });

  test('falls back to AGENT_ENGINE_TOKEN when no argument is given', async () => {
    const { daemon, port } = await startDaemon([], { AGENT_ENGINE_TOKEN: 'env-token' });

    assert.match(daemon.output(), /Token: env-token/);
    assert.equal((await ping(port, 'env-token')).authorized, true);
  });

  /** Nobody should have to invent one: an omitted token is generated and shown. */
  test('is generated and printed when neither was supplied', async () => {
    const { daemon, port } = await startDaemon();

    const token = /Token: (\S+)/.exec(daemon.output())?.[1];
    assert.ok(token, 'a token was printed');
    assert.match(token, /^[0-9a-f-]{36}$/, 'it is a uuid, not an empty string');
    assert.equal((await ping(port, token)).authorized, true);
  });
});

describe('PORT validation', () => {
  for (const [label, port] of [
    ['not a number', 'abc'],
    ['out of range', '70000'],
    ['zero', '0'],
  ] as const) {
    test(`refuses a port that is ${label} instead of listening on a surprise one`, async () => {
      const daemon = spawnCli(['token'], { PORT: port });

      assert.equal(await daemon.exited, 1);
      assert.match(daemon.output(), new RegExp(`Invalid PORT: ${port}`));
    });
  }
});

/**
 * The regression the whole shutdown path exists for. `Server.close()` alone never
 * finishes here — it waits for open connections and an SSE stream has no reason
 * to end — so Ctrl+C used to hang the daemon forever, leaving its containers and
 * MCP subprocesses running with no way out but `kill -9`.
 */
describe('shutdown', () => {
  /**
   * Windows has no signals. `child.kill()` there is `TerminateProcess`, which
   * ends the daemon without running a handler at all — so there is no cleanup to
   * assert, which is precisely why the daemon offers `POST /shutdown` as well.
   * `server.test.ts` covers that route, and therefore the same intent, on every
   * platform.
   */
  const posixOnly = {
    skip: process.platform === 'win32' ? 'signals do not reach a process on Windows' : false,
  };

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    test(`${signal} stops the daemon instead of hanging it`, posixOnly, async () => {
      const { daemon } = await startDaemon(['token']);

      daemon.child.kill(signal);

      const code = await Promise.race([
        daemon.exited,
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 15_000)),
      ]);
      assert.equal(code, 0, `${signal} must end the process cleanly`);
      assert.match(daemon.output(), /Stopping — ending open streams and containers…/);
    });
  }

  test('the port is released, so the daemon can be restarted right away', async () => {
    const { daemon, port } = await startDaemon(['token']);
    daemon.child.kill('SIGTERM');
    await daemon.exited;

    const restarted = spawnCli(['token'], { PORT: String(port) });
    await restarted.waitFor(/agent-engine v\S+ is running/);
    assert.equal((await ping(port, 'token')).authorized, true);
  });
});
