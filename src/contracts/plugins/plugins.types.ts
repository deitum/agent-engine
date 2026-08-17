import { type Manifest } from '../manifest/manifest.types';
import { type Skill } from '../skills/skills.types';
import { type PackageSource, type RepoRef } from '../vcs/vcs.types';

/**
 * The canonical manifest schema identifier of Agent Plugins v1.0.0. A plugin
 * package declares it as `$schema`; a client must recognise the value rather
 * than fetch it (spec §5.2).
 */
export const PLUGIN_SCHEMA_URL = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';

/** The matching identifier for a package's `mcp.json` (spec §7.2.1). */
export const PLUGIN_MCP_SCHEMA_URL = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

/**
 * The reverse-domain extension namespace this engine owns, under which its own
 * manifest data travels in `plugin.json`'s `extensions` object (spec §8).
 *
 * The core manifest schema is closed — `displayName`, the setup {@link Manifest}
 * and the import {@link PackageSource} are ours and have nowhere else to live.
 * A client that has never heard of this engine ignores the whole object and
 * still gets the portable skills and MCP configuration.
 */
export const ENGINE_EXTENSION_NS = 'com.deitum.agent-engine';

/**
 * The extension namespace Claude Code's own artifacts travel under. Slash
 * commands and sub-agents are not portable v1 components, so a conforming
 * package keeps them in a directory named for the client that defines them.
 */
export const CLAUDE_CODE_EXTENSION_NS = 'com.anthropic.claude-code';

/**
 * One slash command bundled with a plugin — a
 * `com.anthropic.claude-code/commands/<name>.md` file: YAML frontmatter
 * (`description`, `argument-hint`, `allowed-tools`) plus a markdown body that is
 * the prompt itself.
 *
 * Commands are not a portable Agent Plugins v1 component, which is why they sit
 * in an extension directory rather than at the package root.
 *
 * The body is a **template**: `$ARGUMENTS` (and the positional `$1`…`$9`) are
 * substituted with what the user typed after the command name, and the result is
 * sent as the turn's message.
 */
export interface PluginCommand {
  /**
   * The file stem, used as `/<plugin>:<name>` in the composer — the same
   * namespaced form Claude Code uses, so two plugins can ship a `review`
   * command without colliding.
   */
  name: string;
  /** When-to-use summary shown in the `/` menu (frontmatter `description`). */
  description: string;
  /** Placeholder for the command's arguments (frontmatter `argument-hint`). */
  argumentHint?: string;
  /**
   * Tools the command declares it needs (frontmatter `allowed-tools`). Carried
   * so a plugin round-trips through the editor and back to disk unchanged; the
   * chat and the coding sandbox composers do not narrow their tool scope from it.
   */
  allowedTools?: string[];
  /** The markdown body — the prompt template. */
  body: string;
}

/**
 * A sub-agent bundled with a plugin — a
 * `com.anthropic.claude-code/agents/<name>.md` file. Projected onto a
 * `DeepAgentSubAgent` when the plugin is applied to a project or a Code session;
 * `model` has no counterpart there and is kept for round-tripping only.
 */
export interface PluginAgent {
  name: string;
  /** When to delegate to this sub-agent (frontmatter `description`). */
  description: string;
  /** Allow-list of tool names (frontmatter `tools`). */
  tools?: string[];
  /** Frontmatter `model` (`inherit` or a model id) — documentation only. */
  model?: string;
  /** The markdown body — the sub-agent's system prompt. */
  systemPrompt: string;
}

/** Author block of a `plugin.json` (spec §5.4). */
export interface PluginAuthor {
  name: string;
  email?: string;
  url?: string;
}

/**
 * An MCP server a plugin ships, exactly as `mcp.json` spells it (spec §7.2.1).
 *
 * Deliberately *not* this app's own {@link McpServerConfig}: the portable format
 * is a closed, transport-tagged union with its own field names, and the whole
 * point of reading it is that a package written by someone else's client is
 * understood unchanged. Mapping onto a native connection is a separate step.
 */
export type PluginMcpServer =
  | {
      type: 'stdio';
      /** A bare executable name or a plugin-relative `./path` — never a shell line. */
      command: string;
      args?: string[];
      env?: Record<string, string>;
      /** `./path`, `${PLUGIN_ROOT}[/…]` or `${PLUGIN_DATA}[/…]`; default is the plugin root. */
      cwd?: string;
    }
  | {
      /** `streamable-http` is current; `sse` is the deprecated 2024-11-05 transport. */
      type: 'streamable-http' | 'sse';
      url: string;
      headers?: Record<string, string>;
    };

/**
 * A **plugin**: one bundle carrying skills, MCP servers, slash commands and
 * sub-agents, in the [Agent Plugins v1](https://agent-plugins.org/specification)
 * layout — a root `plugin.json`, portable `skills/` and `mcp.json`, and the
 * client-specific pieces under a reverse-domain extension directory. Where a
 * {@link Skill} is a single instruction package, a plugin is the next unit of
 * packaging above it — attaching one to a project or a Code session brings all
 * of them at once.
 *
 * Shared plugins are read from a directory declared in the YAML config
 * (read-only at runtime); personal plugins mirror this shape in the browser;
 * local ones are read from a folder on the user's machine through the local
 * connector, and imported ones are pulled out of a repository. All are picked by
 * a scoped ref, exactly like skills.
 */
