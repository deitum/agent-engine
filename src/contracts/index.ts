/**
 * The engine's wire contract — every type, enum and constant that appears in a
 * request to this daemon, in a response from it, or in a frame of one of its
 * streams.
 *
 * Published as its own entry point (`@deitum/agent-engine/contracts`) so that a
 * consumer can be typed against the protocol without depending on the engine's
 * runtime: a browser bundle, a server in another language's toolchain, or a test
 * double all need the shapes and none of them need `node:sqlite`. The client in
 * `../client` is built on exactly these declarations, so a caller and the daemon
 * can never disagree about what a route speaks.
 *
 * Nothing here has a runtime dependency of its own, and nothing here knows which
 * application is embedding the engine.
 */
export * from './llm/llm.constants';
export * from './llm/llm.enums';
export * from './llm/llm.types';
export * from './mcp/mcp.constants';
export * from './mcp/mcp.enums';
export * from './mcp/mcp.policy';
export * from './mcp/mcp.types';
export * from './vcs/vcs.types';
export * from './engine/engine.types';
export * from './manifest/manifest.types';
export * from './skills/skills.types';
export * from './plugins/plugins.types';
export * from './catalog/catalog.types';
export * from './files/files.types';
export * from './integrations/integrations.types';
export * from './agents/agents.types';
export * from './artifacts/artifacts.constants';
export * from './artifacts/artifacts.types';
export * from './code/code.constants';
export * from './code/code.types';
export * from './code/openspec.constants';
export * from './code/openspec.types';
export * from './search/search.constants';
export * from './search/search.types';
export * from './storage/storage.types';
