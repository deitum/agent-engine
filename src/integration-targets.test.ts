import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  expandProjectDir,
  type HostFacts,
  listIntegrationTargets,
  resolveEnginePackageDirs,
  resolveIntegrationTargets,
} from './integration-targets';

/**
 * Half of what this module decides only matters on Windows, and nobody on this
 * team runs one — so the platform, the environment, the home directory and «is
 * this file on disk» all arrive as arguments, and these tests are the only place
 * the `win32` branches are exercised at all.
 *
 * They are written against the paths the tools themselves document, not against
 * whatever the code happens to produce: getting one of these wrong means the
 * screen points a user at a file their agent never reads.
 */

/** A host with nothing on disk, so every path is the default one. */
const host = (over: Partial<HostFacts> = {}): HostFacts => ({
  platform: 'darwin',
  env: {},
  home: '/Users/dev',
  exists: () => false,
  ...over,
});

/** The same, spelled the way a Windows box would. */
const windows = (over: Partial<HostFacts> = {}): HostFacts =>
  host({ platform: 'win32', home: 'C:\\Users\\Müller', ...over });

const targetOf = (facts: HostFacts, id: string, projectDir: string | null = null) => {
  const target = resolveIntegrationTargets(facts, projectDir).find((item) => item.id === id);
  assert.ok(target, `no target ${id}`);
  return target;
};

describe('Claude Code', () => {
  test('keeps MCP in ~/.claude.json and packages in ~/.claude', () => {
    const claude = targetOf(host(), 'claude');

    assert.equal(claude.global.configPath, '/Users/dev/.claude.json');
    assert.equal(claude.global.mcpKey, 'mcpServers');
    assert.equal(claude.global.skillsDir, '/Users/dev/.claude/skills');
    assert.equal(claude.global.commandsDir, '/Users/dev/.claude/commands');
    assert.equal(claude.global.agentsDir, '/Users/dev/.claude/agents');
    assert.equal(claude.global.pluginsDir, '/Users/dev/.claude/plugins');
  });

  // The whole point of resolving on the daemon: a browser building this string
  // would produce `/` separators and a `~` nobody expands.
  test('on Windows that is the same profile, not %APPDATA%', () => {
    const claude = targetOf(windows(), 'claude');

    assert.equal(claude.global.configPath, 'C:\\Users\\Müller\\.claude.json');
    assert.equal(claude.global.skillsDir, 'C:\\Users\\Müller\\.claude\\skills');
  });

  // `.mcp.json` at the project root — not `.claude/.mcp.json`, and not
  // `settings.json`, both of which are the mistakes worth not making for the user.
  test('project servers are .mcp.json at the project root', () => {
    const claude = targetOf(host(), 'claude', '/work/repo');

    assert.equal(claude.project?.configPath, '/work/repo/.mcp.json');
    assert.equal(claude.project?.skillsDir, '/work/repo/.claude/skills');
    // Plugins are installed per user; a checkout has no folder of its own.
    assert.equal(claude.project?.pluginsDir, null);
  });

  test('makes no promise that the model will go to that file', () => {
    assert.equal(targetOf(host(), 'claude').declaresModel, false);
  });
});

describe('OpenCode', () => {
  test('lives under ~/.config, not under ~/.opencode', () => {
    const opencode = targetOf(host(), 'opencode');

    assert.equal(opencode.global.configPath, '/Users/dev/.config/opencode/opencode.json');
    assert.equal(opencode.global.mcpKey, 'mcp');
    assert.equal(opencode.global.skillsDir, '/Users/dev/.config/opencode/skills');
    // Its `plugins/` holds JavaScript plugins, not Agent Plugins packages.
    assert.equal(opencode.global.pluginsDir, null);
  });

  test('obeys XDG_CONFIG_HOME', () => {
    const opencode = targetOf(host({ env: { XDG_CONFIG_HOME: '/opt/cfg' } }), 'opencode');

    assert.equal(opencode.global.configPath, '/opt/cfg/opencode/opencode.json');
    assert.equal(opencode.global.skillsDir, '/opt/cfg/opencode/skills');
  });

  test('OPENCODE_CONFIG overrides everything and names the file itself', () => {
    const opencode = targetOf(
      host({ env: { XDG_CONFIG_HOME: '/opt/cfg', OPENCODE_CONFIG: '/etc/oc/custom.jsonc' } }),
      'opencode',
    );

    assert.equal(opencode.global.configPath, '/etc/oc/custom.jsonc');
    // The suffix, not the target, decides whether comments are allowed.
    assert.equal(opencode.global.format, 'jsonc');
  });

  // Both names are read; until one exists there is nothing to prefer, so the
  // first candidate is where a new document would be created.
  test('prefers the file that already exists', () => {
    const existing = '/Users/dev/.config/opencode/opencode.jsonc';
    const opencode = targetOf(host({ exists: (path) => path === existing }), 'opencode');

    assert.equal(opencode.global.configPath, existing);
    assert.equal(opencode.global.exists, true);
  });

  test('on Windows it is the same literal .config inside the profile', () => {
    const opencode = targetOf(windows(), 'opencode');

    assert.equal(opencode.global.configPath, 'C:\\Users\\Müller\\.config\\opencode\\opencode.json');
  });
});

