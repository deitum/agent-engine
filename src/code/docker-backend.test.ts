import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { dockerExec, envArgs, makeDockerBackend } from './docker-backend';
import { createPlanGuard } from './plan-mode';

/**
 * A `docker` stand-in that runs the command it was handed locally.
 *
 * `dockerExec` spawns `docker` off `PATH`, so putting a script there is the only
 * way to exercise the real code path — the output cap, the timeout kill and the
 * abort handling all live in the parent process and are what these tests are
 * about. `docker exec … sh -lc <command>` puts the command last.
 */
const FAKE_DOCKER = `#!/bin/sh
for last do :; done
exec sh -c "$last"
`;

/**
 * The stand-in cannot exist on Windows, so everything that needs it is skipped
 * there.
 *
 * A shebang script is not executable, and the two spellings that would be —
 * `.cmd` and `.bat` — are refused by `child_process.spawn` unless it is given a
 * shell, which `dockerExec` deliberately does not do (CVE-2024-27980). Without a
 * fake on `PATH` a runner that has Docker installed answers with its *real*
 * daemon, which is worse than not running at all.
 *
 * No coverage of platform-independent behaviour is lost: the timeout, the output
 * ceiling and the environment handling all live in the parent process and are
 * exercised against a real binary, on every platform, in `process.test.ts`.
 */
const needsPosixShell = {
  skip:
    process.platform === 'win32'
      ? 'the Docker CLI cannot be faked on PATH on Windows — see process.test.ts'
      : false,
};

let binDir: string;
let originalPath: string | undefined;

