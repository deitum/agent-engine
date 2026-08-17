/**
 * A single MCP-server dependency declared by a {@link Manifest}. `id` is the MCP
 * library-entry id (slug) when the server was picked from the curated library,
 * so the UI can cross-reference it; `name` is the display name.
 */
export interface McpRequirement {
  id: string;
  name: string;
  /** What the skill/agent uses this server for (optional). */
  note?: string;
}

/**
 * A setup manifest shared by skills and deep agents: declarative metadata
 * describing what is needed to run well — required / recommended MCP servers and
 * recommended settings. It is documentation the UI surfaces (e.g. a warning when
 * a required server is not in the chat's MCP scope); it does not itself change
 * runtime behaviour.
 */
export interface Manifest {
  /** MCP servers needed to function. */
  requiredMcp: McpRequirement[];
  /** MCP servers that enhance behaviour but aren't required. */
  recommendedMcp: McpRequirement[];
  /** Recommended model id (e.g. a large-context or reasoning model). */
  recommendedModel?: string;
  /** Free-form setup notes shown to the user. */
  notes?: string;
}