export interface Plugin {
  id: string;
  /**
   * `plugin.json` `name`, and therefore a **slug**: 1–64 characters of
   * `[a-z0-9.-]`, starting and ending alphanumeric, no `--` or `..` (spec §5.5).
   * Also the namespace of the plugin's slash commands and the directory name it
   * is written under.
   */
  name: string;
  /**
   * Human-readable label, when it differs from the slug — a Russian title, a
   * product name with spaces. Lives in this engine's `extensions` object,
   * because the core schema has no field for it. The UI shows this or `name`.
   */
  displayName?: string;
  /** `plugin.json` `version` (free-form; empty when the manifest omits it). */
  version: string;
  description: string;
  author?: PluginAuthor;
  keywords: string[];
  commands: PluginCommand[];
  agents: PluginAgent[];
  /** Skills bundled under `skills/` — the same shape as a standalone skill. */
  skills: Skill[];
  /**
   * MCP servers declared by the package's `mcp.json`, keyed by server name.
   * Carried and round-tripped; the app does not connect them on its own.
   */
  mcpServers?: Record<string, PluginMcpServer>;
  /**
   * Setup manifest: required / recommended MCP servers and recommended
   * settings, shared with skills and deep agents (see {@link Manifest}).
   */
  manifest?: Manifest;
  /** Where this copy came from, when it was imported from a repository. */
  source?: PackageSource;
  createdAt: string;
  updatedAt: string;
}

/**
 * The plugin fields that travel to the local connector when a plugin is written
 * to disk. A subset of {@link Plugin} that both shared plugins and the browser's
 * personal ones satisfy, so timestamps don't have to be carried.
 */
export type WritablePlugin = Pick<
  Plugin,
  | 'id'
  | 'name'
  | 'displayName'
  | 'version'
  | 'description'
  | 'author'
  | 'keywords'
  | 'commands'
  | 'agents'
  | 'skills'
  | 'mcpServers'
  | 'manifest'
  | 'source'
>;

/**
 * `POST /plugins/list` on the local connector daemon — read the plugin packages
 * sitting in a directory on the user's own machine (e.g. `~/.claude/plugins`).
 * `dir` may start with `~` (expanded by the connector).
 */
export interface LocalPluginsListRequest {
  dir: string;
}

export interface LocalPluginsListResponse {
  /** The absolute directory actually read (after `~` expansion), for the UI. */
  dir: string;
  plugins: Plugin[];
}

/**
 * `POST /plugins/write` on the local connector daemon — write one plugin into
 * `<dir>/<id>/` in the Agent Plugins v1 layout. Existing files are overwritten;
 * nothing is deleted.
 */
export interface LocalPluginWriteRequest {
  dir: string;
  /**
   * The plugin to write. Its `id` is the desired **package directory name**, not
   * the store id — callers send a slug (the connector sanitises it further), so
   * re-syncing the same plugin overwrites its own package.
   */
  plugin: WritablePlugin;
}

export interface LocalPluginWriteResponse {
  /** Absolute path of the written package directory. */
  path: string;
  /** True when that directory already existed and was overwritten. */
  overwritten: boolean;
}

/**
 * `POST /plugins/delete` on the local connector daemon — remove one package
 * from that folder. POST rather than DELETE for the same reason as the rest of
 * these routes: the path travels in a JSON body.
 */
export interface LocalPluginDeleteRequest {
  dir: string;
  /** Package directory name — the same slug `LocalPluginWriteRequest` wrote. */
  id: string;
}

export interface LocalPluginDeleteResponse {
  /** Absolute path of the directory that was removed. */
  path: string;
}

/**
 * `POST /plugins/repo/list` on the local connector daemon — walk a repository
 * and report every plugin package in it (a directory holding a `plugin.json`,
 * or a legacy `.claude-plugin/plugin.json`), without downloading its contents.
 *
 * The credentials are not here: they belong to the configuration the browser
 * hands over when it connects.
 */
export interface PluginRepoListRequest {
  repo: RepoRef;
}

/** One package found in a repository, described from its manifest alone. */
export interface RepoPluginSummary {
  /** Package directory relative to the repository root, e.g. `plugins/my-plugin`. */
  path: string;
  /** The manifest `name` — the id the package gets when written to a folder. */
  id: string;
  name: string;
  displayName?: string;
  version: string;
  description: string;
  keywords: string[];
  /** What the package holds, counted from the file listing alone. */
  counts: { commands: number; agents: number; skills: number; mcpServers: number };
}

export interface PluginRepoListResponse {
  /** The branch actually read — resolved when the request named none. */
  ref: string;
  /** Commit that branch pointed at; every path was listed at this revision. */
  commit: string;
  plugins: RepoPluginSummary[];
}

/**
 * `POST /plugins/repo/fetch` — download whole packages named by
 * {@link RepoPluginSummary.path}, commands, sub-agents, skills and all, ready to
 * be stored as personal plugins or written into a folder.
 */
export interface PluginRepoFetchRequest {
  repo: RepoRef;
  /** Package directories to download, as the listing reported them. */
  paths: string[];
}

/** A file left out of a fetched package, and why the connector skipped it. */
export interface PluginRepoSkippedFile {
  /** Path relative to the repository root. */
  path: string;
  reason: 'binary' | 'too-large';
}

export interface PluginRepoFetchResponse {
  ref: string;
  commit: string;
  /** One per requested path, each carrying its {@link Plugin.source}. */
  plugins: Plugin[];
  /**
   * Files that could not travel as text. A plugin is instructions and prompt
   * templates, all of which are read by a model, so a picture or an archive has
   * nothing to contribute — but the user is told rather than left wondering why
   * the package on disk is thinner than the one in the repository.
   */
  skipped: PluginRepoSkippedFile[];
}
