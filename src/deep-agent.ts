import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { resolveSearchConfig } from './config/engine-config';
import { type Connector } from './connector';
import {
  type ArtifactKind,
  type BackgroundTask,
  type ChatCompletionTool,
  CODE_GIT_TOOLS,
  type CompletionUsage,
  type DeepAgentFile,
  type DeepAgentRunRequest,
  type DeepAgentSkill,
  type DeepAgentStreamEvent,
  type DeepAgentSubAgent,
  type DeepAgentTodo,
  EXIT_PLAN_MODE_TOOL,
  MCP_LOAD_TOOLS,
  MCP_LOAD_TOOLS_DESCRIPTION,
  mcpLoadToolsSchema,
  McpToolMode,
  type McpToolSource,
  OPENSPEC_TOOL_NAMES,
  OPENSPEC_TOOLS,
  parseToolArguments,
  REMEMBER_TOOL,
  resolveToolMode,
  toFunctionParameters,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
  WRITE_ARTIFACT_DESCRIPTION,
  WRITE_ARTIFACT_SCHEMA,
  WRITE_ARTIFACT_TOOL,
} from './contracts';
import { buildHideToolsMiddleware } from './hide-builtin-tools';
import { buildChatModel } from './llm/chat-model';
import { gatewayAttemptMessage } from './llm/llm-client';
import { repetitionMessage } from './llm/repetition';
import { createTokenStream } from './llm/token-stream';
import { createMcpCallMemo } from './mcp-call-memo';
import { buildPlanMiddleware } from './plan/plan-middleware';
import { buildPlanNudgeMiddleware } from './plan/plan-nudge';
import { planPromptSection } from './plan/plan-prompt';
import { WRITE_TODOS_TOOL } from './plan/plan.constants';
import { engineHome, hostShellPromptSection, sandboxEnv } from './platform';
import { RM_RETRY } from './platform.constants';
import { buildToolCallRepairMiddleware } from './repair-tool-calls';
import { buildSearchTools } from './search/search-tools';
import { type SearxngContainer } from './search/searxng-container';
import { packageName, safeSegment } from './skill-package';
import { type BackgroundTasks, TaskError } from './tasks/background-tasks';
import { taskPromptSection } from './tasks/task-prompt';
import {
  BUILTIN_TASK_TOOL,
  CHECK_TASK_TOOL,
  DELEGATE_TASK_SCHEMA,
  DELEGATE_TASK_TOOL,
  LIST_TASKS_TOOL,
  NO_ARGS_SCHEMA,
  SEND_TO_TASK_SCHEMA,
  SEND_TO_TASK_TOOL,
  STOP_TASK_TOOL,
  TASK_ID_SCHEMA,
  TASK_TOOL_NAMES,
} from './tasks/tasks.constants';
import { createTurnTimer } from './turn-timer';

/** Receives progress events as the deep agent streams its turn. */
export type EventSink = (event: DeepAgentStreamEvent) => void;

/**
 * What a connector-side tool blocked on the browser is waiting for: the user's
 * reply to an `ask_user` question, or the outcome of a `client_tool` call the
 * browser executed on the agent's behalf. `isError` only ever comes from the
 * latter — a user picking an option cannot fail.
 */
export interface PendingResult {
  text: string;
  isError?: boolean;
}

/**
 * Resolvers for in-flight tools that block on the browser, keyed by their id.
 * The tool registers one and blocks on it; `POST /deepagent/answer` (an
 * `ask_user` question) or `POST /deepagent/client-tool` (a client tool) looks it
 * up and resolves it, resuming the still-open stream.
 */
export type PendingAnswers = Map<string, (result: PendingResult) => void>;

/**
 * The slice of a compiled `deepagentsjs` agent we use. The library's own types
 * are heavily generic and, because deepagents/langchain are dual-published, run
 * into CJS-vs-ESM type-identity mismatches when consumed from this CommonJS
 * package — so we cast to this minimal structural shape at the seam.
 *
 * We consume with `streamMode: "updates"` (per-node state deltas) rather than
 * `streamEvents`/`streamMode: "messages"`, and get the turn's text token by
 * token from a callback handler on the model instead (`llm/token-stream.ts`).
 * The graph's own message stream cannot say which model call it is reporting,
 * and a turn makes several the user must never read — the summarizer's above
 * all. See that module for why a handler can tell them apart and this stream
 * cannot.
 */
export interface StreamableAgent {
  stream(
    input: unknown,
    options: { streamMode: 'updates'; signal: AbortSignal; recursionLimit: number },
  ): Promise<AsyncIterable<Record<string, unknown>>>;
}

/**
 * Tool names reserved by the middleware a run installs — deepagents' own
 * (filesystem, tasks) and the planning one this daemon adds
 * (`plan/plan-middleware.ts`). A bridged MCP tool with a clashing name is exposed
 * under an `mcp_`-prefixed alias instead (see {@link uniqueExposedName}).
 *
 * `createDeepAgent` throws on a tool reusing one of *its* names, but its
 * `BUILTIN_TOOL_NAMES` is a subset of this: `write_todos` is not in it since
 * deepagents 1.12 dropped planning from the default stack, so for that one name
 * this set is the only thing standing between the model and two same-named
 * tools.
 */
export const RESERVED_TOOL_NAMES = new Set([
  'ls',
  'read_file',
  'write_file',
  'edit_file',
  'glob',
  'grep',
  'execute',
  'task',
  WRITE_TODOS_TOOL,
  'start_async_task',
  'check_async_task',
  'update_async_task',
  'cancel_async_task',
  'list_async_tasks',
]);

/** The built-in `ask_user` tool's model-facing name. */
const ASK_USER_TOOL = 'ask_user';

/**
 * Built-in tools that surface to the user through their own stream event
 * (buttons for `ask_user`, a card for `write_artifact` or for a proposed plan)
 * and are therefore kept out of the activity timeline.
 */
const SILENT_TOOL_NAMES = new Set([
  ASK_USER_TOOL,
  WRITE_ARTIFACT_TOOL,
  EXIT_PLAN_MODE_TOOL,
  // The proposal is a document the user reads in its own card and in the process
  // panel; a step row saying «openspec_propose» beside it is noise.
  OPENSPEC_TOOLS.propose,
]);

/**
 * Tool names this connector adds on top of deepagents' own. Unlike
 * {@link RESERVED_TOOL_NAMES} these do not make `createDeepAgent` throw, so an
 * MCP server exposing one of them would quietly put two same-named tools in the
 * list handed to the model. Bridged tools are renamed around them instead.
 */
const CONNECTOR_TOOL_NAMES = new Set([
  ASK_USER_TOOL,
  WRITE_ARTIFACT_TOOL,
  MCP_LOAD_TOOLS,
  EXIT_PLAN_MODE_TOOL,
  REMEMBER_TOOL,
  WEB_SEARCH_TOOL,
  WEB_FETCH_TOOL,
  // A git or Bitbucket MCP server naming a tool `git_push` is not far-fetched,
  // and the Code path's own one has to win: it is the only one holding the
  // user's credentials.
  ...Object.values(CODE_GIT_TOOLS),
  ...OPENSPEC_TOOL_NAMES,
  ...TASK_TOOL_NAMES,
]);

/** deepagents' delegation tool, hidden whenever ours is offered instead. */
const HIDDEN_BUILTIN_TOOLS: ReadonlySet<string> = new Set([BUILTIN_TASK_TOOL]);

/**
 * Step budget for one turn (langgraph's `recursionLimit`, counted in graph
 * super-steps). The library default of 25 is roughly a dozen model↔tool
 * round-trips — far too few for an agent that plans, reads files and delegates,
 * and it surfaces as a hard `GraphRecursionError` mid-work. Exceeding this one
 * ends the turn as a `limit` event instead, keeping what was already done.
 */
const AGENT_RECURSION_LIMIT = 150;

/** Valid `kind` values for a written artifact; anything else falls back to markdown. */
const ARTIFACT_KINDS = new Set<ArtifactKind>(['markdown', 'code', 'html', 'react']);

/**
 * How much of each tool's output travels back with its `tool_result`, so an
 * expanded step in the chat shows what the tool actually returned instead of a
 * bare "done". The coding path sets a larger budget of its own.
 */
const TOOL_PREVIEW_CHARS = 600;

/** How much of a tool call's raw arguments travels back with its `tool_call`. */
const TOOL_ARGS_CHARS = 400;

/** True for a name already spoken for by deepagents or by this connector. */
function isTakenName(name: string, taken: Set<string>): boolean {
  return taken.has(name) || RESERVED_TOOL_NAMES.has(name) || CONNECTOR_TOOL_NAMES.has(name);
}

/**
 * Picks a model-facing tool name that avoids deepagents' built-ins, this
 * connector's own tools and names already used by another bridged server.
 */
export function uniqueExposedName(name: string, taken: Set<string>): string {
  let candidate = name;
  while (isTakenName(candidate, taken)) {
    candidate = `mcp_${candidate}`;
  }
  return candidate;
}

export async function loadDeps() {
  const [
    {
      createDeepAgent,
      FilesystemBackend,
      LocalShellBackend,
      createFilesystemMiddleware,
      createSummarizationMiddleware,
    },
    { ChatOpenAI },
    { tool },
    { createMiddleware, todoListMiddleware },
  ] = await Promise.all([
    import('deepagents'),
    import('@langchain/openai'),
    import('@langchain/core/tools'),
    import('langchain'),
  ]);
  return {
    createDeepAgent,
    FilesystemBackend,
    LocalShellBackend,
    // deepagents assembles these two itself with defaults we cannot reach through
    // `CreateDeepAgentParams`. Passing same-named middleware to `createDeepAgent`
    // replaces them in place (`mergeMiddlewareStack`: "same-name custom entries
    // replace matching defaults"), which is how the Code path sizes summarization
    // to the real model window and keeps the offloaded history out of the checkout.
    createFilesystemMiddleware,
    createSummarizationMiddleware,
    ChatOpenAI,
    tool,
    createMiddleware,
    // Not in deepagents' own stack since 1.12 — see `plan/plan-middleware.ts`.
    todoListMiddleware,
  };
}

