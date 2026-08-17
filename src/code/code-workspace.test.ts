import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { promisify } from 'node:util';

import { resetEngineConfig, useEngineConfig } from '../config/engine-config';
import { LOCAL_DIR, LOCAL_SKILLS_DIR, OPENSPEC_DIR, SESSION_MEMORY_PATH } from '../contracts';
import { materializeSkills } from '../deep-agent';

import { writeNotesFile } from './code-memory';
import { CodeWorkspaces, normalizeEnv } from './code-workspace';
import { initOpenspec } from './openspec/openspec-store';
import { defaultRunner, type ProcessRunner, type RunResult } from './process';

const execFileAsync = promisify(execFile);

/** The Bitbucket coordinates the tests clone from; rewritten to a local path. */
const REPO = { baseUrl: 'https://git.example.test', owner: 'PRJ', repo: 'service' };
const CLONE_URL = 'https://git.example.test/scm/PRJ/service.git';
const CREDENTIALS = { username: 'tester', token: 'secret-token' };
/** The host's DNS search domains, as the fixture's containers should receive them. */
const SEARCH_DOMAINS = ['corp.example.test', 'example.test'];

/** Runs git for the fixtures, with an identity so commits work on a bare CI box. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@agent-engine.local', ...args],
    { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
  );
  return stdout;
}

/**
 * A stand-in for the Docker CLI.
 *
 * `CodeWorkspaces` shells out to `docker` for the container half of its job, and
 * a test that needed a real daemon would not run in CI. The fake answers the
 * handful of subcommands the class actually uses and records `docker run`, which
 * is how the container-shape assertions are made.
 */
class FakeDocker {
  readonly runs: string[][] = [];
  readonly pulled: string[] = [];
  /** Container names passed to `docker rm`, in order. */
  readonly removed: string[] = [];
  private readonly containers = new Map<string, { image: string; running: boolean }>();

  handle(args: string[]): RunResult {
    const [command, ...rest] = args;
    switch (command) {
      case 'version':
        return { stdout: '27.0.0', stderr: '' };

      case 'image':
        // `image inspect` — nothing is cached, so the pull path is exercised.
        throw new Error(`No such image: ${rest[1]}`);

      case 'pull':
        this.pulled.push(rest[0]);
        return { stdout: '', stderr: '' };

      case 'inspect': {
        const name = rest[rest.length - 1];
        const container = this.containers.get(name);
        if (!container) {
          throw new Error(`No such object: ${name}`);
        }
        return { stdout: `${container.image}\t${String(container.running)}\n`, stderr: '' };
      }

      case 'run': {
        this.runs.push(args);
        const name = rest[rest.indexOf('--name') + 1];
        // The image is the argument before the `sleep infinity` command.
        const image = args[args.length - 3];
        this.containers.set(name, { image, running: true });
        return { stdout: `${name}\n`, stderr: '' };
      }

      case 'start': {
        const existing = this.containers.get(rest[0]);
        if (existing) {
          existing.running = true;
        }
        return { stdout: '', stderr: '' };
      }

      case 'stop': {
        const existing = this.containers.get(rest[rest.length - 1]);
        if (existing) {
          existing.running = false;
        }
        return { stdout: '', stderr: '' };
      }

      case 'rm':
        this.removed.push(rest[rest.length - 1]);
        this.containers.delete(rest[rest.length - 1]);
        return { stdout: '', stderr: '' };

      case 'exec':
        return { stdout: '', stderr: '' };

      default:
        throw new Error(`fake docker: unhandled «${command}»`);
    }
  }
}

/**
 * Runs real `git` and fake `docker`.
 *
 * The clone URL is rewritten to the local bare repository, which is the one
 * thing a test cannot exercise for real — everything downstream (the branch the
 * clone lands on, the remote it records, the diffs) is genuine git behaviour.
 */
