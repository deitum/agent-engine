import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { resetEngineConfig, useEngineConfig } from './config/engine-config';
import {
  CLAUDE_CODE_EXTENSION_NS,
  ENGINE_EXTENSION_NS,
  PLUGIN_SCHEMA_URL,
  type RepoCredentials,
  type RepoRef,
} from './contracts';
import { fetchRepoPlugins, findPluginDirs, listRepoPlugins } from './plugin-repo';

const CREDENTIALS: RepoCredentials = { username: 'ivan', token: 'secret' };
const REPO: RepoRef = {
  baseUrl: 'https://git.example.net',
  owner: 'ACME',
  repo: 'plugins',
};

/** Shorthand for the extension directory, which every path in here mentions. */
const CC = CLAUDE_CODE_EXTENSION_NS;

/** A spec `plugin.json`, the way a repository spells one. */
function manifest(name: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name, ...extra });
}

interface FakeRepo {
  /** Every file in the repository, keyed by path, valued by its bytes. */
  files: Record<string, string | Buffer>;
  defaultBranch?: string;
  commit?: string;
}

const realFetch = globalThis.fetch;

/**
 * Stands in for a Bitbucket Server host — the same fake `skill-repo.test.ts`
 * uses, against a repository of plugin packages rather than skill ones.
 */
