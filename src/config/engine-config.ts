import { ConnectorError } from '../connector';
import {
  type EngineConfigRequest,
  type EngineConfigResponse,
  type HostLlmConfig,
  type RepoCredentials,
  type RepoProvider,
  type SearchConfig,
  repoProvider,
} from '../contracts';

import { trustDeploymentCerts } from './ca-certs';
import { CONFIG_MISSING_STATUS } from './config.constants';

/**
 * The configuration this daemon runs on, as handed over by the client when it
 * connected (`POST /config`).
 *
 * Held in memory and nowhere else — the daemon writes none of it to disk, the
 * user's key least of all. The client re-states it whenever `/ping` reports a
 * version other than the one it holds, so a restarted daemon is told again
 * within one probe interval, and a daemon nobody is talking to knows nothing
 * about anyone's gateway, key or repositories. That is the property which lets
 * an embedder keep the gateway address an administrative setting rather than a
 * per-machine one.
 */
interface AdoptedConfig {
  version: string;
  /** Gateway address, either named outright or read from the host. */
  gatewayUrl: string;
  apiKey: string;
  search?: SearchConfig;
  repos: RepoCredentials[];
}

let current: AdoptedConfig | null = null;

/**
 * Adopts one configuration bundle: settles where the model lives — from the
 * bundle itself, or from the host it names — applies whatever certificates came
 * with it to this process's trust store, and keeps the rest for the routes that
 * need it.
 *
 * Throws (502) rather than degrading when a named host cannot be reached or
 * declares no `baseUrl`: the alternative is accepting the handshake and failing
 * every turn afterwards with an error that no longer names the cause. Nothing is
 * adopted in that case, so the client retries against a daemon that still
 * reports no configuration rather than one holding half of it.
 */
export async function adoptEngineConfig(
  request: EngineConfigRequest,
): Promise<EngineConfigResponse> {
  const { baseUrl, caCerts } = await resolveGateway(request);
  useEngineConfig(request, baseUrl);
  return { version: configVersion(), baseUrl, caCerts };
}

/**
 * Takes a bundle whose gateway is already known and makes it the configuration
 * this process runs on, replacing whatever it held before.
 *
 * Replaced whole rather than merged: the bundle *is* the configuration, so a
 * setting the user turned off has to leave with it.
 */
export function useEngineConfig(request: EngineConfigRequest, gatewayUrl: string): void {
  current = {
    version: request.version ?? '',
    gatewayUrl,
    apiKey: request.llm?.apiKey ?? '',
    ...(request.search ? { search: request.search } : {}),
    repos: request.repos ?? [],
  };
}

/**
 * Settles the two things only the deployment can answer: which gateway to call,
 * and which certificates to trust while calling it.
 *
 * A bundle that names `llm.baseUrl` is complete on its own — that is the path an
 * embedder without a control plane takes, and it touches no network. Otherwise
 * `hostConfigUrl` is fetched, which is the only part of the handshake that can
 * fail. Kept apart from {@link useEngineConfig} for exactly that reason.
 */
async function resolveGateway(
  request: EngineConfigRequest,
): Promise<{ baseUrl: string; caCerts: number }> {
  const named = (request.llm?.baseUrl ?? '').trim().replace(/\/+$/, '');
  if (named) {
    return { baseUrl: named, caCerts: trustDeploymentCerts(request.llm.caCerts ?? []) };
  }

  const url = (request.hostConfigUrl ?? '').trim();
  if (!url) {
    throw new ConnectorError(400, 'Either llm.baseUrl or hostConfigUrl is required');
  }

  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConnectorError(502, `Could not reach the host config at ${url}: ${reason}`);
  }

  if (!response.ok) {
    throw new ConnectorError(502, `The host config at ${url} answered ${response.status}`);
  }

  const config = (await response.json().catch(() => ({}))) as Partial<HostLlmConfig>;
  const baseUrl = (config.baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!baseUrl) {
    throw new ConnectorError(502, `The host config at ${url} declares no baseUrl`);
  }

  return { baseUrl, caCerts: trustDeploymentCerts(config.caCerts ?? []) };
}

/**
 * The adopted configuration, or a 428 when the client has not handed one over
 * yet (see {@link CONFIG_MISSING_STATUS}).
 *
 * Routes that open an SSE stream call this **before** writing the response head:
 * a 428 the client can act on is worth far more than an error event inside a
 * stream it has already committed to reading.
 */
export function requireConfig(): AdoptedConfig {
  if (!current) {
    throw new ConnectorError(
      CONFIG_MISSING_STATUS,
      'This engine has not been configured yet — POST /config first',
    );
  }
  return current;
}

/** The gateway to call, or a 428 when there is no configuration yet. */
export function resolveGatewayUrl(): string {
  return requireConfig().gatewayUrl;
}

/** The user's key for the gateway, or a 428 when there is no configuration. */
export function resolveApiKey(): string {
  return requireConfig().apiKey;
}

/**
 * The web-search policy, or `undefined` when the deployment and the user leave
 * search off. Read rather than required: an agent without search tools is a
 * degraded agent, not a failed request.
 */
export function resolveSearchConfig(): SearchConfig | undefined {
  return current?.search;
}

/**
 * The user's credentials for one provider, or blank ones when they have
 * configured none for it. Blank rather than `undefined` on purpose: every caller
 * ends up building a repository client, which already refuses an empty token
 * with the message that names the fix — so there is one place saying it, not
 * four.
 *
 * `baseUrl` narrows the choice when the user has several accounts on one
 * provider; a credential that names no host answers for every host of it.
 */
export function resolveRepoCredentials(provider: RepoProvider, baseUrl?: string): RepoCredentials {
  const candidates = (current?.repos ?? []).filter((entry) => repoProvider(entry) === provider);
  const host = normalizeHost(baseUrl);
  const exact = host
    ? candidates.find((entry) => normalizeHost(entry.baseUrl) === host)
    : undefined;
  return (
    exact ?? candidates.find((entry) => !entry.baseUrl) ?? candidates[0] ?? { provider, token: '' }
  );
}

/** Host of a URL, for comparing two spellings of the same server. */
function normalizeHost(url: string | undefined): string {
  const trimmed = (url ?? '').trim();
  if (!trimmed) {
    return '';
  }
  try {
    return new URL(trimmed).host.toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}

/**
 * Version of the configuration currently held, or `''` when there is none. This
 * is what `/ping` reports, and comparing it with the version the client computed
 * is the whole of the "has anything changed?" protocol.
 */
export function configVersion(): string {
  return current?.version ?? '';
}

/** Forgets the adopted configuration. For tests. */
export function resetEngineConfig(): void {
  current = null;
}