function testRunner(docker: FakeDocker, remote: string): ProcessRunner {
  return {
    run(command, args, options) {
      if (command === 'docker') {
        return Promise.resolve(docker.handle(args));
      }
      if (command === 'git') {
        return defaultRunner.run(
          command,
          args.map((arg) => (arg === CLONE_URL ? `file://${remote}` : arg)),
          options,
        );
      }
      return defaultRunner.run(command, args, options);
    },
  };
}

interface Fixture {
  root: string;
  remote: string;
  docker: FakeDocker;
  workspaces: CodeWorkspaces;
  /** The checkout `prepare` produces for `sessionId`. */
  checkout: (sessionId: string) => string;
}

let fixture: Fixture;
let scratch: string;

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'agent-engine-code-test-'));

  // A bare "origin" with one commit on `main`.
  const remote = join(scratch, 'remote.git');
  const seed = join(scratch, 'seed');
  await execFileAsync('git', ['init', '--bare', '--initial-branch=main', remote]);
  await mkdir(seed, { recursive: true });
  await execFileAsync('git', ['init', '--initial-branch=main', seed]);
  await writeFile(join(seed, 'README.md'), '# service\n', 'utf8');
  await writeFile(
    join(seed, 'package.json'),
    '{"name":"service","engines":{"node":"20"}}\n',
    'utf8',
  );
  await git(seed, 'add', '-A');
  await git(seed, 'commit', '-m', 'init');
  await git(seed, 'remote', 'add', 'origin', remote);
  await git(seed, 'push', '-u', 'origin', 'main');

  const root = join(scratch, 'workspaces');
  const docker = new FakeDocker();
  fixture = {
    root,
    remote,
    docker,
    workspaces: new CodeWorkspaces({
      runner: testRunner(docker, remote),
      root,
      cacheRoot: join(scratch, 'cache'),
      // Injected so the suite does not depend on the resolver configuration of
      // whatever machine it runs on (the real detector shells out to `scutil`).
      dnsSearch: async () => SEARCH_DOMAINS,
    }),
    checkout: (sessionId) => join(root, sessionId, 'repo'),
  };

  // The credentials a clone uses come from the connection handshake now, so the
  // suite hands the daemon the same bundle the browser would have pushed.
  useEngineConfig(
    {
      version: 'v1',
      llm: { apiKey: 'sk-test' },
      repos: [CREDENTIALS],
    },
    'https://gateway.corp/v1',
  );
});

after(async () => {
  await fixture.workspaces.shutdown();
  resetEngineConfig();
  await rm(scratch, { recursive: true, force: true });
});

describe('normalizeEnv', () => {
  test('drops blanks and duplicates, keeping the first value', () => {
    assert.deepEqual(
      normalizeEnv([
        { key: ' TOKEN ', value: 'a' },
        { key: 'TOKEN', value: 'b' },
        { key: '', value: 'c' },
      ]),
      [{ key: 'TOKEN', value: 'a' }],
    );
  });

  test('refuses a key that could not be a shell variable', () => {
    assert.throws(
      () => normalizeEnv([{ key: 'BAD-KEY', value: 'x' }]),
      /Invalid environment variable name/,
    );
  });
});

