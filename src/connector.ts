import { createHash } from 'node:crypto';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { insecureChildEnv } from './config/tls';
import {
  type McpServerConfig,
  type McpTool,
  type McpToolCallResponse,
  McpTransport,
} from './contracts';
import { McpCatalog } from './mcp-catalog';
import { PACKAGE_NAME, PACKAGE_VERSION } from './package.constants';

const CLIENT_INFO = { name: PACKAGE_NAME, version: PACKAGE_VERSION } as const;
/**
 * How long an unused connection is kept.
 *
 * Half an hour rather than a few minutes because of what the other end is: a
 * stdio server is a child process whose start can involve a package manager and
 * a registry, so dropping it is cheap only for the daemon, never for the next
 * turn that needs it. Idle memory on the user's own machine is the smaller cost.
 */
const IDLE_TTL_MS = 30 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;
/**
 * How old a catalog entry may be before a call that already has the server
 * running takes a fresh listing on the way past. Nothing ever starts a server
 * just to refresh it (see {@link McpCatalog}).
 */
const CATALOG_REFRESH_MS = 6 * 60 * 60_000;
/**
 * Budgets for a single MCP request.
 *
 * Without them an agent turn is at the mercy of the slowest server it talks to:
 * a server that accepts the connection and then never answers blocks the tool
 * call forever — including past Stop, because aborting the SSE response does
 * not touch a promise nobody is going to settle.
 */
const CONNECT_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 120_000;

interface Connection {
  client: Client;
  lastUsed: number;
}

/**
 * Per-request options for the MCP SDK: the caller's abort signal plus a ceiling,
 * so a silent server fails the one tool call instead of the whole turn.
 */
function requestOptions(signal?: AbortSignal): { timeout: number; signal?: AbortSignal } {
  return { timeout: REQUEST_TIMEOUT_MS, ...(signal ? { signal } : {}) };
}

/** Error carrying an HTTP status so the server can map it to a response code. */
export class ConnectorError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ConnectorError';
  }
}

/**
 * Pool of MCP client connections keyed by a hash of their config, ported from
 * the server-side `McpService`. Unlike the API, stdio is always allowed — this
 * daemon runs on the user's own machine, which is the whole point.
 */
export class Connector {
  private readonly connections = new Map<string, Connection>();
  private readonly sweeper: NodeJS.Timeout;
  private readonly catalog: McpCatalog;

  constructor(options: { catalog?: McpCatalog } = {}) {
    this.catalog = options.catalog ?? new McpCatalog();
    this.sweeper = setInterval(() => void this.sweepIdle(), SWEEP_INTERVAL_MS);
    this.sweeper.unref?.();
  }