/** Root for per-chat deep-agent workspaces on the user's machine. */
export const WORKSPACE_ROOT = join(engineHome(), 'deep-agents');
/** Memory file name inside a workspace (deepagents `memory`). */
const MEMORY_FILE = 'MEMORY.md';
/** Sub-directory holding the project's knowledge-base files. */
const FILES_DIR = 'files';
/** Sub-directory holding the agent's materialized skill packages. */
const SKILLS_DIR = 'skills';
/** Agent Skills spec limits: skill name ≤64 chars, description ≤1024. */
const MAX_SKILL_NAME = 64;
const MAX_SKILL_DESCRIPTION = 1024;

/** How long a chat's workspace survives without being used, before the sweep. */
const WORKSPACE_TTL_MS = 30 * 24 * 60 * 60_000;

/** Seconds a single sandbox `execute` may run before it is killed. */
const SANDBOX_COMMAND_TIMEOUT_S = 300;
/** Bytes of a sandbox command's output kept before truncation. */
const SANDBOX_MAX_OUTPUT_BYTES = 200_000;

/** A prepared on-disk workspace and the deepagents params that reference it. */
interface Workspace {
  /** Backend for `createDeepAgent` (LocalShell/Filesystem), or undefined = StateBackend. */
  backend?: unknown;
  /** Absolute workspace dir, or undefined when none was needed. */
  dir?: string;
  /** Virtual skill source paths for `createDeepAgent({ skills })`. */
  skillsPaths?: string[];
  /** Virtual memory file paths for `createDeepAgent({ memory })`. */
  memoryPaths?: string[];
  /** Virtual paths of the project files written to `/files/`, for the prompt. */
  filePaths?: string[];
  /** True when memory is enabled (so we read `MEMORY.md` back afterwards). */
  hasMemory: boolean;
}

/** Sanitises a chat id into a safe single-segment directory name. */
function sessionDirName(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, '-');
  return safe.length > 0 ? safe : 'default';
}

/**
 * Confines a caller-supplied relative path to a single subtree: strips drive
 * letters and leading separators, then drops every `.`/`..` segment. Paths in a
 * run request come from the browser, so without this a crafted `../../` path
 * would let a request write anywhere on the user's disk.
 *
 * Each surviving segment then goes through {@link safeSegment}, because staying
 * inside the subtree is not the same as being creatable: a name carrying `:` or
 * a reserved device name fails `mkdir` on Windows with `ENOENT`, whatever the
 * subtree.
 */
export function safeRelPath(path: string): string {
  const segments = path
    .replace(/^[a-zA-Z]:/, '')
    .split(/[\\/]+/)
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .map(safeSegment)
    .filter((segment) => segment !== '');
  return segments.join('/');
}

/** Writes a file, creating any missing parent directories first. */
function writeFileEnsured(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

/**
 * Empties a materialized sub-directory before it is rewritten.
 *
 * Both `skills/` and `files/` are projections of browser-owned state, so they
 * have to be replaced rather than merged: deepagents discovers skills by
 * scanning the whole source directory, which means a skill detached from the
 * project would otherwise stay loaded forever in every chat that ever used it.
 */
function resetDir(dir: string, subdir: string): void {
  rmSync(join(dir, subdir), RM_RETRY);
}

/**
 * The directory one skill is materialized into. Slugged with {@link packageName}
 * rather than merely confined with {@link safeRelPath}: an embedder namespaces a
 * plugin's skill as `<plugin>:<skill>`, and a colon in a path segment is what
 * Windows reserves for alternate data streams, so `mkdir` fails with `ENOENT`.
 * Truncating can lay a separator bare at the end, hence the second trim.
 */
function skillDirName(id: string): string {
  return (
    packageName(id)
      .slice(0, MAX_SKILL_NAME)
      .replace(/[-._]+$/, '') || 'skill'
  );
}

/**
 * Keeps two skills whose ids slug to the same name from overwriting one another
 * — the very collision the caller's namespacing exists to prevent, which a
 * lossy slug could otherwise reintroduce.
 */
function uniqueSkillDirName(name: string, taken: Set<string>): string {
  let candidate = name;
  for (let n = 2; taken.has(candidate); n += 1) {
    const suffix = `-${n}`;
    candidate = `${name.slice(0, MAX_SKILL_NAME - suffix.length)}${suffix}`;
  }
  taken.add(candidate);
  return candidate;
}

/**
 * Materialises the agent's attached skills into `<dir>/skills/<id>/` as Agent
 * Skills packages (a reconstructed `SKILL.md` with `name`/`description`
 * frontmatter plus any bundled files), and returns the virtual `skills` source
 * path for deepagents, or `undefined` when there are none. Anything left in the
 * directory by a previous turn is dropped first (see {@link resetDir}).
 */
export function materializeSkills(
  dir: string,
  skills: DeepAgentSkill[],
  subdir = SKILLS_DIR,
): string[] | undefined {
  resetDir(dir, subdir);
  if (skills.length === 0) {
    return undefined;
  }
  const skillsDir = join(dir, subdir);
  const taken = new Set<string>();
  for (const skill of skills) {
    const id = uniqueSkillDirName(skillDirName(skill.id), taken);
    const base = join(skillsDir, id);
    const description = (skill.description.trim() || skill.name || id).slice(
      0,
      MAX_SKILL_DESCRIPTION,
    );
    const frontmatter = `---\nname: ${id}\ndescription: ${JSON.stringify(description)}\n---\n\n`;
    writeFileEnsured(join(base, 'SKILL.md'), frontmatter + skill.instructions);
    for (const file of skill.files) {
      const relative = safeRelPath(file.path);
      if (relative) {
        writeFileEnsured(join(base, relative), file.content);
      }
    }
  }
  return [`/${subdir}/`];
}

/**
 * Writes the project's knowledge-base files into `<dir>/files/` and returns
 * their virtual paths (e.g. `/files/spec.md`) so the caller can list them in the
 * system prompt. Unlike skills these are plain reference documents: the agent
 * reads them with its ordinary filesystem tools rather than through deepagents'
 * skill loading. Files left by a previous turn are dropped first, so a document
 * removed from the project stops being readable. Returns `undefined` when there
 * are none.
 */
export function materializeFiles(
  dir: string,
  files: DeepAgentFile[],
  subdir = FILES_DIR,
): string[] | undefined {
  resetDir(dir, subdir);
  const paths: string[] = [];
  for (const file of files) {
    const relative = safeRelPath(file.path);
    if (!relative) {
      continue;
    }
    writeFileEnsured(join(dir, subdir, relative), file.content);
    paths.push(`/${subdir}/${relative}`);
  }
  return paths.length > 0 ? paths : undefined;
}

/**
 * The system-prompt addendum telling the agent which project reference files
 * are on disk. Without it the files are readable but invisible — the model has
 * no reason to `ls` the workspace.
 */
export function filesPromptSection(paths: string[]): string {
  return [
    '## Project files',
    'The following reference files from this project are available in your workspace.',
    'Read the ones relevant to the request before answering.',
    ...paths.map((path) => `- ${path}`),
  ].join('\n');
}

/**
 * Prepares the deepagents backend for one run. When the agent uses skills,
 * memory, or the sandbox, a per-chat directory under
 * `~/.agent-engine/deep-agents/<sessionId>` is created and used as the backend:
 * `LocalShellBackend` when the sandbox is on (adds the `execute`
 * code-interpreter, running shell on the host — no isolation), else a plain
 * `FilesystemBackend` (file tools only, no `execute`). Skills are written to
 * `/skills/`, the project's knowledge files to `/files/`, and memory seeded into
 * `/MEMORY.md` from the browser-owned content. When none of those is needed, no
 * backend is returned and deepagents falls back to its in-memory StateBackend
 * (the original behaviour).
 */
async function prepareWorkspace(
  req: DeepAgentRunRequest,
  deps: Awaited<ReturnType<typeof loadDeps>>,
): Promise<Workspace> {
  const skills = req.skills ?? [];
  const files = req.files ?? [];
  const hasMemory = req.memory !== undefined;
  const needsDisk = Boolean(req.sandbox) || hasMemory || skills.length > 0 || files.length > 0;
  if (!needsDisk) {
    return { hasMemory: false };
  }

  const dir = join(WORKSPACE_ROOT, sessionDirName(req.sessionId));
  mkdirSync(dir, { recursive: true });

  const skillsPaths = materializeSkills(dir, skills);
  const filePaths = materializeFiles(dir, files);

  let memoryPaths: string[] | undefined;
  if (hasMemory) {
    writeFileSync(join(dir, MEMORY_FILE), req.memory ?? '', 'utf8');
    memoryPaths = [`/${MEMORY_FILE}`];
  }

  const backend = req.sandbox
    ? await deps.LocalShellBackend.create({
        rootDir: dir,
        virtualMode: true,
        // Without an explicit environment the shell runs with none at all —
        // see SANDBOX_ENV_KEYS.
        env: sandboxEnv(),
        timeout: SANDBOX_COMMAND_TIMEOUT_S,
        maxOutputBytes: SANDBOX_MAX_OUTPUT_BYTES,
      })
    : new deps.FilesystemBackend({ rootDir: dir, virtualMode: true });

  return { backend, dir, skillsPaths, memoryPaths, filePaths, hasMemory };
}

/**
 * Deletes chat workspaces untouched for {@link WORKSPACE_TTL_MS}. A workspace is
 * named after its chat and nothing tells the daemon when that chat is deleted,
 * so without an age sweep `~/.agent-engine/deep-agents` only ever grows. Failures
 * are ignored: housekeeping must never stop the daemon from starting.
 */
export function sweepWorkspaces(root = WORKSPACE_ROOT, now = Date.now()): number {
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return 0; // No workspaces yet.
  }
  for (const entry of entries) {
    const path = join(root, entry);
    try {
      if (now - statSync(path).mtimeMs > WORKSPACE_TTL_MS) {
        rmSync(path, RM_RETRY);
        removed += 1;
      }
    } catch {
      // A workspace we cannot stat or remove is left for the next sweep.
    }
  }
  return removed;
}

