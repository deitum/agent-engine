import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path';

import { ConnectorError } from './connector';
import {
  type LocalPluginDeleteRequest,
  type LocalPluginDeleteResponse,
  type LocalPluginWriteRequest,
  type LocalPluginWriteResponse,
  type Plugin,
  type PluginAgent,
  type PluginCommand,
  type Skill,
} from './contracts';
import { RM_RETRY } from './platform.constants';
import {
  AGENTS_DIR,
  agentMarkdown,
  COMMANDS_DIR,
  commandMarkdown,
  LEGACY_AGENTS_DIR,
  LEGACY_COMMANDS_DIR,
  LEGACY_PLUGIN_MANIFEST,
  LEGACY_PLUGIN_MCP_FILE,
  mcpJson,
  parseAgentMarkdown,
  parseCommandMarkdown,
  parseMcpJson,
  parsePluginManifest,
  PLUGIN_MANIFEST,
  PLUGIN_MCP_FILE,
  pluginManifestJson,
  pluginName,
  SKILLS_DIR,
} from './plugin-package';
import {
  expandHome,
  packageName,
  readSkillPackages,
  safeRelativePath,
  writeFileEnsured,
  writeSkillPackage,
} from './skill-package';

/**
 * Reads every plugin package in a directory on the user's machine (typically
 * `~/.claude/plugins`) and writes one back into it.
 *
 * The layout — and the reason reading accepts two of them — is described in
 * `plugin-package.ts`. A missing directory is an error here, because the user
 * typed the path. Mirrors the API's `plugins.loader.ts`.
 */
export function listLocalPlugins(dir: string): { dir: string; plugins: Plugin[] } {
  const root = expandHome(dir);

  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    throw new ConnectorError(404, `Folder not found: ${root}`);
  }

  const plugins: Plugin[] = [];
  for (const entry of entries.sort()) {
    const pluginDir = join(root, entry);
    try {
      if (!statSync(pluginDir).isDirectory()) {
        continue;
      }
    } catch {
      // Same reasoning as `readSkillPackages`: one unreadable entry is skipped,
      // not turned into a failed listing.
      continue;
    }
    const manifest = readFirst(pluginDir, [PLUGIN_MANIFEST, LEGACY_PLUGIN_MANIFEST]);
    if (manifest === undefined) {
      continue; // Not a plugin package — just another directory.
    }
    try {
      plugins.push(readPluginPackage(entry, pluginDir, manifest));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ConnectorError(422, `Malformed plugin ${entry}: ${message}`);
    }
  }

  return { dir: root, plugins };
}

/** The first of {@link candidates} that reads as a file, or `undefined`. */
function readFirst(base: string, candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    try {
      return readFileSync(join(base, ...candidate.split('/')), 'utf8');
    } catch {
      // Try the next spelling.
    }
  }
  return undefined;
}

/**
 * The first of {@link candidates} that exists as a directory. A **choice, not a
 * merge** — see the note in `plugin-package.ts`.
 */
function pickDir(base: string, candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    const full = join(base, ...candidate.split('/'));
    try {
      if (statSync(full).isDirectory()) {
        return full;
      }
    } catch {
      // Try the next spelling.
    }
  }
  return undefined;
}

/** Builds a {@link Plugin} from a package directory and its `plugin.json`. */
function readPluginPackage(entry: string, pluginDir: string, rawManifest: string): Plugin {
  const stats = statSync(pluginDir);
  const meta = parsePluginManifest(rawManifest, entry);
  const skillsDir = join(pluginDir, SKILLS_DIR);
  const rawMcp = readFirst(pluginDir, [PLUGIN_MCP_FILE, LEGACY_PLUGIN_MCP_FILE]);
  const mcpServers = rawMcp === undefined ? {} : parseMcpJson(rawMcp);

  return {
    // The directory name is the id, so re-syncing overwrites its own package
    // rather than forking one (same rule as a local skill).
    id: entry,
    ...meta,
    commands: readCommands(pickDir(pluginDir, [COMMANDS_DIR, LEGACY_COMMANDS_DIR])),
    agents: readAgents(pickDir(pluginDir, [AGENTS_DIR, LEGACY_AGENTS_DIR])),
    skills: existsSync(skillsDir) ? readSkillPackages(skillsDir) : ([] as Skill[]),
    ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    createdAt: stats.birthtime.toISOString(),
    updatedAt: stats.mtime.toISOString(),
  };
}

/** Reads `commands/*.md` — the prompt templates the composer offers. */
function readCommands(dir: string | undefined): PluginCommand[] {
  return readMarkdownFiles(dir).map(({ name, raw }) => parseCommandMarkdown(name, raw));
}

/** Reads `agents/*.md` — one sub-agent per file, its body the system prompt. */
function readAgents(dir: string | undefined): PluginAgent[] {
  return readMarkdownFiles(dir).map(({ name, raw }) => parseAgentMarkdown(name, raw));
}

/**
 * Every `.md` file under {@link dir}, named the way Claude Code names it: the
 * file stem, prefixed with its sub-directory as `<dir>:<stem>`.
 */
