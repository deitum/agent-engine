/**
 * The guard against the silent stop: a model answer whose tool-call arguments
 * will not parse must still reach the tool node, because an empty `tool_calls`
 * is how the agent's router spells «the model is done».
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  buildToolCallRepairMiddleware,
  repairToolCalls,
  warnOnTruncation,
} from './repair-tool-calls';

/** A model answer as LangChain hands it to a `wrapModelCall` middleware. */
function answer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'run-1', content: '', tool_calls: [], invalid_tool_calls: [], ...overrides };
}

/** One entry of `invalid_tool_calls`, as `makeInvalidToolCall` builds it. */
function invalid(name: string, args: string, id = 'call-1'): Record<string, unknown> {
  return { name, args, id, error: 'not valid JSON', type: 'invalid_tool_call' };
}

function callsOf(message: Record<string, unknown>) {
  return message.tool_calls as { id: string; name: string; args: unknown; type: string }[];
}

/** Silences the daemon log a repair writes, and reports what it wrote. */
function captureLog<T>(run: () => T): { result: T; lines: string[] } {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (message: unknown) => {
    lines.push(String(message));
  };
  try {
    return { result: run(), lines };
  } finally {
    console.warn = original;
  }
}

describe('repairToolCalls', () => {
  /**
   * The real answer this whole module exists for: `component_list` takes no
   * arguments and the gateway spells that as `{}""`.
   */
  test('a complete object with noise after it keeps its arguments', () => {
    const message = answer({ invalid_tool_calls: [invalid('component_list', '{}""')] });

    const { result: repaired } = captureLog(() => repairToolCalls(message, () => {}));

    assert.equal(repaired, 1);
    assert.deepEqual(callsOf(message), [
      { id: 'call-1', name: 'component_list', args: {}, type: 'tool_call' },
    ]);
    assert.deepEqual(message.invalid_tool_calls, []);
  });

  test('an empty arguments string means no arguments', () => {
    const message = answer({ invalid_tool_calls: [invalid('read_design', '')] });

    captureLog(() => repairToolCalls(message, () => {}));

    assert.deepEqual(callsOf(message)[0]?.args, {});
  });

  test('real arguments survive the repair', () => {
    const message = answer({
      invalid_tool_calls: [invalid('write_design_file', '{"path":"index.tsx"}trailing')],
    });

    captureLog(() => repairToolCalls(message, () => {}));

    assert.deepEqual(callsOf(message)[0]?.args, { path: 'index.tsx' });
  });

  /**
   * Truncated arguments cannot be recovered, but the call still goes through:
   * the tool answers «`path` is required…», which the model can read and retry — where
   * dropping the call ends the turn with nothing said.
   */
  test('truncated arguments still make the call, and are reported', () => {
    const warnings: string[] = [];
    const message = answer({
      invalid_tool_calls: [invalid('write_design_file', '{"path":"index.tsx","content":"<div')],
    });

    captureLog(() => repairToolCalls(message, (text) => warnings.push(text)));

    assert.deepEqual(callsOf(message)[0]?.args, {});
    assert.match(warnings[0] ?? '', /write_design_file/);
    assert.match(warnings[0] ?? '', /arrived truncated/);
  });

  test('a repaired call is appended to the valid ones, not instead of them', () => {
    const valid = { id: 'call-0', name: 'check_design', args: {}, type: 'tool_call' };
    const message = answer({
      tool_calls: [valid],
      invalid_tool_calls: [invalid('component_list', '{}""')],
    });

    captureLog(() => repairToolCalls(message, () => {}));

    assert.deepEqual(
      callsOf(message).map((call) => call.name),
      ['check_design', 'component_list'],
    );
  });

  /** Without an id there is nothing to pair a `ToolMessage` with. */
  test('a call with no id or no name is dropped with a warning', () => {
    const warnings: string[] = [];
    const message = answer({
      invalid_tool_calls: [
        { name: 'component_list', args: '{}""', type: 'invalid_tool_call' },
        invalid('', '{}', 'call-2'),
      ],
    });

    const { result: repaired } = captureLog(() =>
      repairToolCalls(message, (text) => warnings.push(text)),
    );

    assert.equal(repaired, 0);
    assert.deepEqual(callsOf(message), []);
    assert.equal(warnings.length, 2);
  });

  test('an answer with nothing invalid is left exactly as it was', () => {
    const valid = { id: 'call-0', name: 'check_design', args: {}, type: 'tool_call' };
    const message = answer({ tool_calls: [valid] });
    const untouched = answer({ invalid_tool_calls: undefined });

    assert.equal(
      repairToolCalls(message, () => {}),
      0,
    );
    assert.equal(
      repairToolCalls(untouched, () => {}),
      0,
    );
    assert.equal(
      repairToolCalls(null, () => {}),
      0,
    );
    assert.deepEqual(callsOf(message), [valid]);
  });

  /** Serialisation reads the parallel copy of a LangChain message's arguments. */
  test('keeps the message’s serialised copy in step', () => {
    const message = answer({
      lc_kwargs: { tool_calls: [], invalid_tool_calls: [invalid('component_list', '{}""')] },
      invalid_tool_calls: [invalid('component_list', '{}""')],
    });

    captureLog(() => repairToolCalls(message, () => {}));

    const kwargs = message.lc_kwargs as Record<string, unknown[]>;
    assert.deepEqual(kwargs.tool_calls, callsOf(message));
    assert.deepEqual(kwargs.invalid_tool_calls, []);
  });

  test('says in the daemon log which call it repaired', () => {
    const message = answer({ invalid_tool_calls: [invalid('component_list', '{}""')] });

    const { lines } = captureLog(() => repairToolCalls(message, () => {}));

    assert.match(lines[0] ?? '', /component_list/);
    assert.match(lines[0] ?? '', /\{\}""/);
  });
});

