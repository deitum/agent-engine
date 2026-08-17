import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// Type-only, so the lazy loading of the model libraries stays lazy.
import { type ChatResult } from '@langchain/core/outputs';

import { loadDeps, type StreamableAgent, streamAgentUpdates } from '../deep-agent';
import { DELEGATE_TASK_TOOL } from '../tasks/tasks.constants';

import { buildPlanMiddleware } from './plan-middleware';
import { buildPlanNudgeMiddleware, pickNudge, readTurnStats } from './plan-nudge';
import {
  DELEGATE_NUDGE,
  FANOUT_REPEATS,
  MAX_NUDGES_PER_TURN,
  NUDGE_AFTER_TOOL_CALLS,
  PLAN_NUDGE,
  PLAN_UPDATE_NUDGE,
  STALE_PLAN_CALLS,
  WRITE_TODOS_TOOL,
} from './plan.constants';

/**
 * The rules are the whole behaviour of `plan-nudge.ts`, so they are tested
 * directly: driving them through a real agent would say which reminder came out
 * but very little about which rule produced it, and the thresholds are the part
 * that will be re-tuned.
 *
 * The middleware itself is checked twice over: through the `createMiddleware`
 * seam, for what it does to one request, and then inside a real
 * `createDeepAgent`, because the half that fails silently is always the wiring —
 * a reminder the graph never passes on looks exactly like a model that chose not
 * to plan.
 */

/** A langchain-shaped state message: an AI turn with the tool calls it made. */
function aiCall(...names: string[]): unknown {
  return {
    getType: () => 'ai',
    tool_calls: names.map((name, index) => ({ id: `call-${index}`, name, args: {} })),
  };
}

function human(): unknown {
  return { getType: () => 'human', content: 'do it' };
}

/** The system message seam: langchain's `SystemMessage.concat` returns a new one. */
function systemMessage(text: string): { concat: (extra: string) => unknown; text: string } {
  return { text, concat: (extra: string) => systemMessage(text + extra) };
}

/** The one hook this module installs, as the seam hands it back. */
interface Wrapped {
  wrapModelCall: (request: unknown, handler: (request: unknown) => unknown) => unknown;
}

/** `createMiddleware` reduced to what the middleware needs of it: an echo. */
const fakeCreateMiddleware = (config: unknown): unknown => config;

function build(options: Parameters<typeof buildPlanNudgeMiddleware>[1]): Wrapped {
  return buildPlanNudgeMiddleware(fakeCreateMiddleware, options) as Wrapped;
}

/** Runs one model call through the middleware, returning what the model saw. */
function callWith(
  middleware: Wrapped,
  state: { todos?: unknown; messages?: unknown[] },
): { prompt: string; toolChoice: unknown } {
  let seen: { systemMessage: { text: string }; toolChoice?: unknown } | null = null;
  middleware.wrapModelCall(
    { systemMessage: systemMessage('You are an assistant.'), state },
    (next) => {
      seen = next as typeof seen;
      return next;
    },
  );
  assert.ok(seen !== null, 'the middleware never called the handler');
  const { systemMessage: prompt, toolChoice } = seen as {
    systemMessage: { text: string };
    toolChoice?: unknown;
  };
  return { prompt: prompt.text, toolChoice };
}

describe('readTurnStats', () => {
  test('counts only the calls after the user’s last message', () => {
    const stats = readTurnStats([
      human(),
      aiCall('read_file', 'read_file'),
      human(),
      aiCall('grep'),
      aiCall('grep'),
    ]);

    assert.equal(stats.toolCalls, 2);
    assert.equal(stats.repeats, 2);
  });

  test(`${WRITE_TODOS_TOOL} does not count as work and resets the counter since the last plan`, () => {
    const stats = readTurnStats([
      human(),
      aiCall('grep'),
      aiCall(WRITE_TODOS_TOOL),
      aiCall('read_file'),
    ]);

    assert.equal(stats.toolCalls, 2, 'a plan is not a call to a working tool');
    assert.equal(stats.callsSincePlan, 1);
  });

  test('notices a delegation that already happened', () => {
    const stats = readTurnStats([human(), aiCall(DELEGATE_TASK_TOOL)]);

    assert.equal(stats.delegated, true);
  });
});

