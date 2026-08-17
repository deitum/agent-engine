import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { resetEngineConfig, useEngineConfig } from './config/engine-config';
import { ConnectorError } from './connector';
import { type RepoCredentials, type RepoRef } from './contracts';
import { fetchRepoSkills, groupPackages, listRepoSkills } from './skill-repo';

const CREDENTIALS: RepoCredentials = { username: 'ivan', token: 'secret' };
const REPO: RepoRef = {
  baseUrl: 'https://git.example.net',
  owner: 'ACME',
  repo: 'skills',
};

/** One package's `SKILL.md`, the way a repository spells it. */
function skillMd(name: string, description: string, body = 'Body'): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

interface FakeRepo {
  /** Every file in the repository, keyed by path, valued by its bytes. */
  files: Record<string, string | Buffer>;
  defaultBranch?: string;
  commit?: string;
}

const realFetch = globalThis.fetch;
/** Every URL the client asked for, so a test can assert on the pinning. */
let requested: string[] = [];

/**
 * Stands in for a Bitbucket Server host: the four endpoints the client uses,
 * answered out of an in-memory tree. Paging is exercised by `listFiles` asking
 * for a page at a time, so the fake honours `start` / `limit` for real.
 */
function serve(repo: FakeRepo): void {
  const branch = repo.defaultBranch ?? 'master';
  const commit = repo.commit ?? 'c0ffee';
  const base = '/rest/api/1.0/projects/ACME/repos/skills';

  globalThis.fetch = ((input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    requested.push(`${url.pathname}${url.search}`);
    const path = url.pathname;

    const answer = (status: number, body: unknown): Promise<Response> =>
      Promise.resolve(
        new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
      );

    if (path === '/rest/api/1.0/inbox/pull-requests/count') {
      return answer(200, 3);
    }
    if (path === `${base}/branches/default`) {
      return answer(200, { displayId: branch });
    }
    if (path === `${base}/commits`) {
      return answer(200, { values: [{ id: commit }] });
    }
    if (path === `${base}/files` || path.startsWith(`${base}/files/`)) {
      const prefix =
        path === `${base}/files`
          ? ''
          : `${decodeURIComponent(path.slice(`${base}/files/`.length))}/`;
      const all = Object.keys(repo.files)
        .filter((file) => file.startsWith(prefix))
        .map((file) => file.slice(prefix.length))
        .sort();
      const start = Number(url.searchParams.get('start') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 1000);
      const values = all.slice(start, start + limit);
      const isLastPage = start + limit >= all.length;
      return answer(200, {
        values,
        isLastPage,
        ...(isLastPage ? {} : { nextPageStart: start + limit }),
      });
    }
    if (path.startsWith(`${base}/raw/`)) {
      const file = decodeURIComponent(path.slice(`${base}/raw/`.length));
      const content = repo.files[file];
      if (content === undefined) {
        return answer(404, { errors: [] });
      }
      return Promise.resolve(
        new Response(typeof content === 'string' ? content : new Uint8Array(content), {
          status: 200,
        }),
      );
    }
    return answer(404, { errors: [] });
  }) as typeof fetch;
}

beforeEach(() => {
  requested = [];
  // The credentials reach the daemon through the connection handshake, not
  // through these requests — so the suite hands it the bundle first.
  useEngineConfig(
    {
      version: 'v1',
      llm: { apiKey: 'sk-test' },
      repos: [CREDENTIALS],
    },
    'https://gateway.corp/v1',
  );
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetEngineConfig();
});

describe('groupPackages', () => {
  test('a directory holding SKILL.md is a package, with its files under it', () => {
    assert.deepEqual(groupPackages(['tdd/SKILL.md', 'tdd/refs/style.md', 'README.md']), [
      { dir: 'tdd', files: ['refs/style.md'] },
    ]);
  });

  test('a nested package keeps its own files instead of donating them upwards', () => {
    const packages = groupPackages([
      'flow/SKILL.md',
      'flow/notes.md',
      'flow/skills/research/SKILL.md',
      'flow/skills/research/refs/sources.md',
    ]);

    assert.deepEqual(packages, [
      { dir: 'flow', files: ['notes.md'] },
      { dir: 'flow/skills/research', files: ['refs/sources.md'] },
    ]);
  });

  test('a package at the scanned root owns the files beside it', () => {
    assert.deepEqual(groupPackages(['SKILL.md', 'refs/a.md']), [{ dir: '', files: ['refs/a.md'] }]);
  });

  test('a tree with no SKILL.md holds no packages', () => {
    assert.deepEqual(groupPackages(['README.md', 'src/index.ts']), []);
  });
});