  /**
   * Lists the tools advertised by the server described by `config`, connecting
   * to it if necessary. This is the fresh answer — what the MCP screen shows —
   * and it refreshes the catalog on the way back.
   */
  async listTools(config: McpServerConfig, signal?: AbortSignal): Promise<McpTool[]> {
    const client = await this.getClient(config);
    try {
      const result = await client.listTools(undefined, requestOptions(signal));
      const tools = result.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
      }));
      this.catalog.put(config, tools);
      return tools;
    } catch (error) {
      this.evict(config);
      throw this.wrap(error);
    }
  }

  /**
   * The tools of a server as an agent turn needs them: last week's answer now,
   * rather than today's answer in ten seconds.
   *
   * Only a server nobody has ever listed is started here — every other one is
   * answered from the catalog and started later, if and when the model actually
   * calls one of its tools. That is what keeps a chat with several deferred
   * servers attached from paying for all of them on a turn that uses none.
   */
  async catalogTools(config: McpServerConfig, signal?: AbortSignal): Promise<McpTool[]> {
    return this.catalog.get(config) ?? (await this.listTools(config, signal));
  }

  /**
   * Invokes a single tool and returns its concatenated text content. `signal` is
   * the turn's abort signal: pressing Stop has to reach the MCP request, not
   * just the response stream the user was reading.
   */
  async callTool(
    config: McpServerConfig,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpToolCallResponse> {
    const client = await this.getClient(config);
    try {
      const result = await client.callTool(
        { name: toolName, arguments: args },
        undefined,
        requestOptions(signal),
      );
      this.refreshCatalog(config, client);
      return {
        content: this.stringifyContent(result.content),
        isError: result.isError === true,
      };
    } catch (error) {
      this.evict(config);
      throw this.wrap(error);
    }
  }

  /** Closes every pooled connection and stops the sweeper. */
  async shutdown(): Promise<void> {
    clearInterval(this.sweeper);
    await Promise.all([...this.connections.keys()].map((key) => this.close(key)));
  }

  private async getClient(config: McpServerConfig): Promise<Client> {
    const key = this.hashConfig(config);
    const existing = this.connections.get(key);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing.client;
    }

    const client = new Client(CLIENT_INFO);
    try {
      await client.connect(this.createTransport(config), { timeout: CONNECT_TIMEOUT_MS });
    } catch (error) {
      throw this.wrap(error);
    }

    this.connections.set(key, { client, lastUsed: Date.now() });
    return client;
  }

  private createTransport(config: McpServerConfig): Transport {
    if (config.transport === McpTransport.Stdio) {
      if (!config.command) {
        throw new ConnectorError(400, 'stdio transport requires a `command`');
      }
      return new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        // A server started by this daemon reaches its own API over the same
        // network the daemon does, and the SDK's default environment is an
        // allow-list carrying neither TLS variable — so an insecure daemon would
        // otherwise spawn a server that still verifies, and still fails. The
        // user's own `env` stays last: theirs is the final word on their server.
        env: { ...getDefaultEnvironment(), ...insecureChildEnv(), ...config.env },
      });
    }

    if (config.transport === McpTransport.Http) {
      if (!config.url) {
        throw new ConnectorError(400, 'http transport requires a `url`');
      }
      return new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: config.headers ? { headers: config.headers } : undefined,
      });
    }

    throw new ConnectorError(400, `Unsupported MCP transport: ${String(config.transport)}`);
  }

  /** Stable hash of a config so identical configs share one connection. */
  private hashConfig(config: McpServerConfig): string {
    const normalized = JSON.stringify({
      transport: config.transport,
      command: config.command ?? null,
      args: config.args ?? [],
      env: config.env ?? {},
      url: config.url ?? null,
      headers: config.headers ?? {},
    });
    return createHash('sha256').update(normalized).digest('hex');
  }

  private stringifyContent(content: unknown): string {
    if (!Array.isArray(content)) {
      return '';
    }
    return content
      .map((block: { type?: string; text?: string }) =>
        block?.type === 'text' && typeof block.text === 'string'
          ? block.text
          : JSON.stringify(block),
      )
      .join('\n');
  }

  /**
   * Takes a fresh listing from a server that is already running, when the one
   * on record is old enough to be worth replacing. Fire-and-forget and failure-
   * tolerant: this is bookkeeping riding along with a tool call the model is
   * waiting on, and it must never delay or break it.
   */
  private refreshCatalog(config: McpServerConfig, client: Client): void {
    const age = this.catalog.age(config);
    if (age !== null && age < CATALOG_REFRESH_MS) {
      return;
    }
    void client
      .listTools(undefined, { timeout: REQUEST_TIMEOUT_MS })
      .then((result) => {
        this.catalog.put(
          config,
          result.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
          })),
        );
      })
      .catch(() => {
        // The entry on record stays; the next call tries again.
      });
  }

  /**
   * Drops the connection. The catalog is deliberately left alone: a server that
   * has just failed is the one whose real tool list is least available, and its
   * tools did not change because a socket did. It is replaced by the next
   * successful listing and by nothing else.
   */
  private evict(config: McpServerConfig): void {
    void this.close(this.hashConfig(config));
  }

  private async close(key: string): Promise<void> {
    const connection = this.connections.get(key);
    if (!connection) {
      return;
    }
    this.connections.delete(key);
    try {
      await connection.client.close();
    } catch (error) {
      console.warn(`Failed to close MCP connection: ${String(error)}`);
    }
  }

  private async sweepIdle(): Promise<void> {
    const cutoff = Date.now() - IDLE_TTL_MS;
    for (const [key, connection] of this.connections) {
      if (connection.lastUsed < cutoff) {
        await this.close(key);
      }
    }
  }

  private wrap(error: unknown): Error {
    if (error instanceof ConnectorError) {
      return error;
    }
    const message = error instanceof Error ? error.message : String(error);
    return new ConnectorError(500, `MCP request failed: ${message}`);
  }
}
