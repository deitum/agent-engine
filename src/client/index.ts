/**
 * `@deitum/agent-engine/client` — talking to a running daemon over HTTP.
 *
 * Browser-safe by construction: nothing under this directory imports `node:`
 * anything, so the same client runs in a page, in a Node process and inside a
 * desktop shell embedding one. The one thing that differs between those — how the
 * request is actually performed — is injected (`EngineClientOptions.fetch`).
 *
 * Typed entirely from `@deitum/agent-engine/contracts`, which the daemon is
 * built from as well, so a route's request and response shapes cannot drift
 * apart between the two sides.
 */
export { DEFAULT_ENGINE_PORT, EngineClient } from './engine-client';
export { CONFIG_MISSING_STATUS, EngineError, EngineUnreachableError } from './engine-error';
export { streamEvents } from './sse';
export type { EngineClientOptions, FetchFn, RequestOptions } from './client.types';

export * from '../contracts';