describe('warnOnTruncation', () => {
  test('reports an answer cut off by the token limit', () => {
    const warnings: string[] = [];

    warnOnTruncation(answer({ response_metadata: { finish_reason: 'length' } }), (text) =>
      warnings.push(text),
    );

    assert.match(warnings[0] ?? '', /token limit/);
  });

  test('says nothing about an answer that finished on its own', () => {
    const warnings: string[] = [];

    warnOnTruncation(answer({ response_metadata: { finish_reason: 'tool_calls' } }), (text) =>
      warnings.push(text),
    );
    warnOnTruncation(answer(), (text) => warnings.push(text));

    assert.deepEqual(warnings, []);
  });
});

describe('buildToolCallRepairMiddleware', () => {
  type Wrapped = {
    name: string;
    wrapModelCall: (
      request: unknown,
      handler: (request: unknown) => unknown,
    ) => Promise<Record<string, unknown>>;
  };

  /** As in `deep-agent.tools.test.ts`: the factory hands the config straight back. */
  const createMiddleware = (config: unknown): unknown => config;

  test('repairs the answer the handler returned', async () => {
    const message = answer({ invalid_tool_calls: [invalid('component_list', '{}""')] });
    const middleware = buildToolCallRepairMiddleware(createMiddleware, () => {}) as Wrapped;

    const { result } = captureLog(() => middleware.wrapModelCall({}, () => message));

    assert.equal(await result, message, 'the very same message object, not a rebuilt one');
    assert.deepEqual(callsOf(message)[0]?.name, 'component_list');
  });

  test('passes the request through untouched', async () => {
    const request = { tools: [{ name: 'check_design' }] };
    const middleware = buildToolCallRepairMiddleware(createMiddleware, () => {}) as Wrapped;
    let seen: unknown = null;

    await middleware.wrapModelCall(request, (forwarded) => {
      seen = forwarded;
      return answer();
    });

    assert.equal(seen, request);
  });
});
