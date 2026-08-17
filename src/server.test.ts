import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { type CodeWorkspaces } from './code/code-workspace';
import { useEngineConfig } from './config/engine-config';
import { type Connector, ConnectorError } from './connector';
import {
  type BackgroundTaskFrame,
  type BackgroundTaskListResponse,
  type CodeDiff,
  type CodeWorkspaceStatus,
  type CodeWorkspaceSummary,
  type DeepAgentStreamEvent,
  type McpServerConfig,
  McpTransport,
} from './contracts';
import { createEngineServer, openSse } from './server';
import { StateDb } from './storage/state-db';
import { BackgroundTasks } from './tasks/background-tasks';

const TOKEN = 'test-token';

/**
 * A throw-away root for the startup sweep of per-chat deep-agent workspaces.
 * Without it every server built here ages out the real `~/.agent-engine`.
 */
let sweepRoot: string;

/** Starts a server on an ephemeral port and returns its base URL plus a closer. */
async function listen(server: Server): Promise<{ url: string; close: () => Promise<void> }> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

let connector: Awaited<ReturnType<typeof listen>>;
/** Throw-away client database, so the routes never touch the real one. */
let stateDb: StateDb;
before(async () => {
  sweepRoot = mkdtempSync(join(tmpdir(), 'engine-server-test-sweep-'));
  stateDb = new StateDb(join(sweepRoot, 'state.db'));
  connector = await listen(createEngineServer({ token: TOKEN, sweepRoot, stateDb }));
});
after(async () => {
  await connector.close();
  await stateDb.close();
  rmSync(sweepRoot, { recursive: true, force: true });
});

test('/ping answers unauthenticated but reports whether the token matched', async () => {
  const anonymous = (await (await fetch(`${connector.url}/ping`)).json()) as {
    authorized?: boolean;
  };
  assert.equal(anonymous.authorized, false);

  const authorized = (await (
    await fetch(`${connector.url}/ping`, { headers: { Authorization: `Bearer ${TOKEN}` } })
  ).json()) as { authorized?: boolean; name?: string; version?: string };
  assert.equal(authorized.authorized, true);
  // Name and version are the whole of what a caller can branch on, so neither
  // may go missing.
  assert.equal(authorized.name, '@deitum/agent-engine');
  assert.match(authorized.version ?? '', /^\d+\.\d+\.\d+/);
});

test('an authenticated route rejects a wrong token', async () => {
  const response = await fetch(`${connector.url}/deepagent/stream`, {
    method: 'POST',
    headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 401);
});

/**
 * The connection handshake, end to end: the browser hands over the whole
 * configuration, the daemon reads the deployment's half from the API it named,
 * and `/ping` reports the version back so the next probe knows nothing has
 * changed.
 */
describe('POST /config', () => {
  /** The API the daemon fetches during the handshake, answered from here. */
  function apiServing(baseUrl: string): void {
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(typeof input === 'string' ? input : ((input as Request).url ?? input));
      return url.endsWith('/llm/config')
        ? Promise.resolve(Response.json({ baseUrl }))
        : realFetch(input as string, init);
    }) as typeof fetch;
  }

  const realFetch = globalThis.fetch;

  /** Pushes one bundle the way the browser does, with the API stubbed. */
  async function push(version: string): Promise<Response> {
    apiServing('https://gateway.test/v1');
    try {
      return await realFetch(`${connector.url}/config`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version,
          hostConfigUrl: 'https://app.test/api/llm/config',
          llm: { apiKey: 'sk-test' },
        }),
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  test('a turn on an unconfigured daemon is a 428, not a stream that fails', async () => {
    const response = await realFetch(`${connector.url}/deepagent/stream`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [], instructions: '', subAgents: [], tools: [] }),
    });

    // A status the browser can act on: it pushes the configuration and retries.
    // Inside an open SSE it could only have been an error nobody could fix.
    assert.equal(response.status, 428);
    assert.notEqual(response.headers.get('content-type'), 'text/event-stream');
    await response.body?.cancel();
  });

  test('the handshake is adopted and its version is reported by /ping', async () => {
    const response = await push('v-42');
    assert.equal(response.status, 200);
    const body = (await response.json()) as { version?: string; baseUrl?: string };
    assert.equal(body.version, 'v-42');
    assert.equal(body.baseUrl, 'https://gateway.test/v1');

    const ping = (await (
      await realFetch(`${connector.url}/ping`, { headers: { Authorization: `Bearer ${TOKEN}` } })
    ).json()) as { configVersion?: string };
    assert.equal(ping.configVersion, 'v-42');
  });

  test('a later handshake replaces the version the probe compares against', async () => {
    await push('v-43');

    const ping = (await (
      await realFetch(`${connector.url}/ping`, { headers: { Authorization: `Bearer ${TOKEN}` } })
    ).json()) as { configVersion?: string };
    assert.equal(ping.configVersion, 'v-43');
  });
});

test('a missing Authorization header is rejected too', async () => {
  const response = await fetch(`${connector.url}/code/sessions`);
  assert.equal(response.status, 401);
});

test('an unknown route is a 404 with a readable body', async () => {
  const response = await fetch(`${connector.url}/nope`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(response.status, 404);
  const body = (await response.json()) as { message?: string };
  assert.match(body.message ?? '', /Not found/);
});

test('a malformed JSON body is a 400, not a crash', async () => {
  const response = await fetch(`${connector.url}/mcp/tools`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: '{ not json',
  });
  assert.equal(response.status, 400);
});

