import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  type CodeSetupEvent,
  type CodeSetupInfo,
  type CodeSetupRequest,
  type CodeWorkspaceStatus,
} from '../contracts';

import { GENERATED_MEMORY_FILE } from './code-memory';
import { runCodeSetup } from './code-setup';
import { type CodeWorkspaces } from './code-workspace';

const STATUS = { branch: 'agent/session' } as unknown as CodeWorkspaceStatus;

/** Creates a throw-away checkout holding `files` (relative path → content). */
function checkout(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'engine-setup-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  return dir;
}

interface Harness {
  workspaces: CodeWorkspaces;
  dir: string;
  events: CodeSetupEvent[];
  executed: string[];
  saved: CodeSetupInfo[];
}

/**
 * A stand-in workspace. The container and git halves are covered in
 * `code-workspace.test.ts`; what this suite asserts is the bootstrap's own
 * decisions — when it runs an install, when it refuses to, and where the project
 * memory comes from.
 */
function harness(options: {
  files?: Record<string, string>;
  setup?: Partial<CodeSetupInfo>;
  install?: string;
  network?: 'bridge' | 'none';
  exec?: (command: string) => { output: string; exitCode: number | null; truncated: boolean };
  /** How the stubbed language-server layer behaves. */
  lsp?: 'ready' | 'indexing' | 'unavailable' | 'off' | 'throws';
  /** Toolchain reported by the workspace; decides which server would be warmed. */
  toolchain?: 'node' | 'go';
}): Harness {
  const dir = checkout(options.files);
  const events: CodeSetupEvent[] = [];
  const executed: string[] = [];
  const saved: CodeSetupInfo[] = [];

  const workspaces = {
    setEnv: () => Promise.resolve(),
    backendInfo: () =>
      Promise.resolve({
        dir,
        containerName: 'agent-engine-code-session',
        toolchain: options.toolchain ?? 'node',
        detected: {
          toolchain: options.toolchain ?? 'node',
          image: 'node:22-bookworm',
          reason: 'package.json → Node 22, npm',
          commands: { ...(options.install ? { install: options.install } : {}) },
        },
        env: [],
        baseBranch: 'main',
      }),
    setup: () =>
      Promise.resolve<CodeSetupInfo>({ install: 'pending', memory: 'none', ...options.setup }),
    setSetup: (_id: string, info: CodeSetupInfo) => {
      saved.push(info);
      return Promise.resolve();
    },
    limits: () => Promise.resolve({ network: options.network ?? 'bridge' }),
    listFiles: () => Promise.resolve(Object.keys(options.files ?? {})),
    exec: (_id: string, command: string) => {
      executed.push(command);
      return Promise.resolve(
        options.exec?.(command) ?? { output: 'installed\n', exitCode: 0, truncated: false },
      );
    },
    status: () => Promise.resolve(STATUS),
    lsp: () =>
      options.lsp === 'throws'
        ? Promise.reject(new Error('Docker is not running'))
        : Promise.resolve({
            off: options.lsp === 'off',
            warm: (language: string) =>
              Promise.resolve(
                options.lsp === 'unavailable'
                  ? { language, state: 'unavailable', detail: 'the container image has no Node.js' }
                  : { language, state: options.lsp === 'indexing' ? 'indexing' : 'ready' },
              ),
          }),
  } as unknown as CodeWorkspaces;

  return { workspaces, dir, events, executed, saved };
}

function request(partial: Partial<CodeSetupRequest> = {}): CodeSetupRequest {
  return { sessionId: 'session', ...partial };
}

/** The states one phase went through, in order. */
function phases(events: CodeSetupEvent[], phase: 'install' | 'memory' | 'lsp'): string[] {
  return events
    .filter((event) => event.type === 'phase' && event.phase === phase)
    .map((event) => (event as { state: string }).state);
}

