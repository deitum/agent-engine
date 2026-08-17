import { type SearchConfig } from '../search/search.types';
import { type RepoCredentials } from '../vcs/vcs.types';

/**
 * `POST /config` — everything the daemon learns **once, when a client connects**,
 * instead of in the body of every request.
 *
 * The split it draws is configuration vs. content: an address, a credential or a
 * policy belongs here and is the same for every turn, while what a run is
 * actually about (the messages, the chat's MCP scope, its skills and files, the
 * chosen model) stays in the run request.
 *
 * Everything here is held **in memory only** — the daemon writes none of it to
 * disk, the user's key least of all. The client re-states it whenever
 * {@link McpConnectorPing.configVersion} disagrees with what it holds, so a
 * restarted daemon is told again within one probe interval and a daemon nobody
 * is talking to knows nothing about anyone's gateway or repositories.
 */
export interface EngineConfigRequest {
  /**
   * Version of this bundle, computed by the client and echoed back by `/ping`.
   * The daemon never recomputes it — one side owns the hash, so the two can
   * never disagree about what "the same configuration" means.
   */
  version: string;
  /** Where the model lives and what may call it. */
  llm: EngineLlmConfig;
  /**
   * A URL answering {@link HostLlmConfig}, for embedders whose deployment — not
   * their users — owns the gateway address: the daemon `GET`s it and takes
   * `baseUrl` and `caCerts` from the answer.
   *
   * Optional, and ignored when {@link EngineLlmConfig.baseUrl} is set. An
   * embedder with no control plane at all names the gateway directly and never
   * stands one up; one that has a control plane keeps the address administrative
   * rather than per-machine, and the client never has to carry it.
   */
  hostConfigUrl?: string;
  /**
   * Web-search policy. The daemon reads no configuration file of its own — it
   * runs on the user's machine — so the client is the only source it can have.
   */
  search?: SearchConfig;
  /**
   * Repository credentials, one entry per provider the user has configured.
   * Spent by the coding sandbox's clone / push / pull-request and by the skills
   * catalogue's repository import. The host is not here, because each of those
   * names the repository it is talking to anyway.
   */
  repos?: RepoCredentials[];
}

/** Where the model lives, and the user's key for it. */
export interface EngineLlmConfig {
  /**
   * Base URL (including any version prefix) of the OpenAI-compatible gateway.
   * Optional only when {@link EngineConfigRequest.hostConfigUrl} supplies it.
   */
  baseUrl?: string;
  /** The user's provider credentials, adopted for the life of the process. */
  apiKey: string;
  /**
   * PEM certificate blocks added to the trust store of the daemon's own process,
   * so a corporate TLS gateway works without the user setting
   * `NODE_EXTRA_CA_CERTS`.
   */
  caCerts?: string[];
}

/**
 * What {@link EngineConfigRequest.hostConfigUrl} must answer with — the whole of
 * the contract the engine imposes on an embedding application. One `GET`, one
 * JSON object, no authentication assumed and no route naming: the client passes
 * a complete URL, so the engine never has to know how the host spells its own
 * paths.
 */
export interface HostLlmConfig {
  baseUrl: string;
  caCerts?: string[];
}

/** What the daemon resolved — echoed back for diagnostics. */
export interface EngineConfigResponse {
  /** The version just adopted, as `/ping` will report it. */
  version: string;
  /** Gateway address the daemon settled on. */
  baseUrl: string;
  /** How many certificates were applied to the trust store. */
  caCerts: number;
}
