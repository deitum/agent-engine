import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import {
  patchIntegrationConfig,
  readIntegrationConfig,
  writeIntegrationConfig,
} from './integration-config';

/**
 * These routes edit files this app does not own. The tests that matter here are
 * therefore not «did the key land» but «what happened to everything else in the
 * file» — a user's comments, their formatting, and the 4000 lines of project
 * history that `~/.claude.json` also holds.
 */

/**
 * Backdates a file, so that the write which follows is unmistakably newer.
 *
 * Two writes a few microseconds apart can share an mtime: NTFS records it far
 * more coarsely than ext4 or APFS, so on Windows the guard sees an unchanged
 * timestamp and the test reads as «the mtime check is broken» when it is the
 * clock that is imprecise.
 */
function backdate(path: string): void {
  const earlier = new Date(Date.now() - 10_000);
  utimesSync(path, earlier, earlier);
}

let root: string;
const configPath = () => join(root, 'kilo.jsonc');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'engine-integration-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('readIntegrationConfig', () => {
  test('returns the file verbatim along with its mtime', () => {
    writeFileSync(configPath(), '{\n  "mcp": {}\n}\n');

    const response = readIntegrationConfig({ path: configPath() });

    assert.equal(response.exists, true);
    assert.equal(response.content, '{\n  "mcp": {}\n}\n');
    assert.ok(response.mtimeMs > 0);
  });

  // Not an error: the screen has to be able to show «this file does not exist yet» and
  // offer to create it.
  test('answers a missing file with emptiness rather than an error', () => {
    const response = readIntegrationConfig({ path: join(root, 'missing.json') });

    assert.equal(response.exists, false);
    assert.equal(response.content, '');
    assert.equal(response.mtimeMs, 0);
  });
});

describe('writeIntegrationConfig', () => {
  test('replaces the file and leaves a copy of the previous one beside it', () => {
    writeFileSync(configPath(), 'old\n');

    const response = writeIntegrationConfig({ path: configPath(), content: 'new\n' });

    assert.equal(readFileSync(configPath(), 'utf8'), 'new\n');
    assert.ok(response.backupPath);
    assert.equal(readFileSync(response.backupPath, 'utf8'), 'old\n');
  });

  test('creates the file along with the folders above it, so there is nothing to back up', () => {
    const nested = join(root, 'a', 'b', 'opencode.json');

    const response = writeIntegrationConfig({ path: nested, content: '{}\n' });

    assert.equal(readFileSync(nested, 'utf8'), '{}\n');
    assert.equal(response.backupPath, null);
  });

  // The competing writer is the user's own editor, or `claude mcp add`. Both are
  // likely during exactly the task this screen is for.
  test('refuses to overwrite a file that changed after it was read', () => {
    writeFileSync(configPath(), 'first one\n');
    backdate(configPath());
    const read = readIntegrationConfig({ path: configPath() });
    writeFileSync(configPath(), 'somebody else\n');

    assert.throws(
      () =>
        writeIntegrationConfig({
          path: configPath(),
          content: 'mine\n',
          expectedMtimeMs: read.mtimeMs,
        }),
      /changed on disk/,
    );
    assert.equal(readFileSync(configPath(), 'utf8'), 'somebody else\n');
  });

  test('writes unconditionally without expectedMtimeMs', () => {
    writeFileSync(configPath(), 'first one\n');

    writeIntegrationConfig({ path: configPath(), content: 'mine\n' });

    assert.equal(readFileSync(configPath(), 'utf8'), 'mine\n');
  });
});

