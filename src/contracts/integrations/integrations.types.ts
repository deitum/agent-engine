/**
 * Other coding agents installed on the same machine — where each of them keeps
 * its configuration, and how this daemon edits it on the user's behalf.
 *
 * The daemon resolves those locations rather than the app that embeds it,
 * because they are facts about *this* host: the home directory, the platform's
 * separators, and the environment variables each tool honours. An embedder
 * building `~/.config/opencode` into a string in a browser gets it wrong on
 * Windows and cannot find out from there.
 */

/** The agents this daemon knows how to locate. */
export type IntegrationTargetId = 'claude' | 'opencode' | 'kilo';

/** How a target's config document is parsed — Kilo's file permits comments. */
export type IntegrationConfigFormat = 'json' | 'jsonc';

/** Whether a location is the per-user one or belongs to a project folder. */
export type IntegrationScope = 'global' | 'project';

/**
 * One resolved place a target keeps its configuration and packages, with every
 * path already absolute and in the host's own separators.
 *
 * A `null` folder is not «unknown» — it means the target has no such folder and
 * takes that part of its setup in the config document instead (OpenCode's
 * `command`) or has no concept of it at all (Kilo and OpenCode have no Agent
 * Plugins format).
 */
export interface IntegrationLocation {
  scope: IntegrationScope;
  /** Absolute path of the config document, whether or not it is there yet. */
  configPath: string;
  /** True when that file is already on disk. */
  exists: boolean;
  format: IntegrationConfigFormat;
  /**
   * Top-level key the target's MCP servers live under — `mcpServers` for Claude
   * Code, `mcp` for the OpenCode family. The key path a caller patches is
   * `[mcpKey, <server name>]`.
   */
  mcpKey: string;
  /** Absolute folder holding Agent Skills packages. */
  skillsDir: string;
  /** Slash-command markdown, or `null` when commands go into the config. */
  commandsDir: string | null;
  /** Sub-agent markdown, or `null` when sub-agents go into the config. */
  agentsDir: string | null;
  /** Agent Plugins packages, or `null` when the target has no plugin format. */
  pluginsDir: string | null;
}

/**
 * One target as this host has it: what it is called, and both of the places it
 * reads — plus the handful of flags that say which halves of a setup it takes
 * in its config rather than from disk.
 */
export interface IntegrationTarget {
  id: IntegrationTargetId;
  label: string;
  global: IntegrationLocation;
  /** Resolved only when the request named a project folder; `null` otherwise. */
  project: IntegrationLocation | null;
  /**
   * True when the config can name arbitrary skill folders (Kilo's
   * `skills.paths`). The others scan fixed locations only, so their skill
   * packages have to be written into `skillsDir` and nowhere else.
   */
  declaresSkillPaths: boolean;
  /** True when the config carries sub-agents (`agent`). */
  declaresAgents: boolean;
  /** True when the config carries slash commands (`command`). */
  declaresCommands: boolean;
  /** True when per-tool permissions can be expressed (`permission`). */
  declaresPermissions: boolean;
  /**
   * True when the config can point the agent at an OpenAI-compatible gateway
   * (`provider` + `model`). False for Claude Code, which speaks the Anthropic
   * API and reads its model and key from `env` in `~/.claude/settings.json` — a
   * different file from the one this location names.
   */
  declaresModel: boolean;
}

/**
 * Where this daemon keeps the packages that belong to the **embedding app
 * itself**, rather than to one of the agents above.
 *
 * An app that lets its users write a skill has to put it somewhere, and the
 * obvious somewhere is a folder next to the daemon's own state — the same
 * layout every target here already uses, so the app's own packages can be read,
 * copied and edited by exactly the routes that serve the others
 * (`/skills/*`, `/plugins/*`).
 *
 * It is reported here rather than as a fourth {@link IntegrationTarget} because
 * there is no config document behind it: an {@link IntegrationLocation} is
 * built around `configPath` / `mcpKey` / `format`, and the app's own settings
 * are the app's business, not a file on disk this daemon edits.
 */
export interface EnginePackageDirs {
  /** Agent Skills packages belonging to the embedding app. */
  skillsDir: string;
  /** Agent Plugins packages belonging to the embedding app. */
  pluginsDir: string;
}

/** `POST /integrations/list` — every target, resolved for this host. */
export interface IntegrationListRequest {
  /**
   * Absolute folder of the project whose config should be resolved as well (may
   * start with `~`). Omitted or blank, and every target's `project` is `null`.
   */
  projectDir?: string;
}

export interface IntegrationListResponse {
  /** `os.platform()` of the machine this daemon runs on, for the UI's wording. */
  platform: string;
  /** The user's home directory, absolute — what `~` means on this host. */
  home: string;
  targets: IntegrationTarget[];
  /** The embedding app's own package folders — see {@link EnginePackageDirs}. */
  engine: EnginePackageDirs;
  /**
   * Why the `projectDir` that was asked for could not be used, or absent when
   * there was none to use or it resolved.
   *
   * The targets are still resolved — with `project: null` — because their
   * global locations do not depend on that folder, and this list is also how a
   * caller learns which tools exist at all. Failing the whole call over it
   * leaves the very screen that would fix the folder with nothing to render.
   */
  projectDirError?: string;
}

/** `POST /integrations/config/read` — a target's config document, verbatim. */
export interface IntegrationConfigReadRequest {
  path: string;
}

export interface IntegrationConfigReadResponse {
  /** The absolute path actually read, after `~` expansion. */
  path: string;
  exists: boolean;
  /** The file's bytes as text, or `''` when it is not there yet. */
  content: string;
  /**
   * Last modification time in epoch milliseconds, or `0` when absent. Handed
   * back to a write as `expectedMtimeMs` so an edit made in the user's own
   * editor between the read and the save is refused rather than overwritten.
   */
  mtimeMs: number;
}

/** `POST /integrations/config/write` — replace the document wholesale. */
export interface IntegrationConfigWriteRequest {
  path: string;
  content: string;
  /**
   * The `mtimeMs` the caller last read. When it no longer matches the file on
   * disk the write is refused with 409; omit it to write unconditionally.
   */
  expectedMtimeMs?: number;
}

/**
 * One key of a config document, set or removed without disturbing the rest of
 * the file.
 */
export interface IntegrationConfigEdit {
  /**
   * Path to the key, outermost first — `['mcpServers', 'jira']`. Every missing
   * object along the way is created.
   */
  keyPath: string[];
  /**
   * The value to put there, or `null` to remove the key entirely. A JSON `null`
   * is not otherwise a value this route writes; nothing that configures these
   * tools is expressed as one.
   */
  value: unknown;
}

/**
 * `POST /integrations/config/patch` — change named keys and leave every other
 * byte alone.
 *
 * The route a caller uses to install one MCP server or point a target at a
 * gateway. It exists separately from the wholesale write because these are the
 * user's own files: `~/.claude.json` also holds their project history, and a
 * `kilo.jsonc` holds their comments. Round-tripping either through
 * `JSON.parse` / `JSON.stringify` to add one key would reformat the whole
 * document and silently drop the comments.
 */
export interface IntegrationConfigPatchRequest {
  path: string;
  format?: IntegrationConfigFormat;
  edits: IntegrationConfigEdit[];
  expectedMtimeMs?: number;
}

/** What both writing routes answer with. */
export interface IntegrationConfigWriteResponse {
  path: string;
  /** The file's new modification time — the caller's next `expectedMtimeMs`. */
  mtimeMs: number;
  /**
   * Where the previous contents were copied before being replaced, or `null`
   * when the file was created by this call and there was nothing to keep.
   */
  backupPath: string | null;
}
