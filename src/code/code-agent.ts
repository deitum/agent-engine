import { resolveSearchConfig } from '../config/engine-config';
import { type Connector } from '../connector';
import {
  CODE_GIT_TOOLS,
  CODE_MEMORY_SECTIONS,
  type CodeContextReport,
  type CodeRunRequest,
  type CodeSpecStage,
  type CodeStreamEvent,
  type CodeToolchain,
  EXIT_PLAN_MODE_TOOL,
  LOCAL_DIR,
  LOCAL_SKILLS_DIR,
  REMEMBER_TOOL,
} from '../contracts';
import {
  bridgeTools,
  buildAskUserTool,
  buildDeferredGate,
  buildSubAgents,
  loadDeps,
  materializeSkills,
  type PendingAnswers,
  type StreamableAgent,
  streamAgentUpdates,
  toAgentMessages,
} from '../deep-agent';
import { buildChatModel } from '../llm/chat-model';
import { gatewayAttemptMessage } from '../llm/llm-client';
import { createTokenStream } from '../llm/token-stream';
import { buildPlanMiddleware } from '../plan/plan-middleware';
import { buildPlanNudgeMiddleware } from '../plan/plan-nudge';
import { buildToolCallRepairMiddleware } from '../repair-tool-calls';
import { buildSearchTools } from '../search/search-tools';
import { type SearxngContainer } from '../search/searxng-container';

import {
  buildContextReport,
  contextWindowOf,
  SUMMARIZE_KEEP_RATIO,
  summarizeAtTokens,
  TOOL_EVICT_TOKENS,
} from './code-context';
import { buildGitTools } from './code-git';
import {
  buildRememberTool,
  ensureNotesFile,
  GENERATED_MEMORY_FILE,
  headingOf,
  memoryManifest,
  memorySources,
  syncFailuresBlock,
  toFailure,
} from './code-memory';
import { FAILURES_HEADING } from './code-memory.constants';
import { type CodeWorkspaces } from './code-workspace';
import { makeDockerBackend } from './docker-backend';
import { buildLspMiddleware } from './lsp/lsp-middleware';
import { type EditableBackend, buildLspNavigationTools, buildLspRenameTool } from './lsp/lsp-tools';
import { openspecPromptBlock, type OpenspecPromptFacts } from './openspec/openspec-prompt';
import { initOpenspec, isInitialized, readSpecState } from './openspec/openspec-store';
import {
  buildArchiveTool,
  buildProposeTool,
  buildTaskTool,
  type OpenspecToolContext,
} from './openspec/openspec-tools';
import { buildExitPlanModeTool, createPlanGuard } from './plan-mode';
import { type ToolchainCommands, TOOLCHAIN_NOTES } from './toolchain';

/** Receives progress events as the coding agent streams its turn. */
export type CodeEventSink = (event: CodeStreamEvent) => void;

/**
 * Where the language-server layer's own troubles go: the daemon's stderr, not the
 * user's transcript. A server that is slow, missing or crashed is a degraded
 * session and not an event worth interrupting a turn for — `/lsp` reports the
 * state, and every hook already falls back to working without it.
 */
const logLsp = (message: string): void => {
  console.error(`[lsp] ${message}`);
};

/**
 * deepagents built-ins the Code timeline shows as steps. Unlike a chat, the
 * file and shell tools *are* the visible work here — hiding them (the chat's
 * default) leaves the user staring at an idle transcript while the agent edits
 * the repository.
 */
const VISIBLE_BUILTINS: ReadonlySet<string> = new Set([
  'ls',
  'read_file',
  'write_file',
  'edit_file',
  'glob',
  'grep',
  'execute',
]);

/**
 * How much of each tool's output travels back on its step.
 *
 * On the Code path this string is not only what the user expands to read — it is
 * also what the next turn replays to the model, since the graph's own message
 * list does not survive the request. Larger than the chat's budget for that
 * reason, and capped rather than unbounded because it is persisted per step in
 * the browser's IndexedDB.
 */
const TOOL_REPLAY_CHARS = 4000;

/**
 * Directory the summarizer offloads compacted history into, relative to the
 * checkout. Under {@link LOCAL_DIR} because that path is already in
 * `.git/info/exclude` — the library's default (`/conversation_history`) would
 * show up in the user's diff panel and in their pull request.
 */
