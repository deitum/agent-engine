import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { resetEngineConfig, useEngineConfig } from '../config/engine-config';

import {
  fetchSession,
  networkGitRefusal,
  networkGitSubcommand,
  openSessionPullRequest,
  pushSessionBranch,
} from './code-git';
import { type CodeWorkspaces } from './code-workspace';

const REPO = { baseUrl: 'https://git.example.test', owner: 'PRJ', repo: 'service' };
const CREDENTIALS = { username: 'tester', token: 'secret-token' };

/** Records what the git layer asked the workspace to do. */
interface Calls {
  pushed: number;
  fetched: { credentials: unknown; branch?: string }[];
}

/**
 * A stand-in workspace. What these functions add on top of it is the
 * credentials, the base-branch check and the REST call — the git itself is
 * covered in `code-workspace.test.ts`.
 */
function fakeWorkspaces(overrides: Record<string, unknown> = {}): {
  workspaces: CodeWorkspaces;
  calls: Calls;
} {
  const calls: Calls = { pushed: 0, fetched: [] };
  const base = {
    repo: () => Promise.resolve(REPO),
    baseBranch: () => Promise.resolve('main'),
    push: () => {
      calls.pushed += 1;
      return Promise.resolve('agent/session');
    },
    fetch: (_id: string, credentials: unknown, branch?: string) => {
      calls.fetched.push({ credentials, ...(branch ? { branch } : {}) });
      return Promise.resolve('');
    },
    ...overrides,
  };
  return { workspaces: base as unknown as CodeWorkspaces, calls };
}

/** Hands the daemon the credentials the browser would have pushed. */
function configured(): void {
  useEngineConfig(
    { version: 'v1', llm: { apiKey: 'sk-test' }, repos: [CREDENTIALS] },
    'https://gateway.corp/v1',
  );
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  resetEngineConfig();
});

describe('remote git inside the sandbox', () => {
  test('a push anywhere in the line is refused, whatever precedes it', () => {
    for (const command of [
      'git push',
      'git push -u origin HEAD',
      'git add -A && git commit -m "wip" && git push',
      'cd /workspace; git -C /workspace push origin main',
      'git -c http.sslVerify=false push',
    ]) {
      assert.equal(networkGitSubcommand(command), 'push', command);
    }
  });

  test('the other network sub-commands are recognised too', () => {
    assert.equal(networkGitSubcommand('git fetch origin main'), 'fetch');
    assert.equal(networkGitSubcommand('git pull --rebase'), 'pull');
    assert.equal(networkGitSubcommand('git ls-remote --heads origin'), 'ls-remote');
    assert.equal(networkGitSubcommand('git clone https://git.example.test/x.git'), 'clone');
  });

  test('local git is left alone', () => {
    for (const command of [
      'git status',
      'git add -A && git commit -m "fix: push the button"',
      'git log --oneline -5',
      'git branch -a',
      './gradlew test',
      'echo git push',
    ]) {
      assert.equal(networkGitRefusal(command), null, command);
    }
  });

  test('the refusal names the tool that does the job', () => {
    const push = networkGitRefusal('git push') ?? '';
    assert.match(push, /git_push/);
    assert.match(push, /open_pull_request/);
    assert.match(push, /no credentials/);
    // The point of the text: the model must not try to repair the sandbox.
    assert.match(push, /credential helper/);

    assert.match(networkGitRefusal('git fetch') ?? '', /git_fetch/);
    assert.match(networkGitRefusal('git pull') ?? '', /git_fetch/);
    // Nothing here can clone; the refusal says so instead of naming a tool.
    assert.match(networkGitRefusal('git clone https://x/y.git') ?? '', /already cloned/);
  });

  test('the user is pointed at a command, not at a tool they cannot call', () => {
    const forUser = networkGitRefusal('git push', 'user') ?? '';
    assert.match(forUser, /\/push/);
    assert.doesNotMatch(forUser, /git_push/);
    // Advice about `.netrc` is for the agent; the person typed one command.
    assert.doesNotMatch(forUser, /netrc/);
  });
});

describe('the credentialed operations', () => {
  test('a push without configured credentials is refused', async () => {
    const { workspaces, calls } = fakeWorkspaces();
    await assert.rejects(
      () => pushSessionBranch(workspaces, 'session', REPO),
      /needs repository credentials/,
    );
    assert.equal(calls.pushed, 0, 'nothing is attempted without a token');
  });

  test('fetch passes the configured credentials and the branch', async () => {
    configured();
    const { workspaces, calls } = fakeWorkspaces();
    await fetchSession(workspaces, 'session', REPO, 'main');

    assert.deepEqual(calls.fetched, [{ credentials: CREDENTIALS, branch: 'main' }]);
  });

  test('a pull request pushes first, then opens it against the base branch', async () => {
    configured();
    const { workspaces, calls } = fakeWorkspaces();
    const requests: { url: string; body: unknown }[] = [];
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return Promise.resolve(
        new Response(
          JSON.stringify({ links: { self: [{ href: 'https://git.example.test/pr/7' }] } }),
          { status: 201 },
        ),
      );
    }) as unknown as typeof fetch;

    const pr = await openSessionPullRequest(workspaces, 'session', REPO, 'Add x');

    assert.equal(calls.pushed, 1, 'a branch the host has never seen cannot have a pull request');
    assert.deepEqual(pr, {
      branch: 'agent/session',
      baseBranch: 'main',
      url: 'https://git.example.test/pr/7',
      existed: false,
    });
    assert.equal((requests[0].body as { title: string }).title, 'Add x');
  });

  test('a pull request from the base branch onto itself is refused', async () => {
    configured();
    const { workspaces } = fakeWorkspaces({ push: () => Promise.resolve('main') });
    await assert.rejects(
      () => openSessionPullRequest(workspaces, 'session', REPO, ''),
      /current branch is the base branch/,
    );
  });
});
