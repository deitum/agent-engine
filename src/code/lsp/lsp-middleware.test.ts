import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { appendToResult, buildLspMiddleware, editedPath } from './lsp-middleware';
import { type EditProbe, type LspSession } from './lsp-session';

/** The `wrapToolCall` hook, pulled out of the middleware the factory built. */
type WrapToolCall = (request: unknown, handler: (request: unknown) => unknown) => Promise<unknown>;

/** Captures the config `buildLspMiddleware` passes to `createMiddleware`. */
function capture(session: Partial<LspSession>): {
  wrap: WrapToolCall;
  logs: string[];
} {
  let wrap: WrapToolCall | null = null;
  const logs: string[] = [];
  const createMiddleware = (config: { name: string; wrapToolCall: WrapToolCall }): unknown => {
    wrap = config.wrapToolCall;
    return {};
  };

  buildLspMiddleware(createMiddleware, session as LspSession, (message) => logs.push(message));
  assert.ok(wrap, 'middleware must register a wrapToolCall hook');
  return { wrap: wrap as unknown as WrapToolCall, logs };
}

/** A minimal stand-in for the ToolMessage the file tools return. */
function toolMessage(content: string): { content: string; lc_kwargs: { content: string } } {
  return { content, lc_kwargs: { content } };
}

function request(name: string, args: Record<string, unknown>): unknown {
  return { toolCall: { name, args, id: 'call-1' } };
}

