import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { type CodeEnvVar } from '../../contracts';
import { envArgs, killMarkedProcesses, EXEC_MARKER_VAR } from '../docker-backend';

import {
  JsonRpcConnection,
  type LspTransport,
  LspTimeoutError,
  type JsonRpcMessage,
} from './jsonrpc';
import { type LspDiagnostic, type LspPublishDiagnosticsParams } from './lsp.types';

/**
 * One language server, spoken to over stdio.
 *
 * The server runs **inside the session's container** (`docker exec -i`), because
 * that is where the project's resolved dependencies are: without `node_modules`
 * tsserver has no types, without site-packages pyright rejects every import, and
 * without the classpath Gradle produced jdtls does not see a single bean. Running
 * it on the host would also require a toolchain the user's machine is not
 * promised to have — the reason the sandbox exists at all.
 *
 * The transport is injected rather than constructed, so the whole class is
 * testable against a pair of in-memory streams. {@link dockerLspTransport} is what
 * production passes.
 */

/** How a server announces it has finished its initial indexing. */
export type ReadySignal = (method: string, params: unknown) => boolean;

export interface LspClientOptions {
  /** Spawns the server process. Called again by the pool on a restart. */
  spawn: () => LspTransport;
  /** The indexed root, as a URI — always `file:///workspace` in a container. */
  rootUri: string;
  /** Server-specific `initializationOptions`. */
  initializationOptions?: unknown;
  /**
   * Recognises the notification that means «indexing finished». Absent means the
   * server is usable as soon as `initialize` returns, which is true of tsserver
   * and pyright and emphatically not of jdtls.
   */
  readySignal?: ReadySignal;
  /** Budget for the `initialize` round-trip. */
  initializeTimeoutMs: number;
  /** Default budget for every other request. */
  requestTimeoutMs: number;
  /** Server logs and protocol warnings, for the connector's own diagnostics. */
  onLog?: (message: string) => void;
}

/** What the client tracks about a document it has opened. */
interface OpenDocument {
  languageId: string;
  version: number;
}

/** The last diagnostics published for a URI. */
interface DiagnosticsEntry {
  items: LspDiagnostic[];
  /** The document version they describe; absent when the server omits it. */
  version?: number;
  /** Monotonic counter, so a waiter can tell «new publish» from «same publish». */
  seq: number;
}

interface DiagnosticsWaiter {
  uri: string;
  minVersion: number;
  sinceSeq: number;
  resolve: (items: LspDiagnostic[] | null) => void;
  timer: NodeJS.Timeout;
}

/**
 * The capabilities we claim. Kept minimal and honest — a client that advertises
 * a feature it does not implement gets sent requests it will not answer.
 *
 * `publishDiagnostics.versionSupport` is the load-bearing one: it is what makes a
 * server echo the document version on its diagnostics, which is how
 * {@link LspClient.waitForDiagnostics} can tell the answer about the text the
 * agent just wrote from the answer about the text before it.
 */
const CLIENT_CAPABILITIES = {
  workspace: {
    workspaceFolders: true,
    configuration: true,
    applyEdit: false,
    symbol: { dynamicRegistration: false },
    workspaceEdit: { documentChanges: true },
  },
  textDocument: {
    synchronization: { dynamicRegistration: false, didSave: false, willSave: false },
    publishDiagnostics: { relatedInformation: false, versionSupport: true },
    definition: { dynamicRegistration: false, linkSupport: true },
    references: { dynamicRegistration: false },
    documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
    hover: { dynamicRegistration: false, contentFormat: ['markdown', 'plaintext'] },
    rename: { dynamicRegistration: false, prepareSupport: false },
  },
} as const;

export class LspClient {
  private connection: JsonRpcConnection | null = null;
  private transport: LspTransport | null = null;
  private readonly documents = new Map<string, OpenDocument>();
  private readonly diagnostics = new Map<string, DiagnosticsEntry>();
  private readonly waiters = new Set<DiagnosticsWaiter>();
  private publishSeq = 0;
  private ready = false;
  private readyWaiters = new Set<(value: boolean) => void>();
  private stopped = false;

  constructor(private readonly options: LspClientOptions) {}

  /** True until the server dies or {@link dispose} is called. */
  get alive(): boolean {
    return !this.stopped && this.connection !== null;
  }

