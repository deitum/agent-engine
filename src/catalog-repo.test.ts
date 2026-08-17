import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { CatalogCache, readRepoCatalog } from './catalog-repo';
import { resetEngineConfig, useEngineConfig } from './config/engine-config';
import {
  CLAUDE_CODE_EXTENSION_NS,
  ENGINE_EXTENSION_NS,
  PLUGIN_SCHEMA_URL,
  type RepoCredentials,
  type RepoRef,
} from './contracts';

const CREDENTIALS: RepoCredentials = { username: 'ivan', token: 'secret' };
const REPO: RepoRef = {
  baseUrl: 'https://git.example.net',
  owner: 'ACME',
  repo: 'harness',
};

const CC = CLAUDE_CODE_EXTENSION_NS;

/** How many times the fake host was called — what the cache has to bring down. */
let calls = 0;

interface FakeRepo {
  files: Record<string, string | Buffer>;
  commit?: string;
}

const realFetch = globalThis.fetch;

/** Stands in for a Bitbucket Server host, as in `plugin-repo.test.ts`. */
function serve(repo: FakeRepo): void {
  const commit = repo.commit ?? 'c0ffee';
  const base = '/rest/api/1.0/projects/ACME/repos/harness';

  globalThis.fetch = ((input: string | URL | Request) => {
    calls += 1;
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const path = url.pathname;

    const answer = (status: number, body: unknown): Promise<Response> =>
      Promise.resolve(
        new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
      );

    if (path === `${base}/branches/default`) {
      return answer(200, { displayId: 'master' });
    }
    if (path === `${base}/commits`) {
      return answer(200, { values: [{ id: commit }] });
    }
    if (path === `${base}/files` || path.startsWith(`${base}/files/`)) {
      const prefix =
        path === `${base}/files`
          ? ''
          : `${decodeURIComponent(path.slice(`${base}/files/`.length))}/`;
      const values = Object.keys(repo.files)
        .filter((file) => file.startsWith(prefix))
        .map((file) => file.slice(prefix.length))
        .sort();
      return answer(200, { values, isLastPage: true });
    }
    if (path.startsWith(`${base}/raw/`)) {
      const file = decodeURIComponent(path.slice(`${base}/raw/`.length));
      const content = repo.files[file];
      return content === undefined
        ? answer(404, { errors: [] })
        : Promise.resolve(new Response(content, { status: 200 }));
    }
    return answer(404, { errors: [] });
  }) as typeof fetch;
}

function manifest(name: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name, ...extra });
}

function skill(name: string): string {
  return `---\nname: ${name}\ndescription: ${name} does things.\n---\n\nBody of ${name}.\n`;
}

/** The layout the harness repository has: plugins, skills and mcp side by side. */
const HARNESS: Record<string, string> = {
  'README.md': '# harness',
  'plugins/starter/plugin.json': manifest('starter', {
    description: 'Systems analysis',
    extensions: { [ENGINE_EXTENSION_NS]: { displayName: 'Analytics' } },
  }),
  'plugins/starter/mcp.json': JSON.stringify({
    mcpServers: { vendored: { type: 'stdio', command: 'npx' } },
  }),
  'plugins/starter/skills/onboarding/SKILL.md': skill('onboarding'),
  [`plugins/starter/${CC}/commands/onboard.md`]: '---\ndescription: Onboard\n---\n\nDo it.\n',
  'skills/frontend-design/SKILL.md': skill('frontend-design'),
  'skills/frontend-design/references/type.md': '# Typography',
  'mcp/atlassian/mcp.json': JSON.stringify({
    mcpServers: { atlassian: { type: 'stdio', command: 'uvx', args: ['mcp-atlassian'] } },
    extensions: { [ENGINE_EXTENSION_NS]: { displayName: 'Atlassian', description: 'Jira.' } },
  }),
  'mcp/atlassian/README.md': '# Atlassian',
};

let cacheDir = '';
let cache: CatalogCache;

beforeEach(() => {
  calls = 0;
  cacheDir = mkdtempSync(join(tmpdir(), 'engine-catalog-test-'));
  cache = new CatalogCache({ dir: cacheDir });
  useEngineConfig(
    { version: 'v1', llm: { apiKey: 'sk-test' }, repos: [CREDENTIALS] },
    'https://gateway.corp/v1',
  );
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetEngineConfig();
  rmSync(cacheDir, { recursive: true, force: true });
});