describe('patchIntegrationConfig', () => {
  // The reason this route exists at all.
  test('adds a server without touching the comments or the rest of the file', () => {
    writeFileSync(
      configPath(),
      [
        '{',
        '  // my favourite provider',
        '  "model": "acme/gpt-5",',
        '  "mcp": {',
        '    "jira": { "type": "local", "command": ["npx", "jira-mcp"] }',
        '  }',
        '}',
        '',
      ].join('\n'),
    );

    patchIntegrationConfig({
      path: configPath(),
      edits: [
        {
          keyPath: ['mcp', 'camunda'],
          value: { type: 'local', command: ['npx', '@deitum/camunda-mcp'] },
        },
      ],
    });

    const written = readFileSync(configPath(), 'utf8');
    assert.match(written, /\/\/ my favourite provider/);
    assert.match(written, /"model": "acme\/gpt-5"/);
    assert.match(written, /"jira"/);
    assert.match(written, /"camunda"/);
    assert.match(written, /@deitum\/camunda-mcp/);
  });

  test('deletes the key when the value is null', () => {
    writeFileSync(
      configPath(),
      '{\n  "mcp": {\n    "jira": { "type": "local" },\n    "camunda": { "type": "local" }\n  }\n}\n',
    );

    patchIntegrationConfig({
      path: configPath(),
      edits: [{ keyPath: ['mcp', 'jira'], value: null }],
    });

    const written = readFileSync(configPath(), 'utf8');
    assert.equal(written.includes('"jira"'), false);
    assert.match(written, /"camunda"/);
  });

  test('creates the missing objects along the key path', () => {
    writeFileSync(configPath(), '{}\n');

    patchIntegrationConfig({
      path: configPath(),
      edits: [{ keyPath: ['mcp', 'jira'], value: { type: 'local' } }],
    });

    assert.deepEqual(JSON.parse(readFileSync(configPath(), 'utf8')), {
      mcp: { jira: { type: 'local' } },
    });
  });

  test('creates the file from scratch when there is none', () => {
    const fresh = join(root, 'new', 'opencode.json');

    patchIntegrationConfig({
      path: fresh,
      edits: [{ keyPath: ['mcp', 'jira'], value: { type: 'local' } }],
    });

    assert.deepEqual(JSON.parse(readFileSync(fresh, 'utf8')), { mcp: { jira: { type: 'local' } } });
  });

  test('applies edits in order — a removal and an addition in one request', () => {
    writeFileSync(configPath(), '{\n  "mcp": {\n    "old": { "type": "local" }\n  }\n}\n');

    patchIntegrationConfig({
      path: configPath(),
      edits: [
        { keyPath: ['mcp', 'old'], value: null },
        { keyPath: ['mcp', 'new'], value: { type: 'local' } },
      ],
    });

    assert.deepEqual(JSON.parse(readFileSync(configPath(), 'utf8')), {
      mcp: { new: { type: 'local' } },
    });
  });

  // Editing a broken document produces a differently broken one, and the user
  // would have no way to tell which of the two breakages was theirs.
  test('refuses to edit a file it cannot parse', () => {
    writeFileSync(configPath(), '{ "mcp": { ');

    assert.throws(
      () =>
        patchIntegrationConfig({
          path: configPath(),
          edits: [{ keyPath: ['mcp', 'jira'], value: {} }],
        }),
      /not valid JSON/,
    );
  });

  test('tolerates a trailing comma — .jsonc allows it', () => {
    writeFileSync(configPath(), '{\n  "mcp": {\n    "jira": { "type": "local" },\n  },\n}\n');

    patchIntegrationConfig({
      path: configPath(),
      edits: [{ keyPath: ['model'], value: 'acme/gpt-5' }],
    });

    assert.match(readFileSync(configPath(), 'utf8'), /"model": "acme\/gpt-5"/);
  });

  test('also leaves a copy of the previous file beside it', () => {
    writeFileSync(configPath(), '{\n  "mcp": {}\n}\n');

    const response = patchIntegrationConfig({
      path: configPath(),
      edits: [{ keyPath: ['mcp', 'jira'], value: {} }],
    });

    assert.ok(response.backupPath);
    assert.equal(existsSync(response.backupPath), true);
    assert.match(readFileSync(response.backupPath, 'utf8'), /"mcp": \{\}/);
  });

  test('checks the mtime the same way a full write does', () => {
    writeFileSync(configPath(), '{}\n');
    backdate(configPath());
    const read = readIntegrationConfig({ path: configPath() });
    writeFileSync(configPath(), '{ "mcp": {} }\n');

    assert.throws(
      () =>
        patchIntegrationConfig({
          path: configPath(),
          edits: [{ keyPath: ['mcp', 'jira'], value: {} }],
          expectedMtimeMs: read.mtimeMs,
        }),
      /changed on disk/,
    );
  });

  test('refuses an empty key path', () => {
    writeFileSync(configPath(), '{}\n');

    assert.throws(
      () => patchIntegrationConfig({ path: configPath(), edits: [{ keyPath: [], value: 1 }] }),
      /at least one key/,
    );
  });
});
