import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';

import { ConnectorError } from '../connector';

import {
  SQLITE_UNAVAILABLE,
  STATE_DB_MODE,
  STATE_DB_SCHEMA,
  stateDbPath,
} from './storage.constants';

/** A stored record as the daemon requires it: opaque, except for its key. */
interface IdentifiedRecord {
  id: string;
  [key: string]: unknown;
}

/**
 * The client database, kept as a SQLite file on the user's own machine — the
 * daemon's half of the `StorageClient` port the web app persists through
 * (`apps/web/src/shared/lib/storage`).
 *
 * Deliberately dumb: a collection is a string, a record is JSON with an `id`,
 * and nothing here knows what a chat or a project is. See
 * {@link STATE_DB_SCHEMA} for why that shape was chosen over per-entity tables.
 *
 * `node:sqlite` is imported dynamically so that a Node without it (it arrived in
 * 22.5) degrades to a clean 501 instead of a crashed daemon. The **file** is
 * created on first use rather than at startup: a daemon nobody points at leaves
 * no database behind, and an empty one sitting in the user's home would be a
 * puzzle rather than a feature.
 */
export class StateDb {
  readonly path: string;

  #db: DatabaseSync | null = null;
  #opening: Promise<DatabaseSync> | null = null;
  #closing: Promise<void> | null = null;
  #statements = new Map<string, StatementSync>();

  constructor(path: string = stateDbPath()) {
    this.path = path;
  }

  /**
   * Whether this Node can host the store at all. Probes the module without
   * touching the disk, so `GET /ping` can answer honestly before any data
   * exists — the UI has to know *before* the user moves their storage here,
   * not when the first write fails.
   */
  static async isSupported(): Promise<boolean> {
    try {
      await import('node:sqlite');
      return true;
    } catch {
      return false;
    }
  }

  async getAll(collection: string): Promise<unknown[]> {
    const db = await this.#connect();
    const rows = this.#statement(
      db,
      'select-all',
      'SELECT data FROM records WHERE collection = ?',
    ).all(collection) as { data: string }[];
    return rows.map((row) => JSON.parse(row.data) as unknown);
  }

  /**
   * Writes records, replacing same-`id` rows. One transaction per call, so a
   * batch of dirty records from a single turn lands whole or not at all — the
   * promise `bulkPut` makes on the browser side.
   */
  async put(collection: string, records: readonly unknown[]): Promise<void> {
    const rows = records.map((record, index) => asIdentified(record, index));
    if (rows.length === 0) {
      return;
    }
    const db = await this.#connect();
    const statement = this.#statement(
      db,
      'put',
      'INSERT INTO records (collection, id, data) VALUES (?, ?, ?) ' +
        'ON CONFLICT (collection, id) DO UPDATE SET data = excluded.data',
    );
    this.#transaction(db, () => {
      for (const row of rows) {
        statement.run(collection, row.id, JSON.stringify(row));
      }
    });
  }

  async delete(collection: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    const db = await this.#connect();
    const statement = this.#statement(
      db,
      'delete',
      'DELETE FROM records WHERE collection = ? AND id = ?',
    );
    this.#transaction(db, () => {
      for (const id of ids) {
        statement.run(collection, id);
      }
    });
  }

  async clear(collection: string): Promise<void> {
    const db = await this.#connect();
    this.#statement(db, 'clear', 'DELETE FROM records WHERE collection = ?').run(collection);
  }

  /** `null` for a document that was never written — the port's "absent". */
  async getDocument(key: string): Promise<unknown> {
    const db = await this.#connect();
    const row = this.#statement(db, 'doc-get', 'SELECT value FROM documents WHERE key = ?').get(
      key,
    ) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as unknown) : null;
  }

  async setDocument(key: string, value: unknown): Promise<void> {
    const db = await this.#connect();
    this.#statement(
      db,
      'doc-set',
      'INSERT INTO documents (key, value) VALUES (?, ?) ' +
        'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      // `undefined` has no JSON form, and a document with no value is a document
      // that should have been removed instead of written.
    ).run(key, JSON.stringify(value ?? null));
  }

  async removeDocument(key: string): Promise<void> {
    const db = await this.#connect();
    this.#statement(db, 'doc-remove', 'DELETE FROM documents WHERE key = ?').run(key);
  }

  /**
   * Releases the file handle. Safe on a database that was never opened, and
   * memoised because two shutdown paths reach it concurrently — the server's
   * `close` handler and whoever called `shutdownConnector` — and `DatabaseSync`
   * throws on a second `close()`.
   */
  close(): Promise<void> {
    this.#closing ??= (async () => {
      const opening = this.#opening;
      this.#opening = null;
      const db = opening ? await opening.catch(() => null) : this.#db;
      this.#statements.clear();
      this.#db = null;
      db?.close();
    })();
    return this.#closing;
  }

  /**
   * Opens the file on first use, memoised — including the failure, so a daemon
   * on a Node without `node:sqlite` answers the second request as fast as the
   * first instead of retrying the import every time.
   */
  #connect(): Promise<DatabaseSync> {
    if (this.#closing) {
      throw new ConnectorError(503, 'The connector is shutting down');
    }
    this.#opening ??= this.#openFile();
    return this.#opening;
  }

  async #openFile(): Promise<DatabaseSync> {
    let module: typeof import('node:sqlite');
    try {
      module = await import('node:sqlite');
    } catch {
      throw new ConnectorError(501, SQLITE_UNAVAILABLE);
    }

    mkdirSync(dirname(this.path), { recursive: true });
    const db = new module.DatabaseSync(this.path);
    // WAL so a read while a turn is streaming its messages in does not block,
    // and `NORMAL` because losing the last few writes to a power cut is a far
    // smaller loss than an fsync per streamed chunk.
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec(STATE_DB_SCHEMA);
    // After creation, not before: the file does not exist until `DatabaseSync`
    // makes it, and it holds every secret the user has entered.
    chmodSync(this.path, STATE_DB_MODE);

    this.#db = db;
    return db;
  }

  /** Prepared statements are reused; preparing one per write dominated the cost. */
  #statement(db: DatabaseSync, key: string, sql: string): StatementSync {
    const cached = this.#statements.get(key);
    if (cached) {
      return cached;
    }
    const statement = db.prepare(sql);
    this.#statements.set(key, statement);
    return statement;
  }

  #transaction(db: DatabaseSync, work: () => void): void {
    db.exec('BEGIN');
    try {
      work();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

/**
 * Rejects a record the store could never address again.
 *
 * Loudly, because the alternative is worse than a failed request: a row written
 * under a generated key is invisible to `delete`, survives every `clear` its
 * collection gets, and comes back on the next hydration as an entity the app
 * cannot explain.
 */
function asIdentified(record: unknown, index: number): IdentifiedRecord {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    throw new ConnectorError(400, `records[${index}] is not an object`);
  }
  const { id } = record as { id?: unknown };
  if (typeof id !== 'string' || id === '') {
    throw new ConnectorError(400, `records[${index}] has no string "id"`);
  }
  return record as IdentifiedRecord;
}