/**
 * Refusing an upload part-way through races the client that is still writing it:
 * the caller may read the 413, or may see the socket reset first. Both are
 * correct, so what is asserted is that the request cannot succeed and — the
 * actual regression — that the connection is not left poisoned for whatever
 * comes next. Without `Connection: close` the unread body was parsed as the
 * start of the following request, and every later call on that socket failed.
 */
test('an oversized body is refused without poisoning the connection', async () => {
  const status = await fetch(`${connector.url}/mcp/tools`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: `{"padding":"${'x'.repeat(6_000_000)}"}`,
  }).then(
    (response) => response.status,
    () => 'reset' as const,
  );
  assert.ok(status === 413 || status === 'reset', `unexpected outcome: ${String(status)}`);

  const after = await fetch(`${connector.url}/ping`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(after.status, 200, 'the next request on the pool must still work');
});

test('/code/status without a sessionId is a 400', async () => {
  const response = await fetch(`${connector.url}/code/status`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(response.status, 400);
});

test('/code/status for an unprepared session is a 404', async () => {
  const response = await fetch(`${connector.url}/code/status?sessionId=nothing-here`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(response.status, 404);
});

/**
 * The daemon holds no state a caller can reach without the token, so shutdown
 * has to be reachable and has to finish — see `EngineServer.shutdownConnector`.
 * Before it existed, `close()` waited on SSE streams that never end.
 */
test('shutdownConnector settles even with nothing in flight, and is idempotent', async () => {
  const spare = createEngineServer({ token: TOKEN, sweepRoot });
  await new Promise<void>((resolve) => spare.listen(0, '127.0.0.1', resolve));
  await spare.shutdownConnector();
  await spare.shutdownConnector();
  await new Promise<void>((resolve) => spare.close(() => resolve()));
});

/**
 * How an embedding shell stops the daemon it started. It cannot use a signal —
 * Windows has no `SIGTERM`, and a kill skips the container cleanup — so the
 * request has to be answered *and* has to reach the supervisor.
 */
describe('POST /shutdown', () => {
  test('answers the caller and only then asks the supervisor to stop', async () => {
    let asked = 0;
    const spare = await listen(
      createEngineServer({
        token: TOKEN,
        sweepRoot,
        onShutdownRequest: () => {
          asked += 1;
        },
      }),
    );

    const response = await fetch(`${spare.url}/shutdown`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
    // The hook runs once the response has been flushed, so give the event loop
    // the turn that takes.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(asked, 1);

    await spare.close();
  });

  test('is refused without the token — anyone on the machine can reach the port', async () => {
    let asked = 0;
    const spare = await listen(
      createEngineServer({
        token: TOKEN,
        sweepRoot,
        onShutdownRequest: () => {
          asked += 1;
        },
      }),
    );

    const response = await fetch(`${spare.url}/shutdown`, { method: 'POST' });

    assert.equal(response.status, 401);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(asked, 0);

    await spare.close();
  });
});

/**
 * The regression this file exists for. Watching the *request* for the client
 * going away looks equivalent and is not: by the time a handler opens its
 * stream, the body has been drained and the `IncomingMessage` is already
 * destroyed — its `close` fired before anything could subscribe. A turn would
 * then play out in full for a user who already pressed Stop, burning tokens,
 * running tools and writing to the workspace.
 */
test('openSse aborts its signal when the client disconnects', async () => {
  let captured: AbortSignal | undefined;
  let requestCloseFired = false;

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Drain the body exactly as `readJson` does — that is what destroys `req`.
    for await (const _chunk of req) {
      void _chunk;
    }
    assert.equal(req.destroyed, true, 'the request is already destroyed once its body is read');
    req.on('close', () => {
      requestCloseFired = true;
    });

    const sse = openSse<{ type: string }>(res);
    captured = sse.signal;
    sse.send({ type: 'hello' });
  };

  const probe = await listen(
    createServer((req, res) => {
      void handler(req, res);
    }),
  );

  try {
    const controller = new AbortController();
    const response = await fetch(probe.url, {
      method: 'POST',
      body: '{}',
      signal: controller.signal,
    });
    // Read the first frame so the stream is definitely established.
    await response.body!.getReader().read();

    assert.equal(captured?.aborted, false);
    controller.abort();

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(captured?.aborted, true, 'disconnecting the client must abort the run');
    assert.equal(
      requestCloseFired,
      false,
      'req.on("close") never fires here — this is why the listener belongs on the response',
    );
  } finally {
    await probe.close();
  }
});

test('openSse drops writes once the client is gone instead of throwing', async () => {
  let send: ((event: { type: string }) => void) | undefined;
  let done: (() => void) | undefined;

  const probe = await listen(
    createServer((req, res) => {
      void (async () => {
        for await (const _chunk of req) {
          void _chunk;
        }
        const sse = openSse<{ type: string }>(res);
        send = sse.send;
        done = sse.done;
        sse.send({ type: 'hello' });
      })();
    }),
  );

  try {
    const controller = new AbortController();
    const response = await fetch(probe.url, {
      method: 'POST',
      body: '{}',
      signal: controller.signal,
    });
    await response.body!.getReader().read();
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // The `finally` of every stream handler still runs after a disconnect.
    assert.doesNotThrow(() => {
      send?.({ type: 'late' });
      done?.();
    });
  } finally {
    await probe.close();
  }
});

// ─── routes over a stubbed core ───────────────────────────────────────────────

const MCP_CONFIG: McpServerConfig = { transport: McpTransport.Http, url: 'https://mcp.test' };

const STATUS: CodeWorkspaceStatus = {
  cloned: true,
  branch: 'agent/session',
  baseBranch: 'main',
  toolchain: 'node',
  ahead: 0,
  behind: 0,
  files: [],
  image: 'node:22-bookworm',
  imageSource: 'auto',
  detected: { toolchain: 'node', image: 'node:22-bookworm', reason: 'package.json' },
  envKeys: [],
  containerRunning: true,
  busy: false,
  setup: { install: 'ok', installCommand: 'npm ci', memory: 'generated', ranAt: 1 },
};

const DIFF: CodeDiff = { files: [], mode: 'worktree' };

const SUMMARY: CodeWorkspaceSummary = {
  sessionId: 'session',
  repo: { baseUrl: 'https://git.test', owner: 'PRJ', repo: 'service' },
  branch: 'agent/session',
  image: 'node:22-bookworm',
  sizeBytes: 1024,
  containerRunning: true,
  updatedAt: 1,
};

/** Everything the routes asked the two collaborators to do. */
interface CoreCalls {
  listed: McpServerConfig[];
  called: { config: McpServerConfig; toolName: string; args: Record<string, unknown> }[];
  diffed: { sessionId: string; mode?: string }[];
  removed: { sessionId: string; keepFiles: boolean }[];
  prepared: string[];
  acquired: string[];
  released: string[];
  committed: string[];
  shutdowns: string[];
}

/**
 * The connector's core, stubbed. Every route below is thin — read the request,
 * call one method, shape the response — so what needs asserting is the wiring,
 * not the MCP pool (see `connector.test.ts`) or git (see `code-workspace.test.ts`).
 */
function stubbedCore(overrides: Record<string, unknown> = {}) {
  const calls: CoreCalls = {
    listed: [],
    called: [],
    diffed: [],
    removed: [],
    prepared: [],
    acquired: [],
    released: [],
    committed: [],
    shutdowns: [],
  };

  const connectorStub = {
    listTools: (config: McpServerConfig) => {
      calls.listed.push(config);
      return Promise.resolve([{ name: 'search', description: 'looks', inputSchema: {} }]);
    },
    callTool: (config: McpServerConfig, toolName: string, args: Record<string, unknown>) => {
      calls.called.push({ config, toolName, args });
      return Promise.resolve({ content: 'found 3', isError: false });
    },
    shutdown: () => {
      calls.shutdowns.push('connector');
      return Promise.resolve();
    },
  } as unknown as Connector;

  const workspacesStub = {
    prepare: (request: { sessionId: string }) => {
      calls.prepared.push(request.sessionId);
      return Promise.resolve(STATUS);
    },
    status: () => Promise.resolve(STATUS),
    diff: (sessionId: string, mode?: string) => {
      calls.diffed.push({ sessionId, mode });
      return Promise.resolve({ ...DIFF, mode: mode ?? 'worktree' } as CodeDiff);
    },
    list: () => Promise.resolve([SUMMARY]),
    remove: (sessionId: string, keepFiles: boolean) => {
      calls.removed.push({ sessionId, keepFiles });
      return Promise.resolve();
    },
    acquire: (sessionId: string) => {
      calls.acquired.push(sessionId);
      return Promise.resolve();
    },
    release: (sessionId: string) => calls.released.push(sessionId),
    setEnv: () => Promise.resolve(),
    commit: (_sessionId: string, message: string) => {
      calls.committed.push(message);
      return Promise.resolve('1 file changed');
    },
    shutdown: () => {
      calls.shutdowns.push('workspaces');
      return Promise.resolve();
    },
    ...overrides,
  } as unknown as CodeWorkspaces;

  return { connectorStub, workspacesStub, calls };
}

/** A listening server whose core is stubbed, plus the call log and a closer. */
async function stubbedServer(overrides: Record<string, unknown> = {}) {
  const { connectorStub, workspacesStub, calls } = stubbedCore(overrides);
  const server = createEngineServer({
    token: TOKEN,
    connector: connectorStub,
    workspaces: workspacesStub,
    sweepRoot,
    // Its own handle: these servers get shut down mid-suite, and closing the
    // shared one would pull the database out from under the storage tests.
    // Nothing opens a file unless a `/storage/*` route is actually called.
    stateDb: new StateDb(join(sweepRoot, 'stubbed.db')),
  });
  const listening = await listen(server);
  return { ...listening, server, calls };
}

/** Authenticated `POST <path>` with a JSON body. */
function post(url: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${url}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Authenticated `GET <path>`. */
function get(url: string, path: string): Promise<Response> {
  return fetch(`${url}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
}

describe('CORS', () => {
  test('a preflight is answered and the origin is reflected back', async () => {
    const response = await fetch(`${connector.url}/mcp/tools`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://app.test' },
    });

    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://app.test');
    assert.match(response.headers.get('access-control-allow-headers') ?? '', /Authorization/);
    assert.equal(response.headers.get('vary'), 'Origin');
  });
});

describe('MCP routes', () => {
  test('forwards a config to the pool and returns its tools', async () => {
    const server = await stubbedServer();
    try {
      const response = await post(server.url, '/mcp/tools', { config: MCP_CONFIG });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        tools: [{ name: 'search', description: 'looks', inputSchema: {} }],
      });
      assert.deepEqual(server.calls.listed, [MCP_CONFIG]);
    } finally {
      await server.close();
    }
  });

  test('forwards a tool call with its arguments', async () => {
    const server = await stubbedServer();
    try {
      const response = await post(server.url, '/mcp/tools/call', {
        config: MCP_CONFIG,
        toolName: 'search',
        arguments: { jql: 'project = ACME' },
      });

      assert.deepEqual(await response.json(), { content: 'found 3', isError: false });
      assert.deepEqual(server.calls.called, [
        { config: MCP_CONFIG, toolName: 'search', args: { jql: 'project = ACME' } },
      ]);
    } finally {
      await server.close();
    }
  });
});

describe('error mapping', () => {
  test('a ConnectorError keeps its status and message', async () => {
    const server = await stubbedServer({
      remove: () => Promise.reject(new ConnectorError(409, 'Session busy')),
    });
    try {
      const response = await post(server.url, '/code/remove', { sessionId: 'busy' });

      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { message: 'Session busy' });
    } finally {
      await server.close();
    }
  });

  test('anything else is a 500 that still says what happened', async () => {
    const server = await stubbedServer({
      remove: () => Promise.reject(new Error('docker unavailable')),
    });
    try {
      const response = await post(server.url, '/code/remove', { sessionId: 'any' });

      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { message: 'docker unavailable' });
    } finally {
      await server.close();
    }
  });
});

describe('Code routes', () => {
  test('clone prepares the session and returns its status', async () => {
    const server = await stubbedServer();
    try {
      const response = await post(server.url, '/code/clone', { sessionId: 'session' });

      assert.equal(((await response.json()) as CodeWorkspaceStatus).branch, 'agent/session');
      assert.deepEqual(server.calls.prepared, ['session']);
    } finally {
      await server.close();
    }
  });

  test('diff defaults to the worktree and honours an explicit branch mode', async () => {
    const server = await stubbedServer();
    try {
      await get(server.url, '/code/diff?sessionId=session');
      await get(server.url, '/code/diff?sessionId=session&mode=branch');
      // Anything unrecognised must not silently become a branch diff.
      await get(server.url, '/code/diff?sessionId=session&mode=nonsense');

      assert.deepEqual(
        server.calls.diffed.map((call) => call.mode),
        ['worktree', 'branch', 'worktree'],
      );
    } finally {
      await server.close();
    }
  });

  test('diff without a sessionId is a 400', async () => {
    const server = await stubbedServer();
    try {
      assert.equal((await get(server.url, '/code/diff')).status, 400);
    } finally {
      await server.close();
    }
  });

  test('sessions lists every workspace held on disk', async () => {
    const server = await stubbedServer();
    try {
      const response = await get(server.url, '/code/sessions');
      assert.deepEqual(await response.json(), { workspaces: [SUMMARY] });
    } finally {
      await server.close();
    }
  });

  test('remove passes keepFiles through and defaults it to false', async () => {
    const server = await stubbedServer();
    try {
      await post(server.url, '/code/remove', { sessionId: 'a', keepFiles: true });
      await post(server.url, '/code/remove', { sessionId: 'b' });

      assert.deepEqual(server.calls.removed, [
        { sessionId: 'a', keepFiles: true },
        { sessionId: 'b', keepFiles: false },
      ]);
    } finally {
      await server.close();
    }
  });

  test('remove without a sessionId is a 400', async () => {
    const server = await stubbedServer();
    try {
      assert.equal((await post(server.url, '/code/remove', {})).status, 400);
    } finally {
      await server.close();
    }
  });

  test('a command runs while holding the session lock', async () => {
    const server = await stubbedServer();
    try {
      const response = await post(server.url, '/code/command', {
        sessionId: 'session',
        command: 'commit',
        arg: 'fix: x',
      });

      assert.equal(response.status, 200);
      assert.deepEqual(server.calls.committed, ['fix: x']);
      assert.deepEqual(server.calls.acquired, ['session']);
      assert.deepEqual(server.calls.released, ['session']);
    } finally {
      await server.close();
    }
  });

  /**
   * A lock that outlives a failed command wedges the session: every later turn
   * gets a 409 for a task that is no longer running, and only a restart clears it.
   */
  test('a failed command still releases the session lock', async () => {
    const server = await stubbedServer({
      commit: () => Promise.reject(new ConnectorError(400, 'Nothing to commit')),
    });
    try {
      const response = await post(server.url, '/code/command', {
        sessionId: 'session',
        command: 'commit',
      });

      assert.equal(response.status, 400);
      assert.deepEqual(server.calls.released, ['session'], 'the lock is released in the finally');
    } finally {
      await server.close();
    }
  });

  /**
   * By the time a stream is open the status line is already sent, so a refusal
   * cannot be an HTTP error any more — it has to arrive as an event the browser
   * can attach to the message, followed by the terminal sentinel.
   */
  test('a stream that cannot start reports it as an event and still terminates', async () => {
    const server = await stubbedServer({
      acquire: () =>
        Promise.reject(new ConnectorError(409, 'A task is already running for this session')),
    });
    try {
      const response = await post(server.url, '/code/stream', { sessionId: 'session' });

      assert.equal(response.status, 200);
      const frames = (await response.text())
        .split('\n\n')
        .filter(Boolean)
        .map((frame) => frame.replace(/^data: /, ''));

      assert.deepEqual(JSON.parse(frames[0]), {
        type: 'error',
        message: 'A task is already running for this session',
        fatal: true,
      });
      assert.equal(frames.at(-1), '[DONE]');
    } finally {
      await server.close();
    }
  });

  /**
   * The bootstrap holds the same session lock as a turn: an install and an agent
   * editing the same checkout would race over `node_modules`, and the browser
   * starts the bootstrap on its own the first time a session screen mounts.
   */
  test('/code/setup streams its phases and takes the session lock', async () => {
    const server = await stubbedServer({
      backendInfo: () =>
        Promise.resolve({
          dir: sweepRoot,
          containerName: 'agent-engine-code-session',
          toolchain: 'unknown',
          detected: { toolchain: 'unknown', image: 'node:22-bookworm', reason: '—', commands: {} },
          env: [],
          baseBranch: 'main',
        }),
      setup: () => Promise.resolve({ install: 'pending', memory: 'none' }),
      setSetup: () => Promise.resolve(),
      limits: () => Promise.resolve({ network: 'bridge' }),
      listFiles: () => Promise.resolve([]),
    });
    try {
      const response = await post(server.url, '/code/setup', {
        sessionId: 'session',
        phases: ['install'],
      });

      assert.equal(response.status, 200);
      const frames = (await response.text())
        .split('\n\n')
        .filter(Boolean)
        .map((frame) => frame.replace(/^data: /, ''));

      // No install command for an unknown stack, so the phase is skipped — the
      // point here is the frame shape and the terminal sentinel.
      assert.deepEqual(JSON.parse(frames[0]), {
        type: 'phase',
        phase: 'install',
        state: 'skipped',
        detail: 'no install command is known for this stack',
      });
      assert.equal(JSON.parse(frames[1]).type, 'done');
      assert.equal(frames.at(-1), '[DONE]');
      assert.deepEqual(server.calls.acquired, ['session']);
      assert.deepEqual(server.calls.released, ['session']);
    } finally {
      await server.close();
    }
  });

  test('a busy session refuses the bootstrap as an event, not a status code', async () => {
    const server = await stubbedServer({
      acquire: () =>
        Promise.reject(new ConnectorError(409, 'A task is already running for this session')),
    });
    try {
      const response = await post(server.url, '/code/setup', { sessionId: 'session' });

      assert.equal(response.status, 200);
      const frames = (await response.text())
        .split('\n\n')
        .filter(Boolean)
        .map((frame) => frame.replace(/^data: /, ''));

      assert.equal(JSON.parse(frames[0]).type, 'error');
      assert.equal(frames.at(-1), '[DONE]');
    } finally {
      await server.close();
    }
  });
});

describe('pending questions', () => {
  for (const path of ['/deepagent/answer', '/code/answer']) {
    test(`${path} is a 404 for a question nobody is waiting on`, async () => {
      const server = await stubbedServer();
      try {
        const response = await post(server.url, path, { id: 'gone', answer: 'yes' });

        assert.equal(response.status, 404);
        assert.match(
          ((await response.json()) as { message: string }).message,
          /No pending question/,
        );
      } finally {
        await server.close();
      }
    });
  }
});

describe('skills routes', () => {
  test('write a skill to a folder and read it back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'engine-server-skills-'));
    const server = await stubbedServer();
    try {
      const written = await post(server.url, '/skills/write', {
        dir,
        skill: {
          id: 'code-review',
          name: 'Code review',
          description: 'How to review',
          instructions: '# Review',
          files: [{ path: 'refs/style.md', content: 'style' }],
        },
      });
      assert.deepEqual(await written.json(), {
        path: join(dir, 'code-review'),
        overwritten: false,
        pruned: [],
      });
      assert.match(readFileSync(join(dir, 'code-review', 'SKILL.md'), 'utf8'), /# Review/);

      const listed = (await (await post(server.url, '/skills/list', { dir })).json()) as {
        dir: string;
        skills: { id: string; files: { path: string }[] }[];
      };
      assert.equal(listed.dir, dir);
      assert.deepEqual(
        listed.skills.map((skill) => skill.id),
        ['code-review'],
      );
      assert.deepEqual(listed.skills[0].files, [{ path: 'refs/style.md', content: 'style' }]);
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('listing a folder that is not there is a 404 the UI can show', async () => {
    const server = await stubbedServer();
    try {
      const response = await post(server.url, '/skills/list', {
        dir: join(tmpdir(), 'definitely-not-here'),
      });

      assert.equal(response.status, 404);
      assert.match(((await response.json()) as { message: string }).message, /Folder not found/);
    } finally {
      await server.close();
    }
  });

  test('delete a package, and refuse one that is not there', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'engine-server-skills-'));
    const server = await stubbedServer();
    try {
      await post(server.url, '/skills/write', {
        dir,
        skill: {
          id: 'code-review',
          name: 'Code review',
          description: '',
          instructions: '# Review',
          files: [],
        },
      });

      const deleted = await post(server.url, '/skills/delete', { dir, id: 'code-review' });
      assert.deepEqual(await deleted.json(), { path: join(dir, 'code-review') });
      assert.ok(!existsSync(join(dir, 'code-review')));

      const again = await post(server.url, '/skills/delete', { dir, id: 'code-review' });
      assert.equal(again.status, 404);
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('skill repository routes', () => {
  const REPO = { baseUrl: 'https://git.example.net', owner: 'ACME', repo: 'skills' };
  const CREDENTIALS = { username: 'ivan', token: 'secret' };

  /**
   * A Bitbucket that answers the four endpoints the client uses. The route's own
   * job is only to hand the body to `skill-repo.ts` and the answer back, so this
   * checks the wiring rather than the walking (`skill-repo.test.ts` does that).
   *
   * Only requests to the fake host are answered here — everything else, the
   * test's own calls to the connector included, goes on to the real `fetch`.
   */
  function serveBitbucket(
    files: Record<string, string>,
    { checkStatus = 200 }: { checkStatus?: number } = {},
  ): () => void {
    const realFetch = globalThis.fetch;
    const base = '/rest/api/1.0/projects/ACME/repos/skills';
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      if (url.host !== 'git.example.net') {
        return realFetch(input, init);
      }
      const body = (value: unknown): Response =>
        new Response(typeof value === 'string' ? value : JSON.stringify(value), { status: 200 });

      if (url.pathname === '/rest/api/1.0/inbox/pull-requests/count') {
        return Promise.resolve(
          checkStatus === 200 ? body('1') : new Response('', { status: checkStatus }),
        );
      }
      if (url.pathname === `${base}/branches/default`) {
        return Promise.resolve(body({ displayId: 'master' }));
      }
      if (url.pathname === `${base}/commits`) {
        return Promise.resolve(body({ values: [{ id: 'c0ffee' }] }));
      }
      if (url.pathname === `${base}/files` || url.pathname.startsWith(`${base}/files/`)) {
        const prefix =
          url.pathname === `${base}/files`
            ? ''
            : `${decodeURIComponent(url.pathname.slice(`${base}/files/`.length))}/`;
        return Promise.resolve(
          body({
            values: Object.keys(files)
              .filter((file) => file.startsWith(prefix))
              .map((file) => file.slice(prefix.length))
              .sort(),
            isLastPage: true,
          }),
        );
      }
      if (url.pathname.startsWith(`${base}/raw/`)) {
        const file = decodeURIComponent(url.pathname.slice(`${base}/raw/`.length));
        return Promise.resolve(
          file in files ? body(files[file]) : new Response('{}', { status: 404 }),
        );
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    }) as typeof fetch;

    return () => {
      globalThis.fetch = realFetch;
    };
  }

  test('lists the packages a repository holds and fetches one whole', async () => {
    // The credentials come from the connection handshake, not from these two
    // requests — `/repos/check` below is the one route that still takes a pair
    // inline, because verifying them is its whole job.
    useEngineConfig(
      {
        version: 'v-repo',
        llm: { apiKey: 'sk-test' },
        repos: [CREDENTIALS],
      },
      'https://gateway.test/v1',
    );
    const restore = serveBitbucket({
      'skills/tdd/SKILL.md':
        '---\nname: TDD\ndescription: How to write tests\n---\n\nTest first.\n',
      'skills/tdd/refs/cycle.md': 'red-green',
    });
    const server = await stubbedServer();
    try {
      const listed = (await (
        await post(server.url, '/skills/repo/list', { repo: REPO })
      ).json()) as { ref: string; commit: string; skills: { path: string; name: string }[] };

      assert.equal(listed.ref, 'master');
      assert.equal(listed.commit, 'c0ffee');
      assert.deepEqual(
        listed.skills.map((skill) => [skill.path, skill.name]),
        [['skills/tdd', 'TDD']],
      );

      const fetched = (await (
        await post(server.url, '/skills/repo/fetch', { repo: REPO, paths: ['skills/tdd'] })
      ).json()) as { skills: { id: string; files: { path: string }[] }[] };

      assert.equal(fetched.skills[0].id, 'tdd');
      assert.deepEqual(fetched.skills[0].files, [{ path: 'refs/cycle.md', content: 'red-green' }]);
    } finally {
      restore();
      await server.close();
    }
  });

  test('/repos/check accepts working credentials', async () => {
    const restore = serveBitbucket({});
    const server = await stubbedServer();
    try {
      const ok = await post(server.url, '/repos/check', {
        provider: 'bitbucket-server',
        baseUrl: REPO.baseUrl,
        credentials: CREDENTIALS,
      });

      assert.deepEqual(await ok.json(), { ok: true });
    } finally {
      restore();
      await server.close();
    }
  });

  test('/repos/check passes a rejected credential through as a 401', async () => {
    const restore = serveBitbucket({}, { checkStatus: 401 });
    const server = await stubbedServer();
    try {
      const rejected = await post(server.url, '/repos/check', {
        provider: 'bitbucket-server',
        baseUrl: REPO.baseUrl,
        credentials: CREDENTIALS,
      });

      assert.equal(rejected.status, 401);
      assert.match(
        ((await rejected.json()) as { message: string }).message,
        /rejected the credentials/,
      );
    } finally {
      restore();
      await server.close();
    }
  });
});

describe('plugins routes', () => {
  test('write a plugin to a folder and read it back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'engine-server-plugins-'));
    const server = await stubbedServer();
    try {
      const written = await post(server.url, '/plugins/write', {
        dir,
        plugin: {
          id: 'qa-kit',
          name: 'QA Kit',
          version: '1.0.0',
          description: 'QA pack',
          keywords: ['qa'],
          commands: [{ name: 'new-test', description: 'Test', body: 'Write a test.' }],
          agents: [
            { name: 'reviewer', description: 'Reviewer', systemPrompt: 'You are a reviewer.' },
          ],
          skills: [
            {
              id: 'api-test',
              name: 'API',
              description: 'How to write',
              instructions: '# API',
              files: [],
            },
          ],
        },
      });
      assert.deepEqual(await written.json(), { path: join(dir, 'qa-kit'), overwritten: false });

      const listed = (await (await post(server.url, '/plugins/list', { dir })).json()) as {
        dir: string;
        plugins: { id: string; commands: { name: string }[]; skills: { name: string }[] }[];
      };
      assert.equal(listed.dir, dir);
      assert.deepEqual(
        listed.plugins.map((plugin) => plugin.id),
        ['qa-kit'],
      );
      assert.deepEqual(
        listed.plugins[0].commands.map((command) => command.name),
        ['new-test'],
      );
      assert.deepEqual(
        listed.plugins[0].skills.map((skill) => skill.name),
        ['API'],
      );
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('listing a folder that is not there is a 404 the UI can show', async () => {
    const server = await stubbedServer();
    try {
      const response = await post(server.url, '/plugins/list', {
        dir: join(tmpdir(), 'definitely-not-here'),
      });

      assert.equal(response.status, 404);
      assert.match(((await response.json()) as { message: string }).message, /Folder not found/);
    } finally {
      await server.close();
    }
  });
});

describe('storage', () => {
  test('records and documents round-trip through the routes', async () => {
    await post(connector.url, '/storage/records/put', {
      collection: 'chats',
      records: [
        { id: 'c1', title: 'first' },
        { id: 'c2', title: 'second' },
      ],
    });
    await post(connector.url, '/storage/documents/set', {
      key: 'meta:data-version',
      value: 1,
    });

    const listed = (await (
      await post(connector.url, '/storage/records/list', { collection: 'chats' })
    ).json()) as { records: { id: string }[] };
    assert.deepEqual(listed.records.map((record) => record.id).sort(), ['c1', 'c2']);

    const document = (await (
      await post(connector.url, '/storage/documents/get', { key: 'meta:data-version' })
    ).json()) as { value: unknown };
    assert.equal(document.value, 1);

    await post(connector.url, '/storage/records/delete', { collection: 'chats', ids: ['c1'] });
    await post(connector.url, '/storage/documents/remove', { key: 'meta:data-version' });

    const afterDelete = (await (
      await post(connector.url, '/storage/records/list', { collection: 'chats' })
    ).json()) as { records: { id: string }[] };
    assert.deepEqual(
      afterDelete.records.map((record) => record.id),
      ['c2'],
    );
    assert.equal(
      (
        (await (
          await post(connector.url, '/storage/documents/get', { key: 'meta:data-version' })
        ).json()) as { value: unknown }
      ).value,
      null,
    );

    await post(connector.url, '/storage/records/clear', { collection: 'chats' });
    const cleared = (await (
      await post(connector.url, '/storage/records/list', { collection: 'chats' })
    ).json()) as { records: unknown[] };
    assert.deepEqual(cleared.records, []);
  });

  /**
   * The database holds every token the user has entered, so a bad bearer must
   * not read it — the one route where "reads are harmless" is plainly false.
   */
  test('every route needs the token', async () => {
    for (const path of [
      '/storage/records/list',
      '/storage/records/put',
      '/storage/records/delete',
      '/storage/records/clear',
      '/storage/documents/get',
      '/storage/documents/set',
      '/storage/documents/remove',
    ]) {
      const response = await fetch(`${connector.url}${path}`, {
        method: 'POST',
        headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(response.status, 401, path);
    }
  });

  test('a record with no id is a 400 that names the offending entry', async () => {
    const response = await post(connector.url, '/storage/records/put', {
      collection: 'chats',
      records: [{ title: 'nameless' }],
    });

    assert.equal(response.status, 400);
    assert.match(((await response.json()) as { message: string }).message, /records\[0\]/);
  });

  test('/ping advertises the store so the UI knows before it switches', async () => {
    const ping = (await (
      await fetch(`${connector.url}/ping`, { headers: { Authorization: `Bearer ${TOKEN}` } })
    ).json()) as { storage?: boolean };

    assert.equal(ping.storage, true);
  });
});

/**
 * The routes behind the sub-chat. The rule that matters is the inverse of the
 * one `openSse` exists for: a background task was started so the user could
 * walk away, so reading its stream — and stopping reading it — must not touch
 * the run.
 */
describe('/tasks/*', () => {
  /** A server whose task registry is driven by hand instead of by a model. */
  async function taskServer() {
    const runs: {
      emit: (event: DeepAgentStreamEvent) => void;
      signal: AbortSignal;
      finish: () => void;
    }[] = [];
    const tasks = new BackgroundTasks(
      (_request, onEvent, signal) =>
        new Promise<void>((resolve) => {
          runs.push({ emit: onEvent, signal, finish: resolve });
          // A real run ends when it is aborted; a fake that ignored the signal
          // would leave `shutdown` waiting on it and the test process alive.
          signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    );
    const server = createEngineServer({ token: TOKEN, sweepRoot, tasks });
    return { ...(await listen(server)), tasks, runs };
  }

  function startTask(tasks: BackgroundTasks, sessionId = 'chat-1') {
    return tasks.start({
      parent: {
        messages: [],
        instructions: '',
        subAgents: [],
        llm: { model: 'gpt-5' },
        tools: [],
        sessionId,
      },
      agentName: 'general-purpose',
      title: 'Research X',
      prompt: 'Research X',
    }).task;
  }

  /** Reads SSE frames until `count` of them have arrived, then lets go. */
  async function readFrames(response: Response, count: number): Promise<BackgroundTaskFrame[]> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const frames: BackgroundTaskFrame[] = [];
    let buffer = '';
    while (frames.length < count) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      for (const line of buffer.split('\n\n')) {
        const payload = line.trim().replace(/^data: /, '');
        if (payload && payload !== '[DONE]' && frames.length < count) {
          frames.push(JSON.parse(payload) as BackgroundTaskFrame);
        }
      }
      buffer = '';
    }
    await reader.cancel();
    return frames;
  }

  test('lists a chat’s tasks so a reloaded browser finds them again', async () => {
    const server = await taskServer();
    const task = startTask(server.tasks);

    const body = (await (
      await get(server.url, '/tasks/list?parentSessionId=chat-1')
    ).json()) as BackgroundTaskListResponse;

    assert.deepEqual(
      body.tasks.map((entry) => [entry.taskId, entry.status]),
      [[task.taskId, 'running']],
    );
    assert.equal(
      (
        (await (
          await get(server.url, '/tasks/list?parentSessionId=other')
        ).json()) as BackgroundTaskListResponse
      ).tasks.length,
      0,
    );
    await server.close();
  });

  test('streams events live and replays from an absolute index', async () => {
    const server = await taskServer();
    const task = startTask(server.tasks);
    server.runs[0]!.emit({ type: 'text', delta: 'one' });
    server.runs[0]!.emit({ type: 'text', delta: 'two' });

    const replay = await readFrames(
      await get(server.url, `/tasks/events?taskId=${task.taskId}&from=1`),
      1,
    );

    assert.deepEqual(replay, [{ index: 1, event: { type: 'text', delta: 'two' } }]);
    await server.close();
  });

  /**
   * The regression this whole feature turns on. `/deepagent/stream` aborts its
   * run when the browser goes away — deliberately. A background task must do
   * the opposite, or closing the tab would kill the very work that was moved
   * into the background so the tab *could* be closed.
   */
  test('closing the event stream does not cancel the task', async () => {
    const server = await taskServer();
    const task = startTask(server.tasks);

    const response = await get(server.url, `/tasks/events?taskId=${task.taskId}&from=0`);
    await response.body!.cancel();
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(server.runs[0]!.signal.aborted, false);
    assert.equal(server.tasks.get(task.taskId)?.status, 'running');
    await server.close();
  });

  test('a stream opened on a finished task replays it and ends', async () => {
    const server = await taskServer();
    const task = startTask(server.tasks);
    server.runs[0]!.emit({ type: 'text', delta: 'result' });
    server.runs[0]!.finish();
    await new Promise((resolve) => setImmediate(resolve));

    const body = await (await get(server.url, `/tasks/events?taskId=${task.taskId}&from=0`)).text();

    assert.match(body, /"delta":"result"/);
    assert.match(body, /\[DONE\]/);
    await server.close();
  });

  test('an unknown task is a 404 rather than an empty stream', async () => {
    const server = await taskServer();

    assert.equal((await get(server.url, '/tasks/events?taskId=nope&from=0')).status, 404);
    assert.equal(
      (await post(server.url, '/tasks/message', { taskId: 'nope', text: 'x' })).status,
      404,
    );
    assert.equal((await post(server.url, '/tasks/stop', { taskId: 'nope' })).status, 404);
    await server.close();
  });

  test('a follow-up continues the task and a stop cancels it', async () => {
    const server = await taskServer();
    const task = startTask(server.tasks);

    const continued = await (
      await post(server.url, '/tasks/message', { taskId: task.taskId, text: 'a clarification' })
    ).json();
    assert.equal((continued as { status: string }).status, 'running');
    assert.equal(server.runs.length, 2);

    const stopped = await (await post(server.url, '/tasks/stop', { taskId: task.taskId })).json();
    assert.equal((stopped as { status: string }).status, 'cancelled');
    await server.close();
  });
});

describe('shutdown', () => {
  test('stops both collaborators, once, however many times it is asked', async () => {
    const server = await stubbedServer();

    await server.server.shutdownConnector();
    await server.server.shutdownConnector();
    await server.close();

    assert.deepEqual(server.calls.shutdowns.sort(), ['connector', 'workspaces']);
  });

  test('closing the server cleans up even when nobody called shutdown', async () => {
    const server = await stubbedServer();

    await server.close();
    // `close` fires the handler that stops the pool and the containers.
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.deepEqual(server.calls.shutdowns.sort(), ['connector', 'workspaces']);
  });
});
