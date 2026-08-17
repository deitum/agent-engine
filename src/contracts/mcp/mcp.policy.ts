import { McpToolMode } from './mcp.enums';
import { type McpToolPolicy } from './mcp.types';

/** `toolName` matching every tool of a server (see `profiles[]` in the YAML config). */
export const TOOL_NAME_WILDCARD = '*';

/**
 * Resolves a tool's effective mode from a policy list (defaults to Available).
 * A policy naming the tool exactly wins over the `*` catch-all. Shared by the
 * browser's tool loop and the connector's agents so both hide the same methods.
 */
export function resolveToolMode(
  policies: McpToolPolicy[] | undefined,
  toolName: string,
): McpToolMode {
  if (!policies) {
    return McpToolMode.Available;
  }
  const exact = policies.find((policy) => policy.toolName === toolName);
  const wildcard = policies.find((policy) => policy.toolName === TOOL_NAME_WILDCARD);
  return exact?.mode ?? wildcard?.mode ?? McpToolMode.Available;
}
