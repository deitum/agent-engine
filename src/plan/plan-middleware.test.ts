import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// Type-only, so the lazy loading of the model libraries stays lazy.
import { type ChatResult } from '@langchain/core/outputs';

import { type DeepAgentStreamEvent, type DeepAgentTodo } from '../contracts';
import { loadDeps, type StreamableAgent, streamAgentUpdates } from '../deep-agent';

import { buildPlanMiddleware } from './plan-middleware';
import { PLAN_STATE_SCHEMA } from './plan-nudge';
import { WRITE_TODOS_TOOL } from './plan.constants';

/**
 * These two tests are the whole point of `plan-middleware.ts`: they run a real
 * `createDeepAgent` against a scripted model and assert that the planning tool
 * is there and that a plan reaches our stream contract.
 *
 * deepagents dropped `todoListMiddleware` from its default stack in 1.12 and
 * nothing failed — no type error, no exception, not even a visible step: the
 * agent simply stopped having a `write_todos` tool, and the plan card stopped
 * appearing. A unit test over our own code could not have caught that, so this
 * one deliberately goes through the library.
 */

/** One scripted answer: either a tool call to make, or the text to end on. */
type Scripted = { call: { name: string; args: Record<string, unknown> } } | { text: string };

/** The tool names handed to the model, captured per model call. */
interface ToolSpy {
  seen: string[][];
  middleware: unknown;
}

/**
 * A model that replays `script`, one answer per call, ending on plain text.
 * Built through the same dynamic import the daemon uses, and cast at the seam
 * for the reason {@link StreamableAgent} documents.
 */
async function scriptedModel(script: Scripted[]): Promise<unknown> {
  const { BaseChatModel } = await import('@langchain/core/language_models/chat_models');
  const { AIMessage } = await import('@langchain/core/messages');

  let turn = 0;
  class ScriptedModel extends BaseChatModel {
    _llmType(): string {
      return 'scripted';
    }

    /** The agent binds its tools to the model; the script does not care about them. */
    override bindTools(): this {
      return this;
    }

    async _generate(): Promise<ChatResult> {
      const step = script[turn] ?? { text: 'done' };
      turn += 1;
      const message =
        'call' in step
          ? new AIMessage({
              content: '',
              tool_calls: [{ id: `call-${turn}`, name: step.call.name, args: step.call.args }],
            })
          : new AIMessage({ content: step.text });
      return { generations: [{ text: 'text' in step ? step.text : '', message }] };
    }
  }

  return new ScriptedModel({});
}

/** Middleware recording the tool list of every model call it wraps. */
function toolSpy(
  createMiddleware: Awaited<ReturnType<typeof loadDeps>>['createMiddleware'],
): ToolSpy {
  const seen: string[][] = [];
  const middleware = (
    createMiddleware as (config: {
      name: string;
      wrapModelCall: (request: unknown, handler: (request: unknown) => unknown) => unknown;
    }) => unknown
  )({
    name: 'ToolSpy',
    wrapModelCall: (request, handler) => {
      const tools = (request as { tools?: { name?: string }[] }).tools ?? [];
      seen.push(tools.map((entry) => entry.name ?? ''));
      return handler(request);
    },
  });
  return { seen, middleware };
}

/** Middleware recording the plan held in state at every model call it wraps. */
function planSpy(createMiddleware: Awaited<ReturnType<typeof loadDeps>>['createMiddleware']): {
  seen: unknown[];
  middleware: unknown;
} {
  const seen: unknown[] = [];
  const middleware = (
    createMiddleware as (config: {
      name: string;
      stateSchema: unknown;
      wrapModelCall: (request: unknown, handler: (request: unknown) => unknown) => unknown;
    }) => unknown
  )({
    name: 'PlanSpy',
    // Declared for the same reason the nudge middleware declares it: langchain
    // hands a middleware only the state keys its own schema names, so a spy
    // without this one would report «no plan» however the run went.
    stateSchema: PLAN_STATE_SCHEMA,
    wrapModelCall: (request, handler) => {
      seen.push((request as { state?: { todos?: unknown } }).state?.todos);
      return handler(request);
    },
  });
  return { seen, middleware };
}

