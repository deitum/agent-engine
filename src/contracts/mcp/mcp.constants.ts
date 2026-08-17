/**
 * Name of the synthetic meta-tool that pulls deferred MCP tools into the
 * model's tool list on demand. Both execution paths expose it under this name:
 * the browser's client-side tool loop (a normal chat) and the deep / coding
 * agent inside the local connector (a project chat or a Code session).
 */
export const MCP_LOAD_TOOLS = 'mcp_load_tools';

/**
 * Model-facing description of {@link MCP_LOAD_TOOLS}.
 *
 * A constant, and short, because the catalogue of loadable tools lives in the
 * `names` enum next to it (see {@link mcpLoadToolsSchema}) rather than in prose
 * here. It used to be both: every deferred tool was listed by name **and**
 * summarized in this string, which made one function description the single
 * largest thing in the request — 10.6 KB of a 21 KB turn, measured on five
 * ordinary servers (168 tools). The enum is the half worth keeping: it is
 * complete, the provider validates against it, and what a tool actually does
 * arrives with the tool the moment it is loaded.
 */
export const MCP_LOAD_TOOLS_DESCRIPTION =
  'Load one or more deferred MCP tools so that you can call them. The `names` enum is the ' +
  "complete list of what this chat has available; pick by name, and a tool's own description " +
  'and arguments arrive with it once loaded. Load everything you expect to need in one call.';

/**
 * The meta-tool's `parameters`, given the model-facing names of the tools that
 * are still deferred. Shared so the connector's agent and the browser's own tool
 * loop offer the identical tool — they already agree on its name and its
 * description, and this is the third half of that promise.
 */
export function mcpLoadToolsSchema(names: string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      names: { type: 'array', items: { type: 'string', enum: names } },
    },
    required: ['names'],
  };
}

/**
 * JSON Schema keywords that describe a *document* rather than a parameter, and
 * which a function-calling endpoint has no use for.
 */
const SCHEMA_META_KEYS = ['$schema', '$id', '$comment', 'definitions', '$defs'];

/**
 * An MCP tool's `inputSchema` as a function's `parameters`.
 *
 * MCP servers commonly build their schemas with zod, whose JSON-Schema emitter
 * stamps `"$schema": "http://json-schema.org/draft-07/schema#"` on top by
 * default. Function-calling endpoints accept only a *subset* of JSON Schema, and
 * a strict gateway answers an unknown top-level keyword with a flat `500` naming
 * nothing — which reaches the user as an opaque traceId and the model as a dead
 * turn. One bad server would otherwise poison every request of every chat it is
 * in scope for.
 *
 * `properties` and `required` are filled in for the same reason: a tool that
 * takes no arguments is legitimate, but «no properties at all» is the shape
 * gateways are most likely to reject.
 */
export function toFunctionParameters(schema: unknown): Record<string, unknown> {
  const source =
    schema && typeof schema === 'object' && !Array.isArray(schema)
      ? (schema as Record<string, unknown>)
      : {};

  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!SCHEMA_META_KEYS.includes(key)) {
      cleaned[key] = value;
    }
  }

  return {
    ...cleaned,
    type: 'object',
    properties: (cleaned.properties as Record<string, unknown>) ?? {},
    required: Array.isArray(cleaned.required) ? cleaned.required : [],
  };
}