describe('CodeWorkspaces.prepare', () => {
  test('clones, records the base branch and checks out a work branch', async () => {
    const status = await fixture.workspaces.prepare({
      sessionId: 'alpha',
      repo: REPO,
    });

    assert.equal(status.cloned, true);
    assert.equal(status.baseBranch, 'main');
    assert.equal(status.branch, 'agent/alpha');
    assert.equal(
      status.busy,
      false,
      'the call that returns the status must not report itself busy',
    );
    assert.equal(status.toolchain, 'node', 'package.json + engines.node is a Node checkout');
    assert.equal(status.containerRunning, true);
  });

  /**
   * `git` runs on the host, the build runs in a Linux container, and they share
   * one bind mount. A Git-for-Windows default of `core.autocrlf=true` would put
   * CRLF in the working tree, and every shebang script the container executes —
   * `./gradlew`, `./mvnw` — would die with `bad interpreter: /bin/sh^M`.
   * Pinning it locally is what survives the next host-side `checkout`.
   */
  test('pins the checkout to LF line endings', async () => {
    const dir = fixture.checkout('alpha');
    assert.equal((await git(dir, 'config', '--local', '--get', 'core.autocrlf')).trim(), 'false');
    assert.equal((await git(dir, 'config', '--local', '--get', 'core.eol')).trim(), 'lf');
  });

  test('does not force core.symlinks, which needs privileges we may not have', async () => {
    const dir = fixture.checkout('alpha');
    await assert.rejects(() => git(dir, 'config', '--local', '--get', 'core.symlinks'));
  });

  test('re-preparing an existing session leaves the pinned config in place', async () => {
    const dir = fixture.checkout('alpha');
    await git(dir, 'config', '--local', 'core.autocrlf', 'true');

    await fixture.workspaces.prepare({
      sessionId: 'alpha',
      repo: REPO,
    });

    assert.equal((await git(dir, 'config', '--local', '--get', 'core.autocrlf')).trim(), 'false');
  });

  /**
   * Repairing line endings means re-materialising the working tree, and that is
   * only safe when there is nothing in it to lose. A checkout with uncommitted
   * work keeps its changes and its old line endings — the user's turn is worth
   * more than the fix.
   */
  test('never renormalises over uncommitted work', async () => {
    const dir = fixture.checkout('alpha');
    await git(dir, 'config', '--local', 'core.autocrlf', 'true');
    await writeFile(join(dir, 'WIP.md'), 'do not lose\n', 'utf8');
    await writeFile(join(dir, 'README.md'), '# changed\n', 'utf8');

    await fixture.workspaces.prepare({
      sessionId: 'alpha',
      repo: REPO,
    });

    assert.equal(await readFile(join(dir, 'WIP.md'), 'utf8'), 'do not lose\n');
    assert.equal(await readFile(join(dir, 'README.md'), 'utf8'), '# changed\n');

    // Clean up, so the shared fixture's later tests see the tree they expect.
    await rm(join(dir, 'WIP.md'), { force: true });
    await git(dir, 'checkout', '--', 'README.md');
  });

  test('creates the container with the requested resource limits', () => {
    const [run] = fixture.docker.runs;
    assert.ok(run, 'a container should have been created');
    assert.ok(run.includes('--memory'), 'memory limit is applied');
    assert.ok(run.includes('--pids-limit'), 'pid limit is applied');
    assert.ok(
      run.some((arg) => arg.endsWith(':/workspace')),
      'the checkout is bind-mounted at /workspace',
    );
  });

  /**
   * Without the host's search domains a container resolves `binary.corp.example`
   * but not the bare `binary` a repository's `.npmrc` actually names — and the
   * agent then "fixes" the repository instead of reporting the network.
   */
  test('hands the container the host DNS search domains', () => {
    const [run] = fixture.docker.runs;
    for (const domain of SEARCH_DOMAINS) {
      assert.ok(
        run.some((arg, index) => arg === '--dns-search' && run[index + 1] === domain),
        `«${domain}» is passed to docker run`,
      );
    }
  });

  test('a sandbox cut off from the network gets no search domains', async () => {
    await fixture.workspaces.prepare({
      sessionId: 'offline',
      repo: REPO,
      limits: { network: 'none' },
    });
    const run = fixture.docker.runs.find((args) => args.includes('--network'));
    assert.ok(run, 'the offline session should have created a container');
    assert.ok(!run.includes('--dns-search'), 'there is no DNS to search with --network none');
  });

  /**
   * The regression this suite exists for. The base branch is captured from the
   * freshly cloned HEAD and never derived again — derive it later and it yields
   * the *work* branch, which would make `/pr` open a pull request against itself.
   */
  test('re-preparing does not re-derive the base branch from the work branch', async () => {
    const again = await fixture.workspaces.prepare({
      sessionId: 'alpha',
      repo: REPO,
    });
    assert.equal(again.baseBranch, 'main');
    assert.equal(again.branch, 'agent/alpha');
  });

  test('the checkout keeps no credentials in its remote', async () => {
    const config = await readFile(join(fixture.checkout('alpha'), '.git', 'config'), 'utf8');
    assert.ok(!config.includes(CREDENTIALS.token), 'the token must never reach .git/config');
  });

  test('mounts the shared dependency cache and points the package managers at it', () => {
    const [run] = fixture.docker.runs;
    assert.ok(
      run.some((arg) => arg.endsWith(':/cache')),
      'the shared cache is bind-mounted at /cache',
    );
    assert.ok(run.includes('NPM_CONFIG_CACHE=/cache/npm'), 'npm writes into the shared cache');
    assert.ok(run.includes('GRADLE_USER_HOME=/cache/gradle'), 'so does Gradle');
  });

  test('excludes what the connector writes into the checkout from git, idempotently', async () => {
    const excludePath = join(fixture.checkout('alpha'), '.git', 'info', 'exclude');
    const lines = (await readFile(excludePath, 'utf8')).split('\n').map((line) => line.trim());
    for (const entry of [
      '.agent-engine-skills/',
      '.agent-engine/',
      'large_tool_results/',
      'node_modules/',
    ]) {
      assert.equal(
        lines.filter((line) => line === entry).length,
        1,
        `«${entry}» is excluded exactly once, however many times prepare ran`,
      );
    }
  });

  /**
   * The exclusion list and the code that writes into a checkout are two separate
   * places, and they have disagreed before — a rename landed on the entries but
   * not on the writers, so the agent's own scratch directories showed up in the
   * diff panel and, because `/commit` stages with `git add -A`, in the user's
   * pull request.
   *
   * So this asserts the loop rather than the list: run the real writers, then ask
   * git. A literal path here would have passed throughout the bug.
   */
  test('nothing the engine writes into the checkout reaches git status', async () => {
    const dir = fixture.checkout('alpha');

    await writeNotesFile(dir, '# notes');
    await initOpenspec(dir);
    materializeSkills(
      dir,
      [
        {
          id: 'alpha',
          name: 'alpha',
          description: 'description',
          instructions: '# alpha',
          files: [{ path: 'refs/notes.md', content: 'notes' }],
        },
      ],
      LOCAL_SKILLS_DIR,
    );
    // The summarizer's offloaded history, and the one path deepagents hard-codes.
    await mkdir(join(dir, LOCAL_DIR, 'history'), { recursive: true });
    await writeFile(join(dir, LOCAL_DIR, 'history', 'turn-1.md'), 'compacted', 'utf8');
    await mkdir(join(dir, 'large_tool_results'), { recursive: true });
    await writeFile(join(dir, 'large_tool_results', 'call-1.txt'), 'evicted', 'utf8');

    assert.ok(existsSync(join(dir, SESSION_MEMORY_PATH)), 'the notes file was actually written');
    assert.ok(existsSync(join(dir, OPENSPEC_DIR)), 'and so was the OpenSpec tree');
    assert.ok(existsSync(join(dir, LOCAL_SKILLS_DIR)), 'and the skills');

    assert.equal(
      (await git(dir, 'status', '--porcelain')).trim(),
      '',
      'every path the engine writes into a checkout is excluded from git',
    );
  });

  test('a workspace that never bootstrapped reports the install as pending', async () => {
    const setup = await fixture.workspaces.setup('alpha');
    assert.equal(setup.install, 'pending');
    assert.equal(setup.memory, 'none');
    assert.equal(setup.ranAt, undefined, 'ranAt is what tells the UI to start the step');
  });

  test('re-preparing an existing checkout keeps its bootstrap state', async () => {
    await fixture.workspaces.setSetup('alpha', {
      install: 'ok',
      installCommand: 'npm ci',
      fingerprint: 'abc',
      memory: 'generated',
      ranAt: 42,
    });
    const status = await fixture.workspaces.prepare({
      sessionId: 'alpha',
      repo: REPO,
    });
    assert.equal(status.setup.install, 'ok', 'applying an image must not re-install dependencies');
    assert.equal(status.setup.fingerprint, 'abc');
    assert.equal(status.setup.memory, 'generated');
  });

  test('a checkout cloned from scratch starts over', async () => {
    // The recovery path: the workspace metadata survives, the repository does not.
    await rm(fixture.checkout('alpha'), { recursive: true, force: true });
    const status = await fixture.workspaces.prepare({
      sessionId: 'alpha',
      repo: REPO,
    });
    assert.equal(status.setup.install, 'pending', 'a fresh checkout has no dependencies');
    assert.equal(status.setup.ranAt, undefined);
  });

  test('writes versioned metadata that parses', async () => {
    const raw = await readFile(join(fixture.root, 'alpha', 'workspace.json'), 'utf8');
    const meta = JSON.parse(raw) as { version: number; baseBranch: string; sessionId: string };
    assert.equal(meta.version, 1);
    assert.equal(meta.baseBranch, 'main');
    assert.equal(meta.sessionId, 'alpha');
  });
});