/** Reads back the (possibly agent-updated) memory file; `fallback` if unreadable. */
function readMemory(dir: string, fallback: string): string {
  try {
    return readFileSync(join(dir, MEMORY_FILE), 'utf8');
  } catch {
    return fallback;
  }
}

/** Flattens a LangChain message chunk's `content` (string or block array) to text. */
function chunkText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
          ? (block as { text: string }).text
          : '',
      )
      .join('');
  }
  return '';
}

/** The bridged MCP tools of a run, plus the ones gated behind the meta-tool. */
export interface BridgedTools {
  /**
   * Bridged tools keyed by the raw MCP tool name, so a sub-agent's `tools`
   * allow-list (which references those names) matches.
   */
  byName: Map<string, unknown>;
  /** Model-facing names of the tools whose policy is {@link McpToolMode.Deferred}. */
  deferred: Set<string>;
}

/**
 * Bridges every scope-resolved MCP server into LangChain tools backed by the
 * connector's pooled client, honouring the source's tool policies: `disabled`
 * methods are never bridged and `deferred` ones are reported back so the caller
 * can hide them behind {@link buildDeferredGate}. The bridged tool is exposed to
 * the model under a name that avoids clashing with deepagents' built-ins (see
 * {@link uniqueExposedName}). Duplicate names across servers keep the first
 * occurrence. Bridged tools are stored as `unknown` to sidestep the dual-package
 * type-identity mismatch described on {@link StreamableAgent}.
 *
 * `signal` is the turn's abort signal and is handed to every MCP request the
 * bridged tools make. Without it Stop only closes the response the user was
 * watching, while a slow or wedged server keeps the tool call — and therefore
 * the turn — alive behind it.
 *
 * `reserved` holds names claimed by the run itself rather than by this module —
 * the request's client tools, whose names are only known per-run and so cannot
 * live in {@link CONNECTOR_TOOL_NAMES}.
 *
 * The tools bridged by one call share a {@link createMcpCallMemo}: a call an
 * agent makes twice over with the same arguments is answered from the first
 * one's result, labelled as a repeat, instead of going to the server again.
 *
 * The listings are fetched through the catalog (`mcp-catalog.ts`) and **in
 * parallel**, while the naming below runs strictly in source order: which server
 * answered first must not decide which one keeps a contested tool name.
 */
export async function bridgeTools(
  connector: Connector,
  sources: McpToolSource[],
  tool: Awaited<ReturnType<typeof loadDeps>>['tool'],
  onWarn: (message: string) => void = () => {},
  signal?: AbortSignal,
  reserved: ReadonlySet<string> = new Set(),
): Promise<BridgedTools> {
  const byName = new Map<string, unknown>();
  const deferred = new Set<string>();
  const exposedNames = new Set<string>(reserved);
  // One memo for every tool bridged here, so a call repeated verbatim is
  // answered from the turn's own record instead of from the server
  // (`mcp-call-memo.ts`).
  const memo = createMcpCallMemo();

  const listings = await Promise.all(
    sources.map(async ({ config }) => {
      try {
        return await connector.catalogTools(config, signal);
      } catch (error) {
        // A server that will not connect is silently missing from the model's
        // tool list; say so, or the agent just looks like it chose not to use it.
        onWarn(`The MCP server is unavailable: ${describeError(error)}`);
        return null;
      }
    }),
  );

  for (const [index, { config, policies }] of sources.entries()) {
    const mcpTools = listings[index];
    if (!mcpTools) {
      continue;
    }

    for (const mcpTool of mcpTools) {
      const mode = resolveToolMode(policies, mcpTool.name);
      if (mode === McpToolMode.Disabled || byName.has(mcpTool.name)) {
        continue;
      }
      const exposedName = uniqueExposedName(mcpTool.name, exposedNames);
      let bridged: unknown;
      try {
        bridged = tool(
          async (args: Record<string, unknown>): Promise<string> => {
            const repeated = memo.recall(mcpTool.name, args ?? {});
            if (repeated !== undefined) {
              return repeated;
            }
            try {
              const result = await connector.callTool(config, mcpTool.name, args ?? {}, signal);
              const text = result.content || '(empty result)';
              if (result.isError) {
                return `Error: ${text}`;
              }
              memo.remember(mcpTool.name, args ?? {}, text);
              return text;
            } catch (error) {
              // A timeout or an abort comes back as the tool's result, not as a
              // throw: one unreachable server should cost its own call, leaving
              // the model free to work around it.
              return `Error: ${error instanceof Error ? error.message : 'tool call failed'}`;
            }
          },
          {
            name: exposedName,
            description: mcpTool.description ?? '',
            // Not the server's schema verbatim: a zod-built one carries
            // `$schema`, which a strict gateway rejects with an opaque 500 for
            // every request the tool is in scope for.
            schema: toFunctionParameters(mcpTool.inputSchema),
          },
        );
      } catch (error) {
        // One unusable JSON Schema must cost its own tool, not the whole turn.
        onWarn(`Tool «${mcpTool.name}» was skipped: ${describeError(error)}`);
        continue;
      }
      if (mode === McpToolMode.Deferred) {
        deferred.add(exposedName);
      }
      exposedNames.add(exposedName);
      byName.set(mcpTool.name, bridged);
    }
  }

  return { byName, deferred };
}

/** The name/description pair every LangChain tool exposes to the model. */
interface ToolMeta {
  name: string;
  description?: string;
}

/** Reads a bridged tool's model-facing name and description through the `unknown` seam. */
function toolMeta(bridged: unknown): ToolMeta {
  return bridged as ToolMeta;
}

/**
 * The gate that keeps deferred tools out of the model's tool list until it asks
 * for them: a `mcp_load_tools` meta-tool plus the middleware that filters each
 * model call.
 */
export interface DeferredGate {
  /** The `mcp_load_tools` meta-tool; add it to the agent's tool list. */
  tool: unknown;
  /** Middleware hiding still-deferred tools from every model call. */
  middleware: unknown;
}

/**
 * Builds the deferred-tool gate for a run, or `null` when nothing is deferred.
 *
 * Deferred tools are registered with the agent like any other (so the tool node
 * can execute them), but the middleware strips them from `request.tools` on
 * every model call, leaving only the meta-tool that lists them. Calling
 * `mcp_load_tools` promotes them for the rest of the run — the loaded set lives
 * in this closure, which matches the browser's tool loop (it too rebuilds its
 * runtime per user message). Once everything is loaded the meta-tool itself
 * drops out of the tool list.
 */
export function buildDeferredGate(
  deps: Awaited<ReturnType<typeof loadDeps>>,
  bridged: BridgedTools,
): DeferredGate | null {
  const hidden = new Set(bridged.deferred);
  if (hidden.size === 0) {
    return null;
  }

  // The enum is the whole catalogue, and the description says so: this tool
  // travels in every request of the turn, so anything said twice is paid for
  // twice (see MCP_LOAD_TOOLS_DESCRIPTION).
  const names = [...hidden];

  const loadTools = deps.tool(
    (args: Record<string, unknown>): string => {
      const requested = Array.isArray(args.names)
        ? args.names.filter((name): name is string => typeof name === 'string')
        : [];
      const loaded = requested.filter((name) => hidden.delete(name));
      return loaded.length > 0
        ? `Loaded tools: ${loaded.join(', ')}. They are now callable.`
        : 'No matching tools to load.';
    },
    {
      name: MCP_LOAD_TOOLS,
      description: MCP_LOAD_TOOLS_DESCRIPTION,
      schema: mcpLoadToolsSchema(names),
    },
  );

  const middleware = deps.createMiddleware({
    name: 'DeferredMcpTools',
    wrapModelCall: (request, handler) =>
      handler({
        ...request,
        tools: request.tools.filter((entry) => {
          const { name } = toolMeta(entry);
          return name === MCP_LOAD_TOOLS ? hidden.size > 0 : !hidden.has(name);
        }),
      }),
  });

  return { tool: loadTools, middleware };
}

/**
 * JSON Schema for the built-in `ask_user` tool's arguments. Mirrors
 * {@link DeepAgentAsk} minus the connector-assigned `id`.
 */
const ASK_USER_SCHEMA = {
  type: 'object',
  properties: {
    question: { type: 'string', description: 'The question to put to the user.' },
    options: {
      type: 'array',
      items: { type: 'string' },
      description:
        'The choices offered; each is shown as a button and, when picked, sent back verbatim.',
    },
    multi: {
      type: 'boolean',
      description:
        'Set true when the user may select several options; default false (single choice).',
    },
  },
  required: ['question', 'options'],
} as const;

