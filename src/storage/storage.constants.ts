import { join } from 'node:path';

import { engineHome } from '../platform';

/** File the client database lives in, under the daemon's home. */
export const STATE_DB_FILE = 'state.db';

/** Default path of that file (`~/.agent-engine/state.db` unless `AGENT_ENGINE_HOME` moves it). */
export const stateDbPath = (): string => join(engineHome(), STATE_DB_FILE);

/**
 * Mode the file is created with. It holds the LLM token, the Bitbucket token and
 * every MCP server's `env` / `headers` — which is the whole reason moving the
 * app's storage here is a decision and not a detail. Other accounts on the
 * machine have no business reading it.
 */
export const STATE_DB_MODE = 0o600;

/**
 * The schema, in full.
 *
 * Two key-value tables rather than one table per entity, because the port this
 * serves (`StorageClient` in the web app) offers `getAll` / `put` / `delete` /
 * `clear` and no queries at all — so per-entity columns and indexes would buy
 * nothing and cost the daemon knowledge of a domain model that is not its own.
 * Adding a collection in the browser then needs no daemon release, and no
 * request ever names a table.
 *
 * `WITHOUT ROWID` because both tables are looked up exclusively by their primary
 * key, which is exactly the case that layout is for.
 */
export const STATE_DB_SCHEMA = `
CREATE TABLE IF NOT EXISTS records (
  collection TEXT NOT NULL,
  id         TEXT NOT NULL,
  data       TEXT NOT NULL,
  PRIMARY KEY (collection, id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS documents (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
`;

/**
 * Why `node:sqlite` is missing, in the words the user needs. Node gained it in
 * 22.5; the daemon otherwise runs fine, so this is a 501 on seven routes rather
 * than a refusal to start.
 */
export const SQLITE_UNAVAILABLE =
  'This Node build has no «node:sqlite» module (added in Node 22.5). ' +
  'Upgrade Node to keep this app’s data on this machine, or leave its storage in the browser.';
