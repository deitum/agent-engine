import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { type EngineConfigRequest } from '../contracts';

import { EngineClient } from './engine-client';
import { EngineError, EngineUnreachableError } from './engine-error';

const TOKEN = 'tkn';

interface Call {
  url: string;
  method: string;
  auth: string;
  body: string;
}

/** A client whose transport is a recorded stub rather than the network. */
function clientWith(
  handler: (call: Call) => Response | Promise<Response>,
  options: Partial<ConstructorParameters<typeof EngineClient>[0]> = {},
): { engine: EngineClient; calls: Call[] } {
  const calls: Call[] = [];
  const engine = new EngineClient({
    port: 50880,
    token: TOKEN,
    fetch: async (url, init) => {
      const call: Call = {
        url,
        method: init?.method ?? 'GET',
        auth: String((init?.headers as Record<string, string> | undefined)?.Authorization ?? ''),
        body: typeof init?.body === 'string' ? init.body : '',
      };
      calls.push(call);
      return handler(call);
    },
    ...options,
  });
  return { engine, calls };
}

/** An SSE body of the shape every one of the daemon's streams produces. */
function sseBody(frames: unknown[], { done = true } = {}): Response {
  const text = `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}${
    done ? 'data: [DONE]\n\n' : ''
  }`;
  return new Response(text, { headers: { 'Content-Type': 'text/event-stream' } });
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('addressing', () => {
  test('a port is enough — the daemon binds loopback', () => {
    assert.equal(new EngineClient({ port: 51000, token: TOKEN }).baseUrl, 'http://127.0.0.1:51000');
  });

  test('an explicit base URL wins, and its trailing slash is dropped', () => {
    assert.equal(
      new EngineClient({ baseUrl: 'https://engine.internal/', token: TOKEN }).baseUrl,
      'https://engine.internal',
    );
  });
});

describe('requests', () => {
  test('every call carries the bearer token', async () => {
    const { engine, calls } = clientWith(() => Response.json({ status: 'ok' }));

    await engine.ping();

    assert.equal(calls[0].auth, `Bearer ${TOKEN}`);
    assert.equal(calls[0].url, 'http://127.0.0.1:50880/ping');
    assert.equal(calls[0].method, 'GET');
  });

  test('a POST sends its body as JSON', async () => {
    const { engine, calls } = clientWith(() => Response.json({ tools: [] }));

    await engine.mcp.listTools({ config: { transport: 'stdio', command: 'x' } as never });

    assert.equal(calls[0].method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].body), { config: { transport: 'stdio', command: 'x' } });
  });

  test('a refusal becomes an EngineError carrying the status and the message', async () => {
    const { engine } = clientWith(() =>
      Response.json({ message: 'Invalid token' }, { status: 401 }),
    );

    await assert.rejects(engine.ping(), (error: unknown) => {
      assert.ok(error instanceof EngineError);
      assert.equal(error.status, 401);
      assert.equal(error.message, 'Invalid token');
      return true;
    });
  });

  test('a refusal whose body is not the promised JSON still reports its status', async () => {
    const { engine } = clientWith(() => new Response('<html>502</html>', { status: 502 }));

    await assert.rejects(engine.ping(), (error: unknown) => {
      assert.ok(error instanceof EngineError);
      assert.equal(error.status, 502);
      assert.match(error.message, /502/);
      return true;
    });
  });

  test('a daemon that is not there is told apart from one that refused', async () => {
    const { engine } = clientWith(() => {
      throw new Error('ECONNREFUSED');
    });

    await assert.rejects(engine.ping(), (error: unknown) => {
      assert.ok(error instanceof EngineUnreachableError);
      assert.match(error.message, /127\.0\.0\.1:50880/);
      return true;
    });
  });

  test('an abort reaches the caller as itself, not as an unreachable daemon', async () => {
    const { engine } = clientWith(() => {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      throw error;
    });

    await assert.rejects(engine.ping(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, 'AbortError');
      return true;
    });
  });
});

