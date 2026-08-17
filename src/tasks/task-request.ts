import {
  type ChatMessage,
  ChatRole,
  type DeepAgentRunRequest,
  type DeepAgentSubAgent,
  McpToolMode,
  type McpToolSource,
  TOOL_NAME_WILDCARD,
} from '../contracts';

/**
 * Prepended to a background task's own system prompt.
 *
 * The two things it says are the two ways a task differs from an inline
 * delegation: nobody is watching it, so it cannot ask; and its last message is
 * the *only* thing the parent will ever see of it, so a report that assumes the
 * reader watched the work is a report about nothing.
 */
export const BACKGROUND_TASK_PREAMBLE = `You are running a background task delegated to you by another agent.

- There is no user present — you cannot ask one. Act on reasonable assumptions, and list those assumptions and any open questions in your final answer.
- Your last message is the only thing the delegating agent will ever see: it did not watch you work. Make it self-contained — what was done, what was found, what is left.
- Do not retell your work step by step; what is wanted is the result and what follows from it.`;

/**
 * Turns a sub-agent's tool allow-list into per-server policies: everything off
 * by `*`, then each named tool back on (an exact policy beats the wildcard —
 * see `resolveToolMode`). Tools the allow-list does not name are never bridged,
 * which is cheaper than bridging them and hiding them afterwards.
 *
 * Unlike the inline `buildSubAgents` path there is no "resolved to nothing, so
 * grant everything" fallback: which server holds which tool is only known after
 * listing, and by then the sources are built. An allow-list naming tools no
 * server exposes therefore leaves the task with the built-ins only — the
 * author asked for those tools by name, and quietly handing over every tool
 * instead is the more surprising of the two outcomes.
 */
export function scopeToolSources(sources: McpToolSource[], allowed: string[]): McpToolSource[] {
  if (allowed.length === 0) {
    return sources;
  }
  const policies = [
    { toolName: TOOL_NAME_WILDCARD, mode: McpToolMode.Disabled },
    ...allowed.map((toolName) => ({ toolName, mode: McpToolMode.Available })),
  ];
  return sources.map((source) => ({ ...source, policies }));
}

/** What {@link buildTaskRequest} needs beyond the parent's own run request. */
export interface TaskRequestParams {
  /** The run that delegated — everything the task inherits comes from here. */
  parent: DeepAgentRunRequest;
  /** The sub-agent being run, or `null` for the default general-purpose one. */
  subAgent: DeepAgentSubAgent | null;
  /** The task's conversation so far (its brief, then any follow-ups). */
  messages: ChatMessage[];
  /** The task id — names its workspace, so it must be stable across re-runs. */
  taskId: string;
}

/** System prompt for a task run without a configured sub-agent behind it. */
const GENERAL_PURPOSE_PROMPT = `You are a general-purpose worker: you research a question, search across files and data, and carry a multi-step task through to the end.`;

/**
 * Builds the run request for one background task out of the run that delegated
 * it.
 *
 * The task inherits the parent's MCP scope, model, skills, files and sandbox —
 * it is the same agent doing a different job — while the web-search policy, the
 * token and the gateway are not inherited at all: they are the daemon's own
 * configuration, the same for every run it hosts. It deliberately does **not**
 * inherit four things:
 *
 * - `clientTools` and the `ask_user` tool (granted by the runner, not here):
 *   both block on a browser that may have closed the tab, and a task waiting
 *   forever on an answer nobody will give is worse than one that guesses.
 * - `memory`: memory belongs to the project and is edited by the chat the user
 *   is actually in. A task rewriting it unattended is a surprise, not a feature.
 * - `subAgents` and `allowTasks`: delegation is one level deep, as it is in
 *   Claude Code — a task that spawns tasks makes the ceiling meaningless.
 * - `tasks`: the list of the chat's other tasks is the parent's business.
 * - `todos` and `requirePlan`: the parent's plan describes the parent's work,
 *   of which this task is one item. A task plans its own work if it is worth
 *   planning — the reminders reach it like any other run.
 */
export function buildTaskRequest({
  parent,
  subAgent,
  messages,
  taskId,
}: TaskRequestParams): DeepAgentRunRequest {
  const instructions = [
    BACKGROUND_TASK_PREAMBLE,
    subAgent?.systemPrompt?.trim() || GENERAL_PURPOSE_PROMPT,
  ].join('\n\n');

  return {
    messages,
    instructions,
    subAgents: [],
    llm: parent.llm,
    tools: scopeToolSources(parent.tools, subAgent?.tools ?? []),
    sessionId: taskId,
    ...(parent.skills?.length ? { skills: parent.skills } : {}),
    ...(parent.files?.length ? { files: parent.files } : {}),
    ...(parent.sandbox ? { sandbox: true } : {}),
    ...(parent.artifacts === false ? { artifacts: false } : {}),
  };
}

/** The task's brief as the first message of its conversation. */
export function openingMessage(prompt: string): ChatMessage {
  return { role: ChatRole.User, content: prompt };
}
