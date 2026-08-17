import { stringify } from 'yaml';

import { ConnectorError } from './connector';
import {
  CLAUDE_CODE_EXTENSION_NS,
  ENGINE_EXTENSION_NS,
  type Manifest,
  type PackageSource,
  PLUGIN_MCP_SCHEMA_URL,
  PLUGIN_SCHEMA_URL,
  type PluginAgent,
  type PluginAuthor,
  type PluginCommand,
  type PluginMcpServer,
  type WritablePlugin,
} from './contracts';
import { parseFrontmatter, parseHint, parseStringList, splitFrontmatter } from './frontmatter';
import {
  manifestToFrontmatter,
  parseManifest,
  parseSource,
  sourceToFrontmatter,
} from './skill-package';

/**
 * The **Agent Plugins v1** package layout — the one place that knows where a
 * plugin keeps its parts, shared by the folder on the user's machine
 * (`local-plugins.ts`) and by a repository walk (`plugin-repo.ts`).
 *
 * Reading is lenient and writing is strict, on purpose. The spec
 * (https://agent-plugins.org/specification) defines a root `plugin.json` with a
 * closed schema, exactly two portable components — `skills/` and `mcp.json` —
 * and a reverse-domain extension directory for everything a client adds on top.
 * That is what this engine writes. But the folder it writes into is the same one
 * that already holds packages in **Claude Code's** older layout
 * (`.claude-plugin/plugin.json`, `commands/` and `agents/` at the root), and
 * refusing to read those would make a working folder look empty.
 *
 * Resolution between the two is a **choice, not a merge**: when the extension
 * directory exists, the legacy root directory is ignored outright. A push into a
 * folder never deletes anything, so a plugin synced over its own older package
 * would otherwise be read back with every command twice.
 */

/** Manifest location, current and legacy. */
export const PLUGIN_MANIFEST = 'plugin.json';
export const LEGACY_PLUGIN_MANIFEST = '.claude-plugin/plugin.json';

/** Portable MCP configuration, and the file Claude Code reads instead. */
export const PLUGIN_MCP_FILE = 'mcp.json';
export const LEGACY_PLUGIN_MCP_FILE = '.mcp.json';

/** Where slash commands and sub-agents live — an extension namespace, not the root. */
export const COMMANDS_DIR = `${CLAUDE_CODE_EXTENSION_NS}/commands`;
export const AGENTS_DIR = `${CLAUDE_CODE_EXTENSION_NS}/agents`;
export const LEGACY_COMMANDS_DIR = 'commands';
export const LEGACY_AGENTS_DIR = 'agents';

/** The one portable component directory whose location never moved. */
export const SKILLS_DIR = 'skills';

/** Longest `name` the spec allows (§5.5). */
const MAX_PLUGIN_NAME = 64;

/**
 * Cyrillic → Latin, so a package titled in Russian still yields a `name` that
 * says something. Without it «Планирование» reduces to nothing at all and the
 * package falls back to its directory — which is how two plugins end up sharing
 * one identifier.
 *
 * Duplicated in the app's `shared/lib/package-name.ts`, which derives the same
 * slug in the browser. The two have to agree, and a published engine cannot
 * import from the application embedding it.
 */
const TRANSLITERATION: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'c',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

/** The transports `mcp.json` may declare (§7.2.1). */
const MCP_TRANSPORTS = new Set(['stdio', 'streamable-http', 'sse']);

/**
 * Reduces a value to a plugin `name` the spec accepts (§5.5): 1–64 characters of
 * lowercase `[a-z0-9.-]`, alphanumeric at both ends, no `--` and no `..`.
 * Returns `''` when nothing usable is left.
 *
 * Deliberately stricter than `packageName` in `skill-package.ts`, which also
 * allows `_`: that one guards a filesystem write, this one produces an
 * identifier another client will validate.
 */
export function pluginName(value: string): string {
  const slug = [...value.trim().toLowerCase()]
    .map((char) => TRANSLITERATION[char] ?? char)
    .join('')
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .slice(0, MAX_PLUGIN_NAME);
  // Slicing can leave a trailing separator behind.
  return slug.replace(/[^a-z0-9]+$/g, '');
}

/** True when a value is already a conforming plugin `name`. */
export function isPluginName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_PLUGIN_NAME &&
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value) &&
    !value.includes('--') &&
    !value.includes('..')
  );
}

