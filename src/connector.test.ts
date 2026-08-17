import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  type CallToolResult,
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { Connector, ConnectorError } from './connector';
import { type McpServerConfig, McpTransport } from './contracts';
import { McpCatalog } from './mcp-catalog';

const require_ = createRequire(__filename);

/** The tools every fixture server advertises, whichever transport it speaks. */
const FIXTURE_TOOLS = [
  {
    name: 'echo',
    description: 'Returns the text it was given',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  },
  { name: 'blocks', description: 'Mixed content blocks', inputSchema: { type: 'object' } },
  { name: 'boom', description: 'Always fails', inputSchema: { type: 'object' } },
  { name: 'silent', description: 'Returns nothing', inputSchema: { type: 'object' } },
];

/** The `tools/call` result each fixture tool returns, shared by both fixtures. */
function callFixtureTool(name: string, args: Record<string, unknown> | undefined): CallToolResult {
  switch (name) {
    case 'echo':
      return { content: [{ type: 'text', text: String(args?.text ?? '') }] };
    case 'blocks':
      return {
        content: [
          { type: 'text', text: 'first' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        ],
      };
    case 'boom':
      return { content: [{ type: 'text', text: 'broke' }], isError: true };
    case 'silent':
      return { content: [] };
    default:
      throw new Error(`fixture: unknown tool ${name}`);
  }
}

/**
 * A real MCP server spoken to over stdio — the transport this whole daemon
 * exists for. Written to a temp file and spawned by the connector itself, so the
 * process spawning, the handshake and the JSON-RPC framing are all genuine; the
 * SDK is required by absolute path because the script lives outside the repo.
 *
 * Every start appends a line to `ENGINE_MARKER`, which is how connection pooling is
 * observed: one line means the pool reused a process, two mean it did not.
 */
const STDIO_FIXTURE = `
const { appendFileSync } = require('node:fs');
const { Server } = require(${JSON.stringify(require_.resolve('@modelcontextprotocol/sdk/server/index.js'))});
const { StdioServerTransport } = require(${JSON.stringify(require_.resolve('@modelcontextprotocol/sdk/server/stdio.js'))});
const { CallToolRequestSchema, ListToolsRequestSchema } = require(${JSON.stringify(require_.resolve('@modelcontextprotocol/sdk/types.js'))});

appendFileSync(process.env.ENGINE_MARKER, 'started\\n');

const server = new Server({ name: 'engine-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, () => {
  if (process.env.ENGINE_LIST_FAILS === '1') {
    throw new Error('the tool list is unavailable');
  }
  return { tools: ${JSON.stringify(FIXTURE_TOOLS)} };
});

server.setRequestHandler(CallToolRequestSchema, (request) => {
  const { name, arguments: args } = request.params;
  ${callFixtureTool.toString()}
  return callFixtureTool(name, args);
});

void server.connect(new StdioServerTransport());
`;

let scratch: string;
let scriptPath: string;
let connector: Connector;
let httpServer: HttpServer;
let httpUrl: string;

/** A stdio config pointed at the fixture, with its own marker file. */
function stdioConfig(marker: string, extra: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    transport: McpTransport.Stdio,
    command: process.execPath,
    args: [scriptPath],
    env: { ENGINE_MARKER: marker },
    ...extra,
  };
}

/** A fresh marker file path; the number of lines in it is the spawn count. */
function marker(name: string): string {
  const path = join(scratch, `${name}.marker`);
  writeFileSync(path, '', 'utf8');
  return path;
}

/** How many times the fixture behind `marker` was started. */
function spawnCount(path: string): number {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).length;
}

/**
 * A connector whose tool catalog lives in the scratch directory. Never the
 * default: that one is the user's own `~/.agent-engine/mcp-catalog.json`, and a
 * test run must not write to it.
 */
function testConnector(name: string): Connector {
  return new Connector({ catalog: new McpCatalog({ path: join(scratch, `${name}.json`) }) });
}

