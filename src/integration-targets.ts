import { statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { posix as pathPosix, win32 as pathWin32 } from 'node:path';

import { ConnectorError } from './connector';
import {
  type EnginePackageDirs,
  type IntegrationListRequest,
  type IntegrationListResponse,
  type IntegrationLocation,
  type IntegrationTarget,
} from './contracts';
import { engineHome, type PlatformName } from './platform';

/**
 * Where the other coding agents on this machine keep their configuration.
 *
 * Resolved here rather than in the app that embeds the engine, because every
 * input is a fact about *this* host: the home directory, the platform's
 * separators, and the environment variables each tool honours. A browser that
 * builds `~/.config/opencode` as a string cannot know any of them, and gets
 * Windows wrong in a way it has no way to notice.
 *
 * The one thing worth knowing before reading the table: **all three tools use a
 * literal `.config` / `.claude` folder inside the user's profile on Windows
 * too** — none of them moves to `%APPDATA%`. So the Windows work here is
 * separators and environment variables, not a second tree.
 *
 * Following `platform.ts`, nothing reads `process` inline: the platform, the
 * environment, the home directory and even «is this file on disk» arrive as
 * arguments, so the Windows branches — the ones nobody on this team can run —
 * are reachable from a test on macOS.
 */

/** Everything about the host the resolution below depends on. */
export interface HostFacts {
  platform: PlatformName;
  env: NodeJS.ProcessEnv;
  /** Absolute home directory — what a leading `~` means here. */
  home: string;
  /** Whether a path is on disk. Injected so the table is testable without one. */
  exists: (path: string) => boolean;
}

/** The real host, for the route. */
export function hostFacts(): HostFacts {
  return {
    platform: platform(),
    env: process.env,
    home: homedir(),
    exists: (path) => {
      try {
        return statSync(path) !== undefined;
      } catch {
        return false;
      }
    },
  };
}

/** `node:path` for the *target* platform, not the one this process runs on. */
const pathFor = (platformName: PlatformName) => (platformName === 'win32' ? pathWin32 : pathPosix);

/**
 * `$XDG_CONFIG_HOME`, or `~/.config`.
 *
 * OpenCode honours the variable although its documentation does not mention it,
 * and Kilo Code is a fork of OpenCode. Both fall back to a literal `.config`
 * under the profile on every platform, Windows included.
 */
const configHome = (host: HostFacts): string => {
  const xdg = host.env.XDG_CONFIG_HOME?.trim();
  return xdg ? xdg : pathFor(host.platform).join(host.home, '.config');
};

/**
 * The first candidate that is on disk, or the first one outright.
 *
 * Which is the whole of «which file does this tool actually read»: these tools
 * accept several names in a documented order of precedence, and until one
 * exists there is nothing to prefer, so the caller's first choice is where a new
 * document would be created.
 */
const firstExisting = (host: HostFacts, candidates: string[]): string =>
  candidates.find((candidate) => host.exists(candidate)) ?? candidates[0];

/** A location, with `exists` filled in from the host. */
const locate = (
  host: HostFacts,
  location: Omit<IntegrationLocation, 'exists'>,
): IntegrationLocation => ({ ...location, exists: host.exists(location.configPath) });

/** `.jsonc` files may carry comments; everything else is read as strict JSON. */
const formatOf = (configPath: string): 'json' | 'jsonc' =>
  configPath.toLowerCase().endsWith('.jsonc') ? 'jsonc' : 'json';

/**
 * Claude Code.
 *
 * Its MCP servers are the one part of its setup that lives in `~/.claude.json`;
 * skills, commands, sub-agents and plugins are all folders under `~/.claude`,
 * and its *settings* (model, hooks, permissions) are a third file again
 * (`~/.claude/settings.json`) which this daemon deliberately does not touch.
 * Project-scoped servers go in `.mcp.json` at the project root — not in
 * `.claude/`, which is a mistake worth not making on the user's behalf.
 */
const claudeTarget = (host: HostFacts, projectDir: string | null): IntegrationTarget => {
  const path = pathFor(host.platform);
  const dir = path.join(host.home, '.claude');

  return {
    id: 'claude',
    label: 'Claude Code',
    global: locate(host, {
      scope: 'global',
      configPath: path.join(host.home, '.claude.json'),
      format: 'json',
      mcpKey: 'mcpServers',
      skillsDir: path.join(dir, 'skills'),
      commandsDir: path.join(dir, 'commands'),
      agentsDir: path.join(dir, 'agents'),
      pluginsDir: path.join(dir, 'plugins'),
    }),
    project:
      projectDir === null
        ? null
        : locate(host, {
            scope: 'project',
            configPath: path.join(projectDir, '.mcp.json'),
            format: 'json',
            mcpKey: 'mcpServers',
            skillsDir: path.join(projectDir, '.claude', 'skills'),
            commandsDir: path.join(projectDir, '.claude', 'commands'),
            agentsDir: path.join(projectDir, '.claude', 'agents'),
            // Plugins are installed per user, not per checkout.
            pluginsDir: null,
          }),
    declaresSkillPaths: false,
    declaresAgents: false,
    declaresCommands: false,
    declaresPermissions: false,
    // Claude Code speaks the Anthropic API and reads its model and key from
    // `env` in `~/.claude/settings.json` — neither this file nor a shape an
    // OpenAI-compatible gateway would answer.
    declaresModel: false,
  };
};

/**
 * OpenCode.
 *
 * `OPENCODE_CONFIG` names the config *file* outright and wins over everything;
 * otherwise the document is `opencode.json[c]` under the config home. Its
 * package folders use plural names (`skills`, `commands`, `agents`), and its
 * `plugins/` folder holds JavaScript plugins rather than Agent Plugins
 * packages — which is why `pluginsDir` is `null` and a plugin installed for
 * OpenCode is taken apart into the pieces it does read.
 */
const opencodeTarget = (host: HostFacts, projectDir: string | null): IntegrationTarget => {
  const path = pathFor(host.platform);
  const override = host.env.OPENCODE_CONFIG?.trim();
  const dir = path.join(configHome(host), 'opencode');
  const configPath = override
    ? override
    : firstExisting(host, [path.join(dir, 'opencode.json'), path.join(dir, 'opencode.jsonc')]);
  const projectConfig =
    projectDir === null
      ? null
      : firstExisting(host, [
          path.join(projectDir, 'opencode.json'),
          path.join(projectDir, 'opencode.jsonc'),
        ]);

  return {
    id: 'opencode',
    label: 'OpenCode',
    global: locate(host, {
      scope: 'global',
      configPath,
      format: formatOf(configPath),
      mcpKey: 'mcp',
      skillsDir: path.join(dir, 'skills'),
      commandsDir: path.join(dir, 'commands'),
      agentsDir: path.join(dir, 'agents'),
      pluginsDir: null,
    }),
    project:
      projectDir === null || projectConfig === null
        ? null
        : locate(host, {
            scope: 'project',
            configPath: projectConfig,
            format: formatOf(projectConfig),
            mcpKey: 'mcp',
            skillsDir: path.join(projectDir, '.opencode', 'skills'),
            commandsDir: path.join(projectDir, '.opencode', 'commands'),
            agentsDir: path.join(projectDir, '.opencode', 'agents'),
            pluginsDir: null,
          }),
    // No key for skill folders: packages have to sit in one of the locations
    // OpenCode scans, so `skillsDir` is not a free choice.
    declaresSkillPaths: false,
    declaresAgents: true,
    declaresCommands: true,
    declaresPermissions: true,
    declaresModel: true,
  };
};

/**
 * Kilo Code.
 *
 * A fork of OpenCode, so the shape of the config is the same, but the
 * directories are its own: `.kilo/` wins over the project root, and it no
 * longer falls back to `.opencode`. `skills.paths` is the one config key among
 * the three targets that names arbitrary skill folders, which is why
 * `declaresSkillPaths` exists at all.
 */
const kiloTarget = (host: HostFacts, projectDir: string | null): IntegrationTarget => {
  const path = pathFor(host.platform);
  const override = host.env.KILO_CONFIG?.trim();
  const dir = path.join(configHome(host), 'kilo');
  const configPath = override
    ? override
    : firstExisting(host, [path.join(dir, 'kilo.jsonc'), path.join(dir, 'kilo.json')]);
  const projectConfig =
    projectDir === null
      ? null
      : firstExisting(host, [
          // `.kilo/` is canonical and wins when both define the same entry.
          path.join(projectDir, '.kilo', 'kilo.jsonc'),
          path.join(projectDir, '.kilo', 'kilo.json'),
          path.join(projectDir, 'kilo.jsonc'),
          path.join(projectDir, 'kilo.json'),
        ]);

  return {
    id: 'kilo',
    label: 'Kilo Code',
    global: locate(host, {
      scope: 'global',
      configPath,
      format: formatOf(configPath),
      mcpKey: 'mcp',
      skillsDir: path.join(dir, 'skills'),
      commandsDir: path.join(dir, 'commands'),
      agentsDir: null,
      pluginsDir: null,
    }),
    project:
      projectDir === null || projectConfig === null
        ? null
        : locate(host, {
            scope: 'project',
            configPath: projectConfig,
            format: formatOf(projectConfig),
            mcpKey: 'mcp',
            skillsDir: path.join(projectDir, '.kilo', 'skills'),
            commandsDir: path.join(projectDir, '.kilo', 'commands'),
            agentsDir: null,
            pluginsDir: null,
          }),
    declaresSkillPaths: true,
    declaresAgents: true,
    // Kilo reads slash commands only as files, never from the document.
    declaresCommands: false,
    declaresPermissions: true,
    declaresModel: true,
  };
};

/**
 * The embedding app's own package folders, under the daemon's home.
 *
 * `engineHome` honours `AGENT_ENGINE_HOME`, so this follows the database and
 * the code checkouts wherever the user moved them — the app's skills would
 * otherwise be the one thing left behind in a Cyrillic profile path.
 */
export function resolveEnginePackageDirs(host: HostFacts): EnginePackageDirs {
  const path = pathFor(host.platform);
  const home = engineHome(host.env, host.home, host.platform);
  return {
    skillsDir: path.join(home, 'skills'),
    pluginsDir: path.join(home, 'plugins'),
  };
}

/** Every target this daemon knows, resolved for one host. */
export function resolveIntegrationTargets(
  host: HostFacts,
  projectDir: string | null = null,
): IntegrationTarget[] {
  return [
    claudeTarget(host, projectDir),
    opencodeTarget(host, projectDir),
    kiloTarget(host, projectDir),
  ];
}

/**
 * The project folder as the host spells it: `~` expanded against *this* home,
 * separators normalised by the target platform's rules.
 *
 * A relative path is refused rather than resolved. `path.resolve` would anchor
 * it to the daemon's working directory — which the user never chose, cannot see,
 * and which is wherever `npx` happened to be run — so a typo would quietly
 * produce a plausible path pointing at nothing.
 */
export function expandProjectDir(dir: string, host: HostFacts): string {
  const path = pathFor(host.platform);
  const trimmed = dir.trim();
  if (trimmed === '~') {
    return host.home;
  }
  const expanded =
    trimmed.startsWith('~/') || trimmed.startsWith('~\\')
      ? path.join(host.home, trimmed.slice(2))
      : trimmed;
  if (!path.isAbsolute(expanded)) {
    throw new ConnectorError(400, `Project folder must be an absolute path: ${dir}`);
  }
  return path.normalize(expanded);
}

/**
 * `POST /integrations/list`.
 *
 * A folder that cannot be used is reported rather than thrown: the global
 * locations do not depend on it, and this route is also how a caller learns
 * which tools exist at all. Answering 400 took the whole list down with one
 * stray character in a text field — leaving the screen that would fix that
 * field with no tools to show and no way back.
 */
export function listIntegrationTargets(
  request: IntegrationListRequest,
  host: HostFacts = hostFacts(),
): IntegrationListResponse {
  let projectDir: string | null = null;
  let projectDirError: string | undefined;

  if (request.projectDir?.trim()) {
    try {
      projectDir = expandProjectDir(request.projectDir, host);
    } catch (error) {
      projectDirError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    platform: host.platform,
    home: host.home,
    targets: resolveIntegrationTargets(host, projectDir),
    engine: resolveEnginePackageDirs(host),
    ...(projectDirError === undefined ? {} : { projectDirError }),
  };
}
