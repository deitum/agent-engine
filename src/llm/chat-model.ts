import { resolveApiKey, resolveGatewayUrl } from '../config/engine-config';
import { type DeepAgentLlmParams } from '../contracts';
import { type loadDeps } from '../deep-agent';

import { createLlmFetch, type GatewayAttemptSink } from './llm-client';
import { DEFAULT_LLM_MAX_RETRIES, LLM_MAX_RETRIES_VAR } from './llm.constants';

/**
 * The class exactly as `loadDeps()` hands it over — taken from that function's
 * type rather than imported from `@langchain/openai` directly, because a
 * dynamically imported class and a statically imported one are two different
 * types to TypeScript, and every caller here holds the dynamic one.
 */
type ChatOpenAIClass = Awaited<ReturnType<typeof loadDeps>>['ChatOpenAI'];

/**
 * Builds the model every agent in this daemon talks through: the deep agent, the
 * coding agent, and the two one-shot calls (project memory and the project overview).
 *
 * One place, because all four need the same three things that are not in the
 * request: the gateway address and the user's token, which this process holds
 * from the connection handshake (see `config/engine-config.ts`), and
 * {@link createLlmFetch}, without which a non-streaming `invoke` would be refused by a
 * streaming-only gateway.
 *
 * An omitted sampling field is left off entirely rather than defaulted, so the
 * provider's own default applies; `temperature` is the exception the agents have
 * always made, defaulting to a deterministic 0.
 *
 * `callbacks` is how a turn's text is streamed token by token
 * (`llm/token-stream.ts`). It is per-model rather than per-request on purpose:
 * the instance carrying it is the one the user reads along with, and giving a
 * sub-agent its own model without it is what keeps a delegation's narration out
 * of the transcript.
 *
 * `onAttemptFailed` hears about every rejected attempt, and `maxRetries` bounds
 * how many there may be. Both exist because of what langchain does when a call
 * fails: its `AsyncCaller` retries **six** times by default, with an exponential
 * backoff that reaches ~113 seconds, saying nothing to anyone. A gateway that
 * refuses the first few attempts therefore reads, from the chat, as a model that
 * thinks for two minutes about «hello». Three attempts cap that wait at ~13s,
 * and `AGENT_ENGINE_LLM_MAX_RETRIES` moves it for a deployment whose gateway
 * really does need more patience.
 */
export function buildChatModel(
  ChatOpenAI: ChatOpenAIClass,
  llm: DeepAgentLlmParams,
  callbacks?: unknown[],
  onAttemptFailed?: GatewayAttemptSink,
): InstanceType<ChatOpenAIClass> {
  return new ChatOpenAI({
    model: llm.model,
    apiKey: resolveApiKey(),
    temperature: llm.temperature ?? 0,
    maxRetries: resolveMaxRetries(),
    ...(callbacks?.length ? { callbacks: callbacks as never } : {}),
    ...(llm.topP !== undefined ? { topP: llm.topP } : {}),
    ...(llm.maxTokens !== undefined ? { maxTokens: llm.maxTokens } : {}),
    ...(llm.frequencyPenalty !== undefined ? { frequencyPenalty: llm.frequencyPenalty } : {}),
    ...(llm.presencePenalty !== undefined ? { presencePenalty: llm.presencePenalty } : {}),
    ...(llm.reasoningEffort ? { reasoningEffort: llm.reasoningEffort } : {}),
    configuration: { baseURL: resolveGatewayUrl(), fetch: createLlmFetch(onAttemptFailed) },
  });
}

/**
 * The retry budget for one model call: {@link DEFAULT_LLM_MAX_RETRIES}, or
 * whatever {@link LLM_MAX_RETRIES_VAR} says. Read per call rather than once, so
 * a daemon started with the variable set does not need a rebuild to be believed;
 * anything that is not a non-negative number is ignored rather than obeyed.
 */
function resolveMaxRetries(): number {
  // `Number('')` is 0, and a variable that is present but empty means «unset»,
  // not «never retry» — the two differ by two minutes when the gateway is flaky.
  const raw = (process.env[LLM_MAX_RETRIES_VAR] ?? '').trim();
  const parsed = Number(raw);
  return raw !== '' && Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_LLM_MAX_RETRIES;
}
