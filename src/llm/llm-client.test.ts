import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { adoptEngineConfig, resetEngineConfig } from '../config/engine-config';
import { ConnectorError } from '../connector';
import { type ChatCompletion, ChatRole, type ModelsListResponse } from '../contracts';

import {
  chatCompletion,
  createLlmFetch,
  type GatewayAttempt,
  gatewayAttemptMessage,
  listModels,
} from './llm-client';
import { USER_AGENT_VAR } from './llm.constants';

const realFetch = globalThis.fetch;

const GATEWAY = 'https://gateway.corp/v1';

/** One `data:` frame of a streamed completion. */
const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

/** An SSE body: text, a finish reason, the usage chunk and the sentinel. */
const streamed = (content: string): string =>
  frame({ choices: [{ index: 0, delta: { content }, finish_reason: null }] }) +
  frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
  frame({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }) +
  'data: [DONE]\n\n';

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

/** Records what went out and answers with `respond`. */
function gateway(respond: (call: Call) => Response): { calls: Call[] } {
  const calls: Call[] = [];
  globalThis.fetch = ((url: string, init: RequestInit = {}) => {
    const call = {
      url: String(url),
      init,
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {},
    };
    calls.push(call);
    return Promise.resolve(respond(call));
  }) as typeof fetch;
  return { calls };
}

const sse = (body: string): Response =>
  new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