/**
 * Builds the built-in `ask_user` tool (human-in-the-loop): it emits an
 * `ask_user` event with the question + options, then blocks until the browser
 * answers via `POST /deepagent/answer` (which resolves the matching entry in
 * `pending`). The resolved answer becomes the tool result the model sees, so the
 * agent continues the same turn with the user's choice. Rejects if the run is
 * aborted while waiting.
 */
export function buildAskUserTool(
  tool: Awaited<ReturnType<typeof loadDeps>>['tool'],
  onEvent: EventSink,
  pending: PendingAnswers,
  signal: AbortSignal,
): unknown {
  return tool(
    async (args: Record<string, unknown>): Promise<string> => {
      const question = typeof args.question === 'string' ? args.question : '';
      const options = Array.isArray(args.options)
        ? args.options.filter((option): option is string => typeof option === 'string')
        : [];
      const multi = args.multi === true;
      if (options.length === 0) {
        return 'No options provided; ask the user in plain text instead.';
      }

      const id = randomUUID();
      onEvent({ type: 'ask_user', id, question, options, multi });
      // `onAbort` is hoisted so it can be detached again: one signal lives for
      // the whole turn, so an agent that asks repeatedly would otherwise pile
      // up listeners on it until Node warns about the leak.
      let onAbort = (): void => {};
      try {
        return await new Promise<string>((resolve, reject) => {
          onAbort = () => reject(new Error('aborted'));
          if (signal.aborted) {
            onAbort();
            return;
          }
          // The map is shared with `client_tool`, whose results carry an error
          // flag; a user picking an option only ever has text to give back.
          pending.set(id, (result) => resolve(result.text));
          signal.addEventListener('abort', onAbort, { once: true });
        });
      } finally {
        signal.removeEventListener('abort', onAbort);
        pending.delete(id);
      }
    },
    {
      name: ASK_USER_TOOL,
      description:
        'Ask the user to choose between concrete options and wait for their answer. Use this whenever you would otherwise ask the user to pick from a list; the choices are shown as buttons.',
      schema: ASK_USER_SCHEMA,
    },
  );
}

/**
 * Builds the run's {@link DeepAgentRunRequest.clientTools} — tools the model may
 * call but the connector cannot run, because their side effects exist only in
 * the browser — a drawing surface, say, writes to a store held in IndexedDB and
 * renders in a sandboxed iframe, and a Node daemon has neither.
 *
 * Each one emits a `client_tool` event and then blocks on `pending` exactly the
 * way {@link buildAskUserTool} does, until the browser executes the call and
 * answers via `POST /deepagent/client-tool`. Arguments are forwarded **verbatim**
 * rather than parsed here: the browser owns the implementation, so it owns their
 * shape too, and the connector has nothing useful to say about them.
 *
 * A definition that cannot be registered costs its own tool, not the turn — the
 * same rule bridged MCP tools follow.
 */
export function buildClientTools(
  defs: ChatCompletionTool[],
  tool: Awaited<ReturnType<typeof loadDeps>>['tool'],
  onEvent: EventSink,
  pending: PendingAnswers,
  signal: AbortSignal,
  onWarn: (message: string) => void = () => {},
): unknown[] {
  const built: unknown[] = [];

  for (const def of defs) {
    const { name, description, parameters } = def.function;
    if (RESERVED_TOOL_NAMES.has(name) || CONNECTOR_TOOL_NAMES.has(name)) {
      // `createDeepAgent` throws on a tool reusing a built-in name, which would
      // cost the whole turn instead of the one tool that clashed.
      onWarn(`Tool «${name}» was skipped: a built-in tool already has that name.`);
      continue;
    }

    try {
      built.push(
        tool(
          async (args: Record<string, unknown>): Promise<string> => {
            const id = randomUUID();
            onEvent({ type: 'client_tool', id, name, args: JSON.stringify(args ?? {}) });
            // Hoisted so it can be detached again: one signal lives for the whole
            // turn, so an agent that writes and checks repeatedly would otherwise
            // pile up listeners on it until Node warns about the leak.
            let onAbort = (): void => {};
            try {
              const result = await new Promise<PendingResult>((resolve, reject) => {
                onAbort = () => reject(new Error('aborted'));
                if (signal.aborted) {
                  onAbort();
                  return;
                }
                pending.set(id, resolve);
                signal.addEventListener('abort', onAbort, { once: true });
              });
              return result.isError ? `Error: ${result.text}` : result.text;
            } finally {
              signal.removeEventListener('abort', onAbort);
              pending.delete(id);
            }
          },
          {
            name,
            description: description ?? '',
            // Through the same normaliser as a bridged MCP schema: idempotent,
            // and the browser is not the only possible source of these.
            schema: toFunctionParameters(parameters),
          },
        ),
      );
    } catch (error) {
      onWarn(`Tool «${name}» was skipped: ${describeError(error)}`);
    }
  }

  return built;
}

/**
 * Builds the built-in `write_artifact` tool: the agent hands over a finished
 * result (document, code, page or React component) and the browser persists it
 * per chat, rendering it in its artifact panel. Non-blocking — it just emits an
 * `artifact` event and returns immediately, so the agent keeps working.
 * Re-writing the same `key` produces a new version of the same artifact.
 */
export function buildWriteArtifactTool(
  tool: Awaited<ReturnType<typeof loadDeps>>['tool'],
  onEvent: EventSink,
): unknown {
  return tool(
    (args: Record<string, unknown>): string => {
      const key = typeof args.key === 'string' ? args.key.trim() : '';
      const title = typeof args.title === 'string' ? args.title.trim() : '';
      const content = typeof args.content === 'string' ? args.content : '';
      const kind = ARTIFACT_KINDS.has(args.kind as ArtifactKind)
        ? (args.kind as ArtifactKind)
        : 'markdown';
      if (!key || !content) {
        return 'Both `key` and `content` are required to save an artifact.';
      }

      onEvent({
        type: 'artifact',
        key,
        title: title || key,
        kind,
        ...(typeof args.language === 'string' && args.language ? { language: args.language } : {}),
        content,
      });
      return `Saved artifact "${key}" (${kind}). It is now shown to the user; do not repeat its content.`;
    },
    {
      name: WRITE_ARTIFACT_TOOL,
      description: WRITE_ARTIFACT_DESCRIPTION,
      schema: WRITE_ARTIFACT_SCHEMA,
    },
  );
}

/**
 * Builds the five delegation tools, modelled on Claude Code's Agent tool and on
 * deepagents' async-subagent set (whose names and rules this borrows, see
 * {@link TASK_INSTRUCTIONS}).
 *
 * There is one delegation tool rather than two, and it runs **in the background
 * by default**. The synchronous case is the same machinery awaited: a task,
 * with a transcript of its own and a result the registry remembers. That is
 * what makes retrying the parent turn cheap — a delegation the chat has already
 * paid for is answered from the cache whichever mode it ran in — and it is why
 * deepagents' own `task` is hidden while these are offered
 * (`buildHideToolsMiddleware`).
 *
 * A refusal ({@link TaskError} — an unknown agent type, a cap reached) comes
 * back as the tool's result rather than as a thrown error: the model can read it
 * and pick another agent or wait, and a turn should not die over a delegation
 * that was not allowed.
 */