describe('CodeWorkspaces.status', () => {
  test('counts ahead against the base branch when there is no upstream yet', async () => {
    const dir = fixture.checkout('alpha');
    await writeFile(join(dir, 'feature.ts'), 'export const x = 1;\n', 'utf8');
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-m', 'feat: add x');

    const status = await fixture.workspaces.status('alpha');
    assert.equal(status.ahead, 1, 'one commit on top of the base branch');
    assert.equal(status.behind, 0);
  });

  test('reports working-tree changes', async () => {
    await writeFile(join(fixture.checkout('alpha'), 'README.md'), '# service\nchanged\n', 'utf8');
    const status = await fixture.workspaces.status('alpha');
    assert.ok(
      status.files.some((file) => file.path === 'README.md'),
      'a modified tracked file shows up in the status',
    );
  });
});

describe('CodeWorkspaces.diff', () => {
  /**
   * Untracked files are made visible by adding them `--intent-to-add` into a
   * throw-away copy of the index. If that copy ever stopped being a copy, the
   * user's own staging area would be silently rewritten by opening a diff panel.
   */
  test('includes untracked files without touching the real index', async () => {
    const dir = fixture.checkout('alpha');
    const indexPath = join(dir, '.git', 'index');
    await writeFile(join(dir, 'brand new.ts'), 'export const fresh = true;\n', 'utf8');
    const before = await readFile(indexPath);

    const diff = await fixture.workspaces.diff('alpha');
    const after = await readFile(indexPath);

    const added = diff.files.find((file) => file.path === 'brand new.ts');
    assert.ok(added, 'an untracked file with a space in its name is in the diff');
    assert.equal(added.untracked, true);
    assert.ok(before.equals(after), 'the real .git/index must be byte-identical afterwards');
  });

  test('survives non-ASCII paths', async () => {
    const dir = fixture.checkout('alpha');
    await writeFile(join(dir, 'documentación.md'), '# Hello\n', 'utf8');
    const diff = await fixture.workspaces.diff('alpha');
    assert.ok(
      diff.files.some((file) => file.path === 'documentación.md'),
      'a Cyrillic path survives the NUL-delimited parsing',
    );
  });

  test('branch mode compares against the base branch', async () => {
    const diff = await fixture.workspaces.diff('alpha', 'branch');
    assert.equal(diff.mode, 'branch');
    assert.ok(
      diff.files.some((file) => file.path === 'feature.ts'),
      'a file committed on the work branch is part of the branch diff',
    );
  });
});

