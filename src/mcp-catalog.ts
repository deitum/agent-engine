import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { type McpServerConfig, type McpTool } from './contracts';
import { engineHome } from './platform';

/**
 * The last known tool list of every MCP server this daemon has ever talked to,
 * kept on the user's machine.
 *
 * It exists because listing a server's tools means **running** it. A stdio
 * server is a child process — `npx -y some-server@latest` reaches the registry
 * before it prints a byte — and an agent turn needs the list of every server in
 * scope before it can call the model even once. Without a catalog, a chat with
 * five servers attached pays five cold starts, in a row, before the first token
 * of «hello»; with one, the turn is assembled from what the servers said last
 * time and a server is only started when one of its tools is actually called.
 *
 * The trade is a staleness window: a tool removed upstream is offered once more
 * and answers with an error, after which the call itself refreshes the entry.
 * That is the right way round — a wrong tool costs one call, while a cold start
 * costs every turn.
 *
 * Entries are keyed by the server's **identity** — what is started or dialled —
 * and not by its full config. Credentials are deliberately outside the key: a
 * rotated token must not throw the catalog away, and nothing secret should be
 * written to this file.
 */

/** One server's tools, and when they were last seen. */
export interface McpCatalogEntry {
  tools: McpTool[];
  /** `Date.now()` of the listing this entry came from. */
  at: number;
}

/** File format: identity → entry. Versioned so a future shape can be ignored. */
interface CatalogFile {
  version: 1;
  servers: Record<string, McpCatalogEntry>;
}

const CATALOG_FILE = 'mcp-catalog.json';
const CATALOG_VERSION = 1;

/**
 * Stable key for a server: everything that decides **which** server this is —
 * the command and its arguments, or the URL — and nothing that decides how it
 * authenticates. Hashed rather than stored in the clear because a command line
 * can carry a token as an argument.
 */
export function serverIdentity(config: McpServerConfig): string {
  const normalized = JSON.stringify({
    transport: config.transport,
    command: config.command ?? null,
    args: config.args ?? [],
    url: config.url ?? null,
  });
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * The catalog as a file plus an in-memory copy. Every failure is swallowed: a
 * cache that cannot be read or written must never be the reason a turn fails,
 * and the worst case — no entry — is exactly the behaviour that came before it.
 */
export class McpCatalog {
  private readonly path: string;
  private servers: Record<string, McpCatalogEntry> | null = null;

  constructor(options: { path?: string } = {}) {
    this.path = options.path ?? join(engineHome(), CATALOG_FILE);
  }

  /** The tools this server last advertised, or `null` if it never has. */
  get(config: McpServerConfig): McpTool[] | null {
    return this.load()[serverIdentity(config)]?.tools ?? null;
  }

  /**
   * How long ago this server's tools were listed, or `null` when they never
   * were. Read by the one place allowed to refresh an entry — a call that has
   * the server running anyway.
   */
  age(config: McpServerConfig, now = Date.now()): number | null {
    const entry = this.load()[serverIdentity(config)];
    return entry ? now - entry.at : null;
  }

  /** Records a fresh listing, in memory and on disk. */
  put(config: McpServerConfig, tools: McpTool[]): void {
    const servers = this.load();
    servers[serverIdentity(config)] = { tools, at: Date.now() };
    this.save(servers);
  }

  private load(): Record<string, McpCatalogEntry> {
    if (this.servers) {
      return this.servers;
    }
    this.servers = {};
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<CatalogFile>;
      if (parsed.version === CATALOG_VERSION && parsed.servers) {
        this.servers = parsed.servers;
      }
    } catch {
      // No catalog yet, or one this build cannot read — start from nothing.
    }
    return this.servers;
  }

  /**
   * Writes through a temporary file: several turns can finish at once, and a
   * half-written catalog would be read back as no catalog at all — turning the
   * one cold start this class exists to avoid into a permanent one.
   */
  private save(servers: Record<string, McpCatalogEntry>): void {
    const file: CatalogFile = { version: CATALOG_VERSION, servers };
    const temporary = `${this.path}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(temporary, JSON.stringify(file), 'utf8');
      renameSync(temporary, this.path);
    } catch {
      // Kept in memory regardless; the next daemon simply starts cold.
    }
  }
}