describe('the 428 handshake', () => {
  const bundle: EngineConfigRequest = {
    version: 'v1',
    llm: { baseUrl: 'https://gateway/v1', apiKey: 'sk' },
  };

  test('a 428 is answered by pushing the configuration and retrying once', async () => {
    let served = 0;
    const { engine, calls } = clientWith(
      (call) => {
        if (call.url.endsWith('/config')) {
          return Response.json({ version: 'v1', baseUrl: 'https://gateway/v1', caCerts: 0 });
        }
        served += 1;
        return served === 1
          ? Response.json({ message: 'not configured' }, { status: 428 })
          : Response.json({ workspaces: [] });
      },
      { onConfigMissing: () => bundle },
    );

    const result = await engine.code.sessions();

    assert.deepEqual(result, { workspaces: [] });
    assert.deepEqual(
      calls.map((call) => new URL(call.url).pathname),
      ['/code/sessions', '/config', '/code/sessions'],
      'the configuration is pushed between the two attempts',
    );
  });

  test('without a handler the 428 reaches the caller untouched', async () => {
    const { engine } = clientWith(() =>
      Response.json({ message: 'not configured' }, { status: 428 }),
    );

    await assert.rejects(engine.code.sessions(), (error: unknown) => {
      assert.ok(error instanceof EngineError);
      assert.equal(error.status, 428);
      return true;
    });
  });

  test('a daemon that answers 428 twice is reported, not looped over', async () => {
    let attempts = 0;
    const { engine } = clientWith(
      (call) => {
        if (call.url.endsWith('/config')) {
          return Response.json({ version: 'v1', baseUrl: 'https://gateway/v1', caCerts: 0 });
        }
        attempts += 1;
        return Response.json({ message: 'still not configured' }, { status: 428 });
      },
      { onConfigMissing: () => bundle },
    );

    await assert.rejects(engine.code.sessions(), { status: 428 });
    assert.equal(attempts, 2, 'exactly one retry, however stubborn the daemon is');
  });

  test('pushing the configuration is never itself retried', async () => {
    let configCalls = 0;
    const { engine } = clientWith(
      () => {
        configCalls += 1;
        return Response.json({ message: 'not configured' }, { status: 428 });
      },
      { onConfigMissing: () => bundle },
    );

    await assert.rejects(engine.config(bundle), { status: 428 });
    assert.equal(configCalls, 1, 'answering a 428 with a 428 must not recurse');
  });
});

describe('streams', () => {
  test('yields one event per frame and ends at the sentinel', async () => {
    const { engine } = clientWith(() =>
      sseBody([
        { type: 'text', text: 'hello' },
        { type: 'text', text: ' world' },
      ]),
    );

    const events = [];
    for await (const event of engine.deepAgent.stream({} as never)) {
      events.push(event);
    }

    assert.deepEqual(events, [
      { type: 'text', text: 'hello' },
      { type: 'text', text: ' world' },
    ]);
  });

  test('a frame split across chunks is reassembled, not dropped', async () => {
    const halves = ['data: {"type":"te', 'xt","text":"hi"}\n\ndata: [DONE]\n\n'];
    const { engine } = clientWith(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              for (const half of halves) {
                controller.enqueue(encoder.encode(half));
              }
              controller.close();
            },
          }),
        ),
    );

    const events = [];
    for await (const event of engine.code.stream({} as never)) {
      events.push(event);
    }

    assert.deepEqual(events, [{ type: 'text', text: 'hi' }]);
  });

  test('a body that ends without the sentinel still terminates the loop', async () => {
    const { engine } = clientWith(() =>
      sseBody([{ type: 'text', text: 'partial' }], { done: false }),
    );

    const events = [];
    for await (const event of engine.deepAgent.stream({} as never)) {
      events.push(event);
    }

    assert.deepEqual(events, [{ type: 'text', text: 'partial' }]);
  });

  test('a malformed frame costs that frame and nothing else', async () => {
    const { engine } = clientWith(
      () => new Response('data: {oops\n\ndata: {"type":"text","text":"after"}\n\ndata: [DONE]\n\n'),
    );

    const events = [];
    for await (const event of engine.deepAgent.stream({} as never)) {
      events.push(event);
    }

    assert.deepEqual(events, [{ type: 'text', text: 'after' }]);
  });

  test('a stream that is refused throws before any frame is read', async () => {
    const { engine } = clientWith(() =>
      Response.json({ message: 'session busy' }, { status: 409 }),
    );

    await assert.rejects(
      async () => {
        for await (const _ of engine.code.stream({} as never)) {
          assert.fail('no event should have arrived');
        }
      },
      { status: 409 },
    );
  });

  test('background-task events are a GET carrying the resume index', async () => {
    const { engine, calls } = clientWith(() => sseBody([{ index: 3, event: { type: 'text' } }]));

    for await (const _ of engine.tasks.events('t-1', 3)) {
      break;
    }

    assert.equal(calls[0].method, 'GET');
    assert.match(calls[0].url, /\/tasks\/events\?taskId=t-1&from=3$/);
  });
});

describe('route shapes', () => {
  test('query parameters are encoded, so an id with a slash survives', async () => {
    const { engine, calls } = clientWith(() => Response.json({}));

    await engine.code.status('chat/1 2');

    assert.match(calls[0].url, /sessionId=chat%2F1%202/);
  });

  test('the diff defaults to the worktree rather than the whole branch', async () => {
    const { engine, calls } = clientWith(() => Response.json({ files: [] }));

    await engine.code.diff('s1');

    assert.match(calls[0].url, /mode=worktree/);
  });

  test('a chat turn wraps the request the way the route expects', async () => {
    const { engine, calls } = clientWith(() => sseBody([]));

    for await (const _ of engine.llm.chat({ model: 'm', messages: [] })) {
      break;
    }

    assert.deepEqual(JSON.parse(calls[0].body), { request: { model: 'm', messages: [] } });
  });
});