beforeEach(async () => {
  // Adopt a gateway the way the handshake does, then swap the fetch again so the
  // test's own stub sees only the calls it is about.
  gateway(() => new Response(JSON.stringify({ baseUrl: GATEWAY }), { status: 200 }));
  await adoptEngineConfig({
    version: 'v1',
    hostConfigUrl: 'https://app.corp/api/llm/config',
    llm: { apiKey: 'sk-user' },
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetEngineConfig();
});

describe('chatCompletion', () => {
  test('asks the gateway to stream, with usage, and relays what comes back', async () => {
    const api = gateway(() => sse(streamed('Hello')));

    const response = await chatCompletion({
      model: 'gpt',
      messages: [{ role: ChatRole.User, content: 'hello' }],
    });

    const [call] = api.calls;
    assert.equal(call.url, `${GATEWAY}/chat/completions`);
    // The gateway is streaming-only, so every call is upgraded — and asks for
    // the terminal usage chunk the browser reports as the turn's token count.
    // The token is the adopted one: it never travels with a request any more.
    assert.equal(call.body.stream, true);
    assert.deepEqual(call.body.stream_options, { include_usage: true });
    assert.equal(new Headers(call.init.headers).get('authorization'), 'Bearer sk-user');
    assert.equal(await response.text(), streamed('Hello'));
  });

  test('carries the reasoning effort a host asked for, and nothing when it did not', async () => {
    const api = gateway(() => sse(streamed('Hello')));

    await chatCompletion({ model: 'gpt', messages: [], reasoning_effort: 'high' });
    await chatCompletion({ model: 'gpt', messages: [] });

    // Verbatim and under the gateway's own name: this route is a host's only
    // way to set the level when it drives the turn itself, with no agent run to
    // put it on the model instead.
    assert.equal(api.calls[0]?.body.reasoning_effort, 'high');
    assert.ok(!('reasoning_effort' in (api.calls[1]?.body ?? {})));
  });

  test('a rejection keeps the gateway status and its message', async () => {
    gateway(
      () => new Response(JSON.stringify({ error: { message: 'bad token' } }), { status: 401 }),
    );

    await assert.rejects(
      () => chatCompletion({ model: 'gpt', messages: [] }),
      (error: unknown) => {
        assert.ok(error instanceof ConnectorError);
        assert.equal(error.status, 401);
        assert.equal(error.message, 'bad token');
        return true;
      },
    );
  });

  test('an untrusted certificate is named as one, not as "fetch failed"', async () => {
    globalThis.fetch = (() =>
      Promise.reject(
        Object.assign(new TypeError('fetch failed'), {
          cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', message: 'unable to verify' },
        }),
      )) as typeof fetch;

    await assert.rejects(
      () => chatCompletion({ model: 'gpt', messages: [] }),
      (error: unknown) => {
        assert.ok(error instanceof ConnectorError);
        assert.match(error.message, /CA_CERT_DIR/);
        return true;
      },
    );
  });
});

describe('listModels', () => {
  test('normalizes whichever key the provider reports the window under', async () => {
    gateway(() =>
      Response.json({
        object: 'list',
        data: [
          { id: 'a', object: 'model', owned_by: 'x', max_model_len: 32_000 },
          { id: 'b', object: 'model', owned_by: 'x', context_window: 8_000 },
          { id: 'c', object: 'model', owned_by: 'x' },
        ],
      }),
    );

    const models: ModelsListResponse = await listModels();

    assert.equal(models.data[0]?.context_length, 32_000);
    assert.equal(models.data[1]?.context_length, 8_000);
    assert.equal(models.data[2]?.context_length, undefined);
  });
});

describe('createLlmFetch', () => {
  const llmFetch = createLlmFetch();

  test('upgrades an agent call to a stream and folds the reply back into JSON', async () => {
    const api = gateway(() => sse(streamed('Done')));

    const response = await llmFetch(`${GATEWAY}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'content-length': '42' },
      body: JSON.stringify({ model: 'gpt', messages: [], stream: false }),
    });

    const [call] = api.calls;
    assert.equal(call.body.stream, true);
    // The replaced body is longer than the one the SDK measured.
    assert.equal(new Headers(call.init.headers).get('content-length'), null);

    const completion = (await response.json()) as ChatCompletion;
    assert.equal(response.headers.get('content-type'), 'application/json');
    assert.equal(completion.choices[0]?.message.content, 'Done');
    assert.equal(completion.choices[0]?.finish_reason, 'stop');
    assert.equal(completion.usage?.total_tokens, 7);
  });

  test('a streaming caller gets the stream itself', async () => {
    gateway(() => sse(streamed('chunk')));

    const response = await llmFetch(`${GATEWAY}/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt', messages: [], stream: true }),
    });

    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    assert.equal(await response.text(), streamed('chunk'));
  });

  test('a rejected call is passed through with its body still readable', async () => {
    gateway(() => new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 422 }));

    const response = await llmFetch(`${GATEWAY}/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt', messages: [] }),
    });

    // Not thrown: the SDK builds its own error from this, and langchain reports
    // it. Logging must not have consumed the body on the way past.
    assert.equal(response.status, 422);
    assert.match(await response.text(), /nope/);
  });

  test('the stream upgrade keeps the fields it did not come to change', async () => {
    const api = gateway(() => sse(streamed('Done')));

    // The body an agent's `ChatOpenAI` writes, rebuilt here to add `stream`.
    // Whatever else it carried — the reasoning effort among it — has to survive
    // that rebuild, or a setting reaches the daemon and stops there.
    await llmFetch(`${GATEWAY}/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt',
        messages: [],
        stream: false,
        reasoning_effort: 'low',
        tool_choice: 'auto',
      }),
    });

    assert.equal(api.calls[0]?.body.reasoning_effort, 'low');
    assert.equal(api.calls[0]?.body.tool_choice, 'auto');
  });

  test('anything that is not a chat completion goes out untouched', async () => {
    const api = gateway(() => Response.json({ ok: true }));

    await llmFetch(`${GATEWAY}/models`, { method: 'GET' });

    assert.deepEqual(api.calls[0]?.body, {});
    assert.equal(api.calls[0]?.url, `${GATEWAY}/models`);
  });
});

/**
 * The header a corporate gateway was found to route on: the SDK's own
 * `langchainjs-openai/…` was answered in 61–84s where the identical request
 * under any other name came back in ~1.3s. See `userAgent()`.
 */
