/**
 * Budgets and limits for the language-server layer.
 *
 * Every number here exists to bound something that would otherwise be unbounded:
 * a server that wedges must cost one tool call, not the turn, and a repository
 * with four thousand errors must not spend the model's context reporting them.
 */

/** Root of the shared server install, inside the container. */
export const LSP_CACHE_DIR = '/cache/lsp';

/** Where jdtls keeps its per-project index. Outside the checkout on purpose. */
export const JDTLS_DATA_DIR = `${LSP_CACHE_DIR}/jdtls-data`;

/** The workspace root inside the container, as a path and as a URI. */
export const CONTAINER_WORKSPACE = '/workspace';
export const CONTAINER_WORKSPACE_URI = 'file:///workspace';

/** Budget for one install. A cold jdtls tarball over a slow proxy is minutes. */
export const INSTALL_TIMEOUT_SEC = 10 * 60;

/** Budget for a runtime probe — a single `command -v` in a running container. */
export const PROBE_TIMEOUT_SEC = 30;

/**
 * How many diagnostics travel back on one edit. The block is appended to a tool
 * result, so it is paid for on every subsequent turn of the conversation; ten is
 * enough to see the shape of a breakage and small enough to stay cheap.
 */
export const MAX_DIAGNOSTICS = 10;

/** Hard ceiling on the appended block, whatever the count. */
export const MAX_DIAGNOSTICS_CHARS = 2_000;

/** One diagnostic message is truncated to this before it is listed. */
export const MAX_DIAGNOSTIC_MESSAGE_CHARS = 200;

/** How many locations a navigation tool returns. */
export const MAX_NAVIGATION_RESULTS = 50;

/** Characters of source shown next to a location. */
export const MAX_CONTEXT_LINE_CHARS = 160;

/** Ceiling on a navigation tool's whole answer. */
export const MAX_TOOL_RESULT_CHARS = 8_000;

/**
 * How many files one `rename_symbol` may touch. A rename that reaches further
 * than this is a refactor the user should see coming, not something an agent
 * should do inside a tool call.
 */
export const MAX_RENAME_FILES = 40;

/** Ceiling on individual edits in one rename, independent of the file count. */
export const MAX_RENAME_EDITS = 300;

/** File size past which a document is not handed to a language server. */
export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

/**
 * How many times a crashed server is restarted before its language is given up
 * on for the session. One retry covers the ordinary case (an OOM during an
 * unlucky build); a server that dies twice is broken, and retrying it forever
 * would turn every edit into a slow no-op.
 */
export const MAX_SERVER_RESTARTS = 1;