describe('CodeWorkspaces locking', () => {
  test('a second operation on a held session is refused with 409', async () => {
    await fixture.workspaces.acquire('alpha');
    try {
      await assert.rejects(
        () => fixture.workspaces.prepare({ sessionId: 'alpha', repo: REPO }),
        (error: unknown) => (error as { status?: number }).status === 409,
        'a re-clone must not run while a turn holds the session',
      );
      assert.equal((await fixture.workspaces.status('alpha')).busy, true);
    } finally {
      fixture.workspaces.release('alpha');
    }
    assert.equal((await fixture.workspaces.status('alpha')).busy, false);
  });
});

describe('CodeWorkspaces metadata recovery', () => {
  /**
   * A `workspace.json` that will not parse used to mean the session was reported
   * missing for good, stranding the user's uncommitted work behind a button that
   * offers to re-clone over it. The checkout knows its own remote, so the
   * metadata is rebuilt from it instead.
   */
  test('rebuilds metadata from the checkout when the file is corrupt', async () => {
    const dir = fixture.checkout('alpha');
    // A real checkout's origin is the Bitbucket URL; ours was rewritten to a
    // local path when cloning, so restore the shape recovery has to read.
    await git(dir, 'remote', 'set-url', 'origin', CLONE_URL);
    await writeFile(join(fixture.root, 'alpha', 'workspace.json'), '{ truncated', 'utf8');

    const revived = new CodeWorkspaces({
      runner: testRunner(fixture.docker, fixture.remote),
      root: fixture.root,
    });
    try {
      const status = await revived.status('alpha');
      assert.equal(status.baseBranch, 'main');
      assert.equal(status.branch, 'agent/alpha');

      const rewritten = JSON.parse(
        await readFile(join(fixture.root, 'alpha', 'workspace.json'), 'utf8'),
      ) as { version: number; repo: typeof REPO };
      assert.equal(rewritten.version, 1, 'the recovered snapshot is persisted');
      assert.deepEqual(
        rewritten.repo,
        { provider: 'bitbucket-server', ...REPO },
        'the repo is read back off the origin remote, provider and all',
      );
    } finally {
      await revived.shutdown();
    }
  });

  test('a session with no checkout at all is a 404', async () => {
    await assert.rejects(
      () => fixture.workspaces.status('never-prepared'),
      (error: unknown) => (error as { status?: number }).status === 404,
    );
  });
});

