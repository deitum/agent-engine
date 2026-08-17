import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, test } from 'node:test';

import { LspClient } from './client';
import { encodeMessage, type JsonRpcMessage, type LspTransport, MessageReader } from './jsonrpc';
import { type LspDiagnostic } from './lsp.types';

const ROOT_URI = 'file:///workspace';
const FILE_URI = 'file:///workspace/src/OrderService.java';

/** One diagnostic, short enough to read in an assertion. */
function diagnostic(message: string, line = 0): LspDiagnostic {
  return {
    message,
    severity: 1,
    range: { start: { line, character: 0 }, end: { line, character: 1 } },
  };
}

/**
 * A language server that answers `initialize` and otherwise does exactly what a
 * test tells it to. Stands in for `docker exec -i`, which is the whole reason the
 * transport is injected.
 */
function fakeServer(): {
  transport: LspTransport;
  /** Everything the client sent, decoded. */
  received: JsonRpcMessage[];
  /** Pushes a frame at the client. */
  send: (message: JsonRpcMessage) => void;
  /** Ends the process, as a crash would. */
  die: () => void;
  killed: () => boolean;
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const received: JsonRpcMessage[] = [];
  const reader = new MessageReader();
  let wasKilled = false;
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const send = (message: JsonRpcMessage): void => {
    stdout.write(encodeMessage(message));
  };

  stdin.on('data', (chunk: Buffer) => {
    for (const message of reader.push(chunk)) {
      received.push(message);
      if (message.method === 'initialize') {
        send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } });
      }
    }
  });

  return {
    transport: {
      stdin,
      stdout,
      kill: () => {
        wasKilled = true;
        resolveClosed();
      },
      closed,
    },
    received,
    send,
    die: () => resolveClosed(),
    killed: () => wasKilled,
  };
}

/** A started client wired to a fake server. */
async function started(options?: {
  readySignal?: (method: string, params: unknown) => boolean;
}): Promise<{ client: LspClient; server: ReturnType<typeof fakeServer> }> {
  const server = fakeServer();
  const client = new LspClient({
    spawn: () => server.transport,
    rootUri: ROOT_URI,
    initializeTimeoutMs: 1000,
    requestTimeoutMs: 1000,
    ...(options?.readySignal ? { readySignal: options.readySignal } : {}),
  });
  await client.start();
  return { client, server };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('LspClient.start', () => {
  test('completes the handshake and reports the workspace root', async () => {
    const { client, server } = await started();

    const initialize = server.received.find((message) => message.method === 'initialize');
    const params = initialize?.params as { rootUri: string; capabilities: Record<string, unknown> };
    assert.equal(params.rootUri, ROOT_URI);
    assert.ok(server.received.some((message) => message.method === 'initialized'));
    assert.ok(client.alive);
    client.dispose();
  });

  /**
   * `versionSupport` is what makes a server echo the document version on its
   * diagnostics, which is the only way to tell an answer about the text the agent
   * just wrote from an answer about the text before it.
   */
  test('claims publishDiagnostics version support', async () => {
    const { client, server } = await started();

    const initialize = server.received.find((message) => message.method === 'initialize');
    const capabilities = (initialize?.params as { capabilities: Record<string, never> })
      .capabilities as unknown as {
      textDocument: { publishDiagnostics: { versionSupport: boolean } };
    };
    assert.equal(capabilities.textDocument.publishDiagnostics.versionSupport, true);
    client.dispose();
  });

  test('a server without a readiness signal is usable at once', async () => {
    const { client } = await started();

    assert.equal(client.indexed, true);
    assert.equal(await client.whenReady(10), true);
    client.dispose();
  });

  /** jdtls answers `initialize` long before it has imported the Gradle project. */
  test('a server with a readiness signal stays «indexing» until it says otherwise', async () => {
    const { client, server } = await started({
      readySignal: (method, params) =>
        method === 'language/status' && (params as { type?: string })?.type === 'ServiceReady',
    });

    assert.equal(client.indexed, false);
    assert.equal(await client.whenReady(20), false);

    server.send({ jsonrpc: '2.0', method: 'language/status', params: { type: 'ServiceReady' } });
    await flush();

    assert.equal(client.indexed, true);
    assert.equal(await client.whenReady(10), true);
    client.dispose();
  });
});

describe('LspClient.syncDocument', () => {
  test('opens on first sight and changes afterwards, bumping the version', async () => {
    const { client, server } = await started();

    assert.equal(client.syncDocument(FILE_URI, 'java', 'class A {}'), 1);
    assert.equal(client.syncDocument(FILE_URI, 'java', 'class B {}'), 2);
    await flush();

    const open = server.received.find((m) => m.method === 'textDocument/didOpen');
    const change = server.received.find((m) => m.method === 'textDocument/didChange');
    assert.equal(
      (open?.params as { textDocument: { text: string } }).textDocument.text,
      'class A {}',
    );
    assert.equal(
      (change?.params as { contentChanges: { text: string }[] }).contentChanges[0].text,
      'class B {}',
    );
    assert.equal((change?.params as { textDocument: { version: number } }).textDocument.version, 2);
    client.dispose();
  });

  test('closeDocument forgets the file and its diagnostics', async () => {
    const { client, server } = await started();
    client.syncDocument(FILE_URI, 'java', 'class A {}');
    server.send({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri: FILE_URI, version: 1, diagnostics: [diagnostic('boom')] },
    });
    await flush();
    assert.equal(client.diagnosticsFor(FILE_URI).length, 1);

    client.closeDocument(FILE_URI);
    await flush();

    assert.equal(client.isOpen(FILE_URI), false);
    assert.equal(client.diagnosticsFor(FILE_URI).length, 0);
    assert.ok(server.received.some((m) => m.method === 'textDocument/didClose'));
    client.dispose();
  });
});

