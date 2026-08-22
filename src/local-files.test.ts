import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { deleteLocalFiles, writeLocalFiles } from './local-files';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'engine-files-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('writeLocalFiles', () => {
  test('writes files and creates the folders above them', () => {
    const response = writeLocalFiles({
      dir: root,
      files: [
        { path: 'commands/deploy.md', content: '---\ndescription: Deploy\n---\n\nShip it.\n' },
        { path: 'agents/qa/reviewer.md', content: 'You are a reviewer.\n' },
      ],
    });

    assert.equal(response.dir, root);
    assert.deepEqual(response.paths, ['commands/deploy.md', 'agents/qa/reviewer.md']);
    assert.match(readFileSync(join(root, 'commands', 'deploy.md'), 'utf8'), /Ship it\./);
    assert.equal(
      readFileSync(join(root, 'agents', 'qa', 'reviewer.md'), 'utf8'),
      'You are a reviewer.\n',
    );
  });

  test('overwrites an existing file', () => {
    writeLocalFiles({ dir: root, files: [{ path: 'commands/deploy.md', content: 'old' }] });
    writeLocalFiles({ dir: root, files: [{ path: 'commands/deploy.md', content: 'new' }] });

    assert.equal(readFileSync(join(root, 'commands', 'deploy.md'), 'utf8'), 'new');
  });

  test('accepts backslashes as a separator', () => {
    writeLocalFiles({ dir: root, files: [{ path: 'commands\\deploy.md', content: 'ok' }] });

    assert.equal(readFileSync(join(root, 'commands', 'deploy.md'), 'utf8'), 'ok');
  });

  // Nothing may be written when one path is bad: a bundle that landed halfway
  // is the case the config the user pastes cannot describe.
  test('refuses a path that escapes the folder and writes nothing', () => {
    assert.throws(
      () =>
        writeLocalFiles({
          dir: root,
          files: [
            { path: 'commands/ok.md', content: 'ok' },
            { path: '../escaped.md', content: 'no' },
          ],
        }),
      /escapes the package/,
    );

    assert.equal(existsSync(join(root, 'commands', 'ok.md')), false);
  });

  test('refuses an absolute path', () => {
    assert.throws(
      () => writeLocalFiles({ dir: root, files: [{ path: '/etc/passwd', content: 'no' }] }),
      /absolute file path/,
    );
  });

  test('refuses an empty set', () => {
    assert.throws(() => writeLocalFiles({ dir: root, files: [] }), /No files were given/);
  });
});

describe('deleteLocalFiles', () => {
  test('removes what a write put there and names it back', () => {
    writeLocalFiles({
      dir: root,
      files: [
        { path: 'commands/deploy.md', content: 'ship' },
        { path: 'commands/review.md', content: 'read' },
      ],
    });

    const response = deleteLocalFiles({ dir: root, paths: ['commands/deploy.md'] });

    assert.deepEqual(response.removed, ['commands/deploy.md']);
    assert.equal(existsSync(join(root, 'commands', 'deploy.md')), false);
    // Only what was named: the neighbour is the user's, not ours to tidy.
    assert.equal(existsSync(join(root, 'commands', 'review.md')), true);
  });

  // An uninstall that gives up because the user already tidied one file by hand
  // leaves the rest behind, which is the outcome nobody asked for.
  test('a path that is already gone is not an error', () => {
    writeLocalFiles({ dir: root, files: [{ path: 'commands/deploy.md', content: 'ship' }] });

    const response = deleteLocalFiles({
      dir: root,
      paths: ['commands/deploy.md', 'commands/never-was.md'],
    });

    assert.deepEqual(response.removed, ['commands/deploy.md']);
  });

  test('leaves the emptied folder alone', () => {
    writeLocalFiles({ dir: root, files: [{ path: 'commands/deploy.md', content: 'ship' }] });
    deleteLocalFiles({ dir: root, paths: ['commands/deploy.md'] });

    assert.equal(existsSync(join(root, 'commands')), true);
  });

  test('refuses a folder', () => {
    writeLocalFiles({ dir: root, files: [{ path: 'commands/deploy.md', content: 'ship' }] });

    assert.throws(() => deleteLocalFiles({ dir: root, paths: ['commands'] }), /not a file/);
  });

  // Validated before anything is removed — a delete has no half-way back.
  test('refuses a path that escapes the folder and removes nothing', () => {
    writeLocalFiles({ dir: root, files: [{ path: 'commands/deploy.md', content: 'ship' }] });

    assert.throws(
      () => deleteLocalFiles({ dir: root, paths: ['commands/deploy.md', '../escaped.md'] }),
      /escapes the package/,
    );

    assert.equal(existsSync(join(root, 'commands', 'deploy.md')), true);
  });

  test('refuses an absolute path', () => {
    assert.throws(
      () => deleteLocalFiles({ dir: root, paths: ['/etc/passwd'] }),
      /absolute file path/,
    );
  });

  test('refuses an empty set', () => {
    assert.throws(() => deleteLocalFiles({ dir: root, paths: [] }), /No paths were given/);
  });
});
