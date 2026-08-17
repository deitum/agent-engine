/**
 * Hides a built-in tool from the model without removing the middleware that
 * provides it.
 *
 * deepagents assembles `SubAgentMiddleware` itself and treats it as required, so
 * its `task` tool cannot be left out of `createDeepAgent` — but with background
 * tasks on, `task` is a second, worse way to do what `delegate_task` does: it
 * blocks the turn, leaves no transcript, and its result can never be reused when
 * the turn is retried. Two delegation tools also means the model has to choose,
 * and the built-in's own description argues for itself.
 *
 * Filtering the request's tool list is how deepagents does this internally
 * (`createToolExclusionMiddleware`, reached through a harness profile keyed by
 * provider/model — a registry we have no stable key for, since the models come
 * from whatever gateway the deployment points at). The same three lines as our
 * own middleware cost nothing and stay in our hands.
 *
 * Safe to do silently: `createSubAgentMiddleware` is constructed without a
 * `systemPrompt`, so nothing in the prompt refers to the tool being removed.
 */

/** The `createMiddleware` factory, through the same `unknown` seam as its callers. */
type CreateMiddleware = (config: {
  name: string;
  wrapModelCall: (request: unknown, handler: (request: unknown) => unknown) => Promise<unknown>;
}) => unknown;

/** A model request, of which only the tool list concerns us. */
interface ModelRequestLike {
  tools?: unknown[];
}

/** True for a tool object exposing one of `names`. */
function isHidden(tool: unknown, names: ReadonlySet<string>): boolean {
  const name = (tool as { name?: unknown } | null)?.name;
  return typeof name === 'string' && names.has(name);
}

/**
 * Builds middleware that drops `names` from the tool list handed to the model.
 * The tools stay registered — anything already holding a reference to one keeps
 * working — the model simply never sees them.
 */
export function buildHideToolsMiddleware(
  createMiddleware: unknown,
  names: ReadonlySet<string>,
): unknown {
  return (createMiddleware as CreateMiddleware)({
    name: 'HideBuiltinTools',
    wrapModelCall: async (request, handler) => {
      const tools = (request as ModelRequestLike).tools;
      if (!Array.isArray(tools)) {
        return handler(request);
      }
      return handler({
        ...(request as ModelRequestLike),
        tools: tools.filter((tool) => !isHidden(tool, names)),
      });
    },
  });
}
