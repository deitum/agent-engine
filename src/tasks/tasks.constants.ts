/** How many tasks one chat may have running at once. */
export const MAX_TASKS_PER_CHAT = 3;

/**
 * How many tasks may run across every chat. Each one is a full agent loop with
 * its own model calls and its own MCP traffic, so the ceiling is about the
 * user's machine and their token budget rather than about correctness.
 */
export const MAX_TASKS_RUNNING = 6;

/**
 * Events kept per task for replay. A task runs **without** the token stream the
 * interactive routes turn on (`RunOptions.tokens`), so its text arrives one
 * message per step and even a long task lands well inside this; a task that
 * somehow exceeds it drops its oldest events, and a browser reconnecting after
 * the drop simply starts from the oldest event still held (see `subscribe`).
 * Per-token text would blow through the cap in a single answer and push the
 * turn's own tool calls out of the record.
 */
export const MAX_TASK_EVENTS = 2000;

/** How much of a task's answer is kept as its result, for the model to read. */
export const TASK_RESULT_CHARS = 20_000;

/** How much of that result travels in {@link BackgroundTask.resultPreview}. */
export const TASK_PREVIEW_CHARS = 600;

/**
 * How long a finished task is kept. It holds the run's snapshot — including MCP
 * secrets and the user's LLM token — so this is a retention limit first and a
 * memory limit second.
 */
export const TASK_RETENTION_MS = 6 * 60 * 60_000;

/** Hard ceiling on kept tasks, oldest finished ones dropped first. */
export const MAX_TASKS_KEPT = 50;

/** The delegation tools' model-facing names. */
export const DELEGATE_TASK_TOOL = 'delegate_task';
export const CHECK_TASK_TOOL = 'check_task';
export const LIST_TASKS_TOOL = 'list_tasks';
export const SEND_TO_TASK_TOOL = 'send_to_task';
export const STOP_TASK_TOOL = 'stop_task';

export const TASK_TOOL_NAMES = [
  DELEGATE_TASK_TOOL,
  CHECK_TASK_TOOL,
  LIST_TASKS_TOOL,
  SEND_TO_TASK_TOOL,
  STOP_TASK_TOOL,
] as const;

/** deepagents' own delegation tool, replaced by {@link DELEGATE_TASK_TOOL}. */
export const BUILTIN_TASK_TOOL = 'task';

export const DELEGATE_TASK_SCHEMA = {
  type: 'object',
  properties: {
    subagent_type: {
      type: 'string',
      description:
        'One of the agent types listed in your instructions; "general-purpose" when none of them fits.',
    },
    description: {
      type: 'string',
      description: 'Three to five words naming the task, shown to the user on its card.',
    },
    prompt: {
      type: 'string',
      description:
        'The full brief. The agent starts cold and cannot ask you anything, so state the goal, the constraints and what a finished answer looks like.',
    },
    run_in_background: {
      type: 'boolean',
      description:
        'Default true. Pass false only when you cannot continue this turn without the answer.',
    },
  },
  required: ['subagent_type', 'description', 'prompt'],
} as const;

export const TASK_ID_SCHEMA = {
  type: 'object',
  properties: {
    taskId: {
      type: 'string',
      description: 'The exact taskId returned by delegate_task. Pass it verbatim.',
    },
  },
  required: ['taskId'],
} as const;

export const SEND_TO_TASK_SCHEMA = {
  type: 'object',
  properties: {
    taskId: {
      type: 'string',
      description: 'The exact taskId returned by delegate_task. Pass it verbatim.',
    },
    message: {
      type: 'string',
      description:
        'What to tell the task. It keeps everything it has worked out so far; a task still running is interrupted and picks the work back up with this in hand.',
    },
  },
  required: ['taskId', 'message'],
} as const;

/** No arguments, but a schema is still required. */
export const NO_ARGS_SCHEMA = { type: 'object', properties: {} } as const;

/**
 * How the agent is told to use the delegation tools. The hygiene rules are
 * adapted from deepagents' `ASYNC_TASK_SYSTEM_PROMPT` and Claude Code's Agent
 * tool guidance — they are theirs because the failure modes are the same ones:
 * an agent that polls its own task in a loop, one that reports a status it read
 * three turns ago, and one that delegates work it could have done itself in a
 * sentence.
 *
 * What is not theirs is the opening list. Rules alone read as a wall of
 * prohibitions, and an agent given nothing but reasons to be careful with a tool
 * settles on never reaching for it: the observed behaviour was a model that
 * delegated essentially nothing. So the cases *for* delegating are stated first,
 * and the ones against keep their place underneath.
 *
 * Nor is the fan-out paragraph. Two of the rules below — hand control back, do
 * not poll — describe a background task, and read together they say «start it
 * and end your turn», which is precisely wrong for the shape this was still
 * being lost on: one search repeated over ten repositories, in a chat the user
 * is watching. That is several tasks in one message with `run_in_background`
 * off, and nothing here used to say so.
 */
export const TASK_INSTRUCTIONS = `## Background tasks

\`delegate_task\` hands work to a separate agent. By default the task goes **into the background**: you get a \`taskId\` immediately and carry on the conversation, while its own turn runs on its own and costs you no context.

Delegate when:

- **the work is long and the user does not have to sit through it** — a broad search, a sweep across many files or sources, a report to assemble;
- **your plan has items that do not depend on each other** — start them as tasks and let them run side by side instead of one after another;
- **the raw material would swamp your context** — dozens of pages or long tool output, when all you need back is the conclusion;
- **the question belongs to one of the agent types listed below** — that is what they are there for.

**The fan-out is the case worth learning.** When the same work has to be done over one target after another — the same search across five repositories, the same question against several sources — do not walk them yourself, one call at a time. Put several \`delegate_task\` calls **in a single message**: they start together and run side by side, while doing it by hand costs you one round-trip per target and fills your context with everything you read on the way. Up to ${MAX_TASKS_PER_CHAT} tasks may run at once in one chat (${MAX_TASKS_RUNNING} across all of them); beyond that a task is refused and you can start it when another finishes.

Pass \`run_in_background: false\` for a fan-out whose answer this turn needs — your turn waits for all of them and then answers with what came back. Leave it at the default when the work is long and the user does not need to sit through it.

And then:

- **Once a background task is started, give control back to the user.** Say it is under way and end your turn. Do not check its status in that same turn.
- **Do not poll in a loop.** \`check_task\` once, when the user asks about the result. If the status is \`running\`, say so and stop.
- **A status from the history is always stale.** A task that was \`running\` three messages ago is most likely done. Never repeat a status from an earlier tool result — ask \`list_tasks\` (for all of them) or \`check_task\` (for one).
- **Do not invent the result of an unfinished task.** Asked too early, answer that it is still running.
- \`send_to_task\` adds a follow-up to a task; \`stop_task\` cancels one that is no longer needed.
- The user never sees a task's report — retell what matters from it rather than all of it.
- **Do not delegate what is cheaper to do yourself:** every task starts from a cold context and works the question out again.
- Show a \`taskId\` in full; never abbreviate it.`;
