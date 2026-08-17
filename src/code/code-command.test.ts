import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { resetEngineConfig, useEngineConfig } from '../config/engine-config';
import { type CodeDiff, type CodeCommandRequest, type CodeWorkspaceStatus } from '../contracts';

import { runCodeCommand } from './code-command';
import { type CodeWorkspaces } from './code-workspace';

const REPO = { baseUrl: 'https://git.example.test', owner: 'PRJ', repo: 'service' };
const CREDENTIALS = { username: 'tester', token: 'secret-token' };

const STATUS: CodeWorkspaceStatus = {
  cloned: true,
  branch: 'agent/session',
  baseBranch: 'main',
  toolchain: 'node',
  ahead: 1,
  behind: 0,
  files: [],
  image: 'node:20-bookworm',
  imageSource: 'auto',
  detected: { toolchain: 'node', image: 'node:20-bookworm', reason: 'package.json' },
  envKeys: [],
  containerRunning: true,
  busy: true,
  setup: { install: 'ok', memory: 'generated', ranAt: 1 },
};

const DIFF: CodeDiff = { files: [], mode: 'worktree' };

/** Records what the command layer asked the workspace to do. */
interface Calls {
  pushed: number;
  committed: string[];
  executed: string[];
}

/**
 * A stand-in workspace. `runCodeCommand` is pure routing plus the Bitbucket REST
 * call — the git behaviour it delegates to is covered in `code-workspace.test.ts`,
 * so here the workspace is faked and the routing is what gets asserted.
 */
function fakeWorkspaces(overrides: Partial<Record<string, unknown>> = {}): {
  workspaces: CodeWorkspaces;
  calls: Calls;
} {
  const calls: Calls = { pushed: 0, committed: [], executed: [] };
  const base = {
    setEnv: () => Promise.resolve(),
    status: () => Promise.resolve(STATUS),
    diff: () => Promise.resolve(DIFF),
    repo: () => Promise.resolve(REPO),
    baseBranch: () => Promise.resolve('main'),
    push: () => {
      calls.pushed += 1;
      return Promise.resolve('agent/session');
    },
    commit: (_id: string, message: string) => {
      calls.committed.push(message);
      return Promise.resolve('1 file changed');
    },
    createBranch: (_id: string, name: string) => Promise.resolve(name),
    checkout: (_id: string, name: string) => Promise.resolve(name),
    revert: (_id: string, path: string) => Promise.resolve(`«${path}» was restored from HEAD.`),
    commands: () => Promise.resolve({ test: 'npm test', build: 'npm run build' }),
    exec: (_id: string, command: string) => {
      calls.executed.push(command);
      return Promise.resolve({ output: 'ok', exitCode: 0, truncated: false });
    },
    ...overrides,
  };
  return { workspaces: base as unknown as CodeWorkspaces, calls };
}

function request(partial: Partial<CodeCommandRequest>): CodeCommandRequest {
  return { sessionId: 'session', command: 'commit', ...partial } as CodeCommandRequest;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  resetEngineConfig();
});

/** Replaces `fetch` with one canned response and records the request. */
function stubFetch(response: Response): { calls: { url: string; body: unknown }[] } {
  const calls: { url: string; body: unknown }[] = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Promise.resolve(response);
  }) as unknown as typeof fetch;
  return { calls };
}