describe('pickNudge', () => {
  const noPlan: never[] = [];
  const open = [{ status: 'in_progress' }];
  const done = [{ status: 'completed' }];

  test('stays quiet until the turn has become multi-step', () => {
    const stats = {
      toolCalls: NUDGE_AFTER_TOOL_CALLS - 1,
      callsSincePlan: 0,
      repeats: 1,
      delegated: false,
    };

    assert.equal(pickNudge(noPlan, stats, false), null);
  });

  test('asks for a plan on the third call without one', () => {
    const stats = {
      toolCalls: NUDGE_AFTER_TOOL_CALLS,
      callsSincePlan: 0,
      repeats: 1,
      delegated: false,
    };

    assert.equal(pickNudge(noPlan, stats, false), PLAN_NUDGE);
  });

  test('suggests a fan-out when one tool is being repeated by hand', () => {
    const stats = { toolCalls: 9, callsSincePlan: 0, repeats: FANOUT_REPEATS, delegated: false };

    assert.equal(pickNudge(open, stats, true), DELEGATE_NUDGE);
    assert.equal(pickNudge(open, stats, false), null, 'stay quiet when delegation is not allowed');
    assert.equal(
      pickNudge(open, { ...stats, delegated: true }, true),
      null,
      'the turn already delegated — there is nothing to repeat',
    );
  });

  test('asks for a refresh of a plan nobody has touched in a while', () => {
    const stats = { toolCalls: 9, callsSincePlan: STALE_PLAN_CALLS, repeats: 1, delegated: false };

    assert.equal(pickNudge(open, stats, false), PLAN_UPDATE_NUDGE);
    assert.equal(
      pickNudge(done, stats, false),
      null,
      'there is no point refreshing a finished plan',
    );
  });
});

describe('buildPlanNudgeMiddleware', () => {
  const working = { messages: [human(), aiCall('grep'), aiCall('grep'), aiCall('grep')] };

  test('appends the reminder to the system message — of that one call only', () => {
    const middleware = build({});

    const first = callWith(middleware, working);
    assert.ok(first.prompt.includes(PLAN_NUDGE), 'the reminder never reached the model');
    assert.ok(first.prompt.startsWith('You are an assistant.'), 'the original prompt is lost');

    // Cooldown aside, the point here is that the reminder was not written back:
    // the next call starts from the same system message it always had.
    const second = callWith(middleware, working);
    assert.ok(!second.prompt.includes(PLAN_NUDGE));
  });

  test(`does not remind more than ${MAX_NUDGES_PER_TURN} times per turn`, () => {
    const middleware = build({});

    const prompts = Array.from({ length: 12 }, () => callWith(middleware, working).prompt);
    const nudged = prompts.filter((prompt) => prompt.includes(PLAN_NUDGE));

    assert.equal(nudged.length, MAX_NUDGES_PER_TURN);
  });

  test('requirePlan makes the first call write a plan — exactly once', () => {
    const middleware = build({ requirePlan: true });

    const first = callWith(middleware, { messages: [human()] });
    assert.deepEqual(first.toolChoice, {
      type: 'function',
      function: { name: WRITE_TODOS_TOOL },
    });

    const second = callWith(middleware, { messages: [human()] });
    assert.equal(second.toolChoice, undefined, 'the model stayed locked to one tool');
  });

  test('requirePlan leaves a turn that began with a plan alone', () => {
    const middleware = build({ requirePlan: true });

    const call = callWith(middleware, {
      todos: [{ content: 'go through the sources', status: 'in_progress' }],
      messages: [human()],
    });

    assert.equal(call.toolChoice, undefined);
  });
});

/**
 * The seam tests above say the rules are right; these two say the middleware is
 * actually wired into a real `createDeepAgent` — which is the half that failed
 * silently last time (see `plan-middleware.test.ts`). A reminder that never
 * reaches the model, or a `toolChoice` the graph drops on the floor, would look
 * from the outside exactly like a model that chose not to plan.
 */
