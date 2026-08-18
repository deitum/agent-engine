/**
 * `@deitum/agent-engine` — the engine as a library.
 *
 * The package ships three entry points, and which one you want depends on which
 * side of the wire you are on:
 *
 * - **this one** builds the daemon into your own process, when `npx
 *   agent-engine` is not how you want it started (a desktop shell, say, that
 *   owns the process and stops it with the window);
 * - `@deitum/agent-engine/client` talks **to** a running daemon over HTTP, and
 *   is safe to bundle for a browser;
 * - `@deitum/agent-engine/contracts` is the wire contract alone, with no
 *   runtime at all.
 *
 * ```ts
 * import { createEngineServer } from '@deitum/agent-engine';
 *
 * const server = createEngineServer({ token, onShutdownRequest: () => stop() });
 * server.listen(50880, '127.0.0.1');
 * ```
 *
 * Everything the daemon needs beyond its token — the model gateway, the user's
 * key, the web-search policy, the repository credentials — arrives at runtime
 * through `POST /config` and is held in memory only. See `README.md`.
 */
export { createEngineServer, openSse, type EngineServer, type EngineServerOptions } from './server';
export { Connector, ConnectorError } from './connector';
export { CodeWorkspaces } from './code/code-workspace';
export { SearxngContainer } from './search/searxng-container';
export { StateDb } from './storage/state-db';
export { BackgroundTasks } from './tasks/background-tasks';
export { engineHome } from './platform';
export { trustSystemCerts } from './config/ca-certs';
export { applyTlsPolicy, tlsVerificationDisabled, SSL_VERIFY_VAR } from './config/tls';
export { useEngineConfig, resetEngineConfig } from './config/engine-config';

export * from './contracts';
