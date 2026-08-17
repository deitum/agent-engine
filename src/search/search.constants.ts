import { join } from 'node:path';

import { PACKAGE_NAME, PACKAGE_VERSION } from '../package.constants';
import { engineHome } from '../platform';

/** Name of the SearXNG container the connector runs on the user's machine. */
export const SEARXNG_CONTAINER = 'agent-engine-searxng';

/**
 * Names {@link SEARXNG_CONTAINER} has gone by, removed alongside it.
 *
 * The container is started with `--restart unless-stopped` and survives a
 * reboot, so a machine that ran an earlier build still has one under the old
 * name — holding {@link SEARXNG_PORT}, which would make every `docker run` of
 * the new one fail on a port clash rather than the name clash `docker rm`
 * already covers. Droppable once no installation predates the rename.
 */
export const LEGACY_SEARXNG_CONTAINERS = ['aft-cowork-searxng'];

/** Docker label put on that container, so it is recognisable as ours. */
export const SEARXNG_LABEL = 'com.deitum.agent-engine.search';

/** Where the generated `settings.yml` lives; bind-mounted as `/etc/searxng`. */
export const SEARXNG_CONFIG_DIR = join(engineHome(), 'searxng');

/** How long the engine may take to answer its health probe after `docker run`. */
export const SEARXNG_READY_TIMEOUT_MS = 90_000;

/** Gap between health probes while waiting for it. */
export const SEARXNG_PROBE_INTERVAL_MS = 1_000;

/**
 * Environment variables passed through to the container.
 *
 * A corporate machine reaches the internet through a proxy and nothing else, so
 * without these the engine starts cleanly and then fails every single search.
 * Deliberately a proxy allow-list rather than the daemon's whole environment,
 * for the same reason as `SANDBOX_ENV_KEYS` in `deep-agent.ts`.
 */
export const SEARXNG_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
];

/** Bytes of a fetched page read before the download is cut off. */
export const FETCH_MAX_BYTES = 5_000_000;

/**
 * `User-Agent` the connector fetches pages with.
 *
 * Built from the package's own name and version so a site owner reading their
 * logs can find out what visited them. Distinct from the gateway `User-Agent`
 * (`AGENT_ENGINE_USER_AGENT`), which is a routing key rather than an identity.
 */
export const FETCH_USER_AGENT = `Mozilla/5.0 (compatible; ${PACKAGE_NAME}/${PACKAGE_VERSION}; +https://github.com/deitum/agent-engine)`;

/** Content types `web_fetch` can turn into text; anything else is refused. */
export const FETCH_TEXT_TYPES = [
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'text/markdown',
  'application/json',
  'text/xml',
  'application/xml',
];
