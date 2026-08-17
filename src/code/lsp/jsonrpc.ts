import { type Readable, type Writable } from 'node:stream';

/**
 * JSON-RPC over the `Content-Length` framing LSP uses on stdio, plus the
 * request/response correlation on top of it.
 *
 * Kept free of any knowledge of Docker or of LSP semantics, so the part that is
 * easy to get subtly wrong — a header split across two chunks, a body counted in
 * characters instead of bytes — is testable without a container.
 */

/** One frame, in the union of shapes LSP puts on the wire. */
export interface JsonRpcMessage {
  jsonrpc?: string;
  /** Present on requests and responses; absent on notifications. */
  id?: number | string | null;
  /** Present on requests and notifications. */
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** The subset of JSON-RPC error codes we produce ourselves. */
const METHOD_NOT_FOUND = -32601;

const HEADER_SEPARATOR = Buffer.from('\r\n\r\n', 'ascii');
/** What a resync looks for when discarding non-protocol output. */
const CONTENT_LENGTH_TOKEN = Buffer.from('Content-Length', 'ascii');

/**
 * How much unframed output is tolerated before it is thrown away. A language
 * server is not supposed to write anything but frames to stdout, but a JVM under
 * memory pressure prints its warnings wherever it likes — without this cap that
 * output would grow the buffer for the lifetime of the process.
 */
const MAX_HEADER_BYTES = 64 * 1024;

/** Encodes one message into a `Content-Length`-framed buffer. */
export function encodeMessage(message: JsonRpcMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  // `body.length` is the byte count, which is the whole point: a Cyrillic
  // identifier in a rename makes the character count and the byte count differ,
  // and a header counted in characters desynchronises the stream for good.
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
  return Buffer.concat([header, body]);
}

/**
 * Reads `Content-Length` out of a header block, or `null` when it has none.
 *
 * Deliberately not anchored to the start of a line: a resync can leave the tail
 * of some non-protocol output glued to the front of a genuine header, and
 * refusing to read `…warningContent-Length: 42` would throw away a real message.
 */
function parseContentLength(header: string): number | null {
  const match = /content-length:\s*(\d+)/i.exec(header);
  if (!match) {
    return null;
  }
  const length = Number(match[1]);
  return Number.isSafeInteger(length) && length >= 0 ? length : null;
}

/**
 * Incremental decoder for the framed stream: fed whatever `stdout` produced, it
 * returns the messages that are now complete. Chunk boundaries fall wherever the
 * OS put them, so every state here has to survive being interrupted — a header
 * split in half, a body arriving in five pieces, three messages in one chunk.
 */
export class MessageReader {
  private buffer: Buffer = Buffer.alloc(0);
  /** Body length of the frame being read, or `null` while reading headers. */
  private expected: number | null = null;

  /** Appends a chunk and returns every message it completed. */
  push(chunk: Buffer): JsonRpcMessage[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const messages: JsonRpcMessage[] = [];

    for (;;) {
      if (this.expected === null) {
        const end = this.buffer.indexOf(HEADER_SEPARATOR);
        if (end < 0) {
          this.dropOverlongPreamble();
          break;
        }
        const header = this.buffer.subarray(0, end).toString('ascii');
        this.buffer = this.buffer.subarray(end + HEADER_SEPARATOR.length);
        const length = parseContentLength(header);
        if (length === null) {
          // Not a frame header at all — chatter the server wrote to stdout
          // before (or between) its messages. Drop it and look for the next
          // separator rather than giving up on the stream.
          continue;
        }
        this.expected = length;
      }

      if (this.buffer.length < this.expected) {
        break;
      }
      const body = this.buffer.subarray(0, this.expected);
      this.buffer = this.buffer.subarray(this.expected);
      this.expected = null;

      const parsed = safeParse(body);
      if (parsed) {
        messages.push(parsed);
      }
    }

    return messages;
  }

  /**
   * Discards a preamble that has grown past {@link MAX_HEADER_BYTES} without a
   * separator — a server writing something other than frames to stdout.
   *
   * Resynchronises on the next `Content-Length` rather than simply truncating:
   * cutting at an arbitrary offset would leave the tail of the noise attached to
   * whatever header followed. When there is no such token at all, all but the
   * last few bytes go, in case the token itself is what straddles the boundary.
   */
  private dropOverlongPreamble(): void {
    if (this.buffer.length <= MAX_HEADER_BYTES) {
      return;
    }
    const marker = this.buffer.indexOf(CONTENT_LENGTH_TOKEN);
    this.buffer =
      marker >= 0
        ? this.buffer.subarray(marker)
        : this.buffer.subarray(this.buffer.length - (CONTENT_LENGTH_TOKEN.length - 1));
  }
}

/** Parses a frame body, returning `null` for one that is not JSON. */
function safeParse(body: Buffer): JsonRpcMessage | null {
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as JsonRpcMessage) : null;
  } catch {
    return null;
  }
}

/** The process (or fake) a connection talks to. */
export interface LspTransport {
  stdin: Writable;
  stdout: Readable;
  /** Server diagnostics / JVM noise; read for logging only. */
  stderr?: Readable;
  /** Terminates the underlying process. */
  kill(): void;
  /** Resolves once the process is gone, whatever the reason. */
  closed: Promise<void>;
}

