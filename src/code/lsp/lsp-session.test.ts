import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, test } from 'node:test';

import { type ExecuteResponse } from '../docker-backend';

import { encodeMessage, type JsonRpcMessage, type LspTransport, MessageReader } from './jsonrpc';
import { LspSession } from './lsp-session';
import { type LspDiagnostic, LSP_SEVERITY } from './lsp.types';

/** A checkout on disk, cleaned up by the test that made it. */
function checkout(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'engine-lsp-'));
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
  return dir;
}

/**
 * A language server that answers `initialize` and publishes whatever the test
 * queues for a document version. Stands in for the process `docker exec -i`
 * would start.
 */
function fakeServer(): {
  transport: LspTransport;
  received: JsonRpcMessage[];
  /** Publishes diagnostics for a URI at a version. */
  publish: (uri: string, version: number, items: LspDiagnostic[]) => void;
  /** Answers the next `didOpen`/`didChange` for any URI automatically. */
  autoPublish: (items: (version: number) => LspDiagnostic[]) => void;
  die: () => void;
  spawns: number;
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const received: JsonRpcMessage[] = [];
  const reader = new MessageReader();
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let auto: ((version: number) => LspDiagnostic[]) | null = null;

  const send = (message: JsonRpcMessage): void => {
    stdout.write(encodeMessage(message));
  };
  const publish = (uri: string, version: number, items: LspDiagnostic[]): void => {
    send({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri, version, diagnostics: items },
    });
  };

  stdin.on('data', (chunk: Buffer) => {
    for (const message of reader.push(chunk)) {
      received.push(message);
      if (message.method === 'initialize') {
        send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } });
      }
      if (
        auto &&
        (message.method === 'textDocument/didOpen' || message.method === 'textDocument/didChange')
      ) {
        const document = (message.params as { textDocument: { uri: string; version: number } })
          .textDocument;
        publish(document.uri, document.version, auto(document.version));
      }
    }
  });

  return {
    transport: { stdin, stdout, kill: () => resolveClosed(), closed },
    received,
    publish,
    autoPublish: (items) => {
      auto = items;
    },
    die: () => resolveClosed(),
    spawns: 0,
  };
}

/** An `exec` that reports a healthy runtime and an already-installed server. */
const installedExec = (command: string): Promise<ExecuteResponse> =>
  Promise.resolve({
    output: command.includes('node') ? 'v22.0.0' : 'Python 3.12.0',
    exitCode: 0,
    truncated: false,
  });

function error(message: string, line: number): LspDiagnostic {
  return {
    message,
    severity: LSP_SEVERITY.error,
    range: { start: { line, character: 0 }, end: { line, character: 4 } },
  };
}

/** A session wired to a single fake server. */
function session(
  dir: string,
  overrides: Partial<{
    exec: (command: string) => Promise<ExecuteResponse>;
    servers: ReturnType<typeof fakeServer>[];
  }> = {},
): { session: LspSession; servers: ReturnType<typeof fakeServer>[]; spawned: string[] } {
  const servers = overrides.servers ?? [fakeServer()];
  const spawned: string[] = [];
  let index = 0;
  const instance = new LspSession({
    sessionId: 'test-session',
    dir,
    containerName: 'agent-engine-code-test',
    config: {},
    exec: overrides.exec ?? installedExec,
    spawn: (command) => {
      spawned.push(command);
      const server = servers[Math.min(index, servers.length - 1)];
      index += 1;
      return server.transport;
    },
  });
  return { session: instance, servers, spawned };
}

