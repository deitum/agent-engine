import { z } from 'zod';

import { DELEGATE_TASK_TOOL } from '../tasks/tasks.constants';

import {
  DELEGATE_NUDGE,
  FANOUT_REPEATS,
  MAX_NUDGES_PER_TURN,
  NUDGE_AFTER_TOOL_CALLS,
  NUDGE_COOLDOWN_CALLS,
  PLAN_NUDGE,
  PLAN_UPDATE_NUDGE,
  STALE_PLAN_CALLS,
  WRITE_TODOS_TOOL,
} from './plan.constants';

/**
 * Reminds the agent, *while it works*, that the work it is doing wanted a plan —
 * and, where the run says a plan is not optional, makes the first call write one.
 *
 * The policy is already in the system prompt (`plan.constants.ts`), and on a
 * capable model that is enough. It was not enough here: measured over a day of
 * real chats, one turn in ninety wrote a plan, and the turn that most needed one
 * — ninety tool calls across Confluence and a dozen repositories — instead
 * narrated its plan in prose, a sentence at a time, before each call. The
 * intention to plan was there on every step; the tool was not, because the only
 * text asking for it had been read once, at the top of a turn that had not
 * started yet, alongside everything else in the prompt.
 *
 * So the reminder arrives at the moment it applies rather than before it: after
 * three tool calls with no plan, after six with a plan nobody has touched, after
 * the same tool has been pointed at a fourth target by hand. This is the device
 * Claude Code uses on the same failure, and it is cheap for the same reason —
 * each reminder is one line, capped at {@link MAX_NUDGES_PER_TURN} per turn and
 * spaced by {@link NUDGE_COOLDOWN_CALLS}, since an agent nagged on every call
 * learns to read past the nagging.
 *
 * **A reminder is ephemeral.** It is concatenated onto the system message of one
 * model call and never written to state or to `messages` — otherwise it would
 * accumulate in the context, travel in every later request, and end up in the
 * transcript the user reads.
 */

/** The `createMiddleware` factory, through the same `unknown` seam as its callers. */
type CreateMiddleware = (config: {
  name: string;
  stateSchema?: unknown;
  wrapModelCall: (request: unknown, handler: (request: unknown) => unknown) => unknown;
}) => unknown;

/**
 * The plan, declared so this middleware can read it.
 *
 * Not decoration and not a second source of truth: langchain hands each
 * middleware **only the state keys its own schema names**, plus `messages`
 * (`AgentNode`: `interopParse(toPartialZodObject(middleware.stateSchema), state)`).
 * Without this the `todos` channel — which langchain's own todo middleware owns
 * — is simply absent from every request this middleware sees, and every rule
 * below would fire as though the agent had never planned anything.
 *
 * It mirrors that middleware's schema exactly, so the two describe one channel
 * rather than disagreeing about it.
 */
export const PLAN_STATE_SCHEMA = z.object({
  todos: z
    .array(
      z.object({
        content: z.string(),
        status: z.enum(['pending', 'in_progress', 'completed']),
      }),
    )
    .default([]),
});

/** The parts of a model request this middleware reads or replaces. */
interface ModelRequestLike {
  /** langchain's `SystemMessage`, whose `concat` returns the extended one. */
  systemMessage?: { concat: (text: string) => unknown };
  /** The agent's state: `todos` comes from langchain's own todo middleware. */
  state?: { todos?: unknown; messages?: unknown };
  toolChoice?: unknown;
}

/** What one plan item looks like once it has survived validation. */
interface TodoLike {
  status?: unknown;
}

export interface PlanNudgeOptions {
  /**
   * The run must open with a plan, so the first model call is forced to write
   * one (`toolChoice`). Set by the surfaces whose prompt demands a plan outright
   * — research turns and a coding session's plan mode — where leaving it to the
   * model means the mode silently does not happen.
   */
  requirePlan?: boolean;
  /** Whether the run has the delegation tools, so the fan-out reminder can fire. */
  delegating?: boolean;
}

/** What the turn so far says about how it is going. */
interface TurnStats {
  /** Tool calls made since the user's message, `write_todos` excluded. */
  toolCalls: number;
  /** Tool calls made since the plan was last written or revised. */
  callsSincePlan: number;
  /** How often the most-repeated tool was called. */
  repeats: number;
  /** Whether anything was delegated in this turn already. */
  delegated: boolean;
}