describe('buildPlanNudgeMiddleware inside a real agent', () => {
  /**
   * The system message as text. langchain's `SystemMessage.concat` appends a
   * **content block** rather than extending a string, so everything the
   * middleware stack adds arrives as `[{ type: 'text', text }, …]` — the plan
   * instructions included.
   */
  function promptText(content: unknown): string {
    if (typeof content === 'string') {
      return content;
    }
    if (!Array.isArray(content)) {
      return '';
    }
    return content
      .map((block) => (block as { text?: unknown })?.text)
      .filter((text): text is string => typeof text === 'string')
      .join('\n');
  }

  /** What the model was actually told, captured per call. */
  interface ModelSpy {
    prompts: string[];
    toolChoices: unknown[];
    model: unknown;
  }

  /**
   * A model that calls `noop` `calls` times and then answers, recording the
   * system prompt and the tool choice it was bound with each time.
   */
  async function spyModel(calls: number): Promise<ModelSpy> {
    const { BaseChatModel } = await import('@langchain/core/language_models/chat_models');
    const { AIMessage } = await import('@langchain/core/messages');
    const prompts: string[] = [];
    const toolChoices: unknown[] = [];

    let turn = 0;
    class SpyModel extends BaseChatModel {
      _llmType(): string {
        return 'spy';
      }

      override bindTools(_tools: unknown[], kwargs?: Record<string, unknown>): this {
        toolChoices.push(kwargs?.tool_choice);
        return this;
      }

      async _generate(messages: { content: unknown }[]): Promise<ChatResult> {
        prompts.push(promptText(messages[0]?.content));
        turn += 1;
        const message =
          turn <= calls
            ? new AIMessage({
                content: '',
                tool_calls: [{ id: `call-${turn}`, name: 'noop', args: {} }],
              })
            : new AIMessage({ content: 'done' });
        return { generations: [{ text: turn <= calls ? '' : 'done', message }] };
      }
    }

    return { prompts, toolChoices, model: new SpyModel({}) };
  }

  async function run(
    spy: ModelSpy,
    options: Parameters<typeof buildPlanNudgeMiddleware>[1],
  ): Promise<void> {
    const deps = await loadDeps();
    const noop = deps.tool(() => 'ok', {
      name: 'noop',
      description: 'does nothing',
      schema: { type: 'object', properties: {} },
    });

    const agent = deps.createDeepAgent({
      model: spy.model,
      systemPrompt: 'You are an assistant.',
      tools: [noop],
      middleware: [
        buildPlanMiddleware(deps.todoListMiddleware),
        buildPlanNudgeMiddleware(deps.createMiddleware, options),
      ],
    } as unknown as Parameters<typeof deps.createDeepAgent>[0]) as unknown as StreamableAgent;

    await streamAgentUpdates(
      agent,
      [{ role: 'user', content: 'figure it out', id: 'hist-0' }],
      () => {},
      new AbortController().signal,
    );
  }

  test(`the reminder reaches the model after ${NUDGE_AFTER_TOOL_CALLS} calls without a plan`, async () => {
    const spy = await spyModel(NUDGE_AFTER_TOOL_CALLS);
    await run(spy, {});

    assert.ok(
      spy.prompts.length > NUDGE_AFTER_TOOL_CALLS,
      'the turn ended before a reminder would have been apt',
    );
    for (const prompt of spy.prompts.slice(0, NUDGE_AFTER_TOOL_CALLS)) {
      assert.ok(!prompt.includes(PLAN_NUDGE), 'reminded before the turn became multi-step');
    }
    assert.ok(
      spy.prompts.at(-1)?.includes(PLAN_NUDGE),
      'the reminder never reached the model’s system message',
    );
  });

  test('requirePlan reaches the model as tool_choice', async () => {
    const spy = await spyModel(0);
    await run(spy, { requirePlan: true });

    assert.deepEqual(spy.toolChoices[0], {
      type: 'function',
      function: { name: WRITE_TODOS_TOOL },
    });
  });
});
