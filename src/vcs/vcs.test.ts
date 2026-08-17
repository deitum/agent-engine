import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { ConnectorError } from '../connector';
import { type RepoCredentials } from '../contracts';

import { BitbucketServerClient, normalizeBaseUrl } from './bitbucket-server';
import { GithubClient } from './github';
import {
  checkRepoCredentials,
  cloneUrl,
  createRepoClient,
  gitAuthArgs,
  parseCloneUrl,
} from './vcs';

const BITBUCKET: RepoCredentials = {
  provider: 'bitbucket-server',
  username: 'ivan',
  token: 'secret',
};
const GITHUB: RepoCredentials = { provider: 'github', token: 'ghp_secret' };

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Records what the client asked for and answers with a canned response. */
function stub(handler: (url: URL, init?: RequestInit) => Response): {
  urls: string[];
  auth: string[];
  bodies: string[];
} {
  const urls: string[] = [];
  const auth: string[] = [];
  const bodies: string[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    urls.push(`${url.pathname}${url.search}`);
    auth.push(String((init?.headers as Record<string, string> | undefined)?.Authorization ?? ''));
    bodies.push(typeof init?.body === 'string' ? init.body : '');
    return Promise.resolve(handler(url, init));
  }) as typeof fetch;
  return { urls, auth, bodies };
}

describe('normalizeBaseUrl', () => {
  test('drops trailing slashes', () => {
    assert.equal(normalizeBaseUrl('https://git.example.net///'), 'https://git.example.net');
  });

  test('refuses a non-http scheme and an unparseable address', () => {
    assert.throws(() => normalizeBaseUrl('ssh://git.example.net'), ConnectorError);
    assert.throws(() => normalizeBaseUrl('git.example.net'), ConnectorError);
    assert.throws(() => normalizeBaseUrl('  '), ConnectorError);
  });
});

describe('BitbucketServerClient', () => {
  const repo = { baseUrl: 'https://git.example.net', owner: 'ACME', repo: 'skills' };

  test('refuses a project key or slug that would not survive a URL', () => {
    assert.throws(
      () => new BitbucketServerClient({ ...repo, owner: '../etc' }, BITBUCKET),
      ConnectorError,
    );
    assert.throws(
      () => new BitbucketServerClient({ ...repo, repo: 'a b' }, BITBUCKET),
      ConnectorError,
    );
  });

  test('refuses an empty token instead of asking Bitbucket about it', () => {
    assert.throws(
      () => new BitbucketServerClient(repo, { username: 'ivan', token: '  ' }),
      ConnectorError,
    );
  });

  test('sends Basic auth built from the credentials', async () => {
    const calls = stub(
      () => new Response(JSON.stringify({ displayId: 'master' }), { status: 200 }),
    );

    await new BitbucketServerClient(repo, BITBUCKET).defaultBranch();

    assert.equal(calls.auth[0], `Basic ${Buffer.from('ivan:secret').toString('base64')}`);
    assert.equal(calls.urls[0], '/rest/api/1.0/projects/ACME/repos/skills/branches/default');
  });

  test('resolveCommit pins to the tip of the named branch', async () => {
    const calls = stub(() => new Response(JSON.stringify({ values: [{ id: 'abc123' }] })));

    const commit = await new BitbucketServerClient(repo, BITBUCKET).resolveCommit('release/1.0');

    assert.equal(commit, 'abc123');
    assert.match(calls.urls[0], /commits\?limit=1&until=release%2F1\.0/);
  });

  test('resolveCommit refuses a branch name that is really an argument', async () => {
    stub(() => new Response('{}'));

    await assert.rejects(
      new BitbucketServerClient(repo, BITBUCKET).resolveCommit('--upload-pack=evil'),
      ConnectorError,
    );
  });

  test('an unknown branch is a 404 with a message naming it', async () => {
    stub(() => new Response(JSON.stringify({ values: [] })));

    await assert.rejects(
      new BitbucketServerClient(repo, BITBUCKET).resolveCommit('nope'),
      (error) => {
        assert.ok(error instanceof ConnectorError);
        assert.equal(error.status, 404);
        assert.match(error.message, /nope/);
        return true;
      },
    );
  });

  test('an unreachable host is reported as such, not as a bad status', async () => {
    globalThis.fetch = (() => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch;

    await assert.rejects(new BitbucketServerClient(repo, BITBUCKET).defaultBranch(), (error) => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.status, 502);
      assert.match(error.message, /not responding/);
      return true;
    });
  });

  test('readFile returns bytes, so a picture survives the trip to be rejected', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x00, 0x1a]);
    stub(() => new Response(new Uint8Array(bytes), { status: 200 }));

    const read = await new BitbucketServerClient(repo, BITBUCKET).readFile(
      'skills/a/logo.png',
      'c0ffee',
    );

    assert.deepEqual([...read], [...bytes]);
  });

  test('a duplicate pull request reports the open one instead of failing', async () => {
    stub(
      () =>
        new Response(
          JSON.stringify({
            errors: [{ existingPullRequest: { links: { self: [{ href: 'https://git/pr/7' }] } } }],
          }),
          { status: 409 },
        ),
    );

    const pr = await new BitbucketServerClient(repo, BITBUCKET).openPullRequest(
      'feat',
      'master',
      'Feat',
    );

    assert.deepEqual(pr, { url: 'https://git/pr/7', existed: true });
  });
});