export interface JsonRpcConnectionOptions {
  /** Called for every server → client notification. */
  onNotification?: (method: string, params: unknown) => void;
  /**
   * Answers a server → client **request**. Returning `undefined` falls through
   * to {@link defaultServerResponse}. Unanswered requests are not cosmetic:
   * jdtls blocks its own startup waiting for `workspace/configuration`.
   */
  onServerRequest?: (method: string, params: unknown) => unknown;
  /** Non-fatal transport problems, for logging. */
  onError?: (error: Error) => void;
}

/** A request that outlived its budget. Distinguished so callers can degrade. */
export class LspTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(`The LSP request «${method}» timed out after ${Math.round(timeoutMs / 1000)}s.`);
    this.name = 'LspTimeoutError';
  }
}

/** The server answered with an error object. */
export class LspResponseError extends Error {
  constructor(
    readonly method: string,
    readonly rpc: JsonRpcError,
  ) {
    super(`The LSP request «${method}» was refused: ${rpc.message}`);
    this.name = 'LspResponseError';
  }
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Request/response correlation over a {@link LspTransport}.
 *
 * Every request carries its own budget: a language server that wedges (jdtls
 * during a bad project import is the realistic case) must cost one tool call,
 * not the turn. {@link dispose} rejects everything still outstanding, so a
 * crashed server never leaves a promise no one will settle.
 */
export class JsonRpcConnection {
  private readonly reader = new MessageReader();
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private disposed: Error | null = null;

  constructor(
    private readonly transport: LspTransport,
    private readonly options: JsonRpcConnectionOptions = {},
  ) {
    transport.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    transport.stdout.on('error', (error: Error) => this.options.onError?.(error));
    transport.stdin.on('error', (error: Error) => this.options.onError?.(error));
    void transport.closed.then(
      () => this.dispose(new Error('The language server exited.')),
      () => this.dispose(new Error('The language server exited.')),
    );
  }

  /** Sends a request and resolves with its `result`. */
  request<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    if (this.disposed) {
      return Promise.reject(this.disposed);
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      // Deliberately not `unref`ed, unlike the connector's other timers: this one
      // is the only thing that will ever settle the promise, so letting the event
      // loop drain without it turns a slow server into a request that hangs for
      // good. It is short-lived and cleared the moment a response arrives.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LspTimeoutError(method, timeoutMs));
      }, timeoutMs);

      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** Sends a notification; nothing comes back and nothing is awaited. */
  notify(method: string, params: unknown): void {
    if (this.disposed) {
      return;
    }
    this.send({ jsonrpc: '2.0', method, params });
  }

  /** Rejects everything outstanding and stops accepting new work. */
  dispose(reason: Error): void {
    if (this.disposed) {
      return;
    }
    this.disposed = reason;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(reason);
    }
  }

  private send(message: JsonRpcMessage): void {
    try {
      this.transport.stdin.write(encodeMessage(message));
    } catch (error) {
      // A write to a dead process (EPIPE) is the server having gone away; the
      // `closed` promise is about to dispose us, so this only needs reporting.
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private receive(chunk: Buffer): void {
    for (const message of this.reader.push(chunk)) {
      this.dispatch(message);
    }
  }

  private dispatch(message: JsonRpcMessage): void {
    // A frame with both an id and a method is the server asking *us* something.
    if (message.method !== undefined && message.id !== undefined && message.id !== null) {
      this.answer(message.id, message.method, message.params);
      return;
    }
    if (message.method !== undefined) {
      this.options.onNotification?.(message.method, message.params);
      return;
    }
    if (typeof message.id !== 'number') {
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) {
      // A response to a request that already timed out. Expected, not an error.
      return;
    }
    clearTimeout(entry.timer);
    this.pending.delete(message.id);
    if (message.error) {
      entry.reject(new LspResponseError(entry.method, message.error));
    } else {
      entry.resolve(message.result);
    }
  }

  private answer(id: number | string, method: string, params: unknown): void {
    const custom = this.options.onServerRequest?.(method, params);
    const result = custom === undefined ? defaultServerResponse(method, params) : custom;
    if (result === undefined) {
      this.send({
        jsonrpc: '2.0',
        id,
        error: { code: METHOD_NOT_FOUND, message: `Unsupported request: ${method}` },
      });
      return;
    }
    this.send({ jsonrpc: '2.0', id, result });
  }
}

/**
 * What we answer the handful of requests a server makes of its client.
 *
 * These are not optional politeness: a server that asks for configuration and is
 * ignored will sit in initialisation forever. We are a headless client with no
 * settings to offer, so the honest answer to most of them is «nothing», which is
 * exactly what servers treat as «use your defaults».
 *
 * Returns `undefined` for anything unrecognised, which the caller turns into a
 * proper `MethodNotFound` — a server is entitled to know we cannot help.
 */
export function defaultServerResponse(method: string, params: unknown): unknown {
  switch (method) {
    case 'workspace/configuration': {
      // One entry per requested section, in order. Length matters more than
      // content: a short array is read as a protocol violation by some servers.
      const items = (params as { items?: unknown[] } | undefined)?.items;
      return Array.isArray(items) ? items.map(() => null) : [];
    }
    case 'client/registerCapability':
    case 'client/unregisterCapability':
    case 'window/workDoneProgress/create':
      return null;
    case 'workspace/applyEdit':
      // Refused on purpose. The only edits we apply are the ones a tool asked
      // for and can report; a server rewriting files behind the agent's back
      // would appear in the diff panel with nothing in the transcript to explain
      // it. `rename_symbol` reads the edit from the response instead.
      return { applied: false, failureReason: 'the engine applies edits itself' };
    case 'workspace/workspaceFolders':
      return null;
    default:
      return undefined;
  }
}