describe('Kilo Code', () => {
  test('lives in ~/.config/kilo and reads commands only as files', () => {
    const kilo = targetOf(host(), 'kilo');

    assert.equal(kilo.global.configPath, '/Users/dev/.config/kilo/kilo.jsonc');
    assert.equal(kilo.global.format, 'jsonc');
    assert.equal(kilo.global.commandsDir, '/Users/dev/.config/kilo/commands');
    assert.equal(kilo.declaresCommands, false);
    // The one target whose config can name an arbitrary skills folder.
    assert.equal(kilo.declaresSkillPaths, true);
    // Sub-agents go into the document instead.
    assert.equal(kilo.global.agentsDir, null);
  });

  test('KILO_CONFIG overrides the path', () => {
    const kilo = targetOf(host({ env: { KILO_CONFIG: '/etc/kilo.json' } }), 'kilo');

    assert.equal(kilo.global.configPath, '/etc/kilo.json');
    assert.equal(kilo.global.format, 'json');
  });

  // `.kilo/` is canonical and wins when both define the same entry — and Kilo no
  // longer falls back to `.opencode` anywhere.
  test('a project’s .kilo/ beats the root', () => {
    const kilo = targetOf(
      host({ exists: (path) => path === '/work/repo/kilo.jsonc' }),
      'kilo',
      '/work/repo',
    );
    assert.equal(kilo.project?.configPath, '/work/repo/kilo.jsonc');

    const nested = targetOf(
      host({
        exists: (path) =>
          path === '/work/repo/kilo.jsonc' || path === '/work/repo/.kilo/kilo.jsonc',
      }),
      'kilo',
      '/work/repo',
    );
    assert.equal(nested.project?.configPath, '/work/repo/.kilo/kilo.jsonc');
  });
});

describe('expandProjectDir', () => {
  test('expands ~ against this host’s home folder', () => {
    assert.equal(expandProjectDir('~/work/repo', host()), '/Users/dev/work/repo');
    assert.equal(expandProjectDir('~', host()), '/Users/dev');
  });

  test('expands a backslash too on Windows', () => {
    assert.equal(expandProjectDir('~\\work\\repo', windows()), 'C:\\Users\\Müller\\work\\repo');
  });

  // Resolving would anchor it to wherever `npx` was run — a directory the user
  // never chose and cannot see, so a typo would point at something plausible.
  test('refuses a relative path rather than completing it', () => {
    assert.throws(() => expandProjectDir('work/repo', host()), /absolute path/);
  });
});

describe('resolveEnginePackageDirs', () => {
  test('the app’s own packages sit beside the rest of the daemon’s state', () => {
    assert.deepEqual(resolveEnginePackageDirs(host()), {
      skillsDir: '/Users/dev/.agent-engine/skills',
      pluginsDir: '/Users/dev/.agent-engine/plugins',
    });
  });

  test('on Windows it is the same profile and its separators', () => {
    assert.deepEqual(resolveEnginePackageDirs(windows()), {
      skillsDir: 'C:\\Users\\Müller\\.agent-engine\\skills',
      pluginsDir: 'C:\\Users\\Müller\\.agent-engine\\plugins',
    });
  });

  // The whole point of `AGENT_ENGINE_HOME` is a profile path Docker mishandles;
  // the app's own packages have to follow the move, not stay behind in it.
  test('follows AGENT_ENGINE_HOME', () => {
    assert.deepEqual(
      resolveEnginePackageDirs(windows({ env: { AGENT_ENGINE_HOME: 'D:\\engine' } })),
      {
        skillsDir: 'D:\\engine\\skills',
        pluginsDir: 'D:\\engine\\plugins',
      },
    );
  });
});

describe('listIntegrationTargets', () => {
  test('with no project folder there are no project scopes at all', () => {
    const response = listIntegrationTargets({}, host());

    assert.equal(response.platform, 'darwin');
    assert.equal(response.home, '/Users/dev');
    assert.equal(response.engine.skillsDir, '/Users/dev/.agent-engine/skills');
    assert.deepEqual(
      response.targets.map((target) => target.id),
      ['claude', 'opencode', 'kilo'],
    );
    assert.ok(response.targets.every((target) => target.project === null));
  });

  test('with a project folder there is one, and it is expanded', () => {
    const response = listIntegrationTargets({ projectDir: '~/work/repo' }, host());
    const claude = response.targets.find((target) => target.id === 'claude');

    assert.equal(claude?.project?.configPath, '/Users/dev/work/repo/.mcp.json');
  });

  // Picking a project folder is how a user asks for a project config, so a
  // target that has none yet names the file it *would* create rather than
  // refusing the scope.
  test('the project config is named even before it exists', () => {
    const response = listIntegrationTargets({ projectDir: '/work/repo' }, host());
    const opencode = response.targets.find((target) => target.id === 'opencode');

    assert.equal(opencode?.project?.configPath, '/work/repo/opencode.json');
    assert.equal(opencode?.project?.exists, false);
  });

  // The folder is one field of a screen whose other half is the tool list; a
  // half-typed path there used to 400 the call and leave the caller with no
  // tools at all — including the one whose folder field it was.
  test('a broken project folder does not take the tool list down with it', () => {
    const response = listIntegrationTargets({ projectDir: 'x' }, host());

    assert.deepEqual(
      response.targets.map((target) => target.id),
      ['claude', 'opencode', 'kilo'],
    );
    assert.ok(response.targets.every((target) => target.project === null));
    assert.match(response.projectDirError ?? '', /absolute path/);
  });

  test('a healthy folder says nothing about an error', () => {
    assert.equal(
      listIntegrationTargets({ projectDir: '~/work' }, host()).projectDirError,
      undefined,
    );
    assert.equal(listIntegrationTargets({}, host()).projectDirError, undefined);
  });
});