describe('listRepoSkills', () => {
  test('reports every package with the name and description of its SKILL.md', async () => {
    serve({
      files: {
        'README.md': 'about the repository',
        'skills/tdd/SKILL.md': skillMd('TDD', 'How to write tests'),
        'skills/tdd/refs/cycle.md': 'red-green',
        'skills/review/SKILL.md': skillMd('Code review', 'How to review'),
      },
    });

    const response = await listRepoSkills({ repo: REPO });

    assert.equal(response.ref, 'master');
    assert.equal(response.commit, 'c0ffee');
    assert.deepEqual(
      response.skills.map(({ path, id, name, description, files }) => ({
        path,
        id,
        name,
        description,
        files,
      })),
      [
        {
          path: 'skills/review',
          id: 'review',
          name: 'Code review',
          description: 'How to review',
          files: [],
        },
        {
          path: 'skills/tdd',
          id: 'tdd',
          name: 'TDD',
          description: 'How to write tests',
          files: ['refs/cycle.md'],
        },
      ],
    );
  });

  test('scans only the sub-directory the caller named', async () => {
    serve({
      files: {
        'other/thing/SKILL.md': skillMd('Other', 'Not from here'),
        'packs/tdd/SKILL.md': skillMd('TDD', 'How to write tests'),
      },
    });

    const response = await listRepoSkills({ repo: { ...REPO, path: 'packs' } });

    assert.deepEqual(
      response.skills.map((skill) => skill.path),
      ['packs/tdd'],
    );
  });

  test('reads every page of a listing and pins them all to one commit', async () => {
    const files: Record<string, string> = { 'a/SKILL.md': skillMd('A', 'first') };
    for (let index = 0; index < 1200; index += 1) {
      files[`a/refs/${String(index).padStart(4, '0')}.md`] = 'a link';
    }
    serve({ files });

    const response = await listRepoSkills({ repo: REPO });

    assert.equal(response.skills[0].files.length, 200);
    assert.ok(requested.some((url) => url.includes('start=1000')));
    assert.ok(
      requested.filter((url) => url.includes('/files')).every((url) => url.includes('at=c0ffee')),
    );
  });

  test('a rejected token is reported as such, not as a missing repository', async () => {
    globalThis.fetch = (() => Promise.resolve(new Response('{}', { status: 401 }))) as typeof fetch;

    await assert.rejects(listRepoSkills({ repo: REPO }), (error) => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.status, 401);
      assert.match(error.message, /rejected the credentials/);
      return true;
    });
  });
});

describe('fetchRepoSkills', () => {
  test('downloads a package whole and stamps it with where it came from', async () => {
    serve({
      files: {
        'skills/tdd/SKILL.md': skillMd('TDD', 'How to write tests', 'Test first.'),
        'skills/tdd/refs/cycle.md': 'red-green',
      },
    });

    const response = await fetchRepoSkills({
      repo: REPO,
      paths: ['skills/tdd'],
    });

    const [skill] = response.skills;
    assert.equal(skill.id, 'tdd');
    assert.equal(skill.name, 'TDD');
    assert.equal(skill.instructions, 'Test first.');
    assert.deepEqual(skill.files, [{ path: 'refs/cycle.md', content: 'red-green' }]);
    assert.deepEqual(skill.source, {
      kind: 'bitbucket',
      baseUrl: 'https://git.example.net',
      project: 'ACME',
      repo: 'skills',
      path: 'skills/tdd',
      ref: 'master',
      commit: 'c0ffee',
      fetchedAt: skill.source?.fetchedAt ?? '',
    });
  });

  test('leaves a binary resource behind and says which one', async () => {
    serve({
      files: {
        'skills/tdd/SKILL.md': skillMd('TDD', 'How to write tests'),
        'skills/tdd/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a]),
        'skills/tdd/refs/cycle.md': 'red-green',
      },
    });

    const response = await fetchRepoSkills({
      repo: REPO,
      paths: ['skills/tdd'],
    });

    assert.deepEqual(
      response.skills[0].files.map((file) => file.path),
      ['refs/cycle.md'],
    );
    assert.deepEqual(response.skipped, [{ path: 'skills/tdd/logo.png', reason: 'binary' }]);
  });

  test('a package nested in another does not carry the outer one’s files', async () => {
    serve({
      files: {
        'flow/SKILL.md': skillMd('Flow', 'Outer'),
        'flow/notes.md': 'notes',
        'flow/skills/research/SKILL.md': skillMd('Research', 'Inner'),
        'flow/skills/research/refs/sources.md': 'sources',
      },
    });

    const response = await fetchRepoSkills({
      repo: REPO,
      paths: ['flow', 'flow/skills/research'],
    });

    assert.deepEqual(
      response.skills.map((skill) => skill.files.map((file) => file.path)),
      [['notes.md'], ['refs/sources.md']],
    );
  });

  test('refuses an empty selection rather than walking the repository', async () => {
    serve({ files: {} });

    await assert.rejects(fetchRepoSkills({ repo: REPO, paths: [] }), (error) => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.status, 400);
      return true;
    });
  });
});
