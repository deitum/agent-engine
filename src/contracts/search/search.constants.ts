/**
 * Model-facing name of the metasearch tool the local connector grants every
 * agent — a chat, a project chat and a coding sandbox session alike.
 */
export const WEB_SEARCH_TOOL = 'web_search';

/** Model-facing name of the companion tool that reads one page as text. */
export const WEB_FETCH_TOOL = 'web_fetch';

/** Docker image of the SearXNG instance the connector manages itself. */
export const SEARXNG_IMAGE = 'searxng/searxng:latest';

/**
 * Port that instance is published on, bound to loopback only.
 *
 * Next to the connector's own 50880 rather than SearXNG's usual 8080: 8080 is
 * the single most contended port on a developer machine, and a search backend
 * that silently collides with someone's dev server is a bad first run.
 */
export const SEARXNG_PORT = 50881;

/** Results returned by one `web_search` call unless the model asks for fewer. */
export const SEARCH_MAX_RESULTS = 8;

/** Budget for one search request or page fetch. */
export const SEARCH_TIMEOUT_MS = 20_000;

/** Characters of a fetched page handed to the model before truncation. */
export const WEB_FETCH_MAX_CHARS = 20_000;
