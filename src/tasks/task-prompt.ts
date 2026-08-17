import { type BackgroundTask, type DeepAgentSubAgent } from '../contracts';

import { GENERAL_PURPOSE_AGENT } from './background-tasks';
import { TASK_INSTRUCTIONS } from './tasks.constants';

/** How much of a finished task's answer is quoted in the prompt listing. */
const LISTED_RESULT_CHARS = 300;

/**
 * The delegation section of the system prompt: the rules, the agent types that
 * can be delegated to, and the chat's tasks as they stand right now.
 *
 * The task listing is not a nicety. A run has no checkpointer and the browser
 * sends a text-only history (tool calls and their results are transcript
 * segments, not messages), so a `taskId` handed out last turn is gone by this
 * one — the agent would re-delegate work that is running or already done. This
 * is the same route `memory` takes for the same reason.
 */
export function taskPromptSection(subAgents: DeepAgentSubAgent[], tasks: BackgroundTask[]): string {
  const types = [
    `- \`${GENERAL_PURPOSE_AGENT}\` — general-purpose worker: research, searching across files and data, multi-step work.`,
    ...subAgents.map((agent) => `- \`${agent.name}\` — ${agent.description}`),
  ].join('\n');

  const sections = [TASK_INSTRUCTIONS, `### Available agent types\n\n${types}`];

  if (tasks.length > 0) {
    sections.push(`### Tasks in this chat\n\n${tasks.map(describeTask).join('\n')}`);
  }

  return sections.join('\n\n');
}

/**
 * One task as the agent sees it before the turn starts. A finished one is quoted
 * so the obvious next step — re-running the same delegation — is visibly
 * pointless; the full answer is still a `check_task` away.
 */
function describeTask(task: BackgroundTask): string {
  const head = `- \`${task.taskId}\` · ${task.agentName} · ${task.status} — «${task.title}»`;
  if (task.status === 'success' && task.resultPreview) {
    return `${head}\n  Result: ${truncate(task.resultPreview, LISTED_RESULT_CHARS)}`;
  }
  if (task.status === 'error' && task.error) {
    return `${head}\n  Error: ${truncate(task.error, LISTED_RESULT_CHARS)}`;
  }
  return head;
}

function truncate(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}