describe('buildPlanMiddleware', () => {
  test(`gives the model the tool ${WRITE_TODOS_TOOL} — deepagents no longer provides it`, async () => {
    const deps = await loadDeps();
    const spy = toolSpy(deps.createMiddleware);

    const agent = deps.createDeepAgent({
      model: await scriptedModel([{ text: 'done' }]),
      systemPrompt: 'You are an assistant.',
      middleware: [buildPlanMiddleware(deps.todoListMiddleware), spy.middleware],
    } as unknown as Parameters<typeof deps.createDeepAgent>[0]) as unknown as StreamableAgent;

    await streamAgentUpdates(
      agent,
      [{ role: 'user', content: 'hello', id: 'hist-0' }],
      () => {},
      new AbortController().signal,
    );

    assert.ok(spy.seen.length > 0, 'the model was never called');
    for (const tools of spy.seen) {
      assert.ok(tools.includes(WRITE_TODOS_TOOL), `the tool list has no ${WRITE_TODOS_TOOL}`);
    }
  });

  test('a plan the model wrote reaches the todos event', async () => {
    const deps = await loadDeps();
    const todos = [
      { content: 'go through the sources', status: 'in_progress' },
      { content: 'pull the conclusions together', status: 'pending' },
    ];

    const agent = deps.createDeepAgent({
      model: await scriptedModel([
        { call: { name: WRITE_TODOS_TOOL, args: { todos } } },
        { text: 'done' },
      ]),
      systemPrompt: 'You are an assistant.',
      middleware: [buildPlanMiddleware(deps.todoListMiddleware)],
    } as unknown as Parameters<typeof deps.createDeepAgent>[0]) as unknown as StreamableAgent;

    const events: DeepAgentStreamEvent[] = [];
    await streamAgentUpdates(
      agent,
      [{ role: 'user', content: 'do a, then b', id: 'hist-0' }],
      (event) => events.push(event),
      new AbortController().signal,
    );

    assert.deepEqual(
      events.filter((event) => event.type === 'todos'),
      [{ type: 'todos', todos }],
    );
    // The plan card carries the plan; a step row beside it would be noise.
    assert.ok(
      !events.some((event) => event.type === 'tool_call' && event.name === WRITE_TODOS_TOOL),
    );
  });

  test('the previous turn’s plan is adopted by the state and continued rather than duplicated', async () => {
    const deps = await loadDeps();
    const seeded: DeepAgentTodo[] = [
      { content: 'go through the sources', status: 'in_progress' },
      { content: 'pull the conclusions together', status: 'pending' },
    ];
    const revised: DeepAgentTodo[] = [
      { content: 'go through the sources', status: 'completed' },
      { content: 'pull the conclusions together', status: 'in_progress' },
    ];

    const spy = planSpy(deps.createMiddleware);
    const agent = deps.createDeepAgent({
      model: await scriptedModel([
        { call: { name: WRITE_TODOS_TOOL, args: { todos: revised } } },
        { text: 'done' },
      ]),
      systemPrompt: 'You are an assistant.',
      middleware: [buildPlanMiddleware(deps.todoListMiddleware), spy.middleware],
    } as unknown as Parameters<typeof deps.createDeepAgent>[0]) as unknown as StreamableAgent;

    const events: DeepAgentStreamEvent[] = [];
    await streamAgentUpdates(
      agent,
      { messages: [{ role: 'user', content: 'carry on', id: 'hist-0' }], todos: seeded },
      (event) => events.push(event),
      new AbortController().signal,
    );

    // The graph accepted the seed: the very first model call already runs with
    // last turn's plan in state. This is the assertion that would fail if the
    // `todos` channel stopped taking input — the rest of the feature is built on
    // it being there.
    assert.deepEqual(spy.seen[0], seeded);
    assert.deepEqual(spy.seen.at(-1), revised, 'the revision did not reach the state');
    // The seeded plan is the card the browser already has on screen, so only the
    // revision is an event — otherwise every turn would open by redrawing the
    // plan it inherited.
    assert.deepEqual(
      events.filter((event) => event.type === 'todos'),
      [{ type: 'todos', todos: revised }],
    );
  });
});