describe('GithubClient', () => {
  const repo = { provider: 'github' as const, owner: 'acme', repo: 'skills' };

  test('talks to api.github.com when the reference names no host', async () => {
    const calls = stub(() => new Response(JSON.stringify({ default_branch: 'main' })));

    const branch = await new GithubClient(repo, GITHUB).defaultBranch();

    assert.equal(branch, 'main');
    assert.equal(calls.urls[0], '/repos/acme/skills');
    assert.equal(calls.auth[0], 'Bearer ghp_secret');
  });

  test('an Enterprise host gets the /api/v3 prefix', async () => {
    const calls = stub(() => new Response(JSON.stringify({ default_branch: 'main' })));

    await new GithubClient({ ...repo, baseUrl: 'https://ghe.example.net' }, GITHUB).defaultBranch();

    assert.equal(calls.urls[0], '/api/v3/repos/acme/skills');
  });

  test('listFiles returns paths relative to the requested sub-directory', async () => {
    stub(
      () =>
        new Response(
          JSON.stringify({
            tree: [
              { path: 'README.md', type: 'blob' },
              { path: 'skills', type: 'tree' },
              { path: 'skills/a/SKILL.md', type: 'blob' },
              { path: 'skills/a/ref.md', type: 'blob' },
            ],
          }),
        ),
    );

    const files = await new GithubClient(repo, GITHUB).listFiles('skills', 'c0ffee');

    assert.deepEqual(files, ['a/SKILL.md', 'a/ref.md']);
  });

  test('a truncated tree is refused rather than reported as a small repository', async () => {
    stub(() => new Response(JSON.stringify({ tree: [], truncated: true })));

    await assert.rejects(new GithubClient(repo, GITHUB).listFiles('', 'c0ffee'), (error) => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.status, 422);
      return true;
    });
  });

  test('a duplicate pull request is looked up by head branch', async () => {
    const calls = stub((url) =>
      url.pathname.endsWith('/pulls') && url.search === ''
        ? new Response('{"message":"already exists"}', { status: 422 })
        : new Response(JSON.stringify([{ html_url: 'https://github.com/acme/skills/pull/7' }])),
    );

    const pr = await new GithubClient(repo, GITHUB).openPullRequest('feat', 'main', 'Feat');

    assert.deepEqual(pr, { url: 'https://github.com/acme/skills/pull/7', existed: true });
    assert.match(calls.urls[1], /head=acme%3Afeat/);
  });

  test('a fresh pull request comes back with its web URL', async () => {
    stub(() => new Response(JSON.stringify({ html_url: 'https://github.com/acme/skills/pull/8' })));

    const pr = await new GithubClient(repo, GITHUB).openPullRequest('feat', 'main', 'Feat');

    assert.deepEqual(pr, { url: 'https://github.com/acme/skills/pull/8', existed: false });
  });
});