const HISTORY_DIR = `${LOCAL_DIR}/history`;

/**
 * Names + descriptions of the tools the model is offered, for the context
 * report. What the provider is actually sent is a JSON Schema per tool; name and
 * description are the bulk of it and the only parts reachable here.
 */
function describeTools(tools: unknown[]): string[] {
  return tools.map((entry) => {
    const meta = entry as { name?: unknown; description?: unknown };
    const name = typeof meta.name === 'string' ? meta.name : '';
    const description = typeof meta.description === 'string' ? meta.description : '';
    return `${name}${description}`;
  });
}

/** The `/test` and `/build` lines mentioned in the prompt, when detected. */
function commandsNote(commands: ToolchainCommands): string[] {
  const lines: string[] = [];
  if (commands.test) {
    lines.push(`- Project tests: \`${commands.test}\` (the user can run them with /test).`);
  }
  if (commands.build) {
    lines.push(`- Project build: \`${commands.build}\` (the /build command).`);
  }
  if (commands.install) {
    lines.push(`- Dependency install: \`${commands.install}\`.`);
  }
  return lines;
}

/**
 * Builds the built-in coding agent's system prompt: a strong autonomous-engineer
 * instruction set, the concrete repo/branch/toolchain facts for this session, and
 * the git workflow it should follow. In `planMode` a block is appended that
 * describes the read-only regime the workspace is actually enforcing (see
 * `plan-mode.ts`) and the `exit_plan_mode` tool that ends it.
 */
/**
 * What the agent is told about the language-server tools.
 *
 * Worth spelling out rather than leaving to the tool descriptions, because the
 * failure mode is not that the agent misuses them — it is that it keeps reaching
 * for `grep`, which it has used on every repository it has ever seen. The block
 * names the three questions where a text search is actively misleading, and says
 * plainly that the diagnostics arrive on their own.
 */
const LSP_NOTES = [
  '',
  'Semantic code analysis (LSP) is the project compiler, not a text search:',
  '- `find_references` before changing or deleting a public method: grep gives you both false hits (same-named methods on other classes) and misses (calls through an interface or a base class).',
  '- `find_definition` and `hover` to understand a symbol in front of you, instead of reading the whole file.',
  '- `workspace_symbols` to find a class or method by name without knowing its file; `document_symbols` instead of reading a long file just for its shape.',
  '- `rename_symbol` for renames: it rewrites every use at once and leaves unrelated same-named symbols alone.',
  'After every file edit the compiler errors arrive on their own, in the result of `write_file`/`edit_file`. If they do, fix them right away rather than leaving them for the build. If they do not, either there are none or the server is still indexing — which is not a reason to skip `/test`.',
] as const;

/**
 * What the agent is told about the web tools.
 *
 * Spelled out because the default behaviour of a coding model faced with an
 * unfamiliar error or a library it half-remembers is to guess confidently, and
 * a guess costs a build cycle. The block names the three cases where looking it
 * up is strictly better than reasoning about it.
 */
const WEB_NOTES = [
  '',
  'The internet is available through `web_search` (search) and `web_fetch` (read a page):',
  '- an unfamiliar error message or stack trace: look it up first, fix it second;',
  '- a library API you are unsure of: open its documentation rather than recalling the signature;',
  '- versions, changelogs, breaking changes: this knowledge goes stale, so check it.',
  'A search snippet is not a source: before changing code on what you found, open the page with `web_fetch`.',
] as const;

/**
 * What the agent is told about the git it cannot run itself.
 *
 * The sandbox holds no repository credentials — that is the whole point of
 * keeping the token on the host — so `git push` inside the container fails with
 * «could not read Username», and a model that reads that as a broken checkout
 * spends its turn writing a `.netrc`. The block names the three tools that do
 * reach the host, so «push it and open a pull request» is work it can finish
 * rather than a request it has to hand back.
 */
const GIT_NOTES = [
  `When you are asked to outright: commit with \`execute\` (ordinary git, it runs in the container), then push with \`${CODE_GIT_TOOLS.push}\` — or call \`${CODE_GIT_TOOLS.pullRequest}\`, which pushes and opens the pull request in one step.`,
  `Everything that reaches the repository host goes through those tools, plus \`${CODE_GIT_TOOLS.fetch}\` for a fetch: the sandbox deliberately holds no credentials, so \`git push\`/\`git fetch\`/\`git pull\` in the shell are refused there. That is the design, not a broken checkout — never work around it with a \`.netrc\`, a credential helper or a token in the remote URL.`,
] as const;