describe('the User-Agent the daemon calls under', () => {
  const ua = (call: Call): string | null => new Headers(call.init.headers).get('user-agent');

  test('names this daemon, never the SDK', async () => {
    const api = gateway(() => sse(streamed('ok')));

    await createLlmFetch()(`${GATEWAY}/chat/completions`, {
      method: 'POST',
      headers: { 'user-agent': 'langchainjs-openai/1.0.0' },
      body: JSON.stringify({ model: 'gpt', messages: [], stream: true }),
    });

    assert.match(ua(api.calls[0]!) ?? '', /agent-engine\//);
    assert.doesNotMatch(ua(api.calls[0]!) ?? '', /langchain/);
  });

  test('covers the browser-facing proxy too, not only the agents', async () => {
    const api = gateway(() => sse(streamed('ok')));

    await chatCompletion({ model: 'gpt', messages: [] });

    assert.match(ua(api.calls[0]!) ?? '', /agent-engine\//);
  });

  test('a deployment whose gateway expects something else can say so', async () => {
    process.env[USER_AGENT_VAR] = 'Custom-UA/9.9';
    const api = gateway(() => sse(streamed('ok')));

    await chatCompletion({ model: 'gpt', messages: [] });

    assert.equal(ua(api.calls[0]!), 'Custom-UA/9.9');
    delete process.env[USER_AGENT_VAR];
  });
});

/**
 * What the run hears about a call the gateway would not take.
 *
 * langchain retries a failed model call on its own, with a backoff that reaches
 * ~113s over seven attempts, and reports none of it — so a gateway refusing the
 * first few attempts is indistinguishable from a model thinking for two minutes.
 * These attempts are the only thing that can explain that wait.
 */
describe('createLlmFetch attempt reporting', () => {
  const post = (fetcher: ReturnType<typeof createLlmFetch>): Promise<Response> =>
    fetcher(`${GATEWAY}/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt', messages: [], stream: true }),
    });

  test('counts consecutive rejections and names the status', async () => {
    gateway(
      () => new Response(JSON.stringify({ error: { message: 'overloaded' } }), { status: 503 }),
    );
    const seen: GatewayAttempt[] = [];
    const fetcher = createLlmFetch((attempt) => seen.push(attempt));

    await post(fetcher);
    await post(fetcher);

    assert.deepEqual(seen, [
      { attempt: 1, status: 503, reason: 'overloaded' },
      { attempt: 2, status: 503, reason: 'overloaded' },
    ]);
  });

  test('a transport failure is reported too, and rethrown', async () => {
    globalThis.fetch = (() =>
      Promise.reject(
        Object.assign(new TypeError('fetch failed'), {
          cause: { code: 'ECONNRESET', message: 'socket hang up' },
        }),
      )) as typeof fetch;
    const seen: GatewayAttempt[] = [];
    const fetcher = createLlmFetch((attempt) => seen.push(attempt));

    await assert.rejects(() => post(fetcher));

    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.status, undefined);
    // The transport's own words, not the sentence built around them for a turn
    // that dies — the notice supplies that context itself.
    assert.equal(seen[0]?.reason, 'ECONNRESET — socket hang up');
  });

  test('a success resets the count, so the next call starts from its own first attempt', async () => {
    let fail = true;
    gateway(() => (fail ? new Response('{}', { status: 503 }) : sse(streamed('ok'))));
    const seen: GatewayAttempt[] = [];
    const fetcher = createLlmFetch((attempt) => seen.push(attempt));

    await post(fetcher);
    fail = false;
    await post(fetcher);
    fail = true;
    await post(fetcher);

    assert.deepEqual(
      seen.map((attempt) => attempt.attempt),
      [1, 1],
    );
  });

  test('the notice says what happened without promising a retry', () => {
    assert.equal(
      gatewayAttemptMessage({ attempt: 2, status: 429, reason: 'too many requests' }),
      'The LLM gateway rejected attempt 2 with 429: too many requests',
    );
    assert.equal(
      gatewayAttemptMessage({ attempt: 1, reason: 'socket hang up' }),
      'The LLM gateway could not be reached on attempt 1: socket hang up',
    );
  });
});