/** Reads a langchain message's type, tolerating either accessor. */
function messageType(message: unknown): string | undefined {
  if (!message || typeof message !== 'object') {
    return undefined;
  }
  const msg = message as { getType?: () => string; _getType?: () => string };
  return msg.getType?.() ?? msg._getType?.();
}

/** The tool names one message called, in order; empty for anything else. */
function toolNames(message: unknown): string[] {
  const calls = (message as { tool_calls?: unknown }).tool_calls;
  if (!Array.isArray(calls)) {
    return [];
  }
  return calls
    .map((call) => (call as { name?: unknown })?.name)
    .filter((name): name is string => typeof name === 'string');
}

/**
 * Measures the turn from the state's message list.
 *
 * Only what happened after the user's last message counts: the history carries
 * every earlier turn, and a plan written twenty messages ago is not a plan for
 * the work being done now.
 */
export function readTurnStats(messages: unknown): TurnStats {
  const stats: TurnStats = { toolCalls: 0, callsSincePlan: 0, repeats: 0, delegated: false };
  if (!Array.isArray(messages)) {
    return stats;
  }

  const start = messages.findLastIndex((message) => messageType(message) === 'human');
  const counts = new Map<string, number>();

  for (const message of messages.slice(start + 1)) {
    for (const name of toolNames(message)) {
      if (name === WRITE_TODOS_TOOL) {
        // The plan was (re)written here, so everything before it is accounted for.
        stats.callsSincePlan = 0;
        continue;
      }
      stats.toolCalls += 1;
      stats.callsSincePlan += 1;
      stats.delegated ||= name === DELEGATE_TASK_TOOL;
      const seen = (counts.get(name) ?? 0) + 1;
      counts.set(name, seen);
      stats.repeats = Math.max(stats.repeats, seen);
    }
  }

  return stats;
}

/** The plan as the state holds it — an array of items, or none at all. */
function readTodos(value: unknown): TodoLike[] {
  return Array.isArray(value) ? (value as TodoLike[]) : [];
}

/**
 * The reminder this call earns, or `null` when the turn is going fine. Exported
 * for the test: the rules are the whole behaviour of this module, and driving
 * them through a real agent would say very little about which one fired.
 */
export function pickNudge(todos: TodoLike[], stats: TurnStats, delegating: boolean): string | null {
  if (todos.length === 0) {
    return stats.toolCalls >= NUDGE_AFTER_TOOL_CALLS ? PLAN_NUDGE : null;
  }
  // With a plan in hand the fan-out is the more useful thing to say: the plan
  // itself is what makes the independent branches visible.
  if (delegating && !stats.delegated && stats.repeats >= FANOUT_REPEATS) {
    return DELEGATE_NUDGE;
  }
  const open = todos.some((todo) => todo.status !== 'completed');
  return open && stats.callsSincePlan >= STALE_PLAN_CALLS ? PLAN_UPDATE_NUDGE : null;
}

/**
 * Builds the reminder middleware for one run. The counters live in this closure,
 * which is per-run — the same scoping the deferred-tool gate uses.
 */
export function buildPlanNudgeMiddleware(
  createMiddleware: unknown,
  options: PlanNudgeOptions = {},
): unknown {
  let calls = 0;
  let nudges = 0;
  let lastNudgeCall = -NUDGE_COOLDOWN_CALLS;
  let forced = false;

  return (createMiddleware as CreateMiddleware)({
    name: 'PlanNudge',
    stateSchema: PLAN_STATE_SCHEMA,
    wrapModelCall: (request, handler) => {
      calls += 1;
      const model = request as ModelRequestLike;
      const todos = readTodos(model.state?.todos);
      const stats = readTurnStats(model.state?.messages);

      // Forced once and only once. A gateway that ignores `toolChoice`, or a
      // model that answers around it, is left to the reminders below rather than
      // being held at the same tool for the rest of the turn.
      if (options.requirePlan && !forced && todos.length === 0) {
        forced = true;
        return handler({
          ...model,
          toolChoice: { type: 'function', function: { name: WRITE_TODOS_TOOL } },
        });
      }

      if (nudges >= MAX_NUDGES_PER_TURN || calls - lastNudgeCall < NUDGE_COOLDOWN_CALLS) {
        return handler(request);
      }
      const nudge = pickNudge(todos, stats, options.delegating === true);
      if (!nudge || !model.systemMessage) {
        return handler(request);
      }
      nudges += 1;
      lastNudgeCall = calls;
      return handler({ ...model, systemMessage: model.systemMessage.concat(`\n\n${nudge}`) });
    },
  });
}
