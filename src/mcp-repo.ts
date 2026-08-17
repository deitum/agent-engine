import {
  ENGINE_EXTENSION_NS,
  McpToolMode,
  McpTransport,
  type McpLibraryEntry,
  type McpProfile,
  type McpServerConfig,
  type McpToolPolicy,
  type PluginMcpServer,
} from './contracts';
import { parseMcpJson } from './plugin-package';
import { slugify } from './skill-package';

/**
 * Reading a repository's **MCP catalogue** — the third kind of package a
 * catalogue repository holds, next to skills and plugins.
 *
 * An entry is a directory carrying an `mcp.json` in the
 * [Agent Plugins §7.2](https://agent-plugins.org/specification) shape, so the
 * very same file can be dropped into any client that reads `mcpServers`. What
 * only this app understands — the label, the one-line description, the
 * tool-visibility presets — travels in `extensions."com.deitum.agent-engine"`,
 * which every other reader ignores.
 *
 * The rule that makes this unambiguous: an entry is an `mcp.json` **outside**
 * every plugin package. A plugin's own `mcp.json` is its payload (spec §7.2),
 * not a catalogue entry, and listing it twice would offer the user a server the
 * plugin already brings.
 */

/** The file that marks a directory as an MCP catalogue entry. */
export const MCP_CATALOG_FILE = 'mcp.json';

/** The tool modes a preset policy may name. */
const TOOL_MODES = new Set<string>(Object.values(McpToolMode));

/**
 * Directories holding an `mcp.json`, minus everything inside a plugin package.
 *
 * {@link pluginDirs} is what `findPluginDirs` reported for the same listing, so
 * the two walks agree on where a plugin begins by construction rather than by
 * repeating the rule.
 */
export function findMcpDirs(paths: string[], pluginDirs: string[] = []): string[] {
  const dirs = paths
    .filter((path) => path === MCP_CATALOG_FILE || path.endsWith(`/${MCP_CATALOG_FILE}`))
    .map((path) => path.slice(0, Math.max(0, path.length - MCP_CATALOG_FILE.length - 1)))
    .filter((dir) => !pluginDirs.some((plugin) => dir === plugin || dir.startsWith(`${plugin}/`)));

  return [...new Set(dirs)].sort((left, right) => left.localeCompare(right));
}

/**
 * Builds the catalogue entries one `mcp.json` declares.
 *
 * Normally a file declares exactly one server and the directory names it — that
 * is the convention the harness repository follows and what keeps an entry's id
 * stable as its contents change. A file declaring several is still read: each
 * server becomes its own entry, keyed `<dir>-<server>`, because a library entry
 * is one connection the user adds and there is nothing to add "both" of.
 */
export function parseMcpCatalogFile(raw: string, dirName: string, now: string): McpLibraryEntry[] {
  const servers = Object.entries(parseMcpJson(raw));
  if (servers.length === 0) {
    return [];
  }

  const extension = readExtension(raw);
  const single = servers.length === 1;

  return servers.map(([key, server]) => {
    const id = single ? slugify(dirName) || slugify(key) : `${slugify(dirName)}-${slugify(key)}`;
    const name = (single && extension.displayName) || key;
    return {
      id,
      name,
      description: extension.description,
      config: toServerConfig(server),
      presets: parsePresets(extension.presets, id, now),
      createdAt: now,
      updatedAt: now,
    };
  });
}

/** This engine's own object inside `mcp.json`'s `extensions` (spec §8). */
function readExtension(raw: string): {
  displayName: string;
  description: string;
  presets: unknown;
} {
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    return { displayName: '', description: '', presets: undefined };
  }
  const extensions = asObject(asObject(document)?.extensions);
  const own = asObject(extensions?.[ENGINE_EXTENSION_NS]);
  return {
    displayName: typeof own?.displayName === 'string' ? own.displayName.trim() : '',
    description: typeof own?.description === 'string' ? own.description.trim() : '',
    presets: own?.presets,
  };
}

/**
 * The spec's server shape as this app's connection config.
 *
 * Both HTTP transports collapse into one: `McpTransport.Http` is Streamable HTTP
 * with an SSE fallback, which is exactly what a client does with either
 * declaration.
 */
function toServerConfig(server: PluginMcpServer): McpServerConfig {
  if (server.type === 'stdio') {
    return {
      transport: McpTransport.Stdio,
      command: server.command,
      ...(server.args?.length ? { args: server.args } : {}),
      ...(server.env ? { env: server.env } : {}),
    };
  }
  return {
    transport: McpTransport.Http,
    url: server.url,
    ...(server.headers ? { headers: server.headers } : {}),
  };
}

/**
 * Tool-visibility presets, in the shape the YAML library used to declare them —
 * `presets[0]` is what the browser offers by default, and each preset's id is
 * prefixed with the entry's so two servers' `deferred` stay distinct.
 */
function parsePresets(value: unknown, entryId: string, now: string): McpProfile[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const presets: McpProfile[] = [];
  for (const item of value) {
    const preset = asObject(item);
    const name = typeof preset?.name === 'string' ? preset.name.trim() : '';
    if (!name) {
      continue;
    }
    presets.push({
      id: `${entryId}-${slugify(name)}`,
      name,
      policies: parsePolicies(preset?.policies),
      createdAt: now,
      updatedAt: now,
    });
  }
  return presets;
}

function parsePolicies(value: unknown): McpToolPolicy[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const policies: McpToolPolicy[] = [];
  for (const item of value) {
    const policy = asObject(item);
    const toolName = typeof policy?.toolName === 'string' ? policy.toolName.trim() : '';
    const mode = typeof policy?.mode === 'string' ? policy.mode.trim() : '';
    // A policy naming a mode this build does not know would silently widen
    // access, so it is dropped rather than guessed at.
    if (!toolName || !TOOL_MODES.has(mode)) {
      continue;
    }
    policies.push({
      toolName,
      mode: mode as McpToolMode,
      ...(typeof policy?.server === 'string' && policy.server.trim()
        ? { server: policy.server.trim() }
        : {}),
    });
  }
  return policies;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