describe('LspSession.syncDocument', () => {
  test('starts a server and opens the file with its current content', async () => {
    const dir = checkout({ 'src/index.ts': 'export const a = 1;\n' });
    try {
      const { session: instance, servers } = session(dir);

      const prepared = await instance.syncDocument('/src/index.ts');

      assert.equal(prepared?.language, 'typescript');
      assert.equal(prepared?.uri, 'file:///workspace/src/index.ts');
      assert.equal(prepared?.version, 1);
      const open = servers[0].received.find((m) => m.method === 'textDocument/didOpen');
      const document = (open?.params as { textDocument: { text: string; languageId: string } })
        .textDocument;
      assert.equal(document.text, 'export const a = 1;\n');
      assert.equal(document.languageId, 'typescript');
      instance.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('starts nothing for a file no server owns', async () => {
    const dir = checkout({ 'README.md': '# hi' });
    try {
      const { session: instance, spawned } = session(dir);

      assert.equal(await instance.syncDocument('/README.md'), null);
      assert.deepEqual(spawned, []);
      instance.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('starts nothing for a path that escapes the checkout', async () => {
    const dir = checkout({ 'src/a.ts': 'x' });
    try {
      const { session: instance, spawned } = session(dir);

      assert.equal(await instance.syncDocument('../../../etc/passwd.ts'), null);
      assert.deepEqual(spawned, []);
      instance.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('starts one server for many files of the same language', async () => {
    const dir = checkout({ 'a.ts': 'x', 'b.ts': 'y', 'c.tsx': 'z' });
    try {
      const { session: instance, spawned } = session(dir);

      await Promise.all([
        instance.syncDocument('/a.ts'),
        instance.syncDocument('/b.ts'),
        instance.syncDocument('/c.tsx'),
      ]);

      assert.equal(spawned.length, 1);
      instance.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('respects a config that disables the language', async () => {
    const dir = checkout({ 'src/a.ts': 'x' });
    try {
      const instance = new LspSession({
        sessionId: 's',
        dir,
        containerName: 'c',
        config: { servers: ['java'] },
        exec: installedExec,
        spawn: () => fakeServer().transport,
      });

      assert.equal(await instance.syncDocument('/src/a.ts'), null);
      instance.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an unavailable runtime is reported once and not retried', async () => {
    const dir = checkout({ 'src/a.ts': 'x' });
    try {
      let probes = 0;
      const { session: instance } = session(dir, {
        exec: (command) => {
          if (command.includes('command -v')) {
            probes += 1;
            return Promise.resolve({ output: '', exitCode: 127, truncated: false });
          }
          return Promise.resolve({ output: '', exitCode: 0, truncated: false });
        },
      });

      assert.equal(await instance.syncDocument('/src/a.ts'), null);
      assert.equal(await instance.syncDocument('/src/a.ts'), null);

      assert.equal(probes, 1);
      const status = instance.status().find((entry) => entry.language === 'typescript');
      assert.equal(status?.state, 'unavailable');
      assert.match(status?.detail ?? '', /no Node\.js/);
      instance.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('LspSession edit reporting', () => {
  test('reports what an edit broke', async () => {
    const dir = checkout({ 'src/a.ts': 'const a: number = 1;\n' });
    try {
      const { session: instance, servers } = session(dir);
      servers[0].autoPublish((version) =>
        version === 1 ? [] : [error("Type 'string' is not assignable to type 'number'.", 0)],
      );

      const probe = await instance.beforeEdit('/src/a.ts');
      writeFileSync(join(dir, 'src/a.ts'), 'const a: number = "x";\n', 'utf8');
      const block = await instance.afterEdit(probe!);

      assert.match(block ?? '', /⚠ LSP \(typescript\): 1 error/);
      assert.match(block ?? '', /not assignable/);
      instance.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * The pre-existing-breakage case: without a baseline taken before the edit, a
   * repository that already did not compile would blame the agent for it.
   */
  test('does not blame the agent for errors that were already there', async () => {
    const dir = checkout({ 'src/a.ts': 'broken\n' });
    try {
      const { session: instance, servers } = session(dir);
      servers[0].autoPublish(() => [error('pre-existing failure', 0)]);

      const probe = await instance.beforeEdit('/src/a.ts');
      writeFileSync(join(dir, 'src/a.ts'), 'broken but different\n', 'utf8');
      const block = await instance.afterEdit(probe!);

      assert.equal(block, 'LSP (typescript): 1 error in this file, it is not from this edit.');
      instance.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('confirms when an edit cleared the file', async () => {
    const dir = checkout({ 'src/a.ts': 'broken\n' });
    try {
      const { session: instance, servers } = session(dir);
      servers[0].autoPublish((version) => (version === 1 ? [error('was broken', 0)] : []));

      const probe = await instance.beforeEdit('/src/a.ts');
      writeFileSync(join(dir, 'src/a.ts'), 'fixed\n', 'utf8');

      assert.equal(
        await instance.afterEdit(probe!),
        '✓ LSP (typescript): no errors left in this file.',
      );
      instance.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A plan-mode refusal and a failed match both leave the file untouched. */
  test('says nothing when the file did not actually change', async () => {
    const dir = checkout({ 'src/a.ts': 'unchanged\n' });
    try {
      const { session: instance, servers } = session(dir);
      servers[0].autoPublish(() => [error('some error', 0)]);

      const probe = await instance.beforeEdit('/src/a.ts');

      assert.equal(await instance.afterEdit(probe!), null);
      instance.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('stays silent when the server answers nothing in time', async () => {
    const dir = checkout({ 'src/a.ts': 'x\n' });
    try {
      const { session: instance } = session(dir);
      // No autoPublish: the server never says anything.

      const probe = await instance.beforeEdit('/src/a.ts');
      writeFileSync(join(dir, 'src/a.ts'), 'y\n', 'utf8');

      assert.equal(await instance.afterEdit(probe!), null);
      instance.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the second edit compares against the first, not against the original', async () => {
    const dir = checkout({ 'src/a.ts': 'v1\n' });
    try {
      const { session: instance, servers } = session(dir);
      servers[0].autoPublish((version) =>
        version >= 2 ? [error('introduced in edit one', 0)] : [],
      );

      const first = await instance.beforeEdit('/src/a.ts');
      writeFileSync(join(dir, 'src/a.ts'), 'v2\n', 'utf8');
      await instance.afterEdit(first!);

      const second = await instance.beforeEdit('/src/a.ts');
      writeFileSync(join(dir, 'src/a.ts'), 'v3\n', 'utf8');
      const block = await instance.afterEdit(second!);

      // The error is still there but it is not news; it belonged to the previous edit.
      assert.match(block ?? '', /not from this edit/);
      instance.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Uses each server in turn and kills it, so every death happens to a server the
 * session had actually spawned — killing one before it is handed out would test
 * a spawn that returns an already-dead transport instead.
 */
async function killAfterUse(
  instance: LspSession,
  servers: ReturnType<typeof fakeServer>[],
): Promise<void> {
  for (const server of servers) {
    await instance.syncDocument('/src/a.ts');
    server.die();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('LspSession lifecycle', () => {
  test('restarts a server that died, once', async () => {
    const dir = checkout({ 'src/a.ts': 'x' });
    try {
      const first = fakeServer();
      const second = fakeServer();
      const { session: instance, spawned } = session(dir, { servers: [first, second] });

      await instance.syncDocument('/src/a.ts');
      first.die();
      await new Promise((resolve) => setImmediate(resolve));

      assert.ok(await instance.syncDocument('/src/a.ts'));
      assert.equal(spawned.length, 2);
      instance.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A server that dies twice is broken; retrying forever makes every edit slow. */
  test('gives up on a server that keeps dying', async () => {
    const dir = checkout({ 'src/a.ts': 'x' });
    try {
      const servers = [fakeServer(), fakeServer()];
      const { session: instance, spawned } = session(dir, { servers });

      await killAfterUse(instance, servers);

      assert.equal(await instance.syncDocument('/src/a.ts'), null);
      assert.equal(spawned.length, 2);
      const status = instance.status().find((entry) => entry.language === 'typescript');
      assert.equal(status?.state, 'unavailable');
      assert.match(status?.detail ?? '', /crashed several times/);
      instance.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('restart() brings a written-off language back', async () => {
    const dir = checkout({ 'src/a.ts': 'x' });
    try {
      const doomed = [fakeServer(), fakeServer()];
      const healthy = fakeServer();
      const { session: instance } = session(dir, { servers: [...doomed, healthy] });

      await killAfterUse(instance, doomed);
      assert.equal(await instance.syncDocument('/src/a.ts'), null);

      instance.restart();

      assert.ok(await instance.syncDocument('/src/a.ts'));
      instance.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('dispose stops every server and refuses further work', async () => {
    const dir = checkout({ 'src/a.ts': 'x' });
    try {
      const { session: instance } = session(dir);
      await instance.syncDocument('/src/a.ts');

      instance.dispose();

      assert.equal(await instance.syncDocument('/src/a.ts'), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reports «off» for a language that has not been touched', async () => {
    const dir = checkout({ 'src/a.ts': 'x' });
    try {
      const { session: instance } = session(dir);

      assert.deepEqual(instance.status(), []);

      await instance.syncDocument('/src/a.ts');
      assert.deepEqual(instance.status(), [{ language: 'typescript', state: 'ready' }]);
      instance.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('warm() starts a language before any file is touched', async () => {
    const dir = checkout({ 'src/a.ts': 'x' });
    try {
      const { session: instance, spawned } = session(dir);

      const status = await instance.warm('typescript');

      assert.equal(status.state, 'ready');
      assert.equal(spawned.length, 1);
      instance.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('off is true when the config disables everything', () => {
    const instance = new LspSession({
      sessionId: 's',
      dir: '/tmp',
      containerName: 'c',
      config: { enabled: false },
      exec: installedExec,
    });

    assert.equal(instance.off, true);
    instance.dispose();
  });
});
