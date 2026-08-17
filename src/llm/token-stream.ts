/**
 * Token-level streaming for an agent turn.
 *
 * An agent's model is called with `invoke()` — the graph is consumed with
 * langgraph `streamMode: "updates"`, which only reports a message once its step
 * is over. That is a whole paragraph appearing at once, several seconds after
 * the user asked. What follows makes the same turn arrive as it is written,
 * without changing how the graph is consumed.
 *
 * `@langchain/core` streams a model call internally — and reports every token
 * through `handleLLMNewToken` — as soon as **any** callback handler attached to
 * that call declares `lc_prefer_streaming` (`BaseChatModel._generate`). The
 * handler below is that declaration. `invoke()` then returns the concatenated
 * `AIMessageChunk` instead of an `AIMessage`, which every consumer in this
 * package already handles: langchain validates a middleware's answer with the
 * duck-typed `AIMessage.isInstance` (a chunk passes), and `repair-tool-calls.ts`
 * is written against exactly that shape.
 *
 * The reason this is a handler on the model rather than langgraph's own
 * `streamMode: "messages"` is **which** model calls it can tell apart. Not every
 * call a turn makes is the answer: deepagents' summarizer calls the same model
 * instance, from inside the same graph node, to compact the history — and its
 * output must never reach the transcript. langgraph's stream carries no metadata
 * that separates the two, and its events arrive asynchronously, too late to ask.
 * A handler fires **synchronously, while the token is produced**, so a flag set
 * around the real call is exact: {@link TokenStream.middleware} opens it for the
 * duration of the model call the agent node makes, and nothing else runs inside
 * it. A sub-agent's model call is not inside it either — it happens within a
 * tool, long after the parent's call returned — so a delegation stays a single
 * step in the transcript rather than narrating itself into it.
 */

import { createRepetitionWatch, type Repetition } from './repetition';

/** How the tokens of one turn leave this module. */
export type TokenSink = (delta: string) => void;

/**
 * Told once, when the answer being written has degenerated into repeating
 * itself. Whoever passes it owns the response — this module only stops relaying
 * a text that is no longer going anywhere.
 */
export type RepetitionSink = (repetition: Repetition) => void;

/** The `createMiddleware` factory, through the same `unknown` seam as its callers. */
type CreateMiddleware = (config: {
  name: string;
  wrapModelCall: (request: unknown, handler: (request: unknown) => unknown) => Promise<unknown>;
}) => unknown;

/** A finished model call, as `handleLLMEnd` reports it. */
interface LlmResult {
  generations?: { message?: { id?: unknown } }[][];
}

export interface TokenStream {
  /** Callbacks for the model the **main** agent answers with, and no other. */
  callbacks: unknown[];
  /**
   * The middleware that opens the stream around the agent's own model call.
   * Belongs in the main agent's `middleware` — never a sub-agent's.
   */
  middleware: unknown;
  /**
   * Ids of the messages whose text has already gone out as tokens, so the
   * projection can skip the copy that arrives later with the completed step.
   *
   * Taken from the finished call rather than from its fragments: a provider
   * gives each fragment its own id (and the first one, which carries the role
   * and no text at all, is the one the assembled message inherits), so an id
   * collected while streaming names a message that never reaches the graph. The
   * `run-<id>` spelling is recorded beside it, because that is what langchain
   * puts on a message whose provider sent no id of its own.
   */
  streamedIds: ReadonlySet<string>;
}

/**
 * Builds the token relay for one turn. Everything it returns belongs to that
 * turn: the daemon runs several at once, and each holds its own model instance,
 * its own gate and its own set of streamed ids.
 *
 * `onRepetition` is the turn's way out of a loop. Watching the tokens is the
 * only place a repeating answer can be seen while it happens: it is written
 * inside a single model call, so no graph step ends and no step budget applies
 * (`llm/repetition.ts`). Told once per turn, and every token after it is
 * dropped — the caller is expected to end the turn, but the model keeps writing
 * until the abort actually reaches it, and none of that belongs in the
 * transcript.
 */
export function createTokenStream(
  createMiddleware: unknown,
  onToken: TokenSink,
  onRepetition?: RepetitionSink,
): TokenStream {
  const streamedIds = new Set<string>();
  // The calls whose text actually went out, so only their message is skipped
  // later. A call made with the gate shut (the summarizer's) never lands here,
  // and neither does one that streamed nothing but tool calls.
  const streamedRuns = new Set<string>();
  // Counted rather than boolean: the agent node's call is one, but nothing
  // guarantees a middleware above will not re-enter it, and a plain flag would
  // be closed by the inner return while the outer call was still streaming.
  let depth = 0;
  // Per model call, not per turn: an answer is only stuck if *this* call has
  // been writing the same thing, and the previous call's text says nothing
  // about it.
  const watch = createRepetitionWatch();
  let watchedRun: string | null = null;
  // Latched for the rest of the turn once the answer has degenerated: the turn
  // is over either way, and re-reporting it on every token that arrives before
  // the abort lands would be noise.
  let stuck = false;

  const handler = {
    name: 'AgentEngineTokenStream',
    // Awaited, so a token reaches the browser in the order it was produced —
    // and so the call below has finished recording before the graph reports the
    // step it belongs to.
    awaitHandlers: true,
    lc_prefer_streaming: true,
    handleLLMNewToken(token: string, _idx: unknown, runId: string): void {
      if (depth === 0 || !token || stuck) {
        return;
      }
      streamedRuns.add(runId);
      onToken(token);
      if (!onRepetition) {
        return;
      }
      if (watchedRun !== runId) {
        watchedRun = runId;
        watch.reset();
      }
      const repetition = watch.push(token);
      if (repetition) {
        stuck = true;
        onRepetition(repetition);
      }
    },
    handleLLMEnd(output: LlmResult, runId: string): void {
      if (watchedRun === runId) {
        watchedRun = null;
        watch.reset();
      }
      if (!streamedRuns.delete(runId)) {
        return;
      }
      const id = output?.generations?.[0]?.[0]?.message?.id;
      if (typeof id === 'string') {
        streamedIds.add(id);
      }
      streamedIds.add(`run-${runId}`);
    },
  };

  const middleware = (createMiddleware as CreateMiddleware)({
    name: 'StreamTokensToUser',
    wrapModelCall: async (request, handler_) => {
      depth += 1;
      try {
        return await handler_(request);
      } finally {
        depth -= 1;
      }
    },
  });

  return { callbacks: [handler], middleware, streamedIds };
}