  /** True once the server signalled it finished indexing. */
  get indexed(): boolean {
    return this.ready;
  }

  /** Spawns the server and completes the LSP handshake. */
  async start(): Promise<void> {
    const transport = this.options.spawn();
    this.transport = transport;
    this.connection = new JsonRpcConnection(transport, {
      onNotification: (method, params) => this.onNotification(method, params),
      onError: (error) => this.options.onLog?.(`lsp transport: ${error.message}`),
    });

    transport.stderr?.on('data', (chunk: Buffer) => {
      this.options.onLog?.(`lsp stderr: ${chunk.toString('utf8').slice(0, 500)}`);
    });
    void transport.closed.then(
      () => this.onExit(),
      () => this.onExit(),
    );

    await this.connection.request(
      'initialize',
      {
        processId: process.pid,
        rootUri: this.options.rootUri,
        workspaceFolders: [{ uri: this.options.rootUri, name: 'workspace' }],
        capabilities: CLIENT_CAPABILITIES,
        ...(this.options.initializationOptions !== undefined
          ? { initializationOptions: this.options.initializationOptions }
          : {}),
      },
      this.options.initializeTimeoutMs,
    );
    this.connection.notify('initialized', {});

    // A server with no readiness signal of its own is usable now. One that has
    // such a signal (jdtls) stays «indexing» until it says otherwise.
    if (!this.options.readySignal) {
      this.markReady();
    }
  }