describe('deterministic commands', () => {
  test('commit forwards the message and reports the refreshed state', async () => {
    const { workspaces, calls } = fakeWorkspaces();
    const result = await runCodeCommand(workspaces, request({ command: 'commit', arg: 'fix: x' }));

    assert.deepEqual(calls.committed, ['fix: x']);
    assert.equal(result.ok, true);
    assert.equal(result.status.branch, 'agent/session');
    assert.deepEqual(result.diff, DIFF);
  });

  test('test falls back to the detected stack command', async () => {
    const { workspaces, calls } = fakeWorkspaces();
    await runCodeCommand(workspaces, request({ command: 'test' }));
    assert.deepEqual(calls.executed, ['npm test']);
  });

  test('an explicit argument overrides the detected test command', async () => {
    const { workspaces, calls } = fakeWorkspaces();
    await runCodeCommand(workspaces, request({ command: 'test', arg: 'npm run test:unit' }));
    assert.deepEqual(calls.executed, ['npm run test:unit']);
  });

  test('a non-zero exit is reported as a failure, not thrown', async () => {
    const { workspaces } = fakeWorkspaces({
      exec: () => Promise.resolve({ output: '2 failing', exitCode: 1, truncated: false }),
    });
    const result = await runCodeCommand(workspaces, request({ command: 'test' }));

    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /exit code 1/);
    assert.match(result.output, /2 failing/);
  });

  test('an aborted command reports a null exit code', async () => {
    const { workspaces } = fakeWorkspaces({
      exec: () => Promise.resolve({ output: 'partial', exitCode: null, truncated: false }),
    });
    const result = await runCodeCommand(workspaces, request({ command: 'exec', arg: 'sleep 60' }));

    assert.equal(result.ok, false);
    assert.equal(result.exitCode, null);
    assert.match(result.output, /interrupted/);
  });

  test('/run without a command is refused', async () => {
    const { workspaces } = fakeWorkspaces();
    await assert.rejects(
      () => runCodeCommand(workspaces, request({ command: 'exec', arg: '  ' })),
      /Name a command/,
    );
  });
});

describe('network commands', () => {
  /** Hands the daemon the credentials the browser would have pushed. */
  function configured(): void {
    useEngineConfig(
      {
        version: 'v1',
        llm: { apiKey: 'sk-test' },
        repos: [CREDENTIALS],
      },
      'https://gateway.corp/v1',
    );
  }

  test('push requires credentials', async () => {
    const { workspaces } = fakeWorkspaces();
    // Deliberately not `configured()`: an unconfigured daemon is exactly the
    // case this refusal exists for.
    await assert.rejects(
      () => runCodeCommand(workspaces, request({ command: 'push' })),
      /needs repository credentials/,
    );
  });

  test('pr opens a pull request against the base branch and returns its URL', async () => {
    configured();
    const { workspaces, calls } = fakeWorkspaces();
    const stub = stubFetch(
      new Response(
        JSON.stringify({ links: { self: [{ href: 'https://git.example.test/pr/7' }] } }),
        {
          status: 201,
        },
      ),
    );

    const result = await runCodeCommand(
      workspaces,
      request({ command: 'pr', arg: 'Add x', repo: REPO }),
    );

    assert.equal(calls.pushed, 1, 'the branch is pushed before the PR is opened');
    assert.equal(result.prUrl, 'https://git.example.test/pr/7');
    assert.equal(
      stub.calls[0].url,
      'https://git.example.test/rest/api/1.0/projects/PRJ/repos/service/pull-requests',
    );
    assert.deepEqual(stub.calls[0].body, {
      title: 'Add x',
      fromRef: { id: 'refs/heads/agent/session' },
      toRef: { id: 'refs/heads/main' },
    });
  });

  test('an existing pull request (409) is a success, not an error', async () => {
    configured();
    const { workspaces } = fakeWorkspaces();
    stubFetch(new Response('', { status: 409 }));

    const result = await runCodeCommand(workspaces, request({ command: 'pr', repo: REPO }));

    assert.equal(result.ok, true);
    assert.match(result.output, /already open/);
  });

  test('the 409 body names the open pull request, so a repeat /pr still links it', async () => {
    configured();
    const { workspaces } = fakeWorkspaces();
    stubFetch(
      new Response(
        JSON.stringify({
          errors: [
            {
              exceptionName: 'com.atlassian.bitbucket.pull.DuplicatePullRequestException',
              existingPullRequest: {
                id: 7,
                links: { self: [{ href: 'https://git.example.test/pr/7' }] },
              },
            },
          ],
        }),
        { status: 409 },
      ),
    );

    const result = await runCodeCommand(workspaces, request({ command: 'pr', repo: REPO }));

    assert.equal(result.ok, true);
    assert.equal(result.prUrl, 'https://git.example.test/pr/7');
  });

  test('a rejected token surfaces as 401 rather than a generic failure', async () => {
    configured();
    const { workspaces } = fakeWorkspaces();
    stubFetch(new Response('bad token', { status: 403 }));

    await assert.rejects(
      () => runCodeCommand(workspaces, request({ command: 'pr', repo: REPO })),
      (error: unknown) => (error as { status?: number }).status === 401,
    );
  });

  /**
   * Opening a PR from the base branch onto itself is rejected by Bitbucket with
   * an opaque error, so the guard catches it first and says what to do instead.
   */
  test('pr refuses when the work branch is the base branch', async () => {
    configured();
    const { workspaces } = fakeWorkspaces({ push: () => Promise.resolve('main') });
    await assert.rejects(
      () => runCodeCommand(workspaces, request({ command: 'pr', repo: REPO })),
      /is the base branch/,
    );
  });
});