describe('createRepoClient', () => {
  test('picks the provider the reference names, defaulting to Bitbucket', () => {
    assert.ok(
      createRepoClient(
        { baseUrl: 'https://git.example.net', owner: 'A', repo: 'b' },
        BITBUCKET,
      ) instanceof BitbucketServerClient,
    );
    assert.ok(
      createRepoClient({ provider: 'github', owner: 'a', repo: 'b' }, GITHUB) instanceof
        GithubClient,
    );
  });
});

describe('cloneUrl', () => {
  test('builds the Bitbucket Server /scm/ shape', () => {
    assert.equal(
      cloneUrl({ baseUrl: 'https://git.example.net', owner: 'ACME', repo: 'skills' }),
      'https://git.example.net/scm/ACME/skills.git',
    );
  });

  test('builds the GitHub shape, defaulting to the public host', () => {
    assert.equal(
      cloneUrl({ provider: 'github', owner: 'acme', repo: 'skills' }),
      'https://github.com/acme/skills.git',
    );
  });

  test('refuses coordinates that would not survive a URL', () => {
    assert.throws(
      () => cloneUrl({ baseUrl: 'https://g', owner: '../x', repo: 'y' }),
      ConnectorError,
    );
  });
});

describe('parseCloneUrl', () => {
  test('reads back what cloneUrl wrote, for both providers', () => {
    assert.deepEqual(parseCloneUrl('https://git.example.net/scm/ACME/skills.git'), {
      provider: 'bitbucket-server',
      baseUrl: 'https://git.example.net',
      owner: 'ACME',
      repo: 'skills',
    });
    assert.deepEqual(parseCloneUrl('https://github.com/acme/skills.git'), {
      provider: 'github',
      baseUrl: 'https://github.com',
      owner: 'acme',
      repo: 'skills',
    });
  });

  test('returns null for anything else', () => {
    assert.equal(parseCloneUrl('not a url'), null);
    assert.equal(parseCloneUrl('https://example.net/a/b/c/d'), null);
  });
});

describe('gitAuthArgs', () => {
  test('passes the header per invocation, never in the remote URL', () => {
    assert.deepEqual(gitAuthArgs(BITBUCKET), [
      '-c',
      `http.extraHeader=Authorization: Basic ${Buffer.from('ivan:secret').toString('base64')}`,
    ]);
  });

  test('fills in the conventional user for a token that carries none', () => {
    assert.deepEqual(gitAuthArgs(GITHUB), [
      '-c',
      `http.extraHeader=Authorization: Basic ${Buffer.from('x-access-token:ghp_secret').toString('base64')}`,
    ]);
  });

  test('a missing credential adds no arguments at all', () => {
    assert.deepEqual(gitAuthArgs(undefined), []);
  });
});

describe('checkRepoCredentials', () => {
  test('asks each provider the cheapest authenticated question it has', async () => {
    const bitbucket = stub(() => new Response('3'));
    await checkRepoCredentials('bitbucket-server', 'https://git.example.net', BITBUCKET);
    assert.equal(bitbucket.urls[0], '/rest/api/1.0/inbox/pull-requests/count');

    const github = stub(() => new Response('{"login":"acme"}'));
    await checkRepoCredentials('github', undefined, GITHUB);
    assert.equal(github.urls[0], '/user');
  });

  test('a rejected credential is a 401, not a false', async () => {
    stub(() => new Response('', { status: 401 }));

    await assert.rejects(
      checkRepoCredentials('bitbucket-server', 'https://git.example.net', BITBUCKET),
      (error) => {
        assert.ok(error instanceof ConnectorError);
        assert.equal(error.status, 401);
        return true;
      },
    );
  });
});