/** `plugin.json`'s `author`, accepted as a bare string or an object. */
export function parseAuthor(value: unknown): PluginAuthor | undefined {
  if (typeof value === 'string' && value.trim()) {
    return { name: value.trim() };
  }
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) {
    return undefined;
  }
  return {
    name,
    ...(typeof raw.email === 'string' && raw.email.trim() ? { email: raw.email.trim() } : {}),
    ...(typeof raw.url === 'string' && raw.url.trim() ? { url: raw.url.trim() } : {}),
  };
}

/** What a `plugin.json` says about the package, whichever layout wrote it. */
export interface PluginManifest {
  name: string;
  displayName?: string;
  version: string;
  description: string;
  author?: PluginAuthor;
  keywords: string[];
  manifest: Manifest;
  source?: PackageSource;
}

/**
 * Reads a `plugin.json`. The setup manifest, the display name and the import
 * source belong to this engine, so they are looked for in its `extensions`
 * object first — and then, for a package written before the migration, at the
 * top level, where the closed schema no longer allows them.
 *
 * `fallbackName` is the package directory, used when the manifest names nothing.
 */
export function parsePluginManifest(raw: string, fallbackName: string): PluginManifest {
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    throw new ConnectorError(422, `${PLUGIN_MANIFEST} does not parse as JSON: ${String(error)}`);
  }

  const extensions =
    meta.extensions && typeof meta.extensions === 'object' && !Array.isArray(meta.extensions)
      ? (meta.extensions as Record<string, unknown>)
      : {};
  const own =
    extensions[ENGINE_EXTENSION_NS] && typeof extensions[ENGINE_EXTENSION_NS] === 'object'
      ? (extensions[ENGINE_EXTENSION_NS] as Record<string, unknown>)
      : {};

  const declared = typeof meta.name === 'string' ? meta.name.trim() : '';
  // A pre-spec manifest is free to carry a display name in `name`; the slug is
  // what the rest of the app keys on, so it is derived rather than trusted.
  const name = isPluginName(declared) ? declared : pluginName(declared) || pluginName(fallbackName);
  const displayName = typeof own.displayName === 'string' ? own.displayName.trim() : '';
  const source = parseSource(own.source);

  return {
    name,
    // A legacy `name: «Планирование»` is a display name in all but the field it
    // sits in — keep it rather than let the slug swallow it.
    ...(displayName
      ? { displayName }
      : declared && declared !== name
        ? { displayName: declared }
        : {}),
    version: typeof meta.version === 'string' ? meta.version.trim() : '',
    description: typeof meta.description === 'string' ? meta.description.trim() : '',
    ...(parseAuthor(meta.author) ? { author: parseAuthor(meta.author) } : {}),
    keywords: parseStringList(meta.keywords),
    manifest: parseManifest(own.manifest ?? meta.manifest),
    ...(source ? { source } : {}),
  };
}

/** Serializes a `plugin.json`, strictly within the closed v1 schema. */
export function pluginManifestJson(plugin: WritablePlugin): string {
  const name = pluginName(plugin.name) || pluginName(plugin.id);
  if (!name) {
    throw new ConnectorError(400, 'The plugin name does not yield a conforming `name`');
  }
  const display = (plugin.displayName ?? '').trim() || plugin.name.trim();
  const manifest = manifestToFrontmatter(plugin.manifest);
  const source = sourceToFrontmatter(plugin.source);
  const extension = {
    ...(display && display !== name ? { displayName: display } : {}),
    ...(manifest ? { manifest } : {}),
    ...(source ? { source } : {}),
  };

  return `${JSON.stringify(
    {
      $schema: PLUGIN_SCHEMA_URL,
      name,
      ...(plugin.version.trim() ? { version: plugin.version.trim() } : {}),
      ...(plugin.description.trim() ? { description: plugin.description.trim() } : {}),
      ...(plugin.author ? { author: plugin.author } : {}),
      ...(plugin.keywords.length > 0 ? { keywords: plugin.keywords } : {}),
      ...(Object.keys(extension).length > 0
        ? { extensions: { [ENGINE_EXTENSION_NS]: extension } }
        : {}),
    },
    null,
    2,
  )}\n`;
}

/**
 * Reads an `mcp.json`. Per §7.2.2 the failure boundaries are per-entry: a server
 * whose configuration does not conform is skipped and its neighbours load. A
 * document that is not JSON, or has no `mcpServers` object, yields nothing at
 * all rather than failing the package.
 */