before(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'engine-connector-test-'));
  scriptPath = join(scratch, 'mcp-fixture.js');
  writeFileSync(scriptPath, STDIO_FIXTURE, 'utf8');
  connector = testConnector('catalog');

  // The same server over Streamable HTTP. Stateless (`sessionIdGenerator:
  // undefined`) with a transport per request — the pattern the SDK documents —
  // so no session bookkeeping is needed for the handful of calls made here.
  httpServer = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const body =
        chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;

      const server = new Server(
        { name: 'engine-fixture-http', version: '1.0.0' },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: FIXTURE_TOOLS }));
      server.setRequestHandler(CallToolRequestSchema, (request) =>
        callFixtureTool(request.params.name, request.params.arguments),
      );

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    })();
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  httpUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`;
});

after(async () => {
  await connector.shutdown();
  httpServer.closeAllConnections();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  rmSync(scratch, { recursive: true, force: true });
});

describe('stdio transport', () => {
  test('lists a spawned server’s tools in the contract shape', async () => {
    const tools = await connector.listTools(stdioConfig(marker('list')));

    assert.deepEqual(
      tools.map((tool) => tool.name),
      ['echo', 'blocks', 'boom', 'silent'],
    );
    assert.equal(tools[0].description, 'Returns the text it was given');
    assert.deepEqual(tools[0].inputSchema, {
      type: 'object',
      properties: { text: { type: 'string' } },
    });
  });

  test('calls a tool and returns its text', async () => {
    const result = await connector.callTool(stdioConfig(marker('call')), 'echo', {
      text: 'hello',
    });

    assert.deepEqual(result, { content: 'hello', isError: false });
  });

  test('joins mixed content blocks, serialising the ones that are not text', async () => {
    const result = await connector.callTool(stdioConfig(marker('blocks')), 'blocks', {});

    const [first, second] = result.content.split('\n');
    assert.equal(first, 'first');
    assert.deepEqual(JSON.parse(second), {
      type: 'image',
      data: 'AAAA',
      mimeType: 'image/png',
    });
  });

  /**
   * A tool reporting failure is an outcome the model has to see and work around,
   * not an exception — throwing here would end the whole turn over one bad call.
   */
  test('a tool that reports an error comes back as a result, not a throw', async () => {
    const result = await connector.callTool(stdioConfig(marker('boom')), 'boom', {});

    assert.equal(result.isError, true);
    assert.equal(result.content, 'broke');
  });

  test('a tool that returns nothing yields empty content', async () => {
    const result = await connector.callTool(stdioConfig(marker('silent')), 'silent', {});

    assert.deepEqual(result, { content: '', isError: false });
  });
});

describe('http transport', () => {
  test('lists and calls tools on a remote server', async () => {
    const config: McpServerConfig = { transport: McpTransport.Http, url: httpUrl };

    const tools = await connector.listTools(config);
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ['echo', 'blocks', 'boom', 'silent'],
    );

    const result = await connector.callTool(config, 'echo', { text: 'over HTTP' });
    assert.deepEqual(result, { content: 'over HTTP', isError: false });
  });
});

describe('connection pooling', () => {
  /** Spawning a server per tool call would make an agent turn unusably slow. */
  test('identical configs share one spawned process', async () => {
    const path = marker('pool-reuse');
    const config = stdioConfig(path);

    await connector.listTools(config);
    await connector.callTool(config, 'echo', { text: 'once more' });
    await connector.listTools({ ...config, env: { ...config.env } });

    assert.equal(spawnCount(path), 1, 'a structurally equal config must hit the pool');
  });

  test('a config differing in its arguments gets a connection of its own', async () => {
    const path = marker('pool-distinct');

    await connector.listTools(stdioConfig(path));
    await connector.listTools(stdioConfig(path, { args: [scriptPath, '--variant'] }));

    assert.equal(spawnCount(path), 2);
  });

  /**
   * A pooled client whose server has just failed cannot be trusted for the next
   * call, so a failure drops it — otherwise every later request on that config
   * would be routed into the same broken connection.
   */
  test('a failed request evicts the connection so the next one reconnects', async () => {
    const path = marker('evict');
    const failing = stdioConfig(path, { env: { ENGINE_MARKER: path, ENGINE_LIST_FAILS: '1' } });

    await assert.rejects(
      () => connector.listTools(failing),
      (error: unknown) => {
        assert.ok(error instanceof ConnectorError);
        assert.equal(error.status, 500);
        assert.match(error.message, /MCP request failed/);
        return true;
      },
    );
    assert.equal(spawnCount(path), 1);

    await assert.rejects(() => connector.listTools(failing));
    assert.equal(spawnCount(path), 2, 'the second call had to spawn a new server');
  });
});

describe('configuration errors', () => {
  test('a stdio config without a command is rejected before anything is spawned', async () => {
    await assert.rejects(
      () => connector.listTools({ transport: McpTransport.Stdio }),
      (error: unknown) => {
        assert.ok(error instanceof ConnectorError);
        assert.equal(error.status, 400);
        assert.match(error.message, /requires a `command`/);
        return true;
      },
    );
  });

  test('an http config without a url is rejected', async () => {
    await assert.rejects(
      () => connector.listTools({ transport: McpTransport.Http }),
      (error: unknown) => (error as ConnectorError).status === 400,
    );
  });

  test('an unknown transport names itself in the error', async () => {
    await assert.rejects(
      () => connector.listTools({ transport: 'carrier-pigeon' as McpTransport }),
      (error: unknown) => {
        assert.equal((error as ConnectorError).status, 400);
        assert.match((error as Error).message, /carrier-pigeon/);
        return true;
      },
    );
  });

  test('a command that cannot be spawned surfaces as a connector failure', async () => {
    await assert.rejects(
      () =>
        connector.listTools({
          transport: McpTransport.Stdio,
          command: join(scratch, 'no-such-binary'),
        }),
      (error: unknown) => (error as ConnectorError).status === 500,
    );
  });
});

/**
 * Stop has to reach the MCP request itself. Aborting only the SSE response the
 * user was reading leaves a slow server holding the tool call — and the turn
 * behind it — alive with nobody watching.
 */
describe('abort', () => {
  test('an already-aborted signal stops the call from being made', async () => {
    const config = stdioConfig(marker('abort'));
    await connector.listTools(config);

    await assert.rejects(() =>
      connector.callTool(config, 'echo', { text: 'too late' }, AbortSignal.abort()),
    );
  });
});

/**
 * Listing a server means running it, and an agent turn needs the list of every
 * server in scope before it can call the model at all. The catalog is what keeps
 * that from being paid per turn — and, since it is on disk, per daemon.
 */
describe('tool catalog', () => {
  test('a server listed once is not started again by the next turn, or the next daemon', async () => {
    const path = marker('catalog');
    const config = stdioConfig(path, { args: [scriptPath, '--catalog'] });
    const catalogPath = join(scratch, 'shared-catalog.json');
    const first = new Connector({ catalog: new McpCatalog({ path: catalogPath }) });

    await first.listTools(config);
    assert.equal(spawnCount(path), 1);
    await first.shutdown();

    const next = new Connector({ catalog: new McpCatalog({ path: catalogPath }) });
    const tools = await next.catalogTools(config);

    assert.deepEqual(
      tools.map((tool) => tool.name),
      ['echo', 'blocks', 'boom', 'silent'],
    );
    assert.equal(spawnCount(path), 1, 'the catalog answered, so nothing was spawned');
    await next.shutdown();
  });

  test('a server nobody has ever listed is started, once', async () => {
    const path = marker('catalog-cold');
    const config = stdioConfig(path, { args: [scriptPath, '--catalog-cold'] });
    const cold = testConnector('catalog-cold');

    await cold.catalogTools(config);
    await cold.catalogTools(config);

    assert.equal(spawnCount(path), 1);
    await cold.shutdown();
  });
});

describe('shutdown', () => {
  test('closes the pool and can be called on an idle connector', async () => {
    const spare = testConnector('shutdown');
    const path = marker('shutdown');
    await spare.listTools(stdioConfig(path));

    await spare.shutdown();
    // The pool is empty afterwards, so the next call has to start a new server.
    await spare.listTools(stdioConfig(path));
    assert.equal(spawnCount(path), 2);
    await spare.shutdown();
  });
});
