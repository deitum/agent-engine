import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import {
  CLAUDE_CODE_EXTENSION_NS,
  ENGINE_EXTENSION_NS,
  type LocalPluginWriteRequest,
  PLUGIN_MCP_SCHEMA_URL,
  PLUGIN_SCHEMA_URL,
} from './contracts';
import { deleteLocalPlugin, listLocalPlugins, writeLocalPlugin } from './local-plugins';

/** Shorthand for the extension directory, which every path in here mentions. */
const CC = CLAUDE_CODE_EXTENSION_NS;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'engine-plugins-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Writes a file under the temp root, creating the directories above it. */
function write(path: string, content: string): void {
  const full = join(root, ...path.split('/'));
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

/** A write request with the boilerplate filled in. */
function writeRequest(
  plugin: Partial<LocalPluginWriteRequest['plugin']> = {},
): LocalPluginWriteRequest {
  return {
    dir: root,
    plugin: {
      id: 'qa-kit',
      name: 'qa-kit',
      displayName: 'QA Kit',
      version: '1.0.0',
      description: 'QA pack',
      keywords: ['qa'],
      commands: [
        {
          name: 'new-test',
          description: 'Write a test',
          argumentHint: '[endpoint]',
          allowedTools: ['Read', 'Write'],
          body: 'Write a test for $ARGUMENTS.',
        },
      ],
      agents: [
        {
          name: 'reviewer',
          description: 'Reviewer',
          tools: ['Read'],
          systemPrompt: 'You are a reviewer.',
        },
      ],
      skills: [
        {
          id: 'api-test',
          name: 'API tests',
          description: 'How to write API tests',
          instructions: '# API\n\nFollow AAA.',
          files: [{ path: 'references/style.md', content: '# Style\n' }],
          createdAt: '',
          updatedAt: '',
        },
      ],
      ...plugin,
    },
  };
}

describe('listLocalPlugins', () => {
  test('reads a spec package: manifest, mcp.json, commands, agents, skills', () => {
    write(
      'qa/plugin.json',
      JSON.stringify({
        $schema: PLUGIN_SCHEMA_URL,
        name: 'qa-kit',
        version: '2.0.0',
        description: 'Pack',
        author: { name: 'ACME' },
        keywords: ['qa', 'tests'],
        extensions: { [ENGINE_EXTENSION_NS]: { displayName: 'QA Kit' } },
      }),
    );
    write(
      'qa/mcp.json',
      JSON.stringify({
        $schema: PLUGIN_MCP_SCHEMA_URL,
        mcpServers: { local: { type: 'stdio', command: 'npx', args: ['-y', 'x'] } },
      }),
    );
    write(
      `qa/${CC}/commands/new-test.md`,
      '---\ndescription: Write a test\nargument-hint: "[endpoint]"\n---\n\nWrite a test for $ARGUMENTS.\n',
    );
    write(
      `qa/${CC}/agents/reviewer.md`,
      '---\nname: reviewer\ndescription: Reviewer\n---\n\nYou are a reviewer.\n',
    );
    write(
      'qa/skills/api-test/SKILL.md',
      '---\nname: API tests\ndescription: How to write\n---\n\nFollow AAA.\n',
    );

    const { plugins } = listLocalPlugins(root);

    assert.equal(plugins.length, 1);
    const [plugin] = plugins;
    assert.equal(plugin.id, 'qa');
    assert.equal(plugin.name, 'qa-kit');
    assert.equal(plugin.displayName, 'QA Kit');
    assert.equal(plugin.version, '2.0.0');
    assert.deepEqual(plugin.author, { name: 'ACME' });
    assert.deepEqual(plugin.keywords, ['qa', 'tests']);
    assert.deepEqual(plugin.mcpServers, {
      local: { type: 'stdio', command: 'npx', args: ['-y', 'x'] },
    });
    assert.deepEqual(plugin.commands, [
      {
        name: 'new-test',
        description: 'Write a test',
        argumentHint: '[endpoint]',
        body: 'Write a test for $ARGUMENTS.',
      },
    ]);
    assert.equal(plugin.agents[0].systemPrompt, 'You are a reviewer.');
    assert.equal(plugin.skills[0].name, 'API tests');
  });

  /**
   * The display name stays Cyrillic on purpose: `packageName` carries a
   * Cyrillic → Latin table precisely so a package titled in Russian still yields
   * a `name` that says something, and this is the assertion that holds it up.
   */
  test('still reads a Claude Code package: legacy manifest and root directories', () => {
    write(
      'legacy/.claude-plugin/plugin.json',
      JSON.stringify({ name: 'Набор QA', version: '1.0.0', manifest: { notes: 'needs Jira' } }),
    );
    write(
      'legacy/.mcp.json',
      JSON.stringify({ mcpServers: { r: { type: 'sse', url: 'https://e/x' } } }),
    );
    write('legacy/commands/new-test.md', 'Body.\n');
    write('legacy/agents/reviewer.md', '---\nname: reviewer\n---\n\nYou are a reviewer.\n');

    const [plugin] = listLocalPlugins(root).plugins;

    // A pre-spec `name` is a display name in all but the field it sits in.
    assert.equal(plugin.name, 'nabor-qa');
    assert.equal(plugin.displayName, 'Набор QA');
    assert.equal(plugin.manifest?.notes, 'needs Jira');
    assert.deepEqual(plugin.mcpServers, { r: { type: 'sse', url: 'https://e/x' } });
    assert.equal(plugin.commands.length, 1);
    assert.equal(plugin.agents.length, 1);
  });

  test('prefers the extension directory over the legacy root one, without merging', () => {
    write('kit/plugin.json', JSON.stringify({ name: 'kit' }));
    write('kit/commands/stale.md', 'Old.\n');
    write(`kit/${CC}/commands/fresh.md`, 'New.\n');

    const [plugin] = listLocalPlugins(root).plugins;

    assert.deepEqual(
      plugin.commands.map((command) => command.name),
      ['fresh'],
    );
  });

  test('skips an mcp.json server entry that does not conform, keeping its neighbours', () => {
    write('kit/plugin.json', JSON.stringify({ name: 'kit' }));
    write(
      'kit/mcp.json',
      JSON.stringify({
        mcpServers: {
          ok: { type: 'stdio', command: 'npx' },
          noCommand: { type: 'stdio' },
          unknownTransport: { type: 'grpc', url: 'https://e/x' },
        },
      }),
    );

    const [plugin] = listLocalPlugins(root).plugins;

    assert.deepEqual(plugin.mcpServers, { ok: { type: 'stdio', command: 'npx' } });
  });

  test('namespaces a command in a sub-directory as `dir:name`', () => {
    write('kit/plugin.json', JSON.stringify({ name: 'kit' }));
    write(`kit/${CC}/commands/git/commit.md`, 'Make a commit.\n');

    const [plugin] = listLocalPlugins(root).plugins;

    assert.deepEqual(
      plugin.commands.map((command) => command.name),
      ['git:commit'],
    );
  });

  test('reads frontmatter YAML would reject, as Claude Code does', () => {
    write('kit/plugin.json', JSON.stringify({ name: 'kit' }));
    write(
      `kit/${CC}/agents/router.md`,
      '---\nname: router\ndescription: The entry router: it routes to a skill.\ntools: [Read, Grep]\n---\n\nYou are a router.\n',
    );

    const [plugin] = listLocalPlugins(root).plugins;

    assert.equal(plugin.agents[0].description, 'The entry router: it routes to a skill.');
    assert.deepEqual(plugin.agents[0].tools, ['Read', 'Grep']);
  });

  test('keeps an argument-hint written as an unquoted YAML list', () => {
    write('kit/plugin.json', JSON.stringify({ name: 'kit' }));
    // Exactly how real packages write it — YAML reads it as a flow sequence.
    write(
      `kit/${CC}/commands/api.md`,
      '---\nargument-hint: [METHOD /endpoint, what to check]\n---\n\nBody.\n',
    );

    const [plugin] = listLocalPlugins(root).plugins;

    assert.equal(plugin.commands[0].argumentHint, '[METHOD /endpoint, what to check]');
  });

  test('ignores a directory that is not a plugin package', () => {
    write('not-a-plugin/README.md', '# nope\n');

    assert.deepEqual(listLocalPlugins(root).plugins, []);
  });

  test('reports a missing folder rather than an empty catalogue', () => {
    assert.throws(
      () => listLocalPlugins(join(root, 'nope')),
      (error: unknown) => (error as { status?: number }).status === 404,
    );
  });
});

describe('writeLocalPlugin', () => {
  test('writes the Agent Plugins layout and reports the path', () => {
    const response = writeLocalPlugin(writeRequest());

    assert.equal(response.path, join(root, 'qa-kit'));
    assert.equal(response.overwritten, false);
    assert.ok(existsSync(join(root, 'qa-kit', 'plugin.json')));
    assert.ok(existsSync(join(root, 'qa-kit', CC, 'commands', 'new-test.md')));
    assert.ok(existsSync(join(root, 'qa-kit', CC, 'agents', 'reviewer.md')));
    assert.ok(existsSync(join(root, 'qa-kit', 'skills', 'api-test', 'SKILL.md')));
    assert.ok(existsSync(join(root, 'qa-kit', 'skills', 'api-test', 'references', 'style.md')));
    // Nothing of the old layout is written, even when it is what is on disk.
    assert.equal(existsSync(join(root, 'qa-kit', '.claude-plugin')), false);
    assert.equal(existsSync(join(root, 'qa-kit', 'commands')), false);

    const manifest = JSON.parse(
      readFileSync(join(root, 'qa-kit', 'plugin.json'), 'utf8'),
    ) as Record<string, unknown>;
    assert.equal(manifest.$schema, PLUGIN_SCHEMA_URL);
    assert.equal(manifest.name, 'qa-kit');
    assert.equal(manifest.version, '1.0.0');
    // The closed schema has no room for our own fields.
    assert.equal(manifest.manifest, undefined);
    assert.deepEqual(manifest.extensions, { [ENGINE_EXTENSION_NS]: { displayName: 'QA Kit' } });
  });

  test('writes an mcp.json only when the plugin declares servers', () => {
    writeLocalPlugin(writeRequest());
    assert.equal(existsSync(join(root, 'qa-kit', 'mcp.json')), false);

    writeLocalPlugin(
      writeRequest({ mcpServers: { api: { type: 'streamable-http', url: 'https://e/mcp' } } }),
    );

    const mcp = JSON.parse(readFileSync(join(root, 'qa-kit', 'mcp.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    assert.equal(mcp.$schema, PLUGIN_MCP_SCHEMA_URL);
    assert.deepEqual(mcp.mcpServers, { api: { type: 'streamable-http', url: 'https://e/mcp' } });
  });

  test('round-trips through listLocalPlugins', () => {
    writeLocalPlugin(
      writeRequest({ mcpServers: { api: { type: 'streamable-http', url: 'https://e/mcp' } } }),
    );

    const [plugin] = listLocalPlugins(root).plugins;

    assert.equal(plugin.id, 'qa-kit');
    assert.equal(plugin.name, 'qa-kit');
    assert.equal(plugin.displayName, 'QA Kit');
    assert.deepEqual(plugin.mcpServers, {
      api: { type: 'streamable-http', url: 'https://e/mcp' },
    });
    assert.deepEqual(plugin.keywords, ['qa']);
    assert.deepEqual(plugin.commands, [
      {
        name: 'new-test',
        description: 'Write a test',
        argumentHint: '[endpoint]',
        allowedTools: ['Read', 'Write'],
        body: 'Write a test for $ARGUMENTS.',
      },
    ]);
    assert.deepEqual(plugin.agents, [
      {
        name: 'reviewer',
        description: 'Reviewer',
        tools: ['Read'],
        systemPrompt: 'You are a reviewer.',
      },
    ]);
    assert.equal(plugin.skills.length, 1);
    assert.equal(plugin.skills[0].name, 'API tests');
    assert.deepEqual(plugin.skills[0].files, [
      { path: 'references/style.md', content: '# Style\n' },
    ]);
  });

  test('overwrites its own package on a second write', () => {
    writeLocalPlugin(writeRequest());
    const again = writeLocalPlugin(
      writeRequest({ description: 'second version', commands: [], agents: [], skills: [] }),
    );

    assert.equal(again.overwritten, true);
  });

  test('keeps a Cyrillic name inside the folder rather than escaping it', () => {
    const response = writeLocalPlugin(
      writeRequest({ id: 'qa-plugin', name: 'qa-plugin', displayName: 'QA plugin' }),
    );

    // Cyrillic is not in the spec's character set, so it collapses to dashes
    // rather than escaping the folder.
    assert.equal(response.path.startsWith(root), true);
    assert.equal(response.path.includes('..'), false);
  });

  test('refuses a resource path that would escape the package', () => {
    assert.throws(
      () =>
        writeLocalPlugin(
          writeRequest({
            skills: [
              {
                id: 'evil',
                name: 'evil',
                description: '',
                instructions: '',
                files: [{ path: '../../escaped.md', content: 'nope' }],
                createdAt: '',
                updatedAt: '',
              },
            ],
          }),
        ),
      (error: unknown) => (error as { status?: number }).status === 400,
    );
    assert.equal(existsSync(join(root, '..', 'escaped.md')), false);
  });

  test('refuses a plugin with no name', () => {
    assert.throws(
      () => writeLocalPlugin(writeRequest({ name: '  ' })),
      (error: unknown) => (error as { status?: number }).status === 400,
    );
  });
});

describe('deleteLocalPlugin', () => {
  test('removes the package it wrote', () => {
    const { path } = writeLocalPlugin(writeRequest());
    assert.equal(existsSync(path), true);

    const response = deleteLocalPlugin({ dir: root, id: 'qa-kit' });

    assert.equal(response.path, path);
    assert.equal(existsSync(path), false);
  });

  // A mistyped id must not take out a folder that happens to share the name:
  // the manifest is what makes a directory a plugin package.
  test('refuses a directory that is not a plugin package', () => {
    write('notes/README.md', '# just a folder\n');

    assert.throws(
      () => deleteLocalPlugin({ dir: root, id: 'notes' }),
      (error: unknown) => (error as { status?: number }).status === 404,
    );
    assert.equal(existsSync(join(root, 'notes', 'README.md')), true);
  });

  test('refuses an id that climbs out of the folder', () => {
    assert.throws(
      () => deleteLocalPlugin({ dir: root, id: '../..' }),
      (error: unknown) => (error as { status?: number }).status === 400,
    );
  });

  test('accepts the legacy manifest location', () => {
    write('legacy/.claude-plugin/plugin.json', JSON.stringify({ name: 'legacy' }));

    deleteLocalPlugin({ dir: root, id: 'legacy' });

    assert.equal(existsSync(join(root, 'legacy')), false);
  });
});