describe('install phase', () => {
  test('runs the detected command and records the lock-file fingerprint', async () => {
    const test_ = harness({
      files: { 'package.json': '{}', 'package-lock.json': '{"v":1}' },
      install: 'npm ci',
    });
    await runCodeSetup(
      test_.workspaces,
      request({ phases: ['install'] }),
      (event) => test_.events.push(event),
      new AbortController().signal,
    );

    assert.deepEqual(test_.executed, ['npm ci']);
    assert.deepEqual(phases(test_.events, 'install'), ['running', 'ok']);
    const [saved] = test_.saved;
    assert.equal(saved.install, 'ok');
    assert.ok(saved.fingerprint, 'a successful install remembers what it installed');
    assert.ok(saved.ranAt, 'ranAt is what stops the UI starting the step again');
  });

  test('skips an install whose lock files have not moved', async () => {
    const first = harness({
      files: { 'package.json': '{}', 'package-lock.json': '{"v":1}' },
      install: 'npm ci',
    });
    await runCodeSetup(
      first.workspaces,
      request({ phases: ['install'] }),
      () => undefined,
      new AbortController().signal,
    );
    const fingerprint = first.saved[0].fingerprint;

    // Same checkout, same lock file, now with the previous run's outcome.
    const again = harness({
      files: { 'package.json': '{}', 'package-lock.json': '{"v":1}' },
      install: 'npm ci',
      setup: { install: 'ok', fingerprint },
    });
    await runCodeSetup(
      again.workspaces,
      request({ phases: ['install'] }),
      (event) => again.events.push(event),
      new AbortController().signal,
    );

    assert.deepEqual(again.executed, [], 'nothing is re-installed');
    assert.deepEqual(phases(again.events, 'install'), ['skipped']);
  });

  test('…unless the user asked for it', async () => {
    const test_ = harness({
      files: { 'package-lock.json': '{"v":1}' },
      install: 'npm ci',
      setup: { install: 'ok', fingerprint: 'stale-but-present' },
    });
    await runCodeSetup(
      test_.workspaces,
      request({ phases: ['install'], force: true }),
      (event) => test_.events.push(event),
      new AbortController().signal,
    );
    assert.deepEqual(test_.executed, ['npm ci']);
  });

  test('a sandbox without network is skipped rather than failed', async () => {
    const test_ = harness({ install: 'npm ci', network: 'none' });
    await runCodeSetup(
      test_.workspaces,
      request({ phases: ['install'] }),
      (event) => test_.events.push(event),
      new AbortController().signal,
    );

    assert.deepEqual(test_.executed, []);
    assert.deepEqual(phases(test_.events, 'install'), ['skipped']);
    // The phase was skipped; the checkout still has no dependencies, and saying
    // «skipped» there would claim there is nothing left to install.
    assert.equal(test_.saved[0].install, 'pending');
  });

  test('a stack with no install command settles as skipped', async () => {
    const test_ = harness({});
    await runCodeSetup(
      test_.workspaces,
      request({ phases: ['install'] }),
      (event) => test_.events.push(event),
      new AbortController().signal,
    );
    assert.deepEqual(phases(test_.events, 'install'), ['skipped']);
    assert.equal(test_.saved[0].install, 'skipped', 'there is nothing to install, ever');
  });

  test('a skip over an installed checkout keeps it reported as installed', async () => {
    const test_ = harness({
      files: { 'package-lock.json': '{"v":1}' },
      install: 'npm ci',
      setup: { install: 'ok', fingerprint: 'stale' },
      network: 'none',
    });
    await runCodeSetup(
      test_.workspaces,
      request({ phases: ['install'] }),
      (event) => test_.events.push(event),
      new AbortController().signal,
    );
    assert.equal(test_.saved[0].install, 'ok');
  });

  test('a failed install is reported with its exit code and left un-fingerprinted', async () => {
    const test_ = harness({
      files: { 'package-lock.json': '{"v":1}' },
      install: 'npm ci',
      exec: () => ({ output: 'ERR!\n', exitCode: 1, truncated: false }),
    });
    await runCodeSetup(
      test_.workspaces,
      request({ phases: ['install'] }),
      (event) => test_.events.push(event),
      new AbortController().signal,
    );

    const failure = test_.events.find(
      (event) => event.type === 'phase' && event.state === 'failed',
    ) as { exitCode?: number | null } | undefined;
    assert.equal(failure?.exitCode, 1);
    const [saved] = test_.saved;
    assert.equal(saved.install, 'failed');
    assert.equal(saved.fingerprint, undefined, 'a failed install must be retried next time');
  });

  test('the run overrides the command and remembers it', async () => {
    const test_ = harness({ files: { 'package-lock.json': '{}' }, install: 'npm ci' });
    await runCodeSetup(
      test_.workspaces,
      request({ phases: ['install'], installCommand: 'npm install --legacy-peer-deps' }),
      () => undefined,
      new AbortController().signal,
    );
    assert.deepEqual(test_.executed, ['npm install --legacy-peer-deps']);
    assert.equal(test_.saved[0].installCommand, 'npm install --legacy-peer-deps');
  });

  test('streams the command output as it arrives', async () => {
    const test_ = harness({ files: { 'package-lock.json': '{}' }, install: 'npm ci' });
    // The fake `exec` ignores `onOutput`, so drive it through the real option.
    const workspaces = {
      ...(test_.workspaces as unknown as Record<string, unknown>),
      exec: (_id: string, _command: string, options: { onOutput?: (chunk: string) => void }) => {
        options.onOutput?.('added 1 package\n');
        return Promise.resolve({ output: 'added 1 package\n', exitCode: 0, truncated: false });
      },
    } as unknown as CodeWorkspaces;

    await runCodeSetup(
      workspaces,
      request({ phases: ['install'] }),
      (event) => test_.events.push(event),
      new AbortController().signal,
    );

    const log = test_.events.filter((event) => event.type === 'log');
    assert.equal(log.length, 1);
    assert.match((log[0] as { chunk: string }).chunk, /added 1 package/);
  });
});