export function buildTaskTools(
  tasks: BackgroundTasks,
  parent: DeepAgentRunRequest,
  tool: Awaited<ReturnType<typeof loadDeps>>['tool'],
  onEvent: EventSink,
  signal: AbortSignal,
): unknown[] {
  /** Formats a settled task the way the delegating model should read it. */
  const report = (task: BackgroundTask): string => {
    if (task.status === 'success') {
      return `Task \`${task.taskId}\` finished.\n\n${tasks.result(task.taskId)}`;
    }
    if (task.status === 'error') {
      return `Task \`${task.taskId}\` failed: ${task.error ?? 'reason unknown'}`;
    }
    if (task.status === 'cancelled') {
      return `Task \`${task.taskId}\` was cancelled.`;
    }
    return `Task \`${task.taskId}\` is still running. Do not repeat this status later — it will be stale.`;
  };

  const delegate = tool(
    async (args: Record<string, unknown>): Promise<string> => {
      const agentName = typeof args.subagent_type === 'string' ? args.subagent_type : '';
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
      const title = typeof args.description === 'string' ? args.description : '';
      // Background unless explicitly told otherwise — the same default Claude
      // Code's Agent tool has, and the reason the parent's context stays clean.
      const background = args.run_in_background !== false;
      if (!prompt) {
        return 'A `prompt` is required: the agent starts from an empty context and knows only what you write to it.';
      }

      let started;
      try {
        started = tasks.start({ parent, agentName, title, prompt });
      } catch (error) {
        if (error instanceof TaskError) {
          return error.message;
        }
        throw error;
      }

      const { task, cached } = started;
      onEvent({ type: 'task_started', task, ...(cached ? { cached: true } : {}) });
      if (cached) {
        return `This task has already run in this chat — here is its result, there is no need to start it again.\n\n${report(task)}`;
      }
      if (!background) {
        const settled = await tasks.wait(task.taskId, signal);
        onEvent({ type: 'task_status', taskId: settled.taskId, status: settled.status });
        return report(settled);
      }
      return `Started background task \`${task.taskId}\` («${task.title}», agent ${task.agentName}). Tell the user and end your turn — you will collect the result later with \`check_task\`.`;
    },
    {
      name: DELEGATE_TASK_TOOL,
      // Short on purpose: these five tools only exist when `taskPromptSection`
      // is in the system prompt, and it already carries the whole delegation
      // policy. Repeating it here would put it in every request twice.
      description:
        'Hand a self-contained piece of work to another agent and get a taskId back. Runs in the background unless told otherwise.',
      schema: DELEGATE_TASK_SCHEMA,
    },
  );

  const check = tool(
    (args: Record<string, unknown>): string => {
      const taskId = typeof args.taskId === 'string' ? args.taskId : '';
      const task = tasks.get(taskId);
      return task ? report(task) : `Task \`${taskId}\` was not found.`;
    },
    {
      name: CHECK_TASK_TOOL,
      description: 'Current status of one task, with its full result once it is done.',
      schema: TASK_ID_SCHEMA,
    },
  );

  const list = tool(
    (): string => {
      const all = tasks.list(parent.sessionId);
      if (all.length === 0) {
        return 'There are no background tasks in this chat.';
      }
      return all
        .map((task) => `\`${task.taskId}\` · ${task.agentName} · ${task.status} — «${task.title}»`)
        .join('\n');
    },
    {
      name: LIST_TASKS_TOOL,
      description: 'Live statuses of every task in this chat, and their ids.',
      schema: NO_ARGS_SCHEMA,
    },
  );

  const send = tool(
    async (args: Record<string, unknown>): Promise<string> => {
      const taskId = typeof args.taskId === 'string' ? args.taskId : '';
      const message = typeof args.message === 'string' ? args.message.trim() : '';
      if (!message) {
        return 'A non-empty `message` is required.';
      }
      try {
        const task = await tasks.message(taskId, message);
        onEvent({ type: 'task_status', taskId: task.taskId, status: task.status });
        return `Task \`${task.taskId}\` received the follow-up and is carrying on.`;
      } catch (error) {
        return error instanceof TaskError ? error.message : `Failed: ${describeError(error)}`;
      }
    },
    {
      name: SEND_TO_TASK_TOOL,
      description:
        'Send follow-up instructions to a task; it keeps its own context and carries on rather than starting over.',
      schema: SEND_TO_TASK_SCHEMA,
    },
  );

  const stop = tool(
    (args: Record<string, unknown>): string => {
      const taskId = typeof args.taskId === 'string' ? args.taskId : '';
      try {
        const task = tasks.stop(taskId);
        onEvent({ type: 'task_status', taskId: task.taskId, status: task.status });
        return `Task \`${task.taskId}\`: ${task.status}.`;
      } catch (error) {
        return error instanceof TaskError ? error.message : `Failed: ${describeError(error)}`;
      }
    },
    {
      name: STOP_TASK_TOOL,
      description: 'Cancel a task that is no longer needed. A finished task is left as it is.',
      schema: TASK_ID_SCHEMA,
    },
  );

  return [delegate, check, list, send, stop];
}

/** What a run's sub-agents are assembled from. See {@link buildSubAgents}. */
export interface SubAgentContext {
  /** Bridged MCP tools, for resolving an allow-list by its raw tool names. */
  bridged: BridgedTools;
  /** The main agent's full tool list, inherited when there is no allow-list. */
  tools: unknown[];
  /** The connector's own tools, granted on top of any allow-list. */
  builtins: unknown[];
  /** The deferred-tool gate, inherited along with the full tool list. */
  gate: DeferredGate | null;
  /**
   * The middleware repairing unparseable tool-call arguments. Granted whatever
   * else a sub-agent gets, because a delegation that ends on a broken call is
   * indistinguishable from one that decided to do nothing.
   */
  repair: unknown;
  /** Skill source paths — deepagents does not pass the parent's down itself. */
  skillsPaths?: string[];
  /** Reports a degraded sub-agent (an allow-list that resolved to nothing). */
  onWarn: (message: string) => void;
}

/**
 * Maps the configured sub-agents onto deepagents' `subagents[]`.
 *
 * A sub-agent with an explicit allow-list gets exactly those MCP tools (the
 * author asked for them, deferred or not) plus this connector's built-ins —
 * without them a delegation could neither ask the user anything nor save its
 * result. One that inherits the full set also inherits the deferred gate, so it
 * sees the same trimmed tool list as the main agent. Skills are passed
 * explicitly because deepagents gives custom sub-agents none of the parent's.
 *
 * An allow-list that resolves to nothing (a server that is down, a renamed
 * method) falls back to the full set: a sub-agent with zero tools looks like a
 * model that refuses to work, which is far harder to diagnose than a warning.
 */
export function buildSubAgents(subAgents: DeepAgentSubAgent[], ctx: SubAgentContext): unknown[] {
  return subAgents.map((sub) => {
    const requested = sub.tools ?? [];
    const resolved = requested
      .map((name) => ctx.bridged.byName.get(name))
      .filter((entry) => entry !== undefined);
    if (requested.length > 0 && resolved.length === 0) {
      ctx.onWarn(
        `Sub-agent «${sub.name}»: none of the tools ${requested.join(', ')} were found — it was given the full set.`,
      );
    }
    const allowList = resolved.length > 0 ? [...ctx.builtins, ...resolved] : null;

    return {
      name: sub.name,
      description: sub.description,
      systemPrompt: sub.systemPrompt,
      tools: allowList ?? ctx.tools,
      middleware: [...(ctx.gate && !allowList ? [ctx.gate.middleware] : []), ctx.repair],
      ...(ctx.skillsPaths ? { skills: ctx.skillsPaths } : {}),
    };
  });
}

/**
 * Runs one deep-agent turn with `deepagentsjs` and streams progress back through
 * `onEvent`: assistant text, the live plan (`todos`), and each tool call /
 * sub-agent delegation with its completion. The model is an OpenAI-compatible
 * client pointed at the gateway this daemon adopted, carrying the user's own
 * token — both from the configuration handed over when the browser connected
 * (`config/engine-config.ts`), never from this request and never stored on
 * disk. MCP tools execute locally via the shared connection pool. The built-in
 * `ask_user` tool blocks on `pending` for human-in-the-loop choices.
 */
export interface RunOptions {
  /**
   * The task registry, when this run may delegate. Given, and with
   * `req.allowTasks` set, the run gets the `delegate_task` family and loses
   * deepagents' `task`; a run *inside* a task gets neither — delegation is one
   * level deep.
   */
  tasks?: BackgroundTasks;
  /**
   * Whether the agent may ask the user. False for a background task: it blocks
   * on a browser that may have closed the tab, so the question would hang the
   * task forever instead of being answered.
   */
  askUser?: boolean;
  /**
   * Whether the turn's text is streamed token by token (`llm/token-stream.ts`)
   * rather than one message per completed step. On for a run somebody is
   * watching; off for a background task, whose events are also its replay
   * buffer (`tasks/tasks.constants.ts`) — tokens would fill it and push the
   * turn's early tool calls out of the record a reconnecting browser reads.
   */
  tokens?: boolean;
}