/** A session that reports one block for any edit. */
function reportingSession(block: string | null): Partial<LspSession> {
  return {
    off: false,
    beforeEdit: (path: string) =>
      Promise.resolve({ relative: path.replace(/^\//, ''), language: 'typescript', text: 'old' }),
    afterEdit: (_probe: EditProbe) => Promise.resolve(block),
  };
}

describe('editedPath', () => {
  test('reads the spellings the model produces', () => {
    assert.equal(editedPath({ file_path: '/src/a.ts' }), '/src/a.ts');
    assert.equal(editedPath({ filePath: '/src/a.ts' }), '/src/a.ts');
    assert.equal(editedPath({ path: '/src/a.ts' }), '/src/a.ts');
  });

  test('returns null when there is no usable path', () => {
    assert.equal(editedPath({}), null);
    assert.equal(editedPath({ file_path: '   ' }), null);
    assert.equal(editedPath(null), null);
    assert.equal(editedPath('a string'), null);
  });
});

describe('appendToResult', () => {
  test('extends a plain tool message and its serialised copy', () => {
    const message = toolMessage("Successfully wrote to '/src/a.ts'");

    appendToResult(message, '⚠ LSP: 1 error');

    assert.match(message.content, /Successfully wrote/);
    assert.match(message.content, /⚠ LSP: 1 error/);
    assert.equal(message.lc_kwargs.content, message.content);
  });

  /** The shape the tool returns when it also updates graph state. */
  test('extends the last message of a Command', () => {
    const inner = toolMessage('ok');
    const command = { update: { messages: [toolMessage('earlier'), inner] } };

    appendToResult(command, 'block');

    assert.match(inner.content, /block/);
  });

  test('extends block-form content', () => {
    const message = { content: [{ type: 'text', text: 'ok' }] as unknown[] };

    appendToResult(message, 'block');

    assert.deepEqual(message.content, [
      { type: 'text', text: 'ok' },
      { type: 'text', text: 'block' },
    ]);
  });

  test('leaves something it does not understand alone', () => {
    assert.doesNotThrow(() => appendToResult(null, 'block'));
    assert.doesNotThrow(() => appendToResult({ content: 42 }, 'block'));
  });
});

describe('buildLspMiddleware', () => {
  test('appends the diagnostics block to an edit result', async () => {
    const { wrap } = capture(
      reportingSession('⚠ LSP (typescript): 1 error in this file:\nL1  boom'),
    );
    const message = toolMessage("Successfully wrote to '/src/a.ts'");

    const result = await wrap(request('write_file', { file_path: '/src/a.ts' }), () => message);

    assert.equal(result, message);
    assert.match(message.content, /L1 {2}boom/);
  });

  test('leaves the result alone when there is nothing to report', async () => {
    const { wrap } = capture(reportingSession(null));
    const message = toolMessage('ok');

    await wrap(request('edit_file', { file_path: '/src/a.ts' }), () => message);

    assert.equal(message.content, 'ok');
  });

  test('does not touch tools that are not edits', async () => {
    let probed = false;
    const { wrap } = capture({
      off: false,
      beforeEdit: () => {
        probed = true;
        return Promise.resolve(null);
      },
      afterEdit: () => Promise.resolve('should never appear'),
    });
    const message = toolMessage('grep output');

    await wrap(request('grep', { pattern: 'x' }), () => message);

    assert.equal(probed, false);
    assert.equal(message.content, 'grep output');
  });

  test('does nothing at all when LSP is off for the session', async () => {
    let probed = false;
    const { wrap } = capture({
      off: true,
      beforeEdit: () => {
        probed = true;
        return Promise.resolve(null);
      },
    });
    const message = toolMessage('ok');

    await wrap(request('write_file', { file_path: '/src/a.ts' }), () => message);

    assert.equal(probed, false);
    assert.equal(message.content, 'ok');
  });

  /**
   * The whole feature is best-effort: a language server that is missing, slow or
   * broken must cost the agent's edit nothing.
   */
  test('a failure before the edit still lets the edit through', async () => {
    const { wrap, logs } = capture({
      off: false,
      beforeEdit: () => Promise.reject(new Error('docker is not running')),
      afterEdit: () => Promise.resolve('never reached'),
    });
    const message = toolMessage('ok');

    const result = await wrap(request('write_file', { file_path: '/src/a.ts' }), () => message);

    assert.equal(result, message);
    assert.equal(message.content, 'ok');
    assert.match(logs.join('\n'), /docker is not running/);
  });

  test('a failure after the edit still returns the edit result', async () => {
    const { wrap, logs } = capture({
      off: false,
      beforeEdit: () =>
        Promise.resolve({ relative: 'src/a.ts', language: 'typescript', text: 'old' }),
      afterEdit: () => Promise.reject(new Error('server went away')),
    });
    const message = toolMessage('ok');

    const result = await wrap(request('write_file', { file_path: '/src/a.ts' }), () => message);

    assert.equal(result, message);
    assert.equal(message.content, 'ok');
    assert.match(logs.join('\n'), /server went away/);
  });

  test('skips reporting when the file was never prepared', async () => {
    let reported = false;
    const { wrap } = capture({
      off: false,
      beforeEdit: () => Promise.resolve(null),
      afterEdit: () => {
        reported = true;
        return Promise.resolve('block');
      },
    });

    await wrap(request('write_file', { file_path: '/README.md' }), () => toolMessage('ok'));

    assert.equal(reported, false);
  });

  test('the edit runs even when the tool call carries no path', async () => {
    const { wrap } = capture(reportingSession('block'));
    const message = toolMessage('ok');

    await wrap(request('write_file', {}), () => message);

    assert.equal(message.content, 'ok');
  });

  /** The probe has to happen before the write, or there is nothing to compare to. */
  test('probes before running the handler', async () => {
    const order: string[] = [];
    const { wrap } = capture({
      off: false,
      beforeEdit: () => {
        order.push('before');
        return Promise.resolve({ relative: 'src/a.ts', language: 'typescript', text: 'old' });
      },
      afterEdit: () => {
        order.push('after');
        return Promise.resolve(null);
      },
    });

    await wrap(request('edit_file', { file_path: '/src/a.ts' }), () => {
      order.push('handler');
      return toolMessage('ok');
    });

    assert.deepEqual(order, ['before', 'handler', 'after']);
  });
});