// ─── operations on a prepared checkout ────────────────────────────────────────

/** Prepares `sessionId` once and hands back its checkout path. */
async function prepared(sessionId: string): Promise<string> {
  await fixture.workspaces.prepare({ sessionId, repo: REPO });
  return fixture.checkout(sessionId);
}

/** The persisted metadata of a session, as `workspace.json` holds it. */
async function meta(sessionId: string): Promise<{ workBranch: string; env: { key: string }[] }> {
  const raw = await readFile(join(fixture.root, sessionId, 'workspace.json'), 'utf8');
  return JSON.parse(raw) as { workBranch: string; env: { key: string }[] };
}

describe('CodeWorkspaces branches', () => {
  test('creating a branch switches to it and remembers it', async () => {
    const dir = await prepared('beta');

    const branch = await fixture.workspaces.createBranch('beta', ' feat/api ');

    assert.equal(branch, 'feat/api');
    assert.equal((await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).trim(), 'feat/api');
    assert.equal((await meta('beta')).workBranch, 'feat/api', 'a restart must resume on it');
  });

  test('checking out an existing branch also updates the remembered one', async () => {
    const dir = await prepared('beta');

    const branch = await fixture.workspaces.checkout('beta', 'agent/beta');

    assert.equal(branch, 'agent/beta');
    assert.equal((await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).trim(), 'agent/beta');
    assert.equal((await meta('beta')).workBranch, 'agent/beta');
  });

  /**
   * The name comes from a chat message and lands on a git command line, so a
   * value that looks like an option (or walks out of the repo) is refused before
   * git ever sees it.
   */
  for (const name of ['--upload-pack=touch /tmp/pwn', '../escape', '-x', '']) {
    test(`refuses «${name}» as a branch name`, async () => {
      await prepared('beta');
      await assert.rejects(
        () => fixture.workspaces.createBranch('beta', name),
        (error: unknown) => {
          assert.equal((error as { status?: number }).status, 400);
          assert.match((error as Error).message, /Invalid branch name/);
          return true;
        },
      );
    });
  }
});

