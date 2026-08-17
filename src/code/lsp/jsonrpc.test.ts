import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, test } from 'node:test';

import {
  defaultServerResponse,
  encodeMessage,
  type JsonRpcMessage,
  JsonRpcConnection,
  type LspTransport,
  LspResponseError,
  LspTimeoutError,
  MessageReader,
} from './jsonrpc';

/** Frames a body exactly the way a server would, for feeding the reader. */
function frame(body: string): Buffer {
  return Buffer.concat([
    Buffer.from(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`, 'ascii'),
    Buffer.from(body, 'utf8'),
  ]);
}

describe('encodeMessage', () => {
  test('counts the body in bytes, not characters', () => {
    const encoded = encodeMessage({ jsonrpc: '2.0', method: 'x', params: { name: '注文' } });
    const separator = encoded.indexOf('\r\n\r\n');
    const header = encoded.subarray(0, separator).toString('ascii');
    const body = encoded.subarray(separator + 4);

    // The JSON holds two CJK characters, which are six bytes in UTF-8. A header
    // counted in characters desynchronises the stream permanently.
    assert.equal(header, `Content-Length: ${body.length}`);
    assert.ok(body.length > JSON.parse(body.toString('utf8')).params.name.length);
  });

  test('round-trips through the reader', () => {
    const reader = new MessageReader();
    const messages = reader.push(encodeMessage({ id: 7, result: { ok: true } }));

    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0], { id: 7, result: { ok: true } });
  });
});

describe('MessageReader', () => {
  test('reads several messages out of one chunk', () => {
    const reader = new MessageReader();
    const chunk = Buffer.concat([frame('{"id":1}'), frame('{"id":2}'), frame('{"id":3}')]);

    assert.deepEqual(
      reader.push(chunk).map((message) => message.id),
      [1, 2, 3],
    );
  });

  /**
   * Chunk boundaries fall wherever the OS put them. Feeding the reader one byte
   * at a time is the strongest form of that: every internal state has to survive
   * being interrupted.
   */
  test('survives a message delivered one byte at a time', () => {
    const reader = new MessageReader();
    const encoded = frame(
      '{"method":"textDocument/publishDiagnostics","params":{"uri":"file:///a"}}',
    );
    const seen: JsonRpcMessage[] = [];

    for (const byte of encoded) {
      seen.push(...reader.push(Buffer.from([byte])));
    }

    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, 'textDocument/publishDiagnostics');
  });

  test('handles a header split across chunks', () => {
    const reader = new MessageReader();
    const encoded = frame('{"id":42}');
    const cut = 8; // mid-way through «Content-Length»

    assert.deepEqual(reader.push(encoded.subarray(0, cut)), []);
    assert.deepEqual(
      reader.push(encoded.subarray(cut)).map((message) => message.id),
      [42],
    );
  });

  test('ignores extra headers a server sends', () => {
    const reader = new MessageReader();
    const body = '{"id":5}';
    const chunk = Buffer.concat([
      Buffer.from(
        `Content-Length: ${body.length}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n`,
        'ascii',
      ),
      Buffer.from(body, 'utf8'),
    ]);

    assert.deepEqual(
      reader.push(chunk).map((message) => message.id),
      [5],
    );
  });

  /**
   * A JVM under memory pressure prints its warnings to stdout regardless of what
   * the protocol says. Losing the whole stream to that would take the language
   * server down with it.
   */
  test('resynchronises after non-protocol output', () => {
    const reader = new MessageReader();
    const chunk = Buffer.concat([
      Buffer.from('OpenJDK 64-Bit Server VM warning: ignoring option\r\n\r\n', 'utf8'),
      frame('{"id":9}'),
    ]);

    assert.deepEqual(
      reader.push(chunk).map((message) => message.id),
      [9],
    );
  });

  test('skips a body that is not JSON without losing the next message', () => {
    const reader = new MessageReader();
    const chunk = Buffer.concat([frame('{not json}'), frame('{"id":11}')]);

    assert.deepEqual(
      reader.push(chunk).map((message) => message.id),
      [11],
    );
  });

  test('drops an unbounded preamble instead of buffering it forever', () => {
    const reader = new MessageReader();
    const noise = Buffer.alloc(200_000, 0x61);

    assert.deepEqual(reader.push(noise), []);
    assert.deepEqual(
      reader.push(frame('{"id":1}')).map((message) => message.id),
      [1],
    );
  });
});

/** A connection wired to in-memory streams, plus what the client wrote. */
function connect(options?: {
  onNotification?: (method: string, params: unknown) => void;
  onServerRequest?: (method: string, params: unknown) => unknown;
}): {
  connection: JsonRpcConnection;
  /** Frames the client sent us. */
  sent: JsonRpcMessage[];
  /** Pushes a frame at the client. */
  reply: (message: JsonRpcMessage) => void;
  close: () => void;
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const transport: LspTransport = {
    stdin,
    stdout,
    kill: () => resolveClosed(),
    closed,
  };

  const sent: JsonRpcMessage[] = [];
  const reader = new MessageReader();
  stdin.on('data', (chunk: Buffer) => sent.push(...reader.push(chunk)));

  return {
    connection: new JsonRpcConnection(transport, options),
    sent,
    reply: (message) => stdout.write(encodeMessage(message)),
    close: () => resolveClosed(),
  };
}

/** Lets the stream plumbing deliver whatever is queued. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('JsonRpcConnection', () => {
  test('matches a response to its request', async () => {
    const { connection, sent, reply } = connect();
    const pending = connection.request<{ ok: boolean }>('textDocument/hover', { a: 1 }, 1000);
    await flush();

    assert.equal(sent.length, 1);
    assert.equal(sent[0].method, 'textDocument/hover');
    reply({ jsonrpc: '2.0', id: sent[0].id, result: { ok: true } });

    assert.deepEqual(await pending, { ok: true });
  });

  test('keeps concurrent requests apart', async () => {
    const { connection, sent, reply } = connect();
    const first = connection.request<string>('a', null, 1000);
    const second = connection.request<string>('b', null, 1000);
    await flush();

    // Answered out of order on purpose — correlation is by id, not arrival.
    reply({ jsonrpc: '2.0', id: sent[1].id, result: 'second' });
    reply({ jsonrpc: '2.0', id: sent[0].id, result: 'first' });

    assert.equal(await first, 'first');
    assert.equal(await second, 'second');
  });

  test('an error response rejects with the server message', async () => {
    const { connection, sent, reply } = connect();
    const pending = connection.request('textDocument/rename', null, 1000);
    await flush();
    reply({ jsonrpc: '2.0', id: sent[0].id, error: { code: -32602, message: 'no symbol here' } });

    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof LspResponseError);
      assert.equal(error.rpc.message, 'no symbol here');
      return true;
    });
  });

  test('a request that outlives its budget rejects rather than hanging', async () => {
    const { connection } = connect();

    await assert.rejects(connection.request('slow', null, 10), (error: unknown) => {
      assert.ok(error instanceof LspTimeoutError);
      assert.equal(error.method, 'slow');
      return true;
    });
  });

  test('a late response to a timed-out request is ignored', async () => {
    const { connection, sent, reply } = connect();
    await assert.rejects(connection.request('slow', null, 10));
    await flush();

    // Must not throw: there is nothing left to resolve.
    reply({ jsonrpc: '2.0', id: sent[0].id, result: 'too late' });
    await flush();
  });

  test('dispatches notifications', async () => {
    const seen: { method: string; params: unknown }[] = [];
    const { reply } = connect({
      onNotification: (method, params) => seen.push({ method, params }),
    });

    reply({ jsonrpc: '2.0', method: 'window/logMessage', params: { message: 'hi' } });
    await flush();

    assert.deepEqual(seen, [{ method: 'window/logMessage', params: { message: 'hi' } }]);
  });

  /**
   * jdtls blocks its own startup waiting for this answer, so «we have no
   * configuration» has to be said out loud rather than by staying silent.
   */
  test('answers workspace/configuration with one entry per requested section', async () => {
    const { sent, reply } = connect();

    reply({
      jsonrpc: '2.0',
      id: 100,
      method: 'workspace/configuration',
      params: { items: [{ section: 'java' }, { section: 'java.format' }] },
    });
    await flush();

    assert.equal(sent.length, 1);
    assert.equal(sent[0].id, 100);
    assert.deepEqual(sent[0].result, [null, null]);
  });

  test('refuses workspace/applyEdit so a server cannot edit behind the agent', async () => {
    const { sent, reply } = connect();

    reply({ jsonrpc: '2.0', id: 101, method: 'workspace/applyEdit', params: { edit: {} } });
    await flush();

    assert.deepEqual(sent[0].result, {
      applied: false,
      failureReason: 'the engine applies edits itself',
    });
  });

  test('reports an unsupported server request as MethodNotFound', async () => {
    const { sent, reply } = connect();

    reply({ jsonrpc: '2.0', id: 102, method: 'window/showMessageRequest', params: {} });
    await flush();

    assert.equal(sent[0].error?.code, -32601);
  });

  test('a custom responder wins over the default', async () => {
    const { sent, reply } = connect({
      onServerRequest: (method) => (method === 'workspace/configuration' ? ['custom'] : undefined),
    });

    reply({ jsonrpc: '2.0', id: 103, method: 'workspace/configuration', params: { items: [{}] } });
    await flush();

    assert.deepEqual(sent[0].result, ['custom']);
  });

  test('a dead process rejects everything still outstanding', async () => {
    const { connection, close } = connect();
    const pending = connection.request('textDocument/definition', null, 60_000);
    close();

    await assert.rejects(pending, /The language server exited/);
  });

  test('requests after disposal reject instead of queueing', async () => {
    const { connection, close } = connect();
    close();
    await flush();

    await assert.rejects(connection.request('x', null, 1000), /exited/);
  });
});

describe('defaultServerResponse', () => {
  test('returns undefined for anything unrecognised', () => {
    assert.equal(defaultServerResponse('some/unknown', {}), undefined);
  });

  test('tolerates workspace/configuration without items', () => {
    assert.deepEqual(defaultServerResponse('workspace/configuration', {}), []);
  });
});