export async function runDeepAgentStream(
  connector: Connector,
  searxng: SearxngContainer,
  req: DeepAgentRunRequest,
  onEvent: EventSink,
  signal: AbortSignal,
  pending: PendingAnswers,
  options: RunOptions = {},
): Promise<void> {
  // Everything below runs before the model is called, and none of it is visible
  // from the chat — which is why «the answer takes forever» is so often blamed
  // on the model (`turn-timer.ts`).
  const timer = createTurnTimer('deepagent');
  let spoken = false;
  // How much of the turn the agent chose to plan and delegate, counted for the
  // timing line (see the `finally` below).
  let planned = 0;
  let delegated = 0;
  const emit: EventSink = timer.enabled
    ? (event) => {
        if (event.type === 'text' && !spoken) {
          spoken = true;
          timer.note('firstToken', `${timer.since()}ms`);
        }
        if (event.type === 'todos') {
          planned += 1;
        }
        if (event.type === 'task_started') {
          delegated += 1;
        }
        onEvent(event);
      }
    : onEvent;

  const deps = await loadDeps();
  const { createDeepAgent, ChatOpenAI, tool } = deps;
  timer.mark('deps');

  const warn = (message: string): void => emit({ type: 'error', message, fatal: false });

  // Aborted when the answer starts repeating itself, which nothing else in the
  // turn can notice: the loop is written inside one model call, so no graph step
  // ends and the step budget below never applies. Separate from the turn's own
  // signal so the two remain distinguishable — the user's Stop is not an outcome
  // to report, this is (`llm/repetition.ts`).
  const guard = new AbortController();
  let stuck = false;

  // The turn's text, token by token, for a run somebody is watching. Its
  // callbacks belong to this model instance alone, and its middleware to the
  // main agent alone — that is what scopes the stream to the answer the user is
  // reading (`llm/token-stream.ts`).
  const tokenStream = options.tokens
    ? createTokenStream(
        deps.createMiddleware,
        (delta) => emit({ type: 'text', delta }),
        (repetition) => {
          stuck = true;
          warn(repetitionMessage(repetition));
          guard.abort();
        },
      )
    : null;

  // The graph runs under both: whichever fires first ends the turn, and which
  // one it was decides how the turn is recorded (see `interrupted` below).
  const turnSignal = tokenStream ? AbortSignal.any([signal, guard.signal]) : signal;

  // Sampling params come from the agent (see DeepAgentModelParams); the gateway
  // and the streaming shim are this daemon's own (see `llm/chat-model.ts`).
  //
  // A rejected attempt is reported rather than swallowed: the retry that follows
  // it is where a turn's minutes go, and it happens behind a backoff that says
  // nothing. The last attempt reports too — if the call never succeeds, the run
  // fails on its own and this only explains what was tried.
  const model = buildChatModel(ChatOpenAI, req.llm, tokenStream?.callbacks, (attempt) =>
    warn(gatewayAttemptMessage(attempt)),
  );

  const workspace = await prepareWorkspace(req, deps);
  timer.mark('workspace');

  // Client tools are named before bridging so an MCP server exposing the same
  // name is renamed around them, rather than putting two same-named tools in
  // the list handed to the model.
  const clientToolNames = new Set((req.clientTools ?? []).map((def) => def.function.name));
  const bridged = await bridgeTools(connector, req.tools, tool, warn, signal, clientToolNames);
  timer.mark(`mcp[${req.tools.length}]`);
  const askUser = options.askUser === false ? null : buildAskUserTool(tool, emit, pending, signal);
  const gate = buildDeferredGate(deps, bridged);
  // Web search rides in `builtins` so a sub-agent with its own tool allow-list
  // keeps it: research delegated to a specialist that cannot search is the one
  // delegation that is certain to come back empty.
  const web = await buildSearchTools(
    tool,
    { config: resolveSearchConfig(), container: searxng },
    signal,
  );
  timer.mark('search');
  // Client tools ride in `builtins` for the same reason — and a host whose own
  // canvas is the deliverable turns off `write_artifact`, because offering both
  // invites the model to save its screen as an artifact nobody would open.
  const clientTools = buildClientTools(req.clientTools ?? [], tool, emit, pending, signal, warn);
  // Delegation replaces deepagents' `task` rather than joining it, so the tools
  // and the middleware that hides the built-in travel together.
  const delegating = Boolean(options.tasks && req.allowTasks);
  const taskTools = delegating ? buildTaskTools(options.tasks!, req, tool, emit, signal) : [];
  const builtins = [
    ...(askUser ? [askUser] : []),
    ...(req.artifacts === false ? [] : [buildWriteArtifactTool(tool, emit)]),
    ...web,
    ...clientTools,
    ...taskTools,
  ];
  const tools = [...builtins, ...bridged.byName.values(), ...(gate ? [gate.tool] : [])];

  // Not optional and not conditional: without it a model answer whose tool-call
  // arguments will not parse leaves the graph through its exit node, and the
  // turn stops mid-work with nothing said. See `repair-tool-calls.ts`.
  const repair = buildToolCallRepairMiddleware(deps.createMiddleware, warn);

  const subagents = buildSubAgents(req.subAgents, {
    bridged,
    tools,
    builtins,
    gate,
    repair,
    ...(workspace.skillsPaths ? { skillsPaths: workspace.skillsPaths } : {}),
    onWarn: warn,
  });

  // Project files are readable but invisible until the prompt names them, so
  // their paths are appended to the agent's own instructions. The shell notice
  // is only ever non-empty on Windows, and only matters when there is a shell at
  // all — without the sandbox the agent has no `execute` tool to misuse.
  const systemPrompt = [
    req.instructions,
    workspace.filePaths ? filesPromptSection(workspace.filePaths) : '',
    req.sandbox ? hostShellPromptSection() : '',
    delegating ? taskPromptSection(req.subAgents, req.tasks ?? []) : '',
    // Last, so the plan the turn is continuing is the final thing read before
    // the conversation itself (`plan/plan-prompt.ts`).
    req.todos?.length ? planPromptSection(req.todos) : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const params = {
    model,
    ...(systemPrompt ? { systemPrompt } : {}),
    tools,
    subagents,
    // The repair is appended last, which makes it the innermost wrapper: it sees
    // the model's answer before anything else does, so no other middleware ever
    // reads a call that is about to be moved back into `tool_calls`. The token
    // stream sits just outside it, and inside everything deepagents installs —
    // which is what keeps the summarizer's own call, made further out, from
    // being read as the answer.
    //
    // Planning leads, because it is the one entry here that is not about the
    // shape of a request but about the tool list itself: deepagents no longer
    // installs it, and without it the agent has no `write_todos` at all
    // (`plan/plan-middleware.ts`).
    middleware: [
      buildPlanMiddleware(deps.todoListMiddleware),
      // Directly after it, because it is the same subject seen from the other
      // side: the tool exists, and this is what makes the agent reach for it
      // while the work is happening rather than never (`plan/plan-nudge.ts`).
      buildPlanNudgeMiddleware(deps.createMiddleware, {
        ...(req.requirePlan ? { requirePlan: true } : {}),
        delegating,
      }),
      ...(gate ? [gate.middleware] : []),
      ...(delegating
        ? [buildHideToolsMiddleware(deps.createMiddleware, HIDDEN_BUILTIN_TOOLS)]
        : []),
      ...(tokenStream ? [tokenStream.middleware] : []),
      repair,
    ],
    ...(workspace.backend ? { backend: workspace.backend } : {}),
    ...(workspace.skillsPaths ? { skills: workspace.skillsPaths } : {}),
    ...(workspace.memoryPaths ? { memory: workspace.memoryPaths } : {}),
  };
  const agent = createDeepAgent(
    params as unknown as Parameters<typeof createDeepAgent>[0],
  ) as unknown as StreamableAgent;
  timer.mark('build');
  // Ours only — deepagents adds its filesystem set and `write_todos` on top, so
  // the model's list is longer than this number.
  timer.note('ourTools', tools.length);

  try {
    await streamAgentUpdates(
      agent,
      {
        messages: toAgentMessages(req.messages),
        ...(req.todos?.length ? { todos: req.todos } : {}),
      },
      emit,
      turnSignal,
      {
        previewChars: TOOL_PREVIEW_CHARS,
        // A turn cut for repeating itself ends like one out of steps: what it
        // wrote before it got stuck stands. The user's own Stop takes precedence,
        // because a turn they stopped is not an outcome to report back to them.
        interrupted: () => (stuck && !signal.aborted ? 'limit' : null),
        ...(tokenStream ? { streamedIds: tokenStream.streamedIds } : {}),
      },
    );
  } finally {
    // Whether the turn planned and whether it delegated, on the same line as
    // where its time went: both are behaviours we tune (`plan/plan-nudge.ts`),
    // and tuning them from the chat window alone is guesswork.
    timer.note('plan', planned);
    timer.note('tasks', delegated);
    // However the turn ended — answered, stopped, or thrown out of — the line is
    // written once, so a turn that failed is as measurable as one that did not.
    timer.done();
  }

  // The agent may have edited its memory during the turn; stream the final
  // `MEMORY.md` back so the browser (the source of truth) can persist it.
  if (workspace.hasMemory && workspace.dir && !signal.aborted) {
    emit({ type: 'memory', content: readMemory(workspace.dir, req.memory ?? '') });
  }
}

/**
 * One history message as handed to the graph. The `id` is ours on purpose: a
 * langchain middleware node returns the *whole* message list as its state
 * update (see {@link streamAgentUpdates}), so without stable ids the previous
 * turns' assistant messages would be replayed as fresh output.
 */
/** One tool call as langchain wants it: arguments already parsed into an object. */
export interface AgentToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * A history message as handed to the graph. Assistant turns may carry the tool
 * calls they made, and `tool` messages carry the results — without them the agent
 * starts each turn unable to recall which files it read or edited in the last one,
 * and the in-graph summarizer and tool-output eviction have nothing to work on.
 */
export interface AgentMessage {
  role: string;
  content: string;
  id: string;
  tool_calls?: AgentToolCall[];
  tool_call_id?: string;
  name?: string;
}

/** One history message as the browser sends it (OpenAI shape). */
interface HistoryMessage {
  role: string;
  content?: string | null;
  tool_calls?: {
    id: string;
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
  name?: string;
}

/**
 * Converts a run request's history into graph input.
 *
 * OpenAI encodes tool arguments as a JSON *string*, langchain wants an object, so
 * a call whose arguments will not parse (a truncated replay) is dropped together
 * with its result — half a pair is exactly the shape a provider rejects. What
 * survives goes through {@link pairToolMessages} as a final sweep.
 *
 * `parseToolArguments` repairs before it gives up, so only a genuinely truncated
 * call is dropped: a complete object with noise after it — how a streamed
 * zero-argument call tends to come back — keeps the work it stands for.
 */
export function toAgentMessages(messages: HistoryMessage[]): AgentMessage[] {
  const dropped = new Set<string>();

  const converted = messages.map((message, index): AgentMessage => {
    const base = {
      role: message.role,
      content: message.content ?? '',
      id: `hist-${index}`,
    };

    if (message.role === 'tool') {
      return {
        ...base,
        ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
        ...(message.name ? { name: message.name } : {}),
      };
    }

    const calls = (message.tool_calls ?? []).flatMap((call): AgentToolCall[] => {
      const args = parseToolArguments(call.function.arguments);
      if (args === null) {
        dropped.add(call.id);
        return [];
      }
      return [{ id: call.id, name: call.function.name, args }];
    });

    return { ...base, ...(calls.length > 0 ? { tool_calls: calls } : {}) };
  });

  return pairToolMessages(
    converted.filter(
      (message) => message.tool_call_id === undefined || !dropped.has(message.tool_call_id),
    ),
  );
}

/**
 * Makes every tool call and result line up, which is the one invariant providers
 * enforce: a `tool` message whose call is not above it is rejected, and so is a
 * call left without an answer.
 *
 * An orphaned result is dropped — there is nothing to attach it to. A call with
 * no result gets a synthesized one instead of being dropped, because the call is
 * evidence of work the agent did, and «the result was not stored» is a truer account
 * of a turn that was interrupted than pretending it never happened.
 */
export function pairToolMessages(messages: AgentMessage[]): AgentMessage[] {
  const answered = new Set(
    messages.map((message) => message.tool_call_id).filter((id): id is string => id !== undefined),
  );
  const called = new Set(
    messages.flatMap((message) => (message.tool_calls ?? []).map((call) => call.id)),
  );

  const result: AgentMessage[] = [];
  for (const message of messages) {
    if (message.tool_call_id !== undefined && !called.has(message.tool_call_id)) {
      continue;
    }
    result.push(message);
    for (const call of message.tool_calls ?? []) {
      if (!answered.has(call.id)) {
        result.push({
          role: 'tool',
          content: '(the result was not stored)',
          id: `${message.id}-missing-${call.id}`,
          tool_call_id: call.id,
          name: call.name,
        });
        answered.add(call.id);
      }
    }
  }
  return result;
}

/**
 * How a turn's tool activity is projected into progress events.
 *
 * The chat path hides deepagents' built-ins as noise, but on the Code path they
 * *are* the work — while the agent edits files and runs builds a chat-shaped
 * timeline would show nothing at all. `visibleBuiltins` opts those tools back in
 * and `previewChars` attaches the head of each tool's output, so a failing test
 * run is readable without asking the agent to repeat it.
 */
export interface StreamProjection {
  /** Built-in tool names to surface as steps (default: none). */
  visibleBuiltins?: ReadonlySet<string>;
  /** When set, `tool_result` carries this many characters of the tool output. */
  previewChars?: number;
  /**
   * How many characters of a call's arguments travel back on its `tool_call`
   * (default {@link TOOL_ARGS_CHARS}). The Code path raises it because those
   * arguments are what the *next* turn replays the call from — truncated JSON
   * cannot be replayed at all, so the step degrades to a text summary instead.
   */
  argsChars?: number;
  /**
   * Messages whose text has already been streamed token by token
   * (`llm/token-stream.ts`), so the completed step does not send it a second
   * time. Live: the set fills as the turn runs, and is read at the moment each
   * message is projected.
   */
  streamedIds?: ReadonlySet<string>;
  /**
   * Asked, whenever the stream ends in an abort, whether something other than
   * the user stopped it. `'limit'` ends the turn the way an exhausted step
   * budget does — cut short, but everything written so far stands; `null` (or an
   * absent callback) means it really was Stop.
   *
   * The caller answers rather than this function, because it owns the guards it
   * aborted with: the repetition watch is one (`runDeepAgentStream`), and
   * telling its abort from the user's is a question only that scope can settle.
   */
  interrupted?: () => 'limit' | null;
}

/**
 * What a turn starts from: the conversation, plus the state seeded alongside it.
 *
 * A bare message array is still accepted, and means the same thing as
 * `{ messages }` — most callers (and every test) have nothing to seed. The one
 * thing that is seeded is the plan: langchain's todo middleware owns a `todos`
 * channel, and handing it the previous turn's list is what lets the agent
 * *continue* a plan instead of writing a new one each turn (see
 * `DeepAgentRunRequest.todos`).
 */
export interface AgentTurnInput {
  messages: AgentMessage[];
  todos?: DeepAgentTodo[];
}

/**
 * Streams a compiled `deepagents` agent's turn, projecting each langgraph
 * `updates` step into {@link DeepAgentStreamEvent}s: the plan (`todos`),
 * assistant text, tool calls / sub-agent delegations, and their completions.
 * Shared by both the deep-agent (`/deepagent/stream`) and Code (`/code/stream`)
 * paths so the projection logic lives in one place. Rethrows any stream failure
 * with the deepest available detail (see {@link describeError}), except an
 * exhausted step budget, which ends the turn as a `limit` event — the work done
 * so far stands, so it is an outcome rather than a failure.
 *
 * A middleware node's state update is not a delta: langchain merges the hook's
 * result over the whole state, so every such update carries the entire message
 * list — the input history included. Each message is therefore projected at most
 * once, keyed by its id (the history's ids come from {@link toAgentMessages}),
 * which is what keeps a new turn from replaying the previous answer. That same
 * dedupe is where each model call's token usage is counted, so the turn's spend
 * is summed exactly once per message.
 */
export async function streamAgentUpdates(
  agent: StreamableAgent,
  input: AgentMessage[] | AgentTurnInput,
  onEvent: EventSink,
  signal: AbortSignal,
  projection: StreamProjection = {},
): Promise<void> {
  const { messages, todos } = Array.isArray(input) ? { messages: input, todos: undefined } : input;
  const seenMessages = new Set<string>(messages.map((message) => message.id));
  // Seeded from the input history, not empty. A middleware node's update carries
  // the *whole* message list, and that list now contains the previous turns' tool
  // calls — so without this the browser would be handed `tool_call` /
  // `tool_result` events for work it already has on screen, and every step of
  // every earlier turn would be replayed as if it were happening again.
  const seenCalls = new Set<string>(
    messages.flatMap((message) => (message.tool_calls ?? []).map((call) => call.id)),
  );
  const seenResults = new Set<string>(
    messages.map((message) => message.tool_call_id).filter((id): id is string => id !== undefined),
  );
  // Reported once per turn: the middleware re-emits its event on every subsequent
  // state merge, and one compaction is one thing that happened.
  let summarized = false;
  // The plan as the browser last saw it — the seeded one to begin with, since
  // that is the card already on its screen.
  let lastPlan: DeepAgentTodo[] = todos ?? [];
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  /** Calls announced to the browser that have not reported back yet. */
  const inFlight = new Set<string>();
  let ending: 'ok' | 'aborted' | 'limit' | 'failed' = 'ok';

  /**
   * Closes out every call still in flight when the turn ends.
   *
   * A `tool_call` without a matching `tool_result` leaves the step spinning, and
   * the browser persists the transcript — so a sub-agent whose graph threw, or
   * one cut short by the step budget, used to leave a spinner that survived a
   * reload with no way to clear it. There are several ways to reach that state
   * (a raised exception never becomes a tool message, the recursion limit ends
   * the stream mid-call, an abort breaks the loop), so it is settled here, once,
   * rather than at each of them.
   */
  const settleInFlight = (): void => {
    if (inFlight.size === 0) {
      return;
    }
    const preview = {
      ok: 'The turn ended while this call was still running.',
      aborted: 'Stopped by the user.',
      limit: 'The per-turn step limit was reached.',
      failed: 'The turn was cut short by an error.',
    }[ending];
    for (const id of inFlight) {
      onEvent({ type: 'tool_result', id, isError: true, interrupted: true, preview });
    }
    inFlight.clear();
  };

  /**
   * Records how a turn that ended in an abort ended: the user's Stop, or a guard
   * of the caller's that cut it short. Both arrive here as the same aborted
   * signal, and only {@link StreamProjection.interrupted} can tell them apart.
   */
  const cutShort = (): void => {
    if (projection.interrupted?.() === 'limit') {
      ending = 'limit';
      onEvent({ type: 'limit' });
      return;
    }
    ending = 'aborted';
  };

  try {
    const stream = await agent.stream(
      // The plan is seeded only when there is one: passing an empty array would
      // be indistinguishable from a plan the agent had just cleared.
      { messages, ...(todos?.length ? { todos } : {}) },
      { streamMode: 'updates', signal, recursionLimit: AGENT_RECURSION_LIMIT },
    );
    for await (const update of stream) {
      if (signal.aborted) {
        cutShort();
        break;
      }
      // Each update is keyed by the graph node that produced it. Project each
      // node's state-delta into progress events: the plan (`todos`), assistant
      // text, tool calls / sub-agent delegations (from AI-message `tool_calls`),
      // and their completions (tool-result messages). Sub-agent internals surface
      // only as their delegation's final result (a v1 boundary).
      for (const nodeUpdate of Object.values(update)) {
        const delta = nodeUpdate as
          { todos?: unknown; messages?: unknown[]; _summarizationEvent?: unknown } | undefined;

        // Only a plan that has actually changed is an event. Every state merge
        // carries the whole `todos` channel, and the turn now starts with the
        // previous turn's plan already in it — so without this the browser would
        // be handed the plan it drew last turn as a fresh card, before the agent
        // had done anything at all.
        const plan = toTodos(delta?.todos);
        if (plan && !samePlan(plan, lastPlan)) {
          lastPlan = plan;
          onEvent({ type: 'todos', todos: plan });
        }

        // The summarizer compacted the history mid-turn. Surfaced because a
        // silently shrinking context is indistinguishable, from the outside, from
        // an agent that has started forgetting.
        const compaction = toCompaction(delta?._summarizationEvent, messages.length);
        if (compaction !== null && !summarized) {
          summarized = true;
          onEvent({ type: 'summarized', keptMessages: compaction });
        }

        if (!Array.isArray(delta?.messages)) {
          continue;
        }
        for (const message of delta.messages) {
          if (isAiMessage(message)) {
            const id = (message as { id?: unknown }).id;
            if (typeof id === 'string') {
              if (seenMessages.has(id)) {
                continue;
              }
              seenMessages.add(id);
            }
            addUsage(usage, message);
            // The text of a message the user has already watched being written
            // is not sent again — only the rest of what the completed step says
            // about it (its tool calls, its token spend) is new here.
            const streamed = typeof id === 'string' && projection.streamedIds?.has(id);
            const text = streamed ? '' : chunkText((message as { content?: unknown }).content);
            if (text) {
              onEvent({ type: 'text', delta: text });
            }
            for (const event of toolCallEvents(
              message,
              projection.visibleBuiltins,
              projection.argsChars,
            )) {
              if (event.type === 'tool_call' && !seenCalls.has(event.id)) {
                seenCalls.add(event.id);
                inFlight.add(event.id);
                onEvent(event);
              }
            }
          } else if (isToolMessage(message)) {
            const msg = message as { tool_call_id?: unknown; status?: unknown; content?: unknown };
            if (typeof msg.tool_call_id === 'string' && !seenResults.has(msg.tool_call_id)) {
              seenResults.add(msg.tool_call_id);
              inFlight.delete(msg.tool_call_id);
              const full = chunkText(msg.content);
              const preview = projection.previewChars
                ? truncate(full, projection.previewChars)
                : '';
              onEvent({
                type: 'tool_result',
                id: msg.tool_call_id,
                isError: msg.status === 'error',
                ...(preview ? { preview } : {}),
                ...(projection.previewChars && full.length > projection.previewChars
                  ? { truncated: true }
                  : {}),
              });
            }
          }
        }
      }
    }
  } catch (error) {
    // A turn the user stopped is not a failure, and it now *throws* one: with
    // the text streaming, the abort lands inside the model call rather than
    // between two graph steps, so the graph never gets to notice the signal on
    // its own. Settle what was running and end quietly — the browser records the
    // turn as stopped, keeping everything it already wrote.
    if (signal.aborted || isAbortError(error)) {
      cutShort();
      settleInFlight();
      return;
    }
    // Log the raw error for the daemon operator, then rethrow with the deepest
    // available detail (e.g. the API's validation `message`, or the provider's
    // own error text) instead of the opaque `400 "BAD_REQUEST"` status line.
    console.error('[agent] stream failed:', error);
    if (!isRecursionLimit(error)) {
      ending = 'failed';
      settleInFlight();
      throw new Error(describeError(error), { cause: error });
    }
    // Out of steps, not broken: report the cap and let the caller finish the
    // turn normally, keeping the text, plan and tool results already streamed.
    ending = 'limit';
    onEvent({ type: 'limit' });
  }

  settleInFlight();

  if (usage.total_tokens > 0 && !signal.aborted) {
    onEvent({ type: 'usage', usage });
  }
}

/**
 * True for langgraph's `GraphRecursionError` — matched by name so this module
 * does not have to import from `@langchain/langgraph` eagerly and undo the
 * lazy-loading that keeps the base daemon light.
 */
/**
 * True for the two shapes a cancelled model call arrives in: the `AbortError`
 * `fetch` raises when the signal fires mid-request, and langchain's own
 * `ModelAbortError`, which carries the partial answer instead.
 */
function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === 'AbortError' || error.name === 'ModelAbortError')
  );
}

