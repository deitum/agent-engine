import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { McpTransport } from './contracts';
import { McpCatalog, serverIdentity } from './mcp-catalog';

let dir = '';
const path = (): string => join(dir, 'mcp-catalog.json');

const server = (env?: Record<string, string>) => ({
  transport: McpTransport.Stdio,
  command: 'npx',
  args: ['-y', 'some-server@latest'],
  ...(env ? { env } : {}),
});

const tools = [{ name: 'search', description: 'Search things', inputSchema: { type: 'object' } }];

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcp-catalog-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('serverIdentity', () => {
  test('ignores credentials, so a rotated token keeps the catalog', () => {
    assert.equal(
      serverIdentity(server({ TOKEN: 'old' })),
      serverIdentity(server({ TOKEN: 'new' })),
    );
  });

  test('separates servers that are actually different', () => {
    assert.notEqual(
      serverIdentity(server()),
      serverIdentity({ ...server(), args: ['-y', 'other-server@latest'] }),
    );
  });
});

describe('McpCatalog', () => {
  test('survives the daemon: a second instance reads what the first wrote', () => {
    new McpCatalog({ path: path() }).put(server(), tools);

    assert.deepEqual(new McpCatalog({ path: path() }).get(server()), tools);
  });

  test('knows nothing about a server it has never seen', () => {
    const catalog = new McpCatalog({ path: path() });

    assert.equal(catalog.get({ ...server(), args: ['-y', 'unseen@latest'] }), null);
  });

  test('ages an entry from the moment it was recorded', () => {
    const catalog = new McpCatalog({ path: path() });
    catalog.put(server(), tools);

    const age = catalog.age(server(), Date.now() + 5_000);
    assert.ok(age !== null && age >= 5_000 && age < 6_000, `unexpected age ${String(age)}`);
    assert.equal(catalog.age({ ...server(), args: ['-y', 'unseen@latest'] }), null);
  });

  test('an unreadable catalog is no catalog, not a failure', async () => {
    const broken = join(dir, 'broken.json');
    await writeFile(broken, '{ not json', 'utf8');
    const catalog = new McpCatalog({ path: broken });

    assert.equal(catalog.get(server()), null);
    assert.doesNotThrow(() => catalog.put(server(), tools));
    assert.deepEqual(catalog.get(server()), tools);
  });
});