export function buildCodingPrompt(
  facts: {
    branch: string;
    baseBranch: string;
    toolchain: CodeToolchain;
    commands: ToolchainCommands;
    envKeys: string[];
    /** Whether the session actually has language servers to talk about. */
    lsp?: boolean;
    /** Whether this turn actually got the web tools. */
    web?: boolean;
    /** Whether this turn got the credentialed git tools (never in plan mode). */
    git?: boolean;
    /** Where the session stands in the OpenSpec process, when it works by one. */
    spec?: OpenspecPromptFacts;
  },
  planMode: boolean,
): string {
  const header = [
    'You are an autonomous senior engineer. You work in an **isolated Docker sandbox** on a real git clone of the repository at `/workspace`.',
    'You have file tools (ls/read_file/write_file/edit_file/glob/grep) and `execute` for the shell (git, npm, gradle) — commands run inside the container.',
    '',
    `Current branch: **${facts.branch}** (base: **${facts.baseBranch}**).`,
    TOOLCHAIN_NOTES[facts.toolchain],
    ...commandsNote(facts.commands),
    ...(facts.envKeys.length > 0
      ? [
          `- The container environment defines: ${facts.envKeys.join(', ')}. Use them, but never print their values in an answer.`,
        ]
      : []),
    '',
    'Workflow:',
    '1. Study the task and the code; draw up a plan (`write_todos`) when one is warranted.',
    '2. Make targeted changes with the file tools.',
    '3. Check the result with a build or the tests, through `execute`.',
    ...(facts.lsp ? LSP_NOTES : []),
    ...(facts.web ? WEB_NOTES : []),
    '',
    'Commits, branches and pull requests are the user’s own commands (`/commit`, `/branch`, `/pr`) — do not commit or push yourself unless asked to outright.',
    ...(facts.git ? GIT_NOTES : []),
    '',
    `Project memory is read to you at the start of every turn: the repository’s own documentation (when it has any) and your notes in \`${GENERATED_MEMORY_FILE}\` (outside git, so they never reach a pull request).`,
    `Write to those notes **only with \`${REMEMBER_TOOL}\`** — never through \`write_file\`/\`edit_file\`. It checks the section, drops a duplicate and keeps the file from sprawling; the sections are: ${CODE_MEMORY_SECTIONS.map((entry) => `${entry.section} («${entry.heading}»)`).join(', ')}.`,
    `Record what outlives the task: a non-obvious command, a convention, a trap, where something lives. Refer to files by path rather than copying their contents. The progress of the current task does not belong there.`,
    `The «${FAILURES_HEADING}» block in those notes is assembled by the engine from failed commands — editing it by hand achieves nothing. Once you understand why a command failed, record the conclusion under «${headingOf('pitfalls')}» with \`${REMEMBER_TOOL}\`, and the entry leaves the block.`,
    '',
    'Safety: before anything irreversible (force-push, deleting branches, merging, discarding changes) ask for confirmation with `ask_user`. Never commit secrets.',
  ].join('\n');

  // The process replaces plan mode rather than stacking on it: its own research
  // stage *is* planning, with an artefact at the end of it, and two sets of
  // instructions for the same read-only turn would contradict each other about
  // what ends it.
  if (facts.spec) {
    return [header, openspecPromptBlock(facts.spec)].join('\n');
  }

  if (!planMode) {
    return header;
  }
  return [
    header,
    '',
    'PLAN MODE',
    'The workspace is read-only right now, and that is enforced: `write_file`, `edit_file`, deletion and any mutating shell command will be refused. The refusal is the rule of this mode, not a broken tool — do not work around it and do not try to repair the sandbox.',
    '',
    '1. Open with `write_todos`: what you have to find out before the plan can be written. It is your own research checklist, not the plan for the user — keep it current as you read, and do not write to project memory in this mode.',
    '2. Then understand the task and the code by reading alone: `read_file`, `glob`, `grep`, `ls` and read-only git (`git status`, `git diff`, `git log`, `git show`).',
    '3. If the requirements allow more than one reading, settle it with `ask_user` BEFORE you draw up the plan.',
    `4. When the plan is ready, call \`${EXIT_PLAN_MODE_TOOL}\` and pass it whole, in markdown: what you are changing and why, which files it touches, how you will check the result. Write it for the person who will read and approve it.`,
    '',
    'Approval lifts the lock within this very turn — start implementing at once rather than waiting for a new message. If the plan was not approved, find out what to change and propose another.',
  ].join('\n');
}