describe('LspClient.waitForDiagnostics', () => {
  test('resolves with the diagnostics for the requested version', async () => {
    const { client, server } = await started();
    const version = client.syncDocument(FILE_URI, 'java', 'class A {}');
    const pending = client.waitForDiagnostics(FILE_URI, version, 1000);

    server.send({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri: FILE_URI, version, diagnostics: [diagnostic('cannot find symbol')] },
    });

    const items = await pending;
    assert.equal(items?.length, 1);
    assert.equal(items?.[0].message, 'cannot find symbol');
    client.dispose();
  });

  /**
   * The realistic race: the server was still publishing about the previous text
   * when the edit landed. Accepting that would report errors the agent already
   * fixed — the most confusing possible feedback.
   */
  test('ignores a publish about an older version', async () => {
    const { client, server } = await started();
    client.syncDocument(FILE_URI, 'java', 'v1');
    const version = client.syncDocument(FILE_URI, 'java', 'v2');
    const pending = client.waitForDiagnostics(FILE_URI, version, 60);

    server.send({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri: FILE_URI, version: 1, diagnostics: [diagnostic('stale')] },
    });

    assert.equal(await pending, null);
    client.dispose();
  });

  /** `version` is optional in the protocol; arrival order is the fallback. */
  test('accepts a versionless publish that arrives after the wait began', async () => {
    const { client, server } = await started();
    const version = client.syncDocument(FILE_URI, 'python', 'x = 1');
    const pending = client.waitForDiagnostics(FILE_URI, version, 1000);

    server.send({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri: FILE_URI, diagnostics: [diagnostic('undefined name')] },
    });

    const items = await pending;
    assert.equal(items?.[0].message, 'undefined name');
    client.dispose();
  });

  test('resolves null when the server says nothing in time', async () => {
    const { client } = await started();
    const version = client.syncDocument(FILE_URI, 'java', 'class A {}');

    assert.equal(await client.waitForDiagnostics(FILE_URI, version, 20), null);
    client.dispose();
  });

  test('returns at once when the answer is already held', async () => {
    const { client, server } = await started();
    const version = client.syncDocument(FILE_URI, 'java', 'class A {}');
    server.send({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri: FILE_URI, version, diagnostics: [diagnostic('held')] },
    });
    await flush();

    const items = await client.waitForDiagnostics(FILE_URI, version, 0);
    assert.equal(items?.[0].message, 'held');
    client.dispose();
  });

  test('a crashed server releases everything waiting on it', async () => {
    const { client, server } = await started();
    const version = client.syncDocument(FILE_URI, 'java', 'class A {}');
    const pending = client.waitForDiagnostics(FILE_URI, version, 60_000);

    server.die();

    assert.equal(await pending, null);
    assert.equal(client.alive, false);
    client.dispose();
  });
});

describe('LspClient.dispose', () => {
  test('asks the server to shut down, then kills the transport', async () => {
    const { client, server } = await started();

    client.dispose();
    await flush();

    assert.ok(server.received.some((m) => m.method === 'shutdown'));
    assert.ok(server.received.some((m) => m.method === 'exit'));
    assert.ok(server.killed());
    assert.equal(client.alive, false);
  });

  test('is idempotent', async () => {
    const { client } = await started();

    client.dispose();
    client.dispose();

    assert.equal(client.alive, false);
  });

  test('requests after disposal reject rather than hang', async () => {
    const { client } = await started();
    client.dispose();

    await assert.rejects(client.request('textDocument/hover', {}), /not running/);
  });
});