function readMarkdownFiles(dir: string | undefined): { name: string; raw: string }[] {
  const files: { name: string; raw: string }[] = [];
  if (!dir) {
    return files;
  }

  const walk = (current: string, prefix: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      try {
        if (statSync(full).isDirectory()) {
          walk(full, `${prefix}${entry}:`);
          continue;
        }
        if (extname(entry) !== '.md') {
          continue;
        }
        files.push({ name: `${prefix}${basename(entry, '.md')}`, raw: readFileSync(full, 'utf8') });
      } catch {
        // An entry that cannot be read is not a command — skip it.
      }
    }
  };

  walk(dir, '');
  return files;
}

/**
 * Writes one plugin into `<dir>/<id>/` in the Agent Plugins v1 layout: a root
 * `plugin.json`, an `mcp.json` when it declares servers, each bundled skill as a
 * `skills/<id>/SKILL.md` package, and its slash commands and sub-agents under
 * the `com.anthropic.claude-code/` extension directory.
 *
 * Strictly the spec layout, even when the package already on disk uses Claude
 * Code's older one — reading accepts both, so the upgraded package still loads
 * here on the next pass.
 *
 * Existing files are overwritten in place; entries the plugin no longer carries
 * are left alone (the UI warns about this).
 */
export function writeLocalPlugin(request: LocalPluginWriteRequest): LocalPluginWriteResponse {
  const root = expandHome(request.dir);
  const { plugin } = request;
  const name = plugin.name.trim();
  if (!name) {
    throw new ConnectorError(400, 'The plugin has no name');
  }

  // The directory is named for the conforming `name`, so that the package the
  // manifest describes and the folder it sits in agree.
  const segment = pluginName(plugin.id) || pluginName(name);
  if (!segment) {
    throw new ConnectorError(400, 'The plugin name does not yield a folder name');
  }
  const base = join(root, segment);
  const overwritten = existsSync(base);

  // Validate every derived path before writing anything, so a bad entry cannot
  // leave a half-written package on disk.
  const commands = plugin.commands
    .filter((command) => command.name.trim())
    .map((command) => ({
      path: safeRelativePath(`${entryPath(command.name)}.md`),
      content: commandMarkdown(command),
    }));
  const agents = plugin.agents
    .filter((agent) => agent.name.trim())
    .map((agent) => ({
      path: safeRelativePath(`${entryPath(agent.name)}.md`),
      content: agentMarkdown(agent),
    }));
  const skills = plugin.skills
    .filter((skill) => skill.name.trim())
    .map((skill) => ({
      segment: packageName(skill.id) || packageName(skill.name),
      skill,
    }));
  const manifestJson = pluginManifestJson(plugin);
  const mcp = mcpJson(plugin.mcpServers);

  writeFileEnsured(join(base, PLUGIN_MANIFEST), manifestJson);
  if (mcp) {
    writeFileEnsured(join(base, PLUGIN_MCP_FILE), mcp);
  }
  for (const command of commands) {
    writeFileEnsured(
      join(base, ...COMMANDS_DIR.split('/'), ...command.path.split('/')),
      command.content,
    );
  }
  for (const agent of agents) {
    writeFileEnsured(join(base, ...AGENTS_DIR.split('/'), ...agent.path.split('/')), agent.content);
  }
  for (const { segment: skillSegment, skill } of skills) {
    if (!skillSegment) {
      throw new ConnectorError(400, `The skill name «${skill.name}» does not yield a folder name`);
    }
    writeSkillPackage(join(base, SKILLS_DIR, skillSegment), skill);
  }

  return { path: base, overwritten };
}

/**
 * Removes one plugin package from a folder on the user's machine.
 *
 * The containment check is spelled out here rather than reused from
 * `resolvePackageDir`, which slugifies with `packageName`: a plugin directory is
 * named by the stricter {@link pluginName}, and a delete that re-slugified with
 * the looser rule could resolve to a directory other than the one the caller
 * meant. Presence of a manifest is required before anything is removed, so a
 * mistyped id cannot take out an unrelated folder that happens to share the name.
 */
export function deleteLocalPlugin(request: LocalPluginDeleteRequest): LocalPluginDeleteResponse {
  const root = expandHome(request.dir);
  const segment = pluginName(request.id);
  if (!segment) {
    throw new ConnectorError(400, 'The plugin name does not yield a folder name');
  }
  const base = join(root, segment);
  const rel = relative(root, base);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.includes(sep)) {
    throw new ConnectorError(400, `Invalid plugin name: ${request.id}`);
  }

  if (!existsSync(join(base, PLUGIN_MANIFEST)) && !existsSync(join(base, LEGACY_PLUGIN_MANIFEST))) {
    throw new ConnectorError(404, `Plugin package not found: ${base}`);
  }

  rmSync(base, RM_RETRY);

  return { path: base };
}

/**
 * A `<dir>:<stem>` command / agent name back into a relative file path. The
 * segments still go through `safeRelativePath` at the call site.
 */
function entryPath(name: string): string {
  return name
    .trim()
    .split(':')
    .map((part) => packageName(part))
    .filter(Boolean)
    .join('/');
}
