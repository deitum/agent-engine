import { type McpToolMode, type McpTransport } from './mcp.enums';

/**
 * Configuration for a single MCP server. Mirrors the TypingMind / Claude
 * Desktop `mcpServers` entry shape so users can paste an existing config.
 * `command`/`args`/`env` apply to {@link McpTransport.Stdio}; `url`/`headers`
 * apply to {@link McpTransport.Http}.
 */
export interface McpServerConfig {
  transport: McpTransport;
  /** Executable to spawn (stdio transport). */
  command?: string;
  /** Arguments passed to `command` (stdio transport). */
  args?: string[];
  /** Environment variables for the spawned process (stdio transport). */
  env?: Record<string, string>;
  /** Endpoint URL of a remote MCP server (http transport). */
  url?: string;
  /** Extra headers (e.g. `Authorization`) sent to `url` (http transport). */
  headers?: Record<string, string>;
}

/**
 * The `{ mcpServers: { <name>: config } }` document users paste when adding
 * their own MCP servers. Kept for parity with TypingMind / Claude Desktop.
 */
export interface McpServersConfig {
  mcpServers: Record<string, McpServerConfig>;
}

/**
 * One MCP server in an agent run's scope: the connection config plus the tool
 * policies of the preset selected for it. Forwarded to the local connector,
 * which applies the policies when bridging the server's tools — `disabled`
 * methods never reach the model and `deferred` ones stay behind the load-tools
 * meta-tool, mirroring the browser's own tool loop.
 */
export interface McpToolSource {
  config: McpServerConfig;
  /** Per-tool visibility overrides; omitted or empty = every tool available. */
  policies?: McpToolPolicy[];
}

/** A tool ("method") advertised by an MCP server. */
export interface McpTool {
  name: string;
  description?: string;
  /** JSON Schema describing the tool's arguments. */
  inputSchema: Record<string, unknown>;
}

/** `POST /api/mcp/tools` — list the tools a server exposes for a given config. */
export interface McpListToolsRequest {
  config: McpServerConfig;
}

export interface McpListToolsResponse {
  tools: McpTool[];
}

/** `POST /api/mcp/tools/call` — invoke one tool against a forwarded config. */
export interface McpToolCallRequest {
  config: McpServerConfig;
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface McpToolCallResponse {
  /** Text content returned by the tool (concatenated MCP content blocks). */
  content: string;
  /** True when the MCP server flagged the result as an error. */
  isError?: boolean;
}

/**
 * `GET /ping` response of the local MCP connector daemon (`@deitum/agent-engine`)
 * the user runs on their own machine. Used by the web client to verify the
 * connection before routing tool traffic to `http://localhost:<port>`.
 *
 * What a build *can do* is not advertised here: every route this daemon serves,
 * it serves. Only the two things that vary between two runs of the same build
 * are reported — whether the host's Node can hold the database, and which
 * configuration the daemon is currently holding. An embedder that needs a
 * feature its users may not have yet compares {@link McpConnectorPing.version}.
 */
export interface McpConnectorPing {
  status: 'ok';
  /** Connector package name, e.g. `@deitum/agent-engine`. */
  name: string;
  /** Connector version, so the UI can surface a mismatch. */
  version: string;
  /**
   * Whether the bearer token sent with the probe matches the daemon's. The probe
   * itself stays unauthenticated — a wrong token must still answer, or the UI
   * could not tell "daemon down" from "token wrong" — so the verdict travels
   * here instead.
   */
  authorized: boolean;
  /**
   * Whether this daemon can keep the client database (`POST /storage/*`, a SQLite
   * file under its home). False on a Node without `node:sqlite`, where the daemon
   * runs normally and only the storage routes answer 501 — so an embedder can
   * refuse up front instead of stranding the user's data half-way through a move.
   */
  storage: boolean;
  /**
   * {@link EngineConfigRequest.version} of the configuration the daemon currently
   * holds, or `''` when it holds none (it has just started, or the browser has not
   * connected yet). The browser compares this with the version it computed for its
   * own settings and re-pushes when the two differ — which is how a restarted
   * daemon and an edited setting are both picked up by the ordinary probe, without
   * anything subscribing to anything.
   */
  configVersion: string;
}

/**
 * A curated MCP server template declared in the YAML config file (read-only at
 * runtime). Its `config` may carry `${input:NAME}` placeholders for secrets the
 * user fills in client-side when adding it to their own connections.
 */
export interface McpLibraryEntry {
  id: string;
  name: string;
  description: string;
  config: McpServerConfig;
  /**
   * Tool-visibility presets scoped to this server. A user picks one when adding
   * the entry to their connections; `presets[0]` is the default. Each preset's
   * `id` is prefixed with the entry slug (e.g. `github-readonly`).
   */
  presets: McpProfile[];
  createdAt: string;
  updatedAt: string;
}

/** Visibility policy for a single tool within a profile. */
export interface McpToolPolicy {
  /** Optional server name this policy targets (unset = any server). */
  server?: string;
  toolName: string;
  mode: McpToolMode;
}

/**
 * A named set of tool-visibility policies configuring which methods are
 * available, deferred, or disabled. Declared in the YAML config file.
 */
export interface McpProfile {
  id: string;
  name: string;
  policies: McpToolPolicy[];
  createdAt: string;
  updatedAt: string;
}