describe('CodeWorkspaces commit', () => {
  test('a clean tree is reported, not thrown', async () => {
    await prepared('gamma');

    assert.match(await fixture.workspaces.commit('gamma', 'nothing'), /Nothing to commit/);
  });

  test('stages everything, untracked files included, under a default message', async () => {
    const dir = await prepared('gamma');
    await writeFile(join(dir, 'fresh.ts'), 'export const fresh = 1;\n', 'utf8');
    await writeFile(join(dir, 'README.md'), '# service\nchanged\n', 'utf8');

    const summary = await fixture.workspaces.commit('gamma', '   ');

    assert.match(summary, /2 files changed/);
    assert.equal(
      (await git(dir, 'log', '-1', '--pretty=%s')).trim(),
      'Changes (agent-engine)',
      'an empty message still produces a usable commit subject',
    );
    assert.equal((await git(dir, 'status', '--porcelain')).trim(), '');
  });
});

describe('CodeWorkspaces push', () => {
  /**
   * The checkout's `origin` deliberately holds no token, so the credentials ride
   * along on the single invocation as a header. If they ever reached
   * `.git/config` instead, every later command would leak them.
   */
  test('pushes the branch upstream without writing the token anywhere', async () => {
    const dir = await prepared('delta');
    await writeFile(join(dir, 'feature.ts'), 'export const x = 1;\n', 'utf8');
    await fixture.workspaces.commit('delta', 'feat: x');

    const branch = await fixture.workspaces.push('delta', CREDENTIALS);

    assert.equal(branch, 'agent/delta');
    assert.equal(
      (await git(dir, 'rev-parse', '--abbrev-ref', 'agent/delta@{upstream}')).trim(),
      'origin/agent/delta',
    );
    const config = await readFile(join(dir, '.git', 'config'), 'utf8');
    assert.ok(!config.includes(CREDENTIALS.token));
  });

  test('once there is an upstream the counters come from it', async () => {
    const status = await fixture.workspaces.status('delta');

    assert.equal(status.ahead, 0, 'everything on the branch has been pushed');
    assert.equal(status.behind, 0);
  });
});

describe('CodeWorkspaces revert', () => {
  test('restores a tracked file from HEAD', async () => {
    const dir = await prepared('epsilon');
    await writeFile(join(dir, 'README.md'), 'corrupted\n', 'utf8');

    const message = await fixture.workspaces.revert('epsilon', 'README.md');

    assert.match(message, /was restored from HEAD/);
    assert.equal(await readFile(join(dir, 'README.md'), 'utf8'), '# service\n');
  });

  /** `git checkout HEAD --` cannot restore a file that was never committed. */
  test('deletes a file git does not track', async () => {
    const dir = await prepared('epsilon');
    await writeFile(join(dir, 'scratch.txt'), 'temporary\n', 'utf8');

    const message = await fixture.workspaces.revert('epsilon', 'scratch.txt');

    assert.match(message, /git was not tracking it/);
    assert.equal(existsSync(join(dir, 'scratch.txt')), false);
  });

  test('refuses a path that walks out of the checkout', async () => {
    await prepared('epsilon');

    await assert.rejects(
      () => fixture.workspaces.revert('epsilon', '../../.ssh/id_rsa'),
      (error: unknown) => (error as { status?: number }).status === 400,
    );
  });
});

