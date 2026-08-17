import {
  type ChatMessage,
  type CodeContextReport,
  type CodeMemoryManifest,
  type DeepAgentSkill,
} from '../contracts';

import { estimateTokens } from './code-memory';

/**
 * Where the in-graph summarizer is told to start compacting, as a share of the
 * model's window.
 *
 * Below the browser's own safety cap, so the summarizer gets its chance before
 * anything is dropped, and well below the window itself: summarization needs room
 * for the turn that triggers it plus the summary call.
 */
export const SUMMARIZE_AT_RATIO = 0.8;

/**
 * Window assumed when the provider does not report one. The library's own
 * fallback is 170k tokens, which is above what most deployments actually serve —
 * a request against a 128k model would fail before summarization ever ran.
 */
export const FALLBACK_CONTEXT_TOKENS = 128_000;

/**
 * Fraction of the window kept verbatim after a summarization. The rest is
 * replaced by the summary, so this is how much recent work survives intact.
 */
export const SUMMARIZE_KEEP_RATIO = 0.15;

/**
 * Output size past which the filesystem middleware offloads a tool result to a
 * file and leaves a preview the agent can page through. Lower than the library's
 * ~80 KB default because on the Code path tool output *is* the bulk of the
 * context: a single `grep` across a monorepo would otherwise cost more than the
 * conversation around it.
 */
export const TOOL_EVICT_TOKENS = 8_000;

/** The window this turn should be budgeted against. */
export function contextWindowOf(contextLength: number | undefined): number {
  return contextLength && contextLength > 0 ? contextLength : FALLBACK_CONTEXT_TOKENS;
}

/** Token count at which summarization kicks in for a given window. */
export function summarizeAtTokens(contextLength: number | undefined): number {
  return Math.floor(contextWindowOf(contextLength) * SUMMARIZE_AT_RATIO);
}

/**
 * What the model is shown before the conversation begins, measured.
 *
 * The browser cannot compute any of this — the prompt, the memory files, the
 * skills and the tool schemas are all assembled connector-side — so without this
 * report a context indicator would be counting perhaps half the window and
 * calling it the total.
 */
export function buildContextReport(input: {
  systemPrompt: string;
  memory: CodeMemoryManifest;
  skills: DeepAgentSkill[];
  /** Names + descriptions of the tools the model is offered. */
  toolDescriptions: string[];
  contextLength?: number;
  messages?: ChatMessage[];
}): CodeContextReport {
  const systemTokens = estimateTokens(input.systemPrompt);
  const skillsTokens = input.skills.reduce(
    (sum, skill) => sum + estimateTokens(`${skill.name}${skill.description}${skill.instructions}`),
    0,
  );
  const toolsTokens = input.toolDescriptions.reduce(
    (sum, description) => sum + estimateTokens(description),
    0,
  );

  return {
    systemTokens,
    memory: input.memory,
    skillsTokens,
    toolsTokens,
    toolCount: input.toolDescriptions.length,
    overheadTokens: systemTokens + input.memory.totalTokens + skillsTokens + toolsTokens,
    ...(input.messages ? { historyTokens: historyTokensOf(input.messages) } : {}),
    summarizeAtTokens: summarizeAtTokens(input.contextLength),
  };
}

/** Estimated cost of a history, tool calls and results included. */
export function historyTokensOf(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => {
    const calls = (message.tool_calls ?? [])
      .map((call) => `${call.function.name}${call.function.arguments}`)
      .join('');
    return sum + estimateTokens(`${message.content ?? ''}${calls}${message.name ?? ''}`);
  }, 0);
}
