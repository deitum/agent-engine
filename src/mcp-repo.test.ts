import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ENGINE_EXTENSION_NS, McpToolMode, McpTransport } from './contracts';
import { findMcpDirs, parseMcpCatalogFile } from './mcp-repo';

const NOW = '2026-01-01T00:00:00.000Z';

/** An `mcp.json` the way a catalogue repository spells one. */
function entry(servers: Record<string, unknown>, own?: Record<string, unknown>): string {
  return JSON.stringify({
    mcpServers: servers,
    ...(own ? { extensions: { [ENGINE_EXTENSION_NS]: own } } : {}),
  });
}

describe('findMcpDirs', () => {
  test('a directory holding mcp.json is an entry', () => {
    assert.deepEqual(findMcpDirs(['mcp/atlassian/mcp.json', 'mcp/atlassian/README.md']), [
      'mcp/atlassian',
    ]);
  });

  test("a plugin's own mcp.json is its payload, not an entry", () => {
    // Spec §7.2: a package ships the servers it needs. Listing them here would
    // offer the user a server the plugin already brings.
    assert.deepEqual(
      findMcpDirs(
        ['plugins/starter/plugin.json', 'plugins/starter/mcp.json', 'mcp/bitbucket/mcp.json'],
        ['plugins/starter'],
      ),
      ['mcp/bitbucket'],
    );
  });

  test('entries are sorted and de-duplicated', () => {
    assert.deepEqual(findMcpDirs(['mcp/b/mcp.json', 'mcp/a/mcp.json', 'mcp/a/mcp.json']), [
      'mcp/a',
      'mcp/b',
    ]);
  });

  test('a repository with no mcp.json yields nothing', () => {
    assert.deepEqual(findMcpDirs(['README.md', 'skills/a/SKILL.md']), []);
  });
});

describe('parseMcpCatalogFile', () => {
  test('a stdio server becomes a library entry named by its directory', () => {
    const [server] = parseMcpCatalogFile(
      entry(
        {
          atlassian: {
            type: 'stdio',
            command: 'uvx',
            args: ['mcp-atlassian'],
            env: { JIRA_URL: '${input:JIRA_URL}' },
          },
        },
        { displayName: 'Atlassian', description: 'Jira and Confluence.' },
      ),
      'atlassian',
      NOW,
    );

    assert.equal(server.id, 'atlassian');
    assert.equal(server.name, 'Atlassian');
    assert.equal(server.description, 'Jira and Confluence.');
    assert.deepEqual(server.config, {
      transport: McpTransport.Stdio,
      command: 'uvx',
      args: ['mcp-atlassian'],
      env: { JIRA_URL: '${input:JIRA_URL}' },
    });
  });

  test('the directory names the entry even when the server key differs', () => {
    // The id is what a stored reference points at, so it follows the directory
    // — the one thing a package cannot change without moving.
    const [server] = parseMcpCatalogFile(
      entry({ 'server-1': { type: 'stdio', command: 'npx' } }),
      'core-components',
      NOW,
    );
    assert.equal(server.id, 'core-components');
    assert.equal(server.name, 'server-1');
  });

  test('both HTTP transports collapse into one remote config', () => {
    const streamable = parseMcpCatalogFile(
      entry({
        github: {
          type: 'streamable-http',
          url: 'https://api.example/mcp/',
          headers: { Authorization: 'Bearer ${input:TOKEN}' },
        },
      }),
      'github',
      NOW,
    );
    const sse = parseMcpCatalogFile(
      entry({ legacy: { type: 'sse', url: 'https://api.example/sse' } }),
      'legacy',
      NOW,
    );

    assert.deepEqual(streamable[0].config, {
      transport: McpTransport.Http,
      url: 'https://api.example/mcp/',
      headers: { Authorization: 'Bearer ${input:TOKEN}' },
    });
    assert.equal(sse[0].config.transport, McpTransport.Http);
  });

  test('presets are scoped to the entry, in declaration order', () => {
    const [server] = parseMcpCatalogFile(
      entry(
        { camunda: { type: 'stdio', command: 'npx' } },
        {
          presets: [
            { name: 'deferred', policies: [{ toolName: '*', mode: 'deferred' }] },
            { name: 'full', policies: [{ toolName: '*', mode: 'available' }] },
          ],
        },
      ),
      'camunda',
      NOW,
    );

    assert.deepEqual(
      server.presets.map((preset) => preset.id),
      ['camunda-deferred', 'camunda-full'],
    );
    assert.equal(server.presets[0].policies[0].mode, McpToolMode.Deferred);
  });

  test('a policy naming an unknown mode is dropped, not guessed at', () => {
    const [server] = parseMcpCatalogFile(
      entry(
        { x: { type: 'stdio', command: 'npx' } },
        { presets: [{ name: 'weird', policies: [{ toolName: '*', mode: 'sometimes' }] }] },
      ),
      'x',
      NOW,
    );
    assert.deepEqual(server.presets[0].policies, []);
  });

  test('several servers in one file each become an entry', () => {
    const servers = parseMcpCatalogFile(
      entry({
        one: { type: 'stdio', command: 'a' },
        two: { type: 'stdio', command: 'b' },
      }),
      'pair',
      NOW,
    );
    assert.deepEqual(
      servers.map((server) => server.id),
      ['pair-one', 'pair-two'],
    );
  });

  test('a malformed or empty document yields no entries', () => {
    assert.deepEqual(parseMcpCatalogFile('{oops', 'x', NOW), []);
    assert.deepEqual(parseMcpCatalogFile('{}', 'x', NOW), []);
    // A server that matches no transport variant is not an entry either.
    assert.deepEqual(parseMcpCatalogFile(entry({ x: { type: 'carrier-pigeon' } }), 'x', NOW), []);
  });
});
