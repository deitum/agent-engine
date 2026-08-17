import { parseToolArguments } from './contracts';

/**
 * Rescues a turn from a tool call whose arguments would not parse.
 *
 * The protocol carries tool arguments as a **model-generated string**, and this
 * gateway does not always return valid JSON: `component_list` takes no
 * arguments and comes back as `{}""` (see `parseToolArguments` in
 * `./contracts`). LangChain parses that string with a bare `JSON.parse`
 * (`parseToolCall`), and a call that throws is filed under `invalid_tool_calls`
 * instead of `tool_calls`.
 *
 * Nothing downstream reads that array. The agent's router asks only whether
 * `tool_calls` is empty, and an empty one means «the model is done» — so the
 * graph leaves through its exit node without an exception, without an event and
 * without a word of assistant text. To the user the chat simply **stops** after
 * a step, every time, and «continue» buys exactly one more.
 *
 * So the arguments are repaired here, the same way the browser's own tool loop
 * repairs them before storing or forwarding a call (`normalizeToolArguments`),
 * and the call is put back where the router will find it.
 */

/** One entry of `invalid_tool_calls`, as `makeInvalidToolCall` builds it. */
interface InvalidToolCallLike {
  id?: unknown;
  name?: unknown;
  /** The raw arguments string, exactly as the provider sent it. */
  args?: unknown;
  error?: unknown;
}

/** A repaired call in the shape the tool node executes. */
interface RepairedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  type: 'tool_call';
}

/** How the model's answer looks to us through the dual-package type seam. */
interface AiMessageLike {
  tool_calls?: unknown;
  invalid_tool_calls?: unknown;
  response_metadata?: { finish_reason?: unknown };
  /** LangChain messages keep a parallel copy of their constructor arguments. */
  lc_kwargs?: Record<string, unknown>;
}

/** How much of a broken arguments string goes into the log. */
const LOGGED_ARGS_CHARS = 200;

/**
 * Moves every unparseable tool call of `message` into `tool_calls`, repairing
 * its arguments as far as they can be repaired, and returns how many were
 * recovered.
 *
 * `parseToolArguments` handles the two spellings this gateway produces — a
 * complete object with noise after it (`{}""`) and the empty string — and gives
 * up only on a genuinely truncated one (`{"path":`). A call it gives up on is
 * **still** put back, with `{}` for arguments: the tool's own validation then
 * answers «`path` is required…», which the model can read and retry, and that is worth
 * more than a turn that ends mid-thought. It is also exactly what the browser
 * path does with the same string.
 *
 * Mutates the message in place rather than constructing a new `AIMessage`: it
 * arrives across the CJS/ESM seam described in `deep-agent.ts`, so the class we
 * would import is not the class it was built from — and `AgentNode` validates a
 * middleware's answer with `AIMessage.isInstance`. Mutating also keeps the
 * message's `id` (which `streamAgentUpdates` dedupes on), its `usage_metadata`
 * and its `response_metadata`.
 */
export function repairToolCalls(message: unknown, onWarn: (message: string) => void): number {
  const target = message as AiMessageLike | null;
  if (!target || typeof target !== 'object' || !Array.isArray(target.invalid_tool_calls)) {
    return 0;
  }
  const invalid = target.invalid_tool_calls as InvalidToolCallLike[];
  if (invalid.length === 0) {
    return 0;
  }

  const repaired: RepairedToolCall[] = [];
  for (const call of invalid) {
    const id = typeof call?.id === 'string' ? call.id : '';
    const name = typeof call?.name === 'string' ? call.name : '';
    const raw = typeof call?.args === 'string' ? call.args : '';
    if (!id || !name) {
      // Without both there is nothing to pair a result with, and an unanswered
      // call is the one shape every provider rejects.
      onWarn('The model returned a tool call with no name or id — it was dropped.');
      continue;
    }

    const args = parseToolArguments(raw);
    if (args === null) {
      onWarn(
        `The arguments of the «${name}» call arrived truncated — it was retried without them. ` +
          'This is usually what a model answer that hit the token limit looks like.',
      );
    }
    console.warn(
      `[agent] repaired tool call arguments for "${name}": ${truncate(raw, LOGGED_ARGS_CHARS)}`,
    );
    repaired.push({ id, name, args: args ?? {}, type: 'tool_call' });
  }

  const existing = Array.isArray(target.tool_calls) ? target.tool_calls : [];
  setField(target, 'tool_calls', [...existing, ...repaired]);
  setField(target, 'invalid_tool_calls', []);
  return repaired.length;
}

/**
 * Warns when the model's answer was cut off by the token limit.
 *
 * The same silent stop has a second cause: a reply truncated mid-call arrives
 * with unparseable arguments and no explanation. {@link repairToolCalls} keeps
 * the turn moving, but «why did it write half a file» is only answerable from
 * `finish_reason`, which nothing else surfaces. LangChain merges the
 * generation's info into `response_metadata` before the message reaches us.
 */
export function warnOnTruncation(message: unknown, onWarn: (message: string) => void): void {
  const reason = (message as AiMessageLike | null)?.response_metadata?.finish_reason;
  if (reason === 'length') {
    onWarn(
      'The model answer was cut off by the token limit — the turn may have ended mid-thought.',
    );
  }
}

/** The `createMiddleware` factory, through the same `unknown` seam as its callers. */
type CreateMiddleware = (config: {
  name: string;
  wrapModelCall: (request: unknown, handler: (request: unknown) => unknown) => Promise<unknown>;
}) => unknown;

/**
 * Builds the middleware that repairs every model answer on its way back into the
 * graph. Taken through the `unknown` seam rather than `loadDeps` so this module
 * stays free of a cycle with `deep-agent.ts`, which is what imports it.
 */
export function buildToolCallRepairMiddleware(
  createMiddleware: unknown,
  onWarn: (message: string) => void,
): unknown {
  return (createMiddleware as CreateMiddleware)({
    name: 'RepairToolCallArguments',
    wrapModelCall: async (request, handler) => {
      const response = await handler(request);
      repairToolCalls(response, onWarn);
      warnOnTruncation(response, onWarn);
      return response;
    },
  });
}

/** Writes a field on a LangChain message, keeping its serialised copy in step. */
function setField(
  target: AiMessageLike,
  key: 'tool_calls' | 'invalid_tool_calls',
  value: unknown[],
): void {
  target[key] = value;
  if (target.lc_kwargs && typeof target.lc_kwargs === 'object') {
    target.lc_kwargs[key] = value;
  }
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