export function parseMcpJson(raw: string): Record<string, PluginMcpServer> {
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!document || typeof document !== 'object') {
    return {};
  }
  const servers = (document as Record<string, unknown>).mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    return {};
  }

  const result: Record<string, PluginMcpServer> = {};
  for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
    const server = parseMcpServer(value);
    if (server) {
      result[name] = server;
    }
  }
  return result;
}

/** One `mcpServers` entry, or `undefined` when it does not match a variant. */
function parseMcpServer(value: unknown): PluginMcpServer | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const type = typeof raw.type === 'string' ? raw.type.trim() : '';
  if (!MCP_TRANSPORTS.has(type)) {
    return undefined;
  }

  if (type === 'stdio') {
    const command = typeof raw.command === 'string' ? raw.command.trim() : '';
    if (!command) {
      return undefined;
    }
    const args = parseStringList(raw.args);
    const env = parseStringMap(raw.env);
    const cwd = typeof raw.cwd === 'string' ? raw.cwd.trim() : '';
    return {
      type: 'stdio',
      command,
      ...(args.length > 0 ? { args } : {}),
      ...(env ? { env } : {}),
      ...(cwd ? { cwd } : {}),
    };
  }

  const url = typeof raw.url === 'string' ? raw.url.trim() : '';
  if (!url) {
    return undefined;
  }
  const headers = parseStringMap(raw.headers);
  return {
    type: type as 'streamable-http' | 'sse',
    url,
    ...(headers ? { headers } : {}),
  };
}

/** An object of string values, or `undefined` when there is nothing usable. */
function parseStringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string') {
      result[key] = item;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Serializes an `mcp.json`, or `undefined` when the plugin declares no servers. */
export function mcpJson(servers: Record<string, PluginMcpServer> | undefined): string | undefined {
  if (!servers || Object.keys(servers).length === 0) {
    return undefined;
  }
  return `${JSON.stringify({ $schema: PLUGIN_MCP_SCHEMA_URL, mcpServers: servers }, null, 2)}\n`;
}

/** Parses one `commands/<name>.md` — frontmatter plus the prompt template. */
export function parseCommandMarkdown(name: string, raw: string): PluginCommand {
  const { frontmatter, body } = splitFrontmatter(raw);
  const meta = parseFrontmatter(frontmatter);
  const allowedTools = parseStringList(meta['allowed-tools'] ?? meta.allowedTools);
  const hint = parseHint(meta['argument-hint'] ?? meta.argumentHint);
  return {
    name,
    description: typeof meta.description === 'string' ? meta.description.trim() : '',
    ...(hint ? { argumentHint: hint } : {}),
    ...(allowedTools.length > 0 ? { allowedTools } : {}),
    body: body.trim(),
  };
}

/** Parses one `agents/<name>.md` — frontmatter plus the sub-agent's prompt. */
export function parseAgentMarkdown(name: string, raw: string): PluginAgent {
  const { frontmatter, body } = splitFrontmatter(raw);
  const meta = parseFrontmatter(frontmatter);
  const tools = parseStringList(meta.tools);
  return {
    name: typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : name,
    description: typeof meta.description === 'string' ? meta.description.trim() : '',
    ...(tools.length > 0 ? { tools } : {}),
    ...(typeof meta.model === 'string' && meta.model.trim() ? { model: meta.model.trim() } : {}),
    systemPrompt: body.trim(),
  };
}

/** Renders a `commands/<name>.md`: frontmatter + the prompt template. */
export function commandMarkdown(command: PluginCommand): string {
  const frontmatter = stringify({
    description: command.description.trim(),
    ...(command.argumentHint ? { 'argument-hint': command.argumentHint } : {}),
    ...(command.allowedTools && command.allowedTools.length > 0
      ? { 'allowed-tools': command.allowedTools.join(', ') }
      : {}),
  }).trimEnd();
  return `---\n${frontmatter}\n---\n\n${command.body.trim()}\n`;
}

/** Renders an `agents/<name>.md`: frontmatter + the sub-agent's system prompt. */
export function agentMarkdown(agent: PluginAgent): string {
  // The file stem carries the namespace; the frontmatter `name` is the bare one.
  const frontmatter = stringify({
    name: agent.name.trim().split(':').pop(),
    description: agent.description.trim(),
    ...(agent.tools && agent.tools.length > 0 ? { tools: agent.tools.join(', ') } : {}),
    ...(agent.model ? { model: agent.model } : {}),
  }).trimEnd();
  return `---\n${frontmatter}\n---\n\n${agent.systemPrompt.trim()}\n`;
}