describe('/lsp', () => {
  /** A workspace whose language servers report `statuses`, recording restarts. */
  function withLsp(statuses: unknown[]): {
    workspaces: CodeWorkspaces;
    stopped: string[];
  } {
    const stopped: string[] = [];
    const { workspaces } = fakeWorkspaces({
      lspStatus: () => statuses,
      stopLsp: (sessionId: string) => stopped.push(sessionId),
    });
    return { workspaces, stopped };
  }

  test('reports each server with its state', async () => {
    const { workspaces } = withLsp([
      { language: 'java', state: 'indexing' },
      {
        language: 'typescript',
        state: 'unavailable',
        detail: 'the container image has no Node.js',
      },
    ]);

    const result = await runCodeCommand(workspaces, request({ command: 'lsp' }));

    assert.equal(result.ok, true);
    assert.match(result.output, /java: indexing the project/);
    assert.match(result.output, /typescript: unavailable — the container image has no Node\.js/);
  });

  /** Nothing started yet is the normal state of a fresh session, not a problem. */
  test('explains itself when nothing has started', async () => {
    const { workspaces } = withLsp([]);

    const result = await runCodeCommand(workspaces, request({ command: 'lsp' }));

    assert.match(result.output, /have not started yet/);
  });

  test('restart drops the servers so the next request rebuilds them', async () => {
    const { workspaces, stopped } = withLsp([{ language: 'java', state: 'ready' }]);

    const result = await runCodeCommand(workspaces, request({ command: 'lsp', arg: 'restart' }));

    assert.deepEqual(stopped, ['session']);
    assert.match(result.output, /are restarting/);
  });

  test('off stops them too, and says they will come back', async () => {
    const { workspaces, stopped } = withLsp([{ language: 'java', state: 'ready' }]);

    const result = await runCodeCommand(workspaces, request({ command: 'lsp', arg: 'off' }));

    assert.deepEqual(stopped, ['session']);
    assert.match(result.output, /session settings/);
  });

  test('an unknown argument is refused rather than silently ignored', async () => {
    const { workspaces } = withLsp([]);

    await assert.rejects(
      () => runCodeCommand(workspaces, request({ command: 'lsp', arg: 'reboot' })),
      /Available: restart, off/,
    );
  });
});

describe('git that has to reach the repository host', () => {
  test('/run git push is answered with the command that does work', async () => {
    const { workspaces, calls } = fakeWorkspaces();
    const result = await runCodeCommand(
      workspaces,
      request({ command: 'exec', arg: 'git push -u origin HEAD' }),
    );

    assert.equal(result.ok, false);
    assert.deepEqual(calls.executed, [], 'nothing reaches the container');
    assert.match(result.output, /\/push/);
    assert.match(result.output, /no credentials/);
  });

  test('local git still runs in the container', async () => {
    const { workspaces, calls } = fakeWorkspaces();
    await runCodeCommand(workspaces, request({ command: 'exec', arg: 'git status -sb' }));
    assert.deepEqual(calls.executed, ['git status -sb']);
  });
});
