import { type DeepAgentTodo } from '../contracts';

import { PLAN_SECTION_TITLE } from './plan.constants';

/**
 * The plan the turn inherits, written into the system prompt.
 *
 * It has to travel in the prompt because nothing else carries it. A run has no
 * checkpointer, the embedding app sends a text-only history, and langchain's
 * todo middleware — which owns the `todos` state — never puts the list itself in
 * front of the model: within one turn the agent only knows its plan from the
 * `write_todos` tool result, and that message is gone by the next one. So an
 * agent asked to «keep the plan up to date» across turns was being asked for
 * something it had no way to do, and it showed: plans were written once and
 * never revised.
 *
 * The seeded state (see `DeepAgentRunRequest.todos`) is what keeps the card
 * drawn; this is what lets the model act on it.
 */

/** How much of one item travels; a plan item is a line, not a document. */
const MAX_ITEM_CHARS = 300;
/** How many items travel, oldest first — a plan longer than this is a symptom. */
const MAX_ITEMS = 30;

export function planPromptSection(todos: DeepAgentTodo[]): string {
  const items = todos
    .slice(0, MAX_ITEMS)
    .map((todo) => `- [${todo.status}] ${truncate(todo.content, MAX_ITEM_CHARS)}`);

  return [
    PLAN_SECTION_TITLE,
    'This is your plan as it stands, from earlier in this conversation. Continue it: close what is now done, revise what has changed, and write the **whole** list back with `write_todos`. Do not start a second list for the same work.',
    items.join('\n'),
  ].join('\n\n');
}

function truncate(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}
