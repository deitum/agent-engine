import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { adoptEngineConfig, resetEngineConfig } from '../config/engine-config';
import { type DeepAgentLlmParams } from '../contracts';

import { buildChatModel } from './chat-model';
import { DEFAULT_LLM_MAX_RETRIES, LLM_MAX_RETRIES_VAR } from './llm.constants';

const realFetch = globalThis.fetch;

/** Stands in for `ChatOpenAI`: `buildChatModel` takes the class as an argument. */
class FakeChatOpenAI {
  constructor(readonly params: Record<string, unknown>) {}
}

const build = (llm: DeepAgentLlmParams = { model: 'gpt' }): FakeChatOpenAI =>
  buildChatModel(FakeChatOpenAI as never, llm) as unknown as FakeChatOpenAI;

beforeEach(async () => {
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ baseUrl: 'https://gateway.corp/v1' }), { status: 200 }),
    )) as typeof fetch;
  await adoptEngineConfig({
    version: 'v1',
    hostConfigUrl: 'https://app.corp/api/llm/config',
    llm: { apiKey: 'sk-user' },
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env[LLM_MAX_RETRIES_VAR];
  resetEngineConfig();
});

/**
 * The retry budget is the difference between a turn that fails in seconds and
 * one that hangs for two minutes: langchain's own default of 6 backs off to a
 * seventh attempt ~113s after the first, and says nothing while it waits.
 */
describe('buildChatModel', () => {
  test('bounds the retries langchain would otherwise take six of', () => {
    assert.equal(build().params.maxRetries, DEFAULT_LLM_MAX_RETRIES);
  });

  test('a deployment whose gateway needs more patience can say so', () => {
    process.env[LLM_MAX_RETRIES_VAR] = '6';
    assert.equal(build().params.maxRetries, 6);
  });

  test('retries can be turned off outright', () => {
    process.env[LLM_MAX_RETRIES_VAR] = '0';
    assert.equal(build().params.maxRetries, 0);
  });

  test('a value that is not a count is ignored rather than obeyed', () => {
    for (const value of ['', 'lots', '-1', '2.5']) {
      process.env[LLM_MAX_RETRIES_VAR] = value;
      assert.equal(build().params.maxRetries, DEFAULT_LLM_MAX_RETRIES, `for "${value}"`);
    }
  });

  test('passes the reasoning effort a run named, and omits the key when it did not', () => {
    assert.equal(build({ model: 'gpt', reasoningEffort: 'high' }).params.reasoningEffort, 'high');
    // Absent, not `undefined`: an unset sampling field means «the provider's own
    // default», which is not the same as naming one.
    assert.ok(!('reasoningEffort' in build().params));
  });

  test('each model gets its own fetch, so attempts are counted per turn', () => {
    const { fetch: first } = build().params.configuration as { fetch: unknown };
    const { fetch: second } = build().params.configuration as { fetch: unknown };

    assert.equal(typeof first, 'function');
    assert.notEqual(first, second);
  });
});