/**
 * True while the process has nothing approved to implement, which is exactly
 * when the workspace must be read-only. Both `idle` (no change yet) and `review`
 * (a change awaiting a verdict) are that: in either, the turn's job is to write
 * or repair a proposal, and the way out of both is `openspec_propose`.
 */
function isSpecReadOnly(stage: CodeSpecStage | undefined): boolean {
  return stage === 'idle' || stage === 'review' || stage === undefined;
}

/**
 * Reads where the session's process stands, creating the tree if the mode was
 * switched on but nothing has been initialised yet.
 *
 * Creating it here rather than refusing the turn is deliberate: the switch is a
 * session setting, and a first task that answered «press the button first»
 * would be a step the product can take by itself.
 */
async function prepareSpec(dir: string): Promise<OpenspecPromptFacts> {
  if (!isInitialized(dir)) {
    await initOpenspec(dir);
  }
  const state = await readSpecState(dir);
  return {
    stage: state.stage,
    ...(state.active
      ? {
          changeId: state.active.id,
          tasksTotal: state.active.tasksTotal,
          tasksDone: state.active.tasksDone,
        }
      : {}),
    capabilities: state.capabilities.map((entry) => entry.capability),
  };
}

/**
 * The context report for a session that is not running a turn (`GET
 * /code/context`), so `/context` can answer at any time.
 *
 * Skills and MCP tools are absent here on purpose: both arrive with a run
 * request, and inventing them would report a context the next turn will not have.
 * What this covers is the part that is fixed for the session — the prompt and the
 * memory files, which is where the surprises live.
 */
export async function describeCodeContext(
  workspaces: CodeWorkspaces,
  sessionId: string,
  contextLength?: number,
): Promise<CodeContextReport> {
  const info = await workspaces.backendInfo(sessionId);
  const status = await workspaces.status(sessionId);

  return buildContextReport({
    systemPrompt: buildCodingPrompt(
      {
        branch: status.branch,
        baseBranch: info.baseBranch,
        toolchain: info.toolchain,
        commands: info.detected.commands,
        envKeys: status.envKeys,
        // Registered on every turn that is not planning, which is what the
        // `false` below assumes.
        git: true,
      },
      // Plan mode is a browser-side flag, so it is unknown here; its block is a
      // few hundred tokens either way and the report is an accounting of where
      // the window goes, not a byte-exact replay of the next request.
      false,
    ),
    memory: memoryManifest(info.dir, await workspaces.failures(sessionId)),
    skills: [],
    toolDescriptions: [],
    ...(contextLength !== undefined ? { contextLength } : {}),
  });
}

/**
 * Runs one turn of the built-in coding agent inside a session's Docker workspace
 * and streams its progress. Reuses the deep-agent engine (`streamAgentUpdates`,
 * `bridgeTools`, `buildAskUserTool`) with a {@link makeDockerBackend} backend, then
 * emits the workspace's post-turn `git_status` + `diff` so the Code UI updates its
 * diff panel. The workspace must already be prepared via `CodeWorkspaces.prepare`
 * (or be restorable from its metadata on disk).
 */
