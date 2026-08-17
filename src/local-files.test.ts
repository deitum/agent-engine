import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { writeLocalFiles } from './local-files';

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
