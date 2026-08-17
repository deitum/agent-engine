/**
 * `POST /storage/*` on the local connector daemon — the client database kept as
 * a SQLite file on the user's own machine instead of in the browser's IndexedDB.
 *
 * The daemon is deliberately ignorant of what it stores. A collection is a
 * string and a record is an opaque JSON value, so adding an entity to the web
 * app (`designs`, whatever comes next) needs no change here and no change in the
 * daemon — exactly as `POST /mcp/tools` knows nothing about the servers it
 * proxies. That is why the collection names and document keys declared in
 * `apps/web/src/shared/lib/storage/storage.schema.ts` are **not** mirrored into
 * this package: they are the web app's business, not the transport's.
 */

/** Reads every record of one collection. */
export interface StorageRecordsListRequest {
  collection: string;
}

export interface StorageRecordsListResponse {
  /** The stored values, in no guaranteed order — the caller sorts if it cares. */
  records: unknown[];
}

/**
 * Writes records, replacing any that already carry the same `id`.
 *
 * Each entry must be an object with a string `id`; the daemon rejects the batch
 * otherwise rather than storing a row nothing could ever address again. The
 * client splits large batches so one request stays under the daemon's body
 * limit, so a `put` is **not** atomic across chunks.
 */
export interface StorageRecordsPutRequest {
  collection: string;
  records: unknown[];
}

export interface StorageRecordsDeleteRequest {
  collection: string;
  ids: string[];
}

export interface StorageRecordsClearRequest {
  collection: string;
}

/** Reads one singleton document; `value` is `null` when it was never written. */
export interface StorageDocumentGetRequest {
  key: string;
}

export interface StorageDocumentGetResponse {
  value: unknown | null;
}

export interface StorageDocumentSetRequest {
  key: string;
  /** Any JSON value, including `null` — absence is expressed by removing it. */
  value: unknown;
}

export interface StorageDocumentRemoveRequest {
  key: string;
}

/** What the write routes answer; they have nothing else to report. */
export interface StorageOkResponse {
  status: 'ok';
}
