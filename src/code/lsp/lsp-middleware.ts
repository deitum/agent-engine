import { type LspSession } from './lsp-session';

/**
 * The middleware that turns a language server into feedback the agent cannot
 * ignore: after every `write_file` / `edit_file`, the errors the edit introduced
 * are appended to the tool's own result.
 *
 * **Why a middleware and not the backend.** deepagents' `write_file` tool reads
 * exactly one thing from whatever the backend returns — `error` — and otherwise
 * emits a fixed `Successfully wrote to '<path>'`. There is no seam in
 * `DockerShellBackend` through which anything could be added to a *successful*
 * result. LangChain's `wrapToolCall` is that seam: it wraps the whole call, so it
 * can let the ordinary handler run and then extend the `ToolMessage` it produced.
 * The connector already uses the same hook shape for the deferred-tool gate
 * (`buildDeferredGate` in `deep-agent.ts`).
 *
 * **Why it is appended rather than emitted separately.** The browser already
 * renders a tool result's content as the step's preview, and the Code path
 * replays that content to the model on the next turn. Appending therefore reaches
 * both the user and the model with no new event type, no UI work, and no risk of
 * the note being separated from the edit it describes.
 */

/** The tools whose results carry diagnostics. */
const EDIT_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit_file']);

/** How a ToolMessage looks to us through the dual-package type seam. */
interface ToolMessageLike {
  content?: unknown;
  lc_kwargs?: { content?: unknown };
}

/** A `Command`, which is what the tool returns when it also updates state. */
interface CommandLike {
  update?: { messages?: unknown[] };
}

/**
 * Reads the `file_path` a file tool was called with. deepagents normalises the
 * argument name before the tool runs, but the raw call is what middleware sees,
 * so both spellings the model produces are accepted.
 */
export function editedPath(args: unknown): string | null {
  if (!args || typeof args !== 'object') {
    return null;
  }
  const record = args as Record<string, unknown>;
  for (const key of ['file_path', 'filePath', 'path']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return null;
}

/**
 * Appends `block` to a tool result, whatever shape it came back in.
 *
 * Mutates the message in place rather than constructing a new one: `ToolMessage`
 * arrives across the CJS/ESM seam described in `deep-agent.ts`, where the class
 * we would import is not the class the object was built from, and a rebuilt
 * message loses the `tool_call_id` binding the graph pairs on.
 */
export function appendToResult(result: unknown, block: string): unknown {
  const command = result as CommandLike | null;
  const messages = command?.update?.messages;
  if (Array.isArray(messages) && messages.length > 0) {
    appendToMessage(messages[messages.length - 1], block);
    return result;
  }
  appendToMessage(result, block);
  return result;
}

function appendToMessage(message: unknown, block: string): void {
  const target = message as ToolMessageLike | null;
  if (!target || typeof target !== 'object') {
    return;
  }
  if (typeof target.content === 'string') {
    target.content = `${target.content}\n\n${block}`;
  } else if (Array.isArray(target.content)) {
    // The block form some providers use; a trailing text block reads the same.
    target.content = [...target.content, { type: 'text', text: block }];
  } else {
    return;
  }
  // LangChain messages keep a parallel copy of their constructor arguments, and
  // serialisation reads that one.
  if (target.lc_kwargs && typeof target.lc_kwargs === 'object') {
    target.lc_kwargs.content = target.content;
  }
}

/** The `createMiddleware` factory, through the same `unknown` seam as its callers. */
type CreateMiddleware = (config: {
  name: string;
  wrapToolCall: (request: unknown, handler: (request: unknown) => unknown) => Promise<unknown>;
}) => unknown;

/**
 * Builds the diagnostics middleware for a session.
 *
 * Everything it does is best-effort: a language server that is missing, slow or
 * broken must cost the agent nothing at all, so every failure path returns the
 * untouched result of the ordinary handler.
 */
export function buildLspMiddleware(
  createMiddleware: unknown,
  session: LspSession,
  onLog?: (message: string) => void,
): unknown {
  return (createMiddleware as CreateMiddleware)({
    name: 'LspDiagnostics',
    wrapToolCall: async (request, handler) => {
      const call = (request as { toolCall?: { name?: unknown; args?: unknown } }).toolCall;
      const name = typeof call?.name === 'string' ? call.name : '';
      const path = EDIT_TOOLS.has(name) ? editedPath(call?.args) : null;
      if (!path || session.off) {
        return handler(request);
      }

      // Taken *before* the edit: this is what makes «did this edit break it?»
      // answerable at all.
      let probe = null;
      try {
        probe = await session.beforeEdit(path);
      } catch (error) {
        onLog?.(`lsp beforeEdit: ${describe(error)}`);
      }

      const result = await handler(request);
      if (!probe) {
        return result;
      }

      try {
        const block = await session.afterEdit(probe);
        return block ? appendToResult(result, block) : result;
      } catch (error) {
        onLog?.(`lsp afterEdit: ${describe(error)}`);
        return result;
      }
    },
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