describe('memory phase', () => {
  test("a repository's own AGENTS.md wins over generating a description", async () => {
    const test_ = harness({ files: { 'AGENTS.md': '# rules\n' } });
    await runCodeSetup(
      test_.workspaces,
      request({ phases: ['memory'] }),
      (event) => test_.events.push(event),
      new AbortController().signal,
    );

    assert.equal(test_.saved[0].memory, 'repo');
    const notes = readFileSync(join(test_.dir, GENERATED_MEMORY_FILE), 'utf8');
    assert.ok(
      !/Stack and commands/.test(notes),
      'no second description is written next to a hand-written memory',
    );
    assert.match(
      notes,
      /## Pitfalls/,
      'but the notes file exists regardless, because the prompt tells the agent to write there',
    );
  });

  test('without one, the deterministic memory is written outside git', async () => {
    const test_ = harness({
      files: { 'package.json': '{}', 'src/app.ts': '', 'src/lib/util.ts': '' },
      install: 'npm ci',
    });
    await runCodeSetup(
      test_.workspaces,
      request({ phases: ['memory'] }),
      (event) => test_.events.push(event),
      new AbortController().signal,
    );

    assert.equal(test_.saved[0].memory, 'generated');
    const content = readFileSync(join(test_.dir, GENERATED_MEMORY_FILE), 'utf8');
    assert.match(content, /Project memory/);
    assert.match(content, /npm ci/, 'the install command is part of the facts');
    assert.match(content, /src\//, 'so is the layout');
  });

  test('an already generated memory is left alone unless asked', async () => {
    const test_ = harness({
      files: { [GENERATED_MEMORY_FILE]: '# mine\n' },
      setup: { memory: 'generated' },
    });
    await runCodeSetup(
      test_.workspaces,
      request({ phases: ['memory'] }),
      (event) => test_.events.push(event),
      new AbortController().signal,
    );

    assert.deepEqual(phases(test_.events, 'memory'), ['skipped']);
    assert.equal(
      readFileSync(join(test_.dir, GENERATED_MEMORY_FILE), 'utf8'),
      '# mine\n',
      "the agent's own additions survive an ordinary session open",
    );
  });

  test('regenerating replaces the description and keeps what was written by hand', async () => {
    const test_ = harness({
      files: {
        [GENERATED_MEMORY_FILE]: [
          '# mine',
          '',
          '<!-- agent-engine:project -->',
          '### Stack and commands',
          '',
          '- Detected: something stale',
          '<!-- /agent-engine:project -->',
          '',
          '## Pitfalls',
          '',
          '- gradle test fails without --no-daemon',
        ].join('\n'),
        'package.json': '{}',
      },
      setup: { memory: 'generated' },
    });
    await runCodeSetup(
      test_.workspaces,
      request({ phases: ['memory'], force: true }),
      (event) => test_.events.push(event),
      new AbortController().signal,
    );

    assert.deepEqual(phases(test_.events, 'memory'), ['running', 'ok']);
    const content = readFileSync(join(test_.dir, GENERATED_MEMORY_FILE), 'utf8');
    assert.match(content, /Detected: package\.json/, 'the description is regenerated');
    assert.ok(!content.includes('something stale'), 'and the stale one is gone');
    assert.match(content, /# mine/, 'hand-written prose survives');
    assert.match(content, /- gradle test fails without --no-daemon/, 'so do the lessons');
  });
});

describe('lsp phase', () => {
  test('warms the server for the detected stack', async () => {
    const { workspaces, events, saved } = harness({ files: { 'package.json': '{}' } });

    await runCodeSetup(workspaces, request(), () => {}, new AbortController().signal);
    await runCodeSetup(
      workspaces,
      request(),
      (event) => events.push(event),
      new AbortController().signal,
    );

    assert.deepEqual(phases(events, 'lsp'), ['running', 'ok']);
    assert.equal(saved[saved.length - 1].lsp, 'ok');
    assert.match(saved[saved.length - 1].lspDetail ?? '', /typescript: ready/);
  });

  /**
   * A cold Gradle import takes minutes; holding the setup stream open for it
   * would leave the user staring at a spinner for the one phase whose result
   * nothing waits on.
   */
  test('treats «still indexing» as a success', async () => {
    const { workspaces, events, saved } = harness({ lsp: 'indexing' });

    await runCodeSetup(
      workspaces,
      request(),
      (event) => events.push(event),
      new AbortController().signal,
    );

    assert.deepEqual(phases(events, 'lsp'), ['running', 'ok']);
    assert.match(saved[0].lspDetail ?? '', /indexing the project in the background/);
  });

  test('reports an unavailable server with its reason', async () => {
    const { workspaces, events, saved } = harness({ lsp: 'unavailable' });

    await runCodeSetup(
      workspaces,
      request(),
      (event) => events.push(event),
      new AbortController().signal,
    );

    assert.deepEqual(phases(events, 'lsp'), ['running', 'failed']);
    assert.equal(saved[0].lsp, 'failed');
    assert.match(saved[0].lspDetail ?? '', /no Node\.js/);
  });

  test('skips a stack that has no server of ours', async () => {
    const { workspaces, events, saved } = harness({ toolchain: 'go' });

    await runCodeSetup(
      workspaces,
      request(),
      (event) => events.push(event),
      new AbortController().signal,
    );

    assert.deepEqual(phases(events, 'lsp'), ['skipped']);
    assert.equal(saved[0].lsp, 'skipped');
  });

  test('skips when the config turned language servers off', async () => {
    const { workspaces, events, saved } = harness({ lsp: 'off' });

    await runCodeSetup(
      workspaces,
      request(),
      (event) => events.push(event),
      new AbortController().signal,
    );

    assert.deepEqual(phases(events, 'lsp'), ['skipped']);
    assert.match(saved[0].lspDetail ?? '', /turned off in the settings/);
  });

  /** The bootstrap's job is a usable session; this phase must never fail it. */
  test('a broken language-server layer leaves the rest of the bootstrap intact', async () => {
    const { workspaces, events, saved } = harness({
      files: { 'package.json': '{}' },
      install: 'npm ci',
      lsp: 'throws',
    });

    await runCodeSetup(
      workspaces,
      request(),
      (event) => events.push(event),
      new AbortController().signal,
    );

    assert.deepEqual(phases(events, 'install'), ['running', 'ok']);
    assert.deepEqual(phases(events, 'lsp'), ['failed']);
    assert.equal(saved[0].install, 'ok');
    assert.match(saved[0].lspDetail ?? '', /Docker is not running/);
  });

  test('is not run when the caller asked for other phases', async () => {
    const { workspaces, events } = harness({});

    await runCodeSetup(
      workspaces,
      request({ phases: ['memory'] }),
      (event) => events.push(event),
      new AbortController().signal,
    );

    assert.deepEqual(phases(events, 'lsp'), []);
  });
});