describe('CodeWorkspaces environment', () => {
  test('persists the normalised variables the browser sent', async () => {
    await prepared('zeta');

    await fixture.workspaces.setEnv('zeta', [
      { key: ' NPM_TOKEN ', value: 'a' },
      { key: 'NPM_TOKEN', value: 'b' },
      { key: '', value: 'c' },
    ]);

    assert.deepEqual((await fixture.workspaces.status('zeta')).envKeys, ['NPM_TOKEN']);
    assert.deepEqual(
      (await meta('zeta')).env,
      [{ key: 'NPM_TOKEN', value: 'a' }],
      'a rehydrated workspace keeps them',
    );
  });

  test('an omitted env leaves what was there alone', async () => {
    await fixture.workspaces.setEnv('zeta', undefined);

    assert.deepEqual((await fixture.workspaces.status('zeta')).envKeys, ['NPM_TOKEN']);
  });

  test('refuses a name that could not be a shell variable', async () => {
    await assert.rejects(
      () => fixture.workspaces.setEnv('zeta', [{ key: 'NOT-A-VAR', value: 'x' }]),
      (error: unknown) => (error as { status?: number }).status === 400,
    );
  });
});

describe('CodeWorkspaces list', () => {
  test('summarises every workspace on disk and ignores what is not one', async () => {
    await mkdir(join(fixture.root, 'stray-directory'), { recursive: true });

    const summaries = await fixture.workspaces.list();

    const zeta = summaries.find((summary) => summary.sessionId === 'zeta');
    assert.ok(zeta, 'a prepared session shows up');
    assert.deepEqual(zeta.repo, REPO);
    assert.equal(zeta.branch, 'agent/zeta');
    assert.ok((zeta.sizeBytes ?? 0) > 0, 'the checkout is measured for the settings screen');
    assert.ok(
      !summaries.some((summary) => summary.sessionId === 'stray-directory'),
      'a directory without workspace.json is not a session',
    );

    const updatedAt = summaries.map((summary) => summary.updatedAt);
    assert.deepEqual(
      updatedAt,
      [...updatedAt].sort((left, right) => right - left),
    );
  });
});

describe('CodeWorkspaces remove', () => {
  test('keeping the files drops only the container', async () => {
    await prepared('eta');

    await fixture.workspaces.remove('eta', true);

    assert.equal(existsSync(fixture.checkout('eta')), true, 'the user’s work survives');
  });

  test('otherwise the checkout goes with it', async () => {
    await prepared('theta');

    await fixture.workspaces.remove('theta');

    assert.equal(existsSync(join(fixture.root, 'theta')), false);
  });

  test('removing a session that was never prepared is not an error', async () => {
    await fixture.workspaces.remove('never-existed');
  });

  /**
   * A session's container is found by the name derived from its id. A workspace
   * prepared by an older build keeps its metadata on disk, so the session is
   * still listed and still removable — but under the prefix that build used. Miss
   * it and the container survives every `remove`, invisible until someone reads
   * `docker ps`.
   */
  test('a container named by an older build is removed along with the current one', async () => {
    await prepared('iota');

    await fixture.workspaces.remove('iota');

    assert.ok(
      fixture.docker.removed.some((name) => name === 'agent-engine-code-iota'),
      'the current name',
    );
    assert.ok(
      fixture.docker.removed.some((name) => name === 'aft-code-iota'),
      'and the legacy one',
    );
  });
});

describe('CodeWorkspaces diff', () => {
  /** A binary blob has no patch to show, and streaming one would be nonsense. */
  test('describes a binary file instead of trying to render it', async () => {
    const dir = await prepared('iota');
    await writeFile(join(dir, 'logo.png'), Buffer.from([0, 1, 2, 0, 255, 0, 3]));

    const diff = await fixture.workspaces.diff('iota');

    const binary = diff.files.find((file) => file.path === 'logo.png');
    assert.ok(binary);
    assert.equal(binary.added, null);
    assert.equal(binary.removed, null);
    assert.match(binary.patch, /Binary file logo\.png changed/);
  });
});
