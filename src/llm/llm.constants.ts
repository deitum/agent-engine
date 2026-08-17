/** Sub-paths appended to the gateway's base URL. */
export const LLM_UPSTREAM_PATHS = {
  models: 'models',
  chatCompletions: 'chat/completions',
} as const;

/**
 * How much of a rejected request body is kept in the debug log. A turn that
 * edits files carries them whole inside `tool_calls.arguments`, so the untrimmed
 * body runs to hundreds of kilobytes and buries the summary that actually
 * explains the failure.
 */
export const LLM_LOGGED_BODY_CHARS = 4000;

/**
 * How many times a failed model call is retried.
 *
 * Three, not langchain's default of six. Its `AsyncCaller` backs off
 * exponentially — the seventh attempt starts ~113 seconds after the first — and
 * none of that wait is reported anywhere, so a gateway rejecting the first few
 * attempts is indistinguishable from a model taking two minutes over a greeting.
 * Three attempts bound the same storm at ~13 seconds.
 */
export const DEFAULT_LLM_MAX_RETRIES = 3;

/** Overrides {@link DEFAULT_LLM_MAX_RETRIES}; `0` retries nothing. */
export const LLM_MAX_RETRIES_VAR = 'AGENT_ENGINE_LLM_MAX_RETRIES';

/**
 * Overrides the `User-Agent` this daemon calls the gateway under. Gateways route
 * on that header — see the note in `llm-client.ts` for the deployment where it
 * decided a 40× difference in latency.
 */
export const USER_AGENT_VAR = 'AGENT_ENGINE_USER_AGENT';

/**
 * How much of the end of a streaming answer is kept to test it for repetition
 * (`repetition.ts`). Generous next to {@link REPETITION_MIN_SPAN_CHARS} — the
 * whole repetition has to fit in here to be seen — but bounded, because a long
 * turn writes far more than a loop ever needs to be recognised.
 */
export const REPETITION_WINDOW_CHARS = 4000;

/**
 * The suffix whose previous occurrence gives the length of the repeated block.
 * Long enough that an ordinary sentence ending does not recur by chance, short
 * enough to sit inside one repeated line.
 */
export const REPETITION_PROBE_CHARS = 48;

/** How many consecutive copies of a block make the text degenerate rather than emphatic. */
export const REPETITION_MIN_COPIES = 4;

/**
 * How many characters those copies have to cover, together. Keeps a short
 * repeated run of punctuation or a table rule — legitimate output, four copies
 * of very little — from ending a turn.
 */
export const REPETITION_MIN_SPAN_CHARS = 240;

/** How much of the repeated block the notice quotes back — enough to recognise it. */
export const REPETITION_QUOTE_CHARS = 120;