before(async () => {
  binDir = await mkdtemp(join(tmpdir(), 'engine-fake-docker-'));
  const script = join(binDir, 'docker');
  await writeFile(script, FAKE_DOCKER, 'utf8');
  await chmod(script, 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${delimiter}${originalPath ?? ''}`;
});

after(async () => {
  process.env.PATH = originalPath;
  await rm(binDir, { recursive: true, force: true });
});

describe('envArgs', () => {
  test('renders one -e per variable', () => {
    assert.deepEqual(
      envArgs([
        { key: 'A', value: '1' },
        { key: 'B', value: 'x y' },
      ]),
      ['-e', 'A=1', '-e', 'B=x y'],
    );
  });

  test('is empty for no variables', () => {
    assert.deepEqual(envArgs(undefined), []);
    assert.deepEqual(envArgs([]), []);
  });
});

describe('dockerExec', () => {
  test('returns the command output and its exit code', needsPosixShell, async () => {
    const result = await dockerExec('container', 'echo hello');
    assert.equal(result.output.trim(), 'hello');
    assert.equal(result.exitCode, 0);
    assert.equal(result.truncated, false);
  });

  test('reports a non-zero exit instead of throwing', needsPosixShell, async () => {
    const result = await dockerExec('container', 'echo boom >&2; exit 3');
    assert.equal(result.exitCode, 3);
    assert.match(result.output, /boom/, 'stderr is merged into the output');
  });

  /** A build that floods stdout must not be able to exhaust the daemon's memory. */
  test('caps the output and flags it as truncated', needsPosixShell, async () => {
    const result = await dockerExec('container', 'head -c 400000 /dev/zero | tr "\\0" "x"');
    assert.equal(result.truncated, true);
    assert.ok(result.output.length <= 250_000, `output was ${result.output.length} bytes`);
  });

  test('a timeout kills the command and says so', needsPosixShell, async () => {
    const started = Date.now();
    const result = await dockerExec('container', 'sleep 30', { timeoutSec: 1 });
    assert.ok(Date.now() - started < 10_000, 'the call returned promptly');
    assert.match(result.output, /timeout/);
    assert.equal(result.truncated, true);
  });

  /**
   * Stop has to reach the process, and an aborted run reports `null` rather
   * than a real exit code — the caller renders that as «interrupted», not a failure.
   */
  test('an abort stops the command and yields a null exit code', needsPosixShell, async () => {
    const controller = new AbortController();
    const pending = dockerExec('container', 'sleep 30', { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);

    const result = await pending;
    assert.equal(result.exitCode, null);
    assert.match(result.output, /stopped by the user/);
  });

  test('a signal already aborted never starts the command', async () => {
    const result = await dockerExec('container', 'echo should-not-run', {
      signal: AbortSignal.abort(),
    });
    assert.equal(result.exitCode, null);
  });
});

/** The slice of the built backend these tests drive. */
interface GuardedBackend {
  write(filePath: string, content: string): Promise<{ error?: string; path?: string }>;
  edit(filePath: string, oldString: string, newString: string): Promise<{ error?: string }>;
  delete(filePath: string): Promise<{ error?: string }>;
  execute(command: string): Promise<{ output: string; exitCode: number | null }>;
}

/**
 * A `FilesystemBackend` stand-in that records what got through to it. What the
 * guard tests are really asserting is this list staying empty: a refusal that
 * still wrote the file would look identical from the return value alone.
 */
function fakeFilesystemBackend(): { Base: unknown; reached: string[] } {
  const reached: string[] = [];
  class Fake {
    async write(filePath: string): Promise<{ path: string }> {
      reached.push(`write ${filePath}`);
      return { path: filePath };
    }
    async edit(filePath: string): Promise<{ path: string }> {
      reached.push(`edit ${filePath}`);
      return { path: filePath };
    }
    async delete(filePath: string): Promise<{ path: string }> {
      reached.push(`delete ${filePath}`);
      return { path: filePath };
    }
  }
  return { Base: Fake, reached };
}

describe('makeDockerBackend under a plan-mode guard', () => {
  /** Builds the backend over a fresh fake, with or without a guard. */
  function build(guard?: ReturnType<typeof createPlanGuard>) {
    const { Base, reached } = fakeFilesystemBackend();
    const backend = makeDockerBackend(Base, {
      rootDir: '/workspace',
      containerName: 'container',
      ...(guard ? { guard } : {}),
    }) as unknown as GuardedBackend;
    return { backend, reached };
  }

  test('refuses every write, and none of them reaches the filesystem', async () => {
    const { backend, reached } = build(createPlanGuard(true));

    const written = await backend.write('/workspace/src/app.ts', 'x');
    const edited = await backend.edit('/workspace/src/app.ts', 'a', 'b');
    const deleted = await backend.delete('/workspace/src/app.ts');

    for (const result of [written, edited, deleted]) {
      assert.match(result.error ?? '', /plan mode/);
    }
    assert.deepEqual(reached, [], 'nothing may reach the filesystem while planning');
  });

  test('refuses a mutating command as a failed run rather than a thrown error', async () => {
    const { backend } = build(createPlanGuard(true));

    const result = await backend.execute('npm install');

    assert.equal(result.exitCode, 1);
    assert.match(result.output, /plan mode/);
    // The refusal, not the container's output — proof it never got that far.
    assert.ok(!result.output.includes('added'), 'the command must not have run');
  });

  test('lets a read-only command through to the container', needsPosixShell, async () => {
    const { backend } = build(createPlanGuard(true));

    const result = await backend.execute('echo hello');

    assert.equal(result.exitCode, 0);
    assert.equal(result.output.trim(), 'hello');
  });

  test('approving the plan unlocks the same backend, mid-turn', needsPosixShell, async () => {
    const guard = createPlanGuard(true);
    const { backend, reached } = build(guard);

    assert.match((await backend.write('/workspace/a.ts', 'x')).error ?? '', /plan mode/);

    guard.release();

    const after = await backend.write('/workspace/a.ts', 'x');
    assert.equal(after.error, undefined);
    assert.equal((await backend.execute('npm install')).exitCode, 0);
    assert.deepEqual(reached, ['write /workspace/a.ts']);
  });

  test('without a guard nothing is blocked at all', needsPosixShell, async () => {
    const { backend, reached } = build();

    assert.equal((await backend.write('/workspace/a.ts', 'x')).error, undefined);
    assert.equal((await backend.execute('echo ok')).exitCode, 0);
    assert.deepEqual(reached, ['write /workspace/a.ts']);
  });
});
