/** Transport used to reach an MCP server. */
export enum McpTransport {
  /** Local subprocess spoken to over stdio (`command` + `args` + `env`). */
  Stdio = 'stdio',
  /** Remote server reached over Streamable HTTP (with SSE fallback) at `url`. */
  Http = 'http',
}

/**
 * How a profile exposes a single MCP tool ("method") to the model.
 *
 * - `Available` — sent to the model in every request's `tools` array.
 * - `Deferred`  — hidden until the model asks for it via the `mcp_load_tools`
 *   meta-tool, then promoted to `Available` for the rest of the conversation.
 * - `Disabled`  — never exposed to the model.
 */
export enum McpToolMode {
  Available = 'available',
  Deferred = 'deferred',
  Disabled = 'disabled',
}
