/** Metasearch engine behind the agent's `web_search` tool. */
export type SearchEngine = 'searxng';

/**
 * How `web_fetch` may read a page it was handed.
 *
 * The URL is chosen by the model, and the connector runs on the user's own
 * machine — inside their home or corporate network — so reaching private
 * addresses is opt-in rather than the default.
 */
export interface SearchFetchConfig {
  /** Characters of extracted text returned to the model before truncation. */
  maxChars?: number;
  /** Allow loopback / RFC-1918 / link-local hosts (an internal wiki). */
  allowPrivateNetwork?: boolean;
}

/**
 * Web-search settings for one agent run, merged from the deployment's
 * the deployment's own settings (served read-only by the embedding app) and the user's own
 * browser preferences, then forwarded to the local connector on every request.
 *
 * The connector never reads the YAML — it runs on the user's machine — so this
 * travels the same route as `llm` and `lsp`. It also means the **cluster never
 * makes an outbound request**: only the user's machine talks to the search
 * engine, which is the only thing that can, in a deployment without internet
 * access.
 */
export interface SearchConfig {
  /** Master switch. `false` from the deployment config disables it for everyone. */
  enabled?: boolean;
  engine?: SearchEngine;
  /**
   * An existing SearXNG instance reachable **from the user's machine**. Empty
   * means the connector runs and uses its own container (see {@link SearchStatus}).
   */
  baseUrl?: string;
  /** UI language passed to the engine, e.g. `ru-RU`. */
  language?: string;
  /** SearXNG `safesearch`: 0 off, 1 moderate, 2 strict. */
  safeSearch?: 0 | 1 | 2;
  /** How many results a single `web_search` returns at most. */
  maxResults?: number;
  /** SearXNG categories searched by default, e.g. `['general']`. */
  categories?: string[];
  /** Budget for one search / fetch request. */
  timeoutMs?: number;
  fetch?: SearchFetchConfig;
}

/**
 * What the connector's own SearXNG container is doing.
 *
 * `pulling` is a first-class state rather than a flavour of `starting` because
 * it is the one that takes minutes: the image is ~300 MB and the first start on
 * a machine is the only slow one.
 */
export type SearchBackendState =
  /** No container of ours is running. */
  | 'off'
  /** Fetching the image (cold first start). */
  | 'pulling'
  /** Container up, waiting for the engine to answer its health probe. */
  | 'starting'
  | 'running'
  /** Docker is not installed or not running — nothing to start. */
  | 'unavailable'
  /** The last start attempt failed; `message` says why. */
  | 'error';

/**
 * `GET /search/status` on the local connector: whether the agent has a search
 * backend right now, and — for the container the connector manages itself —
 * what it is doing.
 */
export interface SearchStatus {
  /**
   * `external` when the run config names a `baseUrl`, in which case the
   * container is not involved at all and cannot be started from the UI.
   */
  mode: 'managed' | 'external';
  state: SearchBackendState;
  /** Base URL the search currently answers on (set while `running`). */
  url?: string;
  image?: string;
  port?: number;
  /** Reason for `unavailable` / `error`, in the user's language. */
  message?: string;
}

/**
 * `POST /search/start` — bring the connector's own SearXNG up. Both fields fall
 * back to the connector's defaults; `image` exists for a closed network whose
 * machines pull from an internal registry rather than Docker Hub.
 */
export interface SearchStartRequest {
  port?: number;
  image?: string;
}

/** One result row of a `web_search` call, as the engine returned it. */
export interface WebSearchResult {
  title: string;
  url: string;
  /** The engine's snippet; usually a sentence or two, sometimes empty. */
  snippet: string;
  /** Which upstream engine produced the row (SearXNG aggregates several). */
  engine?: string;
  /** Publication date, when the engine reports one. */
  publishedAt?: string;
}