function isRecursionLimit(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'GraphRecursionError' || error.message.includes('Recursion limit'))
  );
}

/**
 * How many messages a summarization kept, or `null` when the update carries no
 * summarization event. deepagents stores `{ cutoffIndex, summaryMessage, filePath }`
 * rather than rewriting the message list, so the count is what survives the cut.
 */
function toCompaction(event: unknown, total: number): number | null {
  if (!event || typeof event !== 'object') {
    return null;
  }
  const cutoff = (event as { cutoffIndex?: unknown }).cutoffIndex;
  if (typeof cutoff !== 'number') {
    return null;
  }
  return Math.max(total - cutoff, 0);
}

/**
 * Adds one AI message's reported token usage to the turn's running total. The
 * connector calls the model itself, so this is the only place a deep-agent turn
 * can learn what it spent; LangChain normalises every provider's counters onto
 * `usage_metadata`.
 */
function addUsage(total: CompletionUsage, message: unknown): void {
  const metadata = (message as { usage_metadata?: unknown }).usage_metadata;
  if (!metadata || typeof metadata !== 'object') {
    return;
  }
  const { input_tokens: input, output_tokens: output } = metadata as Record<string, unknown>;
  total.prompt_tokens += typeof input === 'number' ? input : 0;
  total.completion_tokens += typeof output === 'number' ? output : 0;
  total.total_tokens = total.prompt_tokens + total.completion_tokens;
}