describe('readRepoCatalog', () => {
  test('reads plugins, standalone skills and MCP entries from one tree', async () => {
    serve({ files: HARNESS });

    const { repos } = await readRepoCatalog({ repos: [REPO] }, cache);
    const [catalog] = repos;

    assert.equal(catalog.error, undefined);
    assert.equal(catalog.ref, 'master');
    assert.equal(catalog.commit, 'c0ffee');
    assert.deepEqual(
      catalog.plugins.map((plugin) => plugin.id),
      ['starter'],
    );
    assert.deepEqual(
      catalog.skills.map((entry) => entry.id),
      ['frontend-design'],
    );
    assert.deepEqual(
      catalog.mcpServers.map((entry) => entry.id),
      ['atlassian'],
    );
  });

  test('a plugin arrives whole — commands, bundled skills and its own servers', async () => {
    serve({ files: HARNESS });

    const [catalog] = (await readRepoCatalog({ repos: [REPO] }, cache)).repos;
    const [plugin] = catalog.plugins;

    assert.equal(plugin.displayName, 'Analytics');
    assert.deepEqual(
      plugin.commands.map((command) => command.name),
      ['onboard'],
    );
    assert.deepEqual(
      plugin.skills.map((entry) => entry.id),
      ['onboarding'],
    );
    assert.deepEqual(Object.keys(plugin.mcpServers ?? {}), ['vendored']);
  });

  test("a plugin's bundled skill is not offered as a standalone one", async () => {
    serve({ files: HARNESS });

    const [catalog] = (await readRepoCatalog({ repos: [REPO] }, cache)).repos;

    // It is already in the bundle; twice in the catalogue is once too many.
    assert.equal(
      catalog.skills.some((entry) => entry.id === 'onboarding'),
      false,
    );
  });

  test("a plugin's own mcp.json is not a catalogue entry", async () => {
    serve({ files: HARNESS });

    const [catalog] = (await readRepoCatalog({ repos: [REPO] }, cache)).repos;

    assert.equal(
      catalog.mcpServers.some((entry) => entry.id.includes('vendored')),
      false,
    );
  });

  test('a skill carries its resources and where it came from', async () => {
    serve({ files: HARNESS });

    const [catalog] = (await readRepoCatalog({ repos: [REPO] }, cache)).repos;
    const [design] = catalog.skills;

    assert.deepEqual(
      design.files.map((file) => file.path),
      ['references/type.md'],
    );
    assert.equal(design.source?.path, 'skills/frontend-design');
    assert.equal(design.source?.commit, 'c0ffee');
  });

  test('a second read of the same commit downloads nothing', async () => {
    serve({ files: HARNESS });

    await readRepoCatalog({ repos: [REPO] }, cache);
    const walked = calls;
    calls = 0;

    const { repos } = await readRepoCatalog({ repos: [REPO] }, cache);

    assert.deepEqual(
      repos[0].plugins.map((plugin) => plugin.id),
      ['starter'],
    );
    // Only the two requests that resolve the branch to a commit.
    assert.ok(calls < walked, `expected fewer than ${walked} requests, got ${calls}`);
    assert.equal(calls, 2);
  });

  test('a moved branch is read again', async () => {
    serve({ files: HARNESS });
    await readRepoCatalog({ repos: [REPO] }, cache);

    serve({ files: HARNESS, commit: 'beef' });
    calls = 0;
    const { repos } = await readRepoCatalog({ repos: [REPO] }, cache);

    assert.equal(repos[0].commit, 'beef');
    assert.ok(calls > 2);
  });

  test('refresh reads the repository even when the cache is warm', async () => {
    serve({ files: HARNESS });
    await readRepoCatalog({ repos: [REPO] }, cache);
    calls = 0;

    await readRepoCatalog({ repos: [REPO], refresh: true }, cache);

    assert.ok(calls > 2);
  });

  test('one unreachable repository does not blank the others', async () => {
    serve({ files: HARNESS });

    const { repos } = await readRepoCatalog(
      { repos: [{ ...REPO, owner: 'GONE', repo: 'nope' }, REPO] },
      cache,
    );

    assert.ok(repos[0].error);
    assert.deepEqual(repos[0].plugins, []);
    assert.deepEqual(
      repos[1].plugins.map((plugin) => plugin.id),
      ['starter'],
    );
  });
});
