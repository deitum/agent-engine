import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { ConnectorError } from '../connector';

import { StateDb } from './state-db';

let root: string;
let db: StateDb;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'engine-state-db-test-'));
  db = new StateDb(join(root, 'nested', 'state.db'));
});
after(async () => {
  await db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('records', () => {
  test('round-trips a record whole, nested values included', async () => {
    await db.put('chats', [
      { id: 'c1', title: 'Hello', tags: ['a', 'b'], meta: { pinned: true, count: 3 } },
    ]);

    assert.deepEqual(await db.getAll('chats'), [
      { id: 'c1', title: 'Hello', tags: ['a', 'b'], meta: { pinned: true, count: 3 } },
    ]);
  });

  test('a second put with the same id replaces the row', async () => {
    await db.put('projects', [{ id: 'p1', name: 'first' }]);
    await db.put('projects', [{ id: 'p1', name: 'second' }]);

    assert.deepEqual(await db.getAll('projects'), [{ id: 'p1', name: 'second' }]);
  });

  test('collections do not see each other', async () => {
    await db.put('skills', [{ id: 'shared', kind: 'skill' }]);
    await db.put('plugins', [{ id: 'shared', kind: 'plugin' }]);

    assert.deepEqual(await db.getAll('skills'), [{ id: 'shared', kind: 'skill' }]);
    assert.deepEqual(await db.getAll('plugins'), [{ id: 'shared', kind: 'plugin' }]);
  });

  test('delete removes only the named ids, clear empties the collection', async () => {
    await db.put('messages', [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }]);

    await db.delete('messages', ['m2']);
    assert.deepEqual(
      (await db.getAll('messages')).map((row) => (row as { id: string }).id).sort(),
      ['m1', 'm3'],
    );

    await db.clear('messages');
    assert.deepEqual(await db.getAll('messages'), []);
    // Clearing one collection is not clearing the database.
    assert.deepEqual(await db.getAll('projects'), [{ id: 'p1', name: 'second' }]);
  });

  test('an unknown collection reads as empty rather than failing', async () => {
    assert.deepEqual(await db.getAll('never-written'), []);
  });

  test('empty batches are a no-op', async () => {
    await db.put('chats', []);
    await db.delete('chats', []);

    assert.equal((await db.getAll('chats')).length, 1);
  });

  /**
   * The whole point of the check: a row written under anything but its own id
   * could never be deleted, would survive its collection's `clear`, and would
   * come back on the next hydration as an entity the app cannot explain.
   */
  test('a record without a string id is refused, and nothing in the batch lands', async () => {
    await assert.rejects(
      () => db.put('artifacts', [{ id: 'a1' }, { title: 'no id' }]),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.status === 400 &&
        /records\[1\]/.test(error.message),
    );
    await assert.rejects(() => db.put('artifacts', ['not an object']), ConnectorError);

    assert.deepEqual(await db.getAll('artifacts'), []);
  });
});

describe('documents', () => {
  test('an unwritten document reads as null', async () => {
    assert.equal(await db.getDocument('settings'), null);
  });

  test('round-trips, replaces and removes', async () => {
    await db.setDocument('settings', { token: 'secret', model: 'gpt' });
    assert.deepEqual(await db.getDocument('settings'), { token: 'secret', model: 'gpt' });

    await db.setDocument('settings', { token: 'other', model: 'gpt' });
    assert.deepEqual(await db.getDocument('settings'), { token: 'other', model: 'gpt' });

    await db.removeDocument('settings');
    assert.equal(await db.getDocument('settings'), null);
  });

  test('holds keys the port uses verbatim, including the meta prefix', async () => {
    await db.setDocument('meta:data-version', 1);
    assert.equal(await db.getDocument('meta:data-version'), 1);
  });
});

describe('the file', () => {
  test('is created lazily, under the daemon home, readable only by its owner', () => {
    const mode = statSync(db.path).mode & 0o777;
    // Windows does not carry POSIX permission bits; the check is about the
    // machines where a second account could read the user's tokens.
    if (process.platform !== 'win32') {
      assert.equal(mode, 0o600);
    }
  });

  test('survives a reopen — this is the whole reason it is a file', async () => {
    await db.setDocument('bitbucket', { baseUrl: 'https://git.example' });
    await db.put('artifacts', [{ id: 'd1', name: 'form' }]);
    await db.close();

    const reopened = new StateDb(db.path);
    try {
      assert.deepEqual(await reopened.getDocument('bitbucket'), {
        baseUrl: 'https://git.example',
      });
      assert.deepEqual(await reopened.getAll('artifacts'), [{ id: 'd1', name: 'form' }]);
    } finally {
      await reopened.close();
    }
  });

  test('closing a database that was never opened is safe', async () => {
    await new StateDb(join(root, 'untouched.db')).close();
  });
});
