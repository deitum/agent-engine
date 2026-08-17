/** The planning tool's model-facing name. */
export const WRITE_TODOS_TOOL = 'write_todos';

/**
 * The `write_todos` tool description, replacing langchain's own.
 *
 * The stock one runs to some two thousand tokens — a dozen worked examples, most
 * of them arguing *against* writing a plan — and it travels in every request of
 * every turn. This one keeps the same policy (a plan is for work worth tracking,
 * not for a question with an answer) in the space the policy actually needs, and
 * spends what is left on the rules that decide whether a plan is any use to the
 * person reading it: one item in flight, closed the moment it is done.
 */
export const WRITE_TODOS_DESCRIPTION = `Record the plan for the work you are doing now, as a checklist the user watches while you work.

Each call **replaces the whole list**, so always send every item, each with its current status — omitting one deletes it.

Write a plan when the request:
- takes three or more steps, or more than a couple of tool calls;
- spans several files, sources or systems;
- came in several parts the user listed themselves;
- is open-ended enough that the first step may change the rest.

Do not write one for a question you can simply answer, or for work that is one or two obvious tool calls: there it costs time and tells the user nothing.

Statuses: \`pending\`, \`in_progress\` (keep exactly one), \`completed\` (set it the moment the item is done — never a batch of them at the end). Revise the list as you learn more: add, drop or reword items.`;

/**
 * The planning section of the system prompt, replacing langchain's own for the
 * same reason the description is (see {@link WRITE_TODOS_DESCRIPTION}) — and
 * because the stock text closes on "writing todos takes time and tokens", which
 * is the last thing a model reads before deciding not to plan at all.
 *
 * The triggers are repeated here rather than left to the tool description: the
 * description is read when the model is already considering the tool, and the
 * complaint this answers is that it never gets that far.
 */
export const PLAN_INSTRUCTIONS = `## Planning

You have a \`write_todos\` tool. The plan you write with it is shown to the user as a live checklist, so it is both how you keep multi-step work on track and how they see where you are.

Write one before you start work that takes three or more steps, spans several files, sources or systems, or arrives as a list of things to do. Answer directly — no plan — when the request is a question, or one or two obvious tool calls.

- Write the plan **before** the first tool call of the work it describes, not after.
- Keep exactly one item \`in_progress\`, and mark an item \`completed\` as soon as it is done. A plan updated in one batch at the end was never a plan.
- Revise it when what you learn changes the work. New steps, dropped steps and reworded steps are all expected.
- Name outcomes, not tools: "check the order endpoint 404s after deletion", not "call read_file".
- Call \`write_todos\` once at a time, never twice in the same turn.
- A plan you were given at the start of the turn is one you already wrote: carry it on rather than replacing it with a fresh list of the same work.`;

/**
 * The header of the section listing the plan a turn inherits from the one before
 * it. See `plan/plan-prompt.ts` for why it has to travel in the prompt at all.
 */
export const PLAN_SECTION_TITLE = '## Your current plan';

/**
 * Tool calls a turn may make with no plan before the first reminder. Three is
 * the same threshold the policy states, so the reminder never contradicts it:
 * by the third call the work is, by our own definition, worth a plan.
 */
export const NUDGE_AFTER_TOOL_CALLS = 3;

/**
 * Tool calls a *planned* turn may make without touching its plan before it is
 * reminded to. Deliberately looser than the first threshold: an item can
 * genuinely take several calls, and a reminder that fires inside one step reads
 * as noise.
 */
export const STALE_PLAN_CALLS = 6;

/**
 * How many times the same tool may be called in one turn before delegation is
 * suggested. The signal this stands in for is a fan-out done by hand — the same
 * search repeated over one repository after another — which is exactly the work
 * that should have been several tasks running side by side.
 */
export const FANOUT_REPEATS = 4;

/** Reminders one turn may receive, however many rules fire. */
export const MAX_NUDGES_PER_TURN = 2;

/** Model calls that must pass between two reminders. */
export const NUDGE_COOLDOWN_CALLS = 3;

/**
 * The reminders `plan/plan-nudge.ts` puts in front of the model, and the whole
 * reason that module exists.
 *
 * The policy above is read once, at the top of a turn that has not started yet,
 * and it competes with everything else in the system prompt — the host app's own
 * instructions, the filesystem section, the skills, the delegation rules. What
 * it cannot do is arrive *at the moment it applies*: several tool calls in, when
 * the turn has visibly become multi-step work and no plan was ever written.
 * These do, and they are the same device Claude Code uses for the same failure.
 *
 * Each is one line, present tense, and states what to do rather than restating
 * the policy — a reminder that has to be reasoned about is a reminder that gets
 * ignored on the model this runs on.
 */
export const PLAN_NUDGE = `Reminder: this turn has become multi-step work and has no plan. Call \`write_todos\` now with the steps you have left, then carry on.`;

export const PLAN_UPDATE_NUDGE = `Reminder: your plan has not been updated for several tool calls. Close the items you have finished, keep exactly one \`in_progress\`, and add anything you have learned is still missing.`;

export const DELEGATE_NUDGE = `Reminder: you are repeating the same tool over one target after another. Independent branches like these belong in \`delegate_task\` — several in one message run side by side, and their output never enters your context.`;
