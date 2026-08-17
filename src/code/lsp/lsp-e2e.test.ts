import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { dockerExec } from '../docker-backend';

import { toLocations } from './lsp-format';
import { LspSession } from './lsp-session';

/**
 * The one test that proves the whole wire end to end: a **real**
 * `typescript-language-server`, started by `docker exec -i` inside a real
 * container, answering about a real file on a real bind mount.
 *
 * Everything else in this directory runs against fakes, which is right — they
 * test our decisions, and they run in milliseconds. But fakes cannot catch the
 * failures that actually bite here: a `Content-Length` we count wrongly, a URI we
 * spell differently from the server, a document version it declines to echo, a
 * launch command whose glob matches nothing. Those only appear against the real
 * thing.
 *
 * **Skipped unless `AGENT_ENGINE_LSP_E2E=1`.** It needs Docker, pulls an image and reaches
 * npm, so CI stays free of all three; run it by hand when touching the protocol
 * or the launch recipes:
 *
 * ```sh
 * AGENT_ENGINE_LSP_E2E=1 npm run test --workspace @deitum/agent-engine
 * ```
 */

const ENABLED = process.env.AGENT_ENGINE_LSP_E2E === '1';
const IMAGE = 'node:22-bookworm';
const CONTAINER = 'engine-lsp-e2e';

/** A tiny project with one deliberate type error. */
const BROKEN = [
  'export const greet = (name: string): string => name;',
  'export const n: number = greet("x");',
  '',
].join('\n');
const FIXED = [
  'export const greet = (name: string): string => name;',
  'export const n: string = greet("x");',
  '',
].join('\n');

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', timeout: 15 * 60_000 });
}

describe('LSP against a real language server', { skip: !ENABLED }, () => {
  let dir = '';
  let session: LspSession | null = null;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'engine-lsp-e2e-'));
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }),
      'utf8',
    );
    writeFileSync(join(dir, 'index.ts'), BROKEN, 'utf8');

    docker(['rm', '-f', CONTAINER]);
    docker(['pull', IMAGE]);
    docker([
      'run',
      '-d',
      '--name',
      CONTAINER,
      '-v',
      `${dir}:/workspace`,
      '-w',
      '/workspace',
      IMAGE,
      'sleep',
      'infinity',
    ]);

    session = new LspSession({
      sessionId: 'e2e',
      dir,
      containerName: CONTAINER,
      config: {},
      exec: (command, timeoutSec) => dockerExec(CONTAINER, command, { timeoutSec }),
    });
  });

  after(() => {
    session?.dispose();
    docker(['rm', '-f', CONTAINER]);
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('installs the server, opens the file and reports the real type error', async () => {
    const prepared = await session!.syncDocument('/index.ts');

    assert.ok(prepared, 'the server must start and take the document');
    assert.equal(prepared.uri, 'file:///workspace/index.ts');

    const diagnostics = await prepared.client.waitForDiagnostics(
      prepared.uri,
      prepared.version,
      // Generous: this is the first analysis of a cold project.
      30_000,
    );
    assert.ok(diagnostics, 'tsserver must publish diagnostics for the version we sent');
    assert.ok(
      diagnostics.some((item) => /not assignable/i.test(item.message)),
      `expected an assignability error, got: ${JSON.stringify(diagnostics)}`,
    );
  });

  test('an edit that fixes the file is reported as cleared', async () => {
    const probe = await session!.beforeEdit('/index.ts');
    assert.ok(probe);

    writeFileSync(join(dir, 'index.ts'), FIXED, 'utf8');
    const block = await session!.afterEdit(probe);

    assert.match(block ?? '', /no errors left in this file/);
  });

  test('find_definition resolves a symbol to its declaration', async () => {
    const prepared = await session!.syncDocument('/index.ts');
    assert.ok(prepared);

    const result = await prepared.client.request<unknown>('textDocument/definition', {
      textDocument: { uri: prepared.uri },
      // `greet` on the second line, where it is used.
      position: { line: 1, character: 27 },
    });

    const locations = toLocations(result);
    assert.equal(locations.length, 1);
    assert.equal(locations[0].uri, 'file:///workspace/index.ts');
    assert.equal(locations[0].range.start.line, 0, 'the declaration is on the first line');
  });
});