export async function runCodeStream(
  connector: Connector,
  workspaces: CodeWorkspaces,
  searxng: SearxngContainer,
  req: CodeRunRequest,
  onEvent: CodeEventSink,
  signal: AbortSignal,
  pending: PendingAnswers,
): Promise<void> {
  const deps = await loadDeps();
  const {
    createDeepAgent,
    ChatOpenAI,
    tool,
    FilesystemBackend,
    createSummarizationMiddleware,
    createFilesystemMiddleware,
  } = deps;

  await workspaces.setEnv(req.sessionId, req.env);
  const info = await workspaces.backendInfo(req.sessionId);
  const status = await workspaces.status(req.sessionId);

  // A coding turn is long and mostly narration, so it is streamed token by token
  // like a chat's (`llm/token-stream.ts`); there is always somebody watching this
  // route, unlike a background task's.
  const tokenStream = createTokenStream(deps.createMiddleware, (delta) =>
    onEvent({ type: 'text', delta }),
  );

  // A rejected attempt is surfaced for the same reason as on the chat path: the
  // retry behind it is a silent, growing pause that otherwise reads as a coding
  // agent thinking (see `llm/chat-model.ts`).
  const model = buildChatModel(ChatOpenAI, req.llm, tokenStream.callbacks, (attempt) =>
    onEvent({ type: 'error', message: gatewayAttemptMessage(attempt), fatal: false }),
  );

  // The OpenSpec process, when the session works by one. The stage is read from
  // the checkout rather than taken from the request: a browser that has been
  // sitting on a stale tab must not be able to put an approved, half-implemented
  // change back into research.
  const spec = req.spec?.enabled === true ? await prepareSpec(info.dir) : null;

  // Plan mode is enforced by the backend, not by the prompt: while the guard is
  // active every write and every mutating command is refused, and `exit_plan_mode`
  // is the only thing that lifts it — mid-turn, so an approved plan is
  // implemented without waiting for another message.
  //
  // The process reuses that machinery for its research stage: nothing is
  // approved yet, so the workspace is exactly as read-only as it is while
  // planning, and `openspec_propose` is what lifts the guard instead.
  const planMode = spec ? isSpecReadOnly(spec.stage) : req.planMode === true;
  const guard = createPlanGuard(planMode);

  // The notes file has to exist before the memory middleware reads it, and its
  // failures block has to be current before this turn's prompt is built — that
  // block is the whole mechanism by which a command that broke last turn is not
  // tried again this turn.
  await ensureNotesFile(info.dir);
  await syncFailuresBlock(info.dir, await workspaces.failures(req.sessionId));

  const backend = makeDockerBackend(FilesystemBackend, {
    rootDir: info.dir,
    containerName: info.containerName,
    env: info.env,
    signal,
    ...(planMode ? { guard } : {}),
    // Recorded rather than surfaced: the failure is already visible as a step in
    // the transcript, and what memory adds is that it survives into next turn.
    onFailure: (command, exitCode, output) => {
      void workspaces.recordFailure(req.sessionId, toFailure(command, exitCode, output));
    },
  });

  const warn = (message: string): void => onEvent({ type: 'error', message, fatal: false });

  // Language servers, owned by the workspace so they survive between turns — a
  // jdtls restarted every turn would spend the whole session importing the
  // project. Failing to get them is never fatal: `off` disables every hook.
  const lsp = await workspaces.lsp(req.sessionId, req.lsp ?? {}).catch((error: unknown) => {
    warn(`Code analysis is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  });

  const bridged = await bridgeTools(connector, req.tools, tool, warn, signal);
  const askUser = buildAskUserTool(tool, onEvent, pending, signal);
  const gate = buildDeferredGate(deps, bridged);
  // Outside plan mode the tool does not exist at all, so there is no way to
  // "approve" a plan that was never demanded. `remember` is the mirror image: in
  // plan mode the workspace is read-only, and memory is part of the workspace.
  // Navigation is read-only, so it is offered in plan mode too — planning against
  // a semantic index instead of `grep` is most of the point of having one.
  // `rename_symbol` is the exception, for the same reason `remember` is: it
  // writes, and in plan mode the workspace is not the agent's to change.
  const lspTools =
    lsp && !lsp.off
      ? [
          ...buildLspNavigationTools(tool, { session: lsp, dir: info.dir }),
          ...(planMode
            ? []
            : [
                buildLspRenameTool(tool, {
                  session: lsp,
                  dir: info.dir,
                  backend: backend as EditableBackend,
                }),
              ]),
        ]
      : [];

  // Search reads, it never writes, so it is offered in plan mode too — reading
  // the library's own documentation is part of drafting a plan, not part of
  // carrying it out.
  const web = await buildSearchTools(
    tool,
    { config: resolveSearchConfig(), container: searxng },
    signal,
  );

  // The process' own tools, granted by stage. `openspec_propose` exists only
  // while nothing is approved, so a change cannot be re-proposed out from under
  // an implementation; `openspec_archive` only once the checklist is empty, so
  // the model cannot close a change it has not finished.
  const specContext: OpenspecToolContext | null = spec
    ? { dir: info.dir, onEvent, ...(spec.changeId ? { changeId: spec.changeId } : {}) }
    : null;
  const specTools = specContext
    ? isSpecReadOnly(spec?.stage)
      ? [buildProposeTool(tool, specContext, pending, signal, guard)]
      : [buildTaskTool(tool, specContext), buildArchiveTool(tool, specContext)]
    : [];

  // The remote git the sandbox cannot do for itself. Never in plan mode: all
  // three change something outside the workspace, and a plan-mode turn changes
  // nothing at all.
  const gitTools = planMode ? [] : buildGitTools(tool, { workspaces, sessionId: req.sessionId });

  const builtins = [
    askUser,
    ...lspTools,
    ...web,
    ...specTools,
    ...gitTools,
    // `exit_plan_mode` is plan mode's way out and has no meaning in the process,
    // whose research stage ends with a proposal instead. `remember` is skipped
    // wherever the workspace is read-only — memory is part of the workspace.
    ...(planMode
      ? spec
        ? []
        : [buildExitPlanModeTool(tool, onEvent, pending, signal, guard)]
      : [
          buildRememberTool(tool, {
            dir: info.dir,
            failures: () => workspaces.failures(req.sessionId),
            clearFailures: (lesson) => workspaces.clearFailures(req.sessionId, lesson),
          }),
        ]),
  ];
  const tools = [...builtins, ...bridged.byName.values(), ...(gate ? [gate.tool] : [])];

  const basePrompt = buildCodingPrompt(
    {
      branch: status.branch,
      baseBranch: info.baseBranch,
      toolchain: info.toolchain,
      commands: info.detected.commands,
      envKeys: status.envKeys,
      lsp: lspTools.length > 0,
      web: web.length > 0,
      git: gitTools.length > 0,
      ...(spec ? { spec } : {}),
    },
    planMode,
  );
  const rules = req.instructions?.trim();
  const systemPrompt = rules
    ? `${basePrompt}\n\nAdditional rules for this session:\n${rules}`
    : basePrompt;

  // Materialise the session's skills into the workspace (excluded from git via
  // `.git/info/exclude`, see CodeWorkspaces.prepare) and expose them to the
  // agent (deepagents `skills`). The Docker backend's file tools read the host
  // workspace dir, so a skills dir under it is discoverable by the agent.
  const skillsPaths = materializeSkills(info.dir, req.skills ?? [], LOCAL_SKILLS_DIR);

  // Sub-agents the coding agent may delegate to — same rules as the deep-agent
  // path (allow-list by MCP tool name, built-ins always granted, skills passed
  // down explicitly), so the two behave alike.
  // Same reason as on the deep-agent path: a tool call whose arguments will not
  // parse otherwise ends the turn through the graph's exit node, silently.
  const repair = buildToolCallRepairMiddleware(deps.createMiddleware, warn);

  const subagents = buildSubAgents(req.subAgents ?? [], {
    bridged,
    tools,
    builtins,
    gate,
    repair,
    ...(skillsPaths ? { skillsPaths } : {}),
    onWarn: warn,
  });

  // deepagents always installs a summarizer and a filesystem middleware of its
  // own, and `CreateDeepAgentParams` exposes neither's thresholds. Same-named
  // entries in `middleware` replace them in place (`mergeMiddlewareStack`), which
  // is the supported way to keep the library's stack and still choose:
  //   - where summarization triggers — from the *real* window, because the
  //     library's profile-less fallback (170k) sits above what most deployments
  //     serve, so a 128k model would fail before it ever fired;
  //   - where the offloaded history lands — under `.agent-engine/`, already
  //     outside git, instead of a `/conversation_history/` directory appearing in
  //     the user's diff panel;
  //   - when a tool result is offloaded to a file rather than kept inline.
  //
  // *Where* an offloaded tool result lands is not among them: the library
  // hard-codes `/large_tool_results/<tool_call_id>.txt`, so unlike the history
  // it cannot be moved under `.agent-engine/` and is instead kept out of the diff
  // via `.git/info/exclude` (see `TOOL_EVICT_EXCLUDE_ENTRY`).
  const window = contextWindowOf(req.llm.contextLength);
  // `makeDockerBackend` returns `object`: `FilesystemBackend` only exists after
  // the lazy import, so the class cannot be typed at module scope. The same cast
  // is applied to `createDeepAgent` below, for the same reason.
  const backendRef = backend as Parameters<typeof createSummarizationMiddleware>[0]['backend'];
  const tuned = [
    createSummarizationMiddleware({
      backend: backendRef,
      trigger: { type: 'tokens', value: summarizeAtTokens(req.llm.contextLength) },
      keep: { type: 'tokens', value: Math.floor(window * SUMMARIZE_KEEP_RATIO) },
      historyPathPrefix: `/${HISTORY_DIR}`,
    }),
    createFilesystemMiddleware({
      backend: backendRef,
      toolTokenLimitBeforeEvict: TOOL_EVICT_TOKENS,
    }),
  ];

  const agent = createDeepAgent({
    model,
    systemPrompt,
    tools,
    subagents,
    backend,
    // The repository's own AGENTS.md / CLAUDE.md (when it has one), then the
    // agent's notes. Derived from the checkout rather than a fixed precedence
    // list, so what reaches the prompt is exactly what exists.
    memory: memorySources(info.dir),
    middleware: [
      // The workflow above tells the agent to draw up a plan; this is what gives
      // it the tool to draw one with, since deepagents stopped installing it
      // (`plan/plan-middleware.ts`).
      buildPlanMiddleware(deps.todoListMiddleware),
      // And this is what makes it reach for the tool: a reminder once the turn
      // has visibly become multi-step work, and — in plan mode, whose whole
      // deliverable is a plan — the first call forced outright
      // (`plan/plan-nudge.ts`). The process stages are left out: their research
      // already ends in `openspec_propose`, whose `tasks` checklist would be a
      // second plan competing with this one.
      buildPlanNudgeMiddleware(deps.createMiddleware, {
        ...(planMode && !spec ? { requirePlan: true } : {}),
      }),
      ...tuned,
      ...(gate ? [gate.middleware] : []),
      // Appended last so it wraps the file tools closest in: whatever else runs,
      // the diagnostics it reports describe the write that actually happened.
      // Its own failures are logged, never surfaced — a language server having a
      // bad day is not something to interrupt the user's transcript with, and
      // `/lsp` already reports a server that has genuinely given up.
      ...(lsp && !lsp.off ? [buildLspMiddleware(deps.createMiddleware, lsp, logLsp)] : []),
      tokenStream.middleware,
      repair,
    ],
    ...(skillsPaths ? { skills: skillsPaths } : {}),
  } as unknown as Parameters<typeof createDeepAgent>[0]) as unknown as StreamableAgent;

  onEvent({
    type: 'context',
    context: buildContextReport({
      systemPrompt,
      memory: memoryManifest(info.dir, await workspaces.failures(req.sessionId)),
      skills: req.skills ?? [],
      toolDescriptions: describeTools(tools),
      ...(req.llm.contextLength !== undefined ? { contextLength: req.llm.contextLength } : {}),
      messages: req.messages,
    }),
  });

  await streamAgentUpdates(agent, toAgentMessages(req.messages), onEvent, signal, {
    visibleBuiltins: VISIBLE_BUILTINS,
    previewChars: TOOL_REPLAY_CHARS,
    argsChars: TOOL_REPLAY_CHARS,
    streamedIds: tokenStream.streamedIds,
  });

  // Surface the workspace changes this turn produced so the diff panel refreshes.
  if (!signal.aborted) {
    onEvent({ type: 'git_status', status: await workspaces.status(req.sessionId) });
    onEvent({ type: 'diff', diff: await workspaces.diff(req.sessionId) });
    // …and where the process ended up. The tools already announce each move, but
    // a turn that was interrupted, or that edited `tasks.md` some other way,
    // would otherwise leave the panel a stage behind.
    if (spec) {
      const state = await readSpecState(info.dir);
      onEvent({
        type: 'spec_stage',
        stage: state.stage,
        ...(state.active ? { change: state.active } : {}),
      });
    }
  }
}
