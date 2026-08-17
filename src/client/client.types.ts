import { type EngineConfigRequest } from '../contracts';

/** The `fetch` an {@link EngineClient} calls. Matches the platform signature. */
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** How to reach one running daemon, and how to behave while talking to it. */
export interface EngineClientOptions {
  /**
   * Where the daemon listens. Either a full base URL or just the port — the
   * daemon binds `127.0.0.1`, so a port is the whole of the address in the
   * ordinary case.
   */
  baseUrl?: string;
  port?: number;
  /** The bearer token the daemon was started with. */
  token: string;

  /**
   * The `fetch` to use. Defaults to the global one.
   *
   * Injectable because the ordinary one does not always work: a page served over
   * HTTPS cannot reach `http://127.0.0.1` in WKWebView (the check is WebKit's,
   * not the network stack's), so an embedding shell hands in a transport that
   * goes through its native side instead. Nothing else about the client changes.
   */
  fetch?: FetchFn;

  /**
   * Called when the daemon answers `428` — it is running but holds no
   * configuration, which is its state after a restart. Return the bundle to hand
   * it, and the call that hit the 428 is retried once.
   *
   * This is what makes a restarted daemon invisible to the user: without it,
   * every call after a restart fails for a reason they can neither see nor fix.
   * Return `null` to let the 428 through untouched.
   */
  onConfigMissing?: () => Promise<EngineConfigRequest | null> | EngineConfigRequest | null;

  /** Applied to every request that does not carry a signal of its own. */
  signal?: AbortSignal;
}

/** Per-call options every method accepts. */
export interface RequestOptions {
  signal?: AbortSignal;
}