  /** Issues a request, defaulting to the client's ordinary budget. */
  request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (!this.connection) {
      return Promise.reject(new Error('The language server is not running.'));
    }
    return this.connection.request<T>(method, params, timeoutMs ?? this.options.requestTimeoutMs);
  }

  /**
   * Makes the server's view of a file match `text`, opening it on first use.
   * Returns the version the server now holds, which is what
   * {@link waitForDiagnostics} matches on.
   *
   * Everything is pushed rather than left to the server's own file watcher: the
   * agent's file tools write on the **host** side of the bind mount, and inotify
   * across a macOS bind mount (VirtioFS / gRPC-FUSE) does not reliably fire. A
   * server watching for itself would answer about the previous text.
   */
  syncDocument(uri: string, languageId: string, text: string): number {
    const open = this.documents.get(uri);
    if (!open) {
      this.documents.set(uri, { languageId, version: 1 });
      this.connection?.notify('textDocument/didOpen', {
        textDocument: { uri, languageId, version: 1, text },
      });
      return 1;
    }
    open.version += 1;
    this.connection?.notify('textDocument/didChange', {
      textDocument: { uri, version: open.version },
      // Full-document sync. Incremental sync would save bytes over a socket we
      // do not pay for, at the cost of tracking ranges the agent's edits do not
      // give us anyway (`edit_file` reports occurrences, not offsets).
      contentChanges: [{ text }],
    });
    return open.version;
  }

  /** True when the server already holds this document. */
  isOpen(uri: string): boolean {
    return this.documents.has(uri);
  }

  /** Tells the server to forget a document. */
  closeDocument(uri: string): void {
    if (!this.documents.delete(uri)) {
      return;
    }
    this.diagnostics.delete(uri);
    this.connection?.notify('textDocument/didClose', { textDocument: { uri } });
  }

  /** The diagnostics currently held for a URI (possibly stale). */
  diagnosticsFor(uri: string): LspDiagnostic[] {
    return this.diagnostics.get(uri)?.items ?? [];
  }

  /**
   * Waits for the diagnostics that describe version `minVersion` of `uri`.
   *
   * Resolves `null` on timeout rather than rejecting: a server still indexing is
   * the normal state for the first minute of a Java session, and the caller's
   * job is to say nothing rather than to fail the agent's edit.
   *
   * Two acceptance rules, because `version` is optional in the protocol and not
   * every server sends it:
   *  - a publish carrying a version is accepted when it is at least `minVersion`;
   *  - a publish carrying none is accepted when it arrived **after** this call,
   *    which is the best «is this about my text?» available.
   */
  waitForDiagnostics(
    uri: string,
    minVersion: number,
    timeoutMs: number,
  ): Promise<LspDiagnostic[] | null> {
    const held = this.diagnostics.get(uri);
    if (held?.version !== undefined && held.version >= minVersion) {
      return Promise.resolve(held.items);
    }

    return new Promise((resolve) => {
      const waiter: DiagnosticsWaiter = {
        uri,
        minVersion,
        sinceSeq: this.publishSeq,
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          resolve(null);
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  /**
   * Resolves `true` once the server finished indexing, `false` if it has not by
   * `timeoutMs`. A `false` is not a failure — requests still work, they are just
   * answered from a partial index, which is worth telling the caller about.
   */
  whenReady(timeoutMs: number): Promise<boolean> {
    if (this.ready) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const settle = (value: boolean): void => {
        this.readyWaiters.delete(settle);
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => settle(false), timeoutMs);
      this.readyWaiters.add(settle);
    });
  }

  /** Shuts the server down and releases everything waiting on it. */
  dispose(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    // A polite `shutdown`/`exit` gives the server a chance to flush its index
    // caches, which is minutes saved on the next jdtls start. We do not wait for
    // it: the transport is killed either way.
    try {
      this.connection?.notify('shutdown', null);
      this.connection?.notify('exit', null);
    } catch {
      // The process is already gone; the kill below is the belt.
    }
    this.connection?.dispose(new Error('The language server was stopped.'));
    this.connection = null;
    this.transport?.kill();
    this.transport = null;
    this.settleAll();
  }

  private onExit(): void {
    this.connection = null;
    this.transport = null;
    this.ready = false;
    this.settleAll();
  }

  /** Releases every waiter, so nothing is left pending on a dead server. */
  private settleAll(): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
    this.waiters.clear();
    for (const resolve of [...this.readyWaiters]) {
      resolve(false);
    }
    this.readyWaiters.clear();
  }

  private onNotification(method: string, params: unknown): void {
    if (method === 'textDocument/publishDiagnostics') {
      this.onDiagnostics(params as LspPublishDiagnosticsParams);
      return;
    }
    if (method === 'window/logMessage' || method === 'window/showMessage') {
      const message = (params as { message?: unknown })?.message;
      if (typeof message === 'string') {
        this.options.onLog?.(message.slice(0, 500));
      }
    }
    if (!this.ready && this.options.readySignal?.(method, params)) {
      this.markReady();
    }
  }

  private onDiagnostics(params: LspPublishDiagnosticsParams | undefined): void {
    if (!params || typeof params.uri !== 'string') {
      return;
    }
    this.publishSeq += 1;
    const entry: DiagnosticsEntry = {
      items: Array.isArray(params.diagnostics) ? params.diagnostics : [],
      seq: this.publishSeq,
      ...(typeof params.version === 'number' ? { version: params.version } : {}),
    };
    this.diagnostics.set(params.uri, entry);

    for (const waiter of [...this.waiters]) {
      if (waiter.uri !== params.uri) {
        continue;
      }
      const acceptable =
        entry.version !== undefined
          ? entry.version >= waiter.minVersion
          : entry.seq > waiter.sinceSeq;
      if (acceptable) {
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        waiter.resolve(entry.items);
      }
    }
  }

  private markReady(): void {
    this.ready = true;
    for (const resolve of [...this.readyWaiters]) {
      resolve(true);
    }
    this.readyWaiters.clear();
  }
}

/**
 * A transport that runs `command` inside the session's container.
 *
 * `-i` keeps stdin open, which is the whole mechanism; there is deliberately no
 * `-t`, because a TTY would rewrite `\n` on the way through and corrupt the
 * `Content-Length` framing. The command is stamped with {@link EXEC_MARKER_VAR}
 * so {@link LspTransport.kill} can reach the process on the far side of the
 * socket — killing the `docker exec` client alone would leave a jdtls holding a
 * gigabyte or two of the container's memory limit.
 */
export function dockerLspTransport(
  containerName: string,
  command: string,
  env?: CodeEnvVar[],
): LspTransport {
  const marker = randomUUID();
  const child = spawn(
    'docker',
    [
      'exec',
      '-i',
      '-w',
      '/workspace',
      '-e',
      `${EXEC_MARKER_VAR}=${marker}`,
      ...envArgs(env),
      containerName,
      'sh',
      '-lc',
      command,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );

  const closed = new Promise<void>((resolve) => {
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });

  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    kill: () => {
      child.kill('SIGKILL');
      killMarkedProcesses(containerName, marker);
    },
    closed,
  };
}

/** Re-exported so callers can distinguish «server is slow» from «server said no». */
export { LspTimeoutError, type JsonRpcMessage };