/** Reads a langgraph state message's type (`ai`, `tool`, …), tolerating either accessor. */
function messageType(message: unknown): string | undefined {
  if (!message || typeof message !== 'object') {
    return undefined;
  }
  const msg = message as { getType?: () => string; _getType?: () => string };
  if (typeof msg.getType === 'function') {
    return msg.getType();
  }
  if (typeof msg._getType === 'function') {
    return msg._getType();
  }
  return undefined;
}

/** True when a langgraph state message is an assistant (AI) message. */
function isAiMessage(message: unknown): boolean {
  return messageType(message) === 'ai';
}

/** True when a langgraph state message is a tool-result message. */
function isToolMessage(message: unknown): boolean {
  return messageType(message) === 'tool';
}

/** True when two plans say the same thing, item for item. */
function samePlan(left: DeepAgentTodo[], right: DeepAgentTodo[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (todo, index) =>
        todo.content === right[index]?.content && todo.status === right[index]?.status,
    )
  );
}

/** Validates the `todos` state-delta into the contract shape, or `null` if absent/malformed. */
function toTodos(value: unknown): DeepAgentTodo[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const todos: DeepAgentTodo[] = [];
  for (const item of value) {
    if (item && typeof item === 'object') {
      const { content, status } = item as { content?: unknown; status?: unknown };
      if (
        typeof content === 'string' &&
        (status === 'pending' || status === 'in_progress' || status === 'completed')
      ) {
        todos.push({ content, status });
      }
    }
  }
  return todos;
}

/** Argument names, in priority order, that best describe a tool call. */
const LABEL_ARG_KEYS = ['command', 'file_path', 'path', 'pattern', 'notebook_path', 'query', 'url'];

/** Collapses whitespace and cuts `text` to `limit` characters. */
function truncate(text: string, limit: number): string {
  const flat = text.trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * The most telling argument of a tool call, for the step row's label: the shell
 * command, the file path, the search pattern. Without it a Code timeline reads as
 * a list of bare tool names.
 */
function toolLabel(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') {
    return undefined;
  }
  const record = args as Record<string, unknown>;
  for (const key of LABEL_ARG_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return truncate(value.replace(/\s+/g, ' '), 120);
    }
  }
  return undefined;
}

/**
 * The call's arguments as compact JSON, for the expanded step row: `label` shows
 * one argument, this shows what was really passed. Empty when there are none.
 */
function toolArgs(
  args: unknown,
  limit: number = TOOL_ARGS_CHARS,
): { args: string; truncated: boolean } | undefined {
  if (!args || typeof args !== 'object' || Object.keys(args as object).length === 0) {
    return undefined;
  }
  try {
    const raw = JSON.stringify(args);
    return { args: truncate(raw, limit), truncated: raw.length > limit };
  } catch {
    return undefined;
  }
}

/**
 * Projects an AI message's `tool_calls` into `tool_call` progress events. The
 * built-in `task` tool is surfaced as a sub-agent delegation (its `subagent_type`
 * / `description` args). Built-ins are skipped as timeline noise unless the caller
 * opts them in via `visibleBuiltins` (the Code path does — see
 * {@link StreamProjection}); `write_todos` stays hidden either way because the
 * plan card already reflects it.
 */
export function toolCallEvents(
  message: unknown,
  visibleBuiltins: ReadonlySet<string> = new Set(),
  argsChars: number = TOOL_ARGS_CHARS,
): DeepAgentStreamEvent[] {
  const calls = (message as { tool_calls?: unknown }).tool_calls;
  if (!Array.isArray(calls)) {
    return [];
  }
  const events: DeepAgentStreamEvent[] = [];
  for (const call of calls) {
    if (!call || typeof call !== 'object') {
      continue;
    }
    const { id, name, args } = call as { id?: unknown; name?: unknown; args?: unknown };
    if (typeof id !== 'string' || typeof name !== 'string') {
      continue;
    }
    if (name === 'task') {
      const taskArgs = (args ?? {}) as { subagent_type?: unknown; description?: unknown };
      events.push({
        type: 'tool_call',
        id,
        kind: 'subagent',
        name: typeof taskArgs.subagent_type === 'string' ? taskArgs.subagent_type : 'sub-agent',
        ...(typeof taskArgs.description === 'string' ? { label: taskArgs.description } : {}),
      });
    } else if (SILENT_TOOL_NAMES.has(name)) {
      // `ask_user` surfaces as buttons and `write_artifact` as an artifact card
      // (each has its own event), so keep both out of the tool/activity timeline.
      continue;
    } else if (!RESERVED_TOOL_NAMES.has(name) || visibleBuiltins.has(name)) {
      const label = toolLabel(args);
      const rawArgs = toolArgs(args, argsChars);
      events.push({
        type: 'tool_call',
        id,
        kind: 'tool',
        name,
        ...(label ? { label } : {}),
        ...(rawArgs ? { args: rawArgs.args } : {}),
        ...(rawArgs?.truncated ? { argsTruncated: true } : {}),
      });
    }
  }
  return events;
}

/**
 * Digs a human-readable reason out of an LLM/HTTP error. OpenAI-style errors put
 * the parsed response body on `.error` (or `.response.data`); a Nest-style host
 * API shapes it as `{ statusCode, message, error }`, where `message` may be a
 * string or an array of validation problems.
 */
function describeError(error: unknown): string {
  if (error && typeof error === 'object') {
    const err = error as {
      status?: number;
      message?: string;
      error?: { message?: unknown; error?: unknown };
      response?: { data?: { message?: unknown } };
    };
    const body = err.error ?? err.response?.data;
    const raw =
      body && typeof body === 'object' && 'message' in body
        ? (body as { message?: unknown }).message
        : undefined;
    const detail = Array.isArray(raw) ? raw.join('; ') : typeof raw === 'string' ? raw : undefined;
    const status = err.status ? `${err.status} ` : '';
    if (detail) {
      return `${status}${detail}`;
    }
    if (err.message) {
      return err.message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