function serve(repo: FakeRepo): void {
  const branch = repo.defaultBranch ?? 'master';
  const commit = repo.commit ?? 'c0ffee';
  const base = '/rest/api/1.0/projects/ACME/repos/plugins';

  globalThis.fetch = ((input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const path = url.pathname;

    const answer = (status: number, body: unknown): Promise<Response> =>
      Promise.resolve(
        new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
      );

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
  // The credentials reach the daemon through the connection handshake, not
  // through these requests — so the suite hands it the bundle first.
  useEngineConfig(
    { version: 'v1', llm: { apiKey: 'sk-test' }, repos: [CREDENTIALS] },
    'https://gateway.corp/v1',
  );
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetEngineConfig();
});

describe('findPluginDirs', () => {
  test('a directory holding plugin.json is a package', () => {
    assert.deepEqual(findPluginDirs(['flow/plugin.json', 'flow/skills/a/SKILL.md', 'README.md']), [
      'flow',
    ]);
  });

  test('accepts the legacy Claude Code manifest too', () => {
    assert.deepEqual(findPluginDirs(['kit/.claude-plugin/plugin.json', 'kit/commands/a.md']), [
      'kit',
    ]);
  });

  test('a manifest inside a package is payload, not a second plugin', () => {
    // Unlike a skill, a plugin does not nest: an example vendored inside a
    // bundle belongs to the bundle.
    assert.deepEqual(
      findPluginDirs([
        'flow/plugin.json',
        'flow/examples/demo/plugin.json',
        'flow/skills/a/SKILL.md',
      ]),
      ['flow'],
    );
  });

  test('a package at the scanned root is found', () => {
    assert.deepEqual(findPluginDirs(['plugin.json', 'skills/a/SKILL.md']), ['']);
  });

  test('a repository with no manifest yields nothing', () => {
    assert.deepEqual(findPluginDirs(['README.md', 'src/index.ts']), []);
  });
});

describe('listRepoPlugins', () => {
  test('describes each package from its manifest and counts what it holds', async () => {
    serve({
      files: {
        'plugins/flow/plugin.json': manifest('flow-pack', {
          version: '1.0.0',
          description: 'Planning',
          keywords: ['jira'],
          extensions: { [ENGINE_EXTENSION_NS]: { displayName: 'Flow' } },
        }),
        'plugins/flow/mcp.json': JSON.stringify({
          mcpServers: { jira: { type: 'streamable-http', url: 'https://e/mcp' } },
        }),
        [`plugins/flow/${CC}/commands/grill.md`]: 'Body.\n',
        [`plugins/flow/${CC}/agents/explorer.md`]: '---\nname: explorer\n---\n\nScout.\n',
        'plugins/flow/skills/grilling/SKILL.md': '---\nname: grilling\n---\n\nInterview.\n',
        'plugins/flow/skills/grilling/references/a.md': '# a\n',
        'README.md': '# repo\n',
      },
    });

    const { ref, commit, plugins } = await listRepoPlugins({ repo: REPO });

    assert.equal(ref, 'master');
    assert.equal(commit, 'c0ffee');
    assert.equal(plugins.length, 1);
    const [plugin] = plugins;
    assert.equal(plugin.path, 'plugins/flow');
    assert.equal(plugin.name, 'flow-pack');
    assert.equal(plugin.displayName, 'Flow');
    assert.equal(plugin.version, '1.0.0');
    assert.equal(plugin.description, 'Planning');
    assert.deepEqual(plugin.keywords, ['jira']);
    assert.deepEqual(plugin.counts, { commands: 1, agents: 1, skills: 1, mcpServers: 1 });
  });

  test('counts a legacy package from its root directories', async () => {
    serve({
      files: {
        'kit/.claude-plugin/plugin.json': JSON.stringify({ name: 'kit' }),
        'kit/commands/a.md': 'a\n',
        'kit/commands/b.md': 'b\n',
        'kit/agents/r.md': 'r\n',
      },
    });

    const { plugins } = await listRepoPlugins({ repo: REPO });

    assert.deepEqual(plugins[0].counts, { commands: 2, agents: 1, skills: 0, mcpServers: 0 });
  });

  test('scans only the sub-directory the reference names', async () => {
    serve({
      files: {
        'a/plugin.json': manifest('a'),
        'nested/b/plugin.json': manifest('b'),
      },
    });

    const { plugins } = await listRepoPlugins({ repo: { ...REPO, path: 'nested' } });

    assert.deepEqual(
      plugins.map((plugin) => plugin.path),
      ['nested/b'],
    );
  });
});

describe('fetchRepoPlugins', () => {
  test('downloads a package whole and records where it came from', async () => {
    serve({
      files: {
        'flow/plugin.json': manifest('flow-pack', {
          version: '2.0.0',
          extensions: {
            [ENGINE_EXTENSION_NS]: { displayName: 'Flow', manifest: { notes: 'needs Jira' } },
          },
        }),
        'flow/mcp.json': JSON.stringify({
          mcpServers: { jira: { type: 'stdio', command: 'npx', args: ['-y', 'jira'] } },
        }),
        [`flow/${CC}/commands/git/commit.md`]: '---\ndescription: Commit\n---\n\nMake a commit.\n',
        [`flow/${CC}/agents/explorer.md`]:
          '---\nname: explorer\ndescription: Scout\n---\n\nYou are a scout.\n',
        'flow/skills/grilling/SKILL.md':
          '---\nname: grilling\ndescription: Interview\n---\n\nOne at a time.\n',
        'flow/skills/grilling/references/a.md': '# a\n',
      },
    });

    const { plugins, skipped } = await fetchRepoPlugins({ repo: REPO, paths: ['flow'] });

    assert.equal(skipped.length, 0);
    const [plugin] = plugins;
    assert.equal(plugin.id, 'flow-pack');
    assert.equal(plugin.name, 'flow-pack');
    assert.equal(plugin.displayName, 'Flow');
    assert.equal(plugin.manifest?.notes, 'needs Jira');
    assert.deepEqual(plugin.mcpServers, {
      jira: { type: 'stdio', command: 'npx', args: ['-y', 'jira'] },
    });
    // A command in a sub-directory keeps the `dir:name` form the composer shows.
    assert.deepEqual(
      plugin.commands.map((command) => command.name),
      ['git:commit'],
    );
    assert.equal(plugin.agents[0].systemPrompt, 'You are a scout.');
    assert.equal(plugin.skills.length, 1);
    assert.deepEqual(plugin.skills[0].files, [{ path: 'references/a.md', content: '# a\n' }]);
    assert.deepEqual(plugin.source, {
      kind: 'bitbucket',
      baseUrl: 'https://git.example.net',
      project: 'ACME',
      repo: 'plugins',
      path: 'flow',
      ref: 'master',
      commit: 'c0ffee',
      fetchedAt: plugin.source?.fetchedAt ?? '',
    });
  });

  test('reports a file that cannot travel as text instead of failing the package', async () => {
    serve({
      files: {
        'flow/plugin.json': manifest('flow-pack'),
        'flow/skills/a/SKILL.md': '---\nname: a\n---\n\nBody.\n',
        'flow/skills/a/references/logo.png': Buffer.from([0x89, 0x50, 0x00, 0x01]),
      },
    });

    const { plugins, skipped } = await fetchRepoPlugins({ repo: REPO, paths: ['flow'] });

    assert.deepEqual(plugins[0].skills[0].files, []);
    assert.deepEqual(skipped, [{ path: 'flow/skills/a/references/logo.png', reason: 'binary' }]);
  });

  test('refuses a directory that holds no manifest', async () => {
    serve({ files: { 'flow/README.md': '# nope\n' } });

    await assert.rejects(
      () => fetchRepoPlugins({ repo: REPO, paths: ['flow'] }),
      (error: unknown) => (error as { status?: number }).status === 422,
    );
  });

  test('refuses an empty selection', async () => {
    serve({ files: {} });

    await assert.rejects(
      () => fetchRepoPlugins({ repo: REPO, paths: [] }),
      (error: unknown) => (error as { status?: number }).status === 400,
    );
  });
});
