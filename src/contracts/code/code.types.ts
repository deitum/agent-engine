import {
  type DeepAgentModelParams,
  type DeepAgentSkill,
  type DeepAgentStreamEvent,
  type DeepAgentSubAgent,
} from '../agents/agents.types';
import { type ChatMessage } from '../llm/llm.types';
import { type McpToolSource } from '../mcp/mcp.types';
import { type RepoCredentials, type RepoRef } from '../vcs/vcs.types';

import {
  type CodeSpecChange,
  type CodeSpecProposal,
  type CodeSpecRunConfig,
  type CodeSpecStage,
} from './openspec.types';

/**
 * Coordinates of the repository a coding session works in.
 *
 * The same {@link RepoRef} the skills importer uses, under the name the coding
 * routes have always called it: one repository reference, whichever feature is
 * holding it. The clone URL is derived from the provider —
 * `<baseUrl>/scm/<owner>/<repo>.git` on Bitbucket Server,
 * `https://github.com/<owner>/<repo>.git` on GitHub.
 */
export type CodeRepoRef = RepoRef;

/**
 * Credentials used for cloning / pushing / opening a pull request.
 *
 * They do not travel with each request: the client hands them over once, as part
 * of {@link EngineConfigRequest}, and the daemon keeps them in memory for the
 * life of the process. The checkout's `origin` remote stays credential-free
 * either way — the token goes on the git invocation, never into `.git/config`.
 */
export type CodeCredentials = RepoCredentials;

/** Build toolchain detected in a cloned workspace. */
export type CodeToolchain = 'node' | 'gradle' | 'maven' | 'python' | 'go' | 'unknown';

/**
 * One environment variable injected into every command the session runs inside
 * its container (`docker exec -e`). Owned by the browser (the session) and
 * mirrored into the workspace metadata so a rehydrated workspace keeps it.
 */
export interface CodeEnvVar {
  key: string;
  value: string;
  /**
   * Masked in the UI. The flag is presentational only — the connector treats
   * every value the same and never echoes any of them back.
   */
  secret?: boolean;
}

/**
 * Resource limits applied to a session's container at creation time. Omitted
 * fields fall back to the connector's built-in defaults.
 */
export interface CodeSandboxLimits {
  /** Docker `--memory`, e.g. `4g`. */
  memory?: string;
  /** Docker `--cpus`, e.g. `2`. */
  cpus?: string;
  /** Docker `--pids-limit`. */
  pidsLimit?: number;
  /** Docker `--network`; `none` cuts the sandbox off from the network. */
  network?: 'bridge' | 'none';
}

/**
 * Where a session's effective Docker image came from: an explicit image sent by
 * the browser (session setting or the app-wide default), the connector's own
 * detection, or the built-in fallback used when a detected tag cannot be pulled.
 */
export type CodeImageSource = 'override' | 'auto' | 'fallback';

/** The commands a detected stack is built and tested with (`/build`, `/test`). */
export interface CodeToolchainCommands {
  install?: string;
  test?: string;
  build?: string;
}

/**
 * What the connector detected in a checkout and the image it picked from it.
 * `reason` is a short human sentence the UI shows next to the image chip, e.g.
 * «`.nvmrc` → Node 20».
 */
export interface CodeToolchainInfo {
  toolchain: CodeToolchain;
  /** The image the detection suggests (before any session/app override). */
  image: string;
  /** Detected package manager / build command hint, when there is one. */
  packageManager?: string;
  /** Why this image was picked, in the user's language. */
  reason: string;
  /** What `/test` and `/build` will run for this stack. */
  commands?: CodeToolchainCommands;
}

/**
 * Languages the Code tab can run a language server for. A closed list because
 * each one is a concrete server with its own install recipe and its own runtime
 * requirement inside the container — see the connector's `lsp/servers.ts`.
 */
export type CodeLspLanguage = 'java' | 'typescript' | 'python';

/**
 * Where the connector may fetch language servers from, declared in
 * the embedding app's own configuration and forwarded on every run / setup request.
 *
 * The sources are configurable rather than hard-coded because a closed corporate
 * network reaches an internal Nexus and not `registry.npmjs.org`. The connector
 * itself never reads the YAML — it runs on the user's machine — so this travels
 * the same route as `llm` and `env`.
 */
export interface CodeLspConfig {
  /** Master switch; omitted is read as enabled. */
  enabled?: boolean;
  /** Which servers may start at all. Omitted means every supported language. */
  servers?: CodeLspLanguage[];
  /** npm registry used to install the TypeScript server. */
  npmRegistry?: string;
  /** PyPI index used to install the Python server. */
  pypiIndexUrl?: string;
  /** Tarball of the Eclipse JDT language server. */
  jdtlsUrl?: string;
}

/**
 * What a session's language server is doing.
 *
 * `indexing` is a first-class state rather than a flavour of `starting` because
 * it is the one the user asks about: jdtls answers `initialize` in seconds and
 * then spends minutes importing a Gradle project, during which its answers are
 * real but incomplete.
 */
export type CodeLspState = 'off' | 'installing' | 'starting' | 'indexing' | 'ready' | 'unavailable';

/** One language server's state, as shown in the session header and by `/lsp`. */
export interface CodeLspStatus {
  language: CodeLspLanguage;
  state: CodeLspState;
  /** Why, in the user's language — mainly for `unavailable`. */
  detail?: string;
  /** Files the server currently holds open. */
  openFiles?: number;
}

/**
 * `POST /code/clone` on the local connector: prepare a per-session workspace —
 * pull the Docker image, `git clone` the repo (with the credentials from the
 * adopted configuration), and check out a work branch in a host dir
 * bind-mounted into a fresh container.
 */
export interface CodeCloneRequest {
  /** Stable per-session id (the Code session id); names the workspace + container. */
  sessionId: string;
  repo: CodeRepoRef;
  /** Branch to clone from; defaults to the repo's default branch. */
  baseBranch?: string;
  /** Work branch to create + check out; defaults to a generated `agent/...` name. */
  workBranch?: string;
  /**
   * Docker image override. Omitted = the connector detects the toolchain and
   * picks an image itself (see {@link CodeToolchainInfo}).
   */
  image?: string;
  /** Environment variables for every command run in the container. */
  env?: CodeEnvVar[];
  /** Container resource limits. */
  limits?: CodeSandboxLimits;
}

/**
 * What a session's workspace is bootstrapped with before the agent gets to work:
 * the stack's dependencies installed inside the container, the project memory
 * (`AGENTS.md`) the agent reads on every turn, and the language server for the
 * detected stack.
 *
 * `lsp` runs last and only warms what the other two made possible — jdtls reads
 * the classpath the dependency install produced — and it is the one phase whose
 * result nothing waits for.
 */
export type CodeSetupPhase = 'install' | 'memory' | 'lsp';

/**
 * How one bootstrap phase ended. `pending` means it has never run for this
 * checkout (the UI starts it), `skipped` that there was nothing to do — no
 * install command for the stack, or a sandbox cut off from the network.
 */
export type CodeSetupState = 'pending' | 'running' | 'ok' | 'failed' | 'skipped';

/** Where the project memory injected into the coding agent's prompt comes from. */
export type CodeMemorySource = 'repo' | 'generated' | 'none';

/**
 * The bootstrap state of a session's workspace: what the dependency install did
 * and which project memory the agent will read. Persisted in `workspace.json`,
 * so re-opening a session does not re-install, and returned in the workspace
 * status so the browser knows when to start the step.
 */
export interface CodeSetupInfo {
  install: CodeSetupState;
  /** The install command that ran (or would run). */
  installCommand?: string;
  installExitCode?: number | null;
  /**
   * Digest of the checkout's lock files at the last successful install. An
   * unchanged fingerprint is what lets a re-opened session skip the step.
   */
  fingerprint?: string;
  memory: CodeMemorySource;
  /**
   * How warming the language server for the detected stack went. `skipped` means
   * the stack has no server of ours (Go) or LSP is turned off; `failed` carries
   * its reason in {@link lspDetail} and leaves the session perfectly usable.
   */
  lsp?: CodeSetupState;
  /** Why the language server ended up in that state, for the settings screen. */
  lspDetail?: string;
  /** When the bootstrap last ran, epoch ms. */
  ranAt?: number;
}

/**
 * The sections a session's notes file is divided into. A closed list on purpose:
 * the agent writes through a validating tool rather than free-form, so every
 * entry lands somewhere the reader (and the de-duplicator) can find it.
 */
export type CodeMemorySection = 'commands' | 'conventions' | 'pitfalls' | 'map';

/**
 * Which memory file: the one the repository brings itself (`AGENTS.md` and
 * friends, tracked by git) or the notes the agent maintains
 * ({@link SESSION_MEMORY_PATH}, kept out of git).
 */
export type CodeMemoryKind = 'repo' | 'notes';

/** One section of the notes file: how many entries it holds and what it costs. */
export interface CodeMemorySectionInfo {
  section: CodeMemorySection;
  entries: number;
  chars: number;
}

/** One memory file's cost, as injected into the agent's prompt every turn. */
export interface CodeMemoryFileInfo {
  kind: CodeMemoryKind;
  /** Path relative to the checkout: `AGENTS.md`, `.agent-engine/AGENTS.md`. */
  path: string;
  exists: boolean;
  chars: number;
  /** Estimate, chars / 4 — so the UI needs no tokenizer. */
  tokens: number;
  /** Only for `notes`. */
  sections?: CodeMemorySectionInfo[];
}

/**
 * A command that failed in this workspace. Recorded deterministically by the
 * connector — no model call — and injected into the notes file so the agent does
 * not retry the same broken command a turn later. Cleared once the agent has
 * promoted the lesson into the `pitfalls` section.
 */
export interface CodeCommandFailure {
  command: string;
  exitCode: number | null;
  /** First meaningful line of the output, truncated. */
  detail: string;
  at: number;
}

/** What the coding agent's memory costs, broken down per file and section. */
export interface CodeMemoryManifest {
  files: CodeMemoryFileInfo[];
  totalChars: number;
  totalTokens: number;
  /** Write budget of the notes file, so the UI can show what is left. */
  notesBudgetChars: number;
  overBudget: boolean;
  /** Failures still awaiting a lesson (injected, but not part of the budget). */
  failures: CodeCommandFailure[];
}

/** `GET /code/memory`: both memory files verbatim, for the editor. */
export interface CodeMemoryReport {
  manifest: CodeMemoryManifest;
  files: { kind: CodeMemoryKind; path: string; content: string; exists: boolean }[];
}

/**
 * `POST /code/memory`: append one entry (the composer's `#` shortcut), replace a
 * file wholesale (the editor), or tidy the notes — one model call that merges
 * duplicates and drops what has gone stale.
 */
export interface CodeMemoryWriteRequest {
  sessionId: string;
  kind: CodeMemoryKind;
  op: 'append' | 'write' | 'tidy';
  /** Required for `append`; ignored otherwise. */
  section?: CodeMemorySection;
  /** The entry (`append`) or the whole file (`write`). */
  text?: string;
  /** Required for `tidy`. */
  llm?: CodeLlmParams;
}

/**
 * Why an `append` did not happen. Both are answers rather than failures: the
 * entry is already there, or the notes file has no room left and something has to
 * give first.
 */
export type CodeMemoryWriteStatus = 'ok' | 'duplicate' | 'over-budget';

/** Result of a `POST /code/memory`, with the refreshed report. */
export interface CodeMemoryWriteResult {
  status: CodeMemoryWriteStatus;
  report: CodeMemoryReport;
}

/**
 * What the model is shown before a single message of the conversation is added:
 * the system prompt, the memory files, the skills and the MCP tool schemas. The
 * browser cannot see any of it (it lives connector-side), so without this report
 * a context indicator would be counting half the window.
 */
export interface CodeContextReport {
  /** The built-in coding prompt plus any session rules. */
  systemTokens: number;
  memory: CodeMemoryManifest;
  /** Materialised skills, as they reach the prompt. */
  skillsTokens: number;
  /** Bridged MCP tool schemas. */
  toolsTokens: number;
  toolCount: number;
  /** systemTokens + memory.totalTokens + skillsTokens + toolsTokens. */
  overheadTokens: number;
  /** History the connector received this turn; absent on the `GET`. */
  historyTokens?: number;
  /**
   * Where the in-graph summarizer kicks in, derived from the model's window.
   * Shown as a mark on the context gauge and printed by `/context`.
   */
  summarizeAtTokens: number;
}

/** A single changed path in a workspace's git status. */
export interface CodeFileStatus {
  path: string;
  /** Porcelain status letters, e.g. `M`, `A`, `??`. */
  status: string;
  /** Previous path for a rename (`R`). */
  from?: string;
}

/**
 * The git + toolchain state of a session's workspace, returned by `/code/clone`
 * and `/code/status` and streamed after each agent turn as a `git_status` event.
 */
export interface CodeWorkspaceStatus {
  /** True once the repo has been cloned into the workspace. */
  cloned: boolean;
  branch: string;
  baseBranch: string;
  toolchain: CodeToolchain;
  /** Commits ahead of the upstream branch. */
  ahead: number;
  /** Commits behind the upstream branch. */
  behind: number;
  files: CodeFileStatus[];
  /** The image the session's container actually runs. */
  image: string;
  imageSource: CodeImageSource;
  /** What the connector detected in the checkout (drives the `auto` image). */
  detected: CodeToolchainInfo;
  /** Names (never values) of the environment variables applied to commands. */
  envKeys: string[];
  /** False when the container was swept / stopped; it restarts on next use. */
  containerRunning: boolean;
  /** True while a turn or command is running for this session. */
  busy: boolean;
  /** Dependency install + project memory state (see {@link CodeSetupInfo}). */
  setup: CodeSetupInfo;
  /**
   * What each language server the session has touched is doing. Empty on a
   * session where none has started yet, and absent from a connector that predates
   * the feature.
   */
  lsp?: CodeLspStatus[];
}

/** One file's unified diff plus its line counters. */
export interface CodeDiffFile {
  path: string;
  patch: string;
  /** Added lines (`git diff --numstat`); `null` for a binary file. */
  added: number | null;
  /** Removed lines; `null` for a binary file. */
  removed: number | null;
  /** True when the path is not tracked by git yet. */
  untracked?: boolean;
}

/** A per-file unified diff of a workspace's changes (read-only view). */
export interface CodeDiff {
  files: CodeDiffFile[];
  /** Which comparison produced this diff (see {@link CodeDiffMode}). */
  mode: CodeDiffMode;
}

/**
 * What a diff compares:
 * - `worktree` — uncommitted changes (including new files) against `HEAD`;
 * - `branch` — everything the work branch adds on top of its base branch,
 *   including the uncommitted changes.
 */
export type CodeDiffMode = 'worktree' | 'branch';

/**
 * OpenAI-compatible LLM parameters the connector uses to build its `ChatOpenAI`
 * for a Code run — identical to a deep agent's, and just as free of an address
 * and a credential: both are the connector's own business, adopted once when the
 * browser connected (see {@link DeepAgentLlmParams}).
 */
export interface CodeLlmParams extends DeepAgentModelParams {
  model: string;
  /**
   * The model's context window (`ModelInfo.context_length`), when the provider
   * reports it. The connector sizes the in-graph summarizer's trigger from it;
   * without it the library would fall back to a threshold well above the real
   * window and the request would fail before summarization ever ran.
   */
  contextLength?: number;
}

/**
 * `POST /code/stream` on the local connector: runs the built-in coding agent for
 * one turn inside the session's Docker workspace and streams {@link CodeStreamEvent}s.
 * The agent's instructions / sub-agents are injected connector-side (the built-in
 * coding agent), so only the task, LLM settings and tool scope are forwarded.
 */
export interface CodeRunRequest {
  /** The session's workspace (must have been prepared via `/code/clone`). */
  sessionId: string;
  /** Conversation so far, in OpenAI chat-message shape. */
  messages: ChatMessage[];
  llm: CodeLlmParams;
  /**
   * Scope-resolved MCP servers the agent may use (e.g. Bitbucket for PRs), each
   * with the tool policies of its selected preset.
   */
  tools: McpToolSource[];
  /**
   * Plan-first mode. The connector runs the turn read-only — every write and
   * every mutating shell command is refused at the backend — and grants the
   * agent an `exit_plan_mode` tool to put its plan to the user. Approving lifts
   * the guard for the rest of the turn (see {@link CodePlanProposal}).
   */
  planMode?: boolean;
  /**
   * Extra session rules (custom instructions) appended to the built-in coding
   * agent's system prompt. Empty/omitted = the built-in prompt only.
   */
  instructions?: string;
  /**
   * Sub-agents the coding agent may delegate to, mapped onto deepagents'
   * `subagents[]` (same shape as a deep agent's). Omitted/empty = none.
   */
  subAgents?: DeepAgentSubAgent[];
  /**
   * Resolved skill contents the connector materialises into the session's
   * workspace and exposes to the coding agent (deepagents `skills`).
   * Omitted/empty = no skills.
   */
  skills?: DeepAgentSkill[];
  /** Environment variables for the commands this turn runs. */
  env?: CodeEnvVar[];
  /**
   * Language-server policy for this session, merged from the deployment's own settings and
   * the user's own settings. Forwarded on every turn rather than held by the
   * connector because the connector never reads the YAML — same route as `llm`.
   * Omitted is read as «enabled with the defaults».
   */
  lsp?: CodeLspConfig;
  /**
   * OpenSpec mode. When enabled the turn is run against the session's process
   * state (`.agent-engine/openspec/state.json`): the proposal stage runs read-only
   * under the same guard as {@link planMode} and grants `openspec_propose`, the
   * implementation stage grants `openspec_task`. Omitted = the ordinary Code turn.
   */
  spec?: CodeSpecRunConfig;
}

/**
 * A plan the coding agent drafted in plan mode and put to the user for approval
 * (its `exit_plan_mode` tool). Unlike a `write_todos` checklist — the agent's own
 * working notes — this is a document written to be read: what will change, why,
 * and how it will be verified.
 *
 * The tool blocks on it exactly like `ask_user` does, so the answer travels back
 * through the same `POST /code/answer`. Answering {@link CODE_PLAN_APPROVE} lifts
 * the turn's read-only guard and the agent implements the plan without waiting
 * for another message; anything else keeps the guard on and asks it to revise.
 */
export interface CodePlanProposal {
  /** Correlates the emitted plan with the answer that resumes the run. */
  id: string;
  /** The plan itself, as markdown. */
  plan: string;
}

/**
 * A progress event streamed from the connector while the coding agent runs
 * (`POST /code/stream`, one per SSE `data:` frame). Reuses every
 * {@link DeepAgentStreamEvent} (assistant text, the live plan, tool / sub-agent
 * activity, `ask_user`) and adds workspace deltas the Code UI renders in its diff
 * panel after tool turns.
 */
export type CodeStreamEvent =
  | DeepAgentStreamEvent
  /** The workspace's git status changed (emitted after tool turns and at the end). */
  | { type: 'git_status'; status: CodeWorkspaceStatus }
  /** The workspace's diff after the turn. */
  | { type: 'diff'; diff: CodeDiff }
  /** The agent put a plan to the user and is blocked on the answer. */
  | ({ type: 'plan_proposal' } & CodePlanProposal)
  /**
   * Plan mode changed connector-side — emitted with `active: false` when a plan
   * is approved, so the browser drops the session's flag and the next task runs
   * as an ordinary turn.
   */
  | { type: 'plan_mode'; active: boolean }
  /** The agent drafted a change and is blocked on the user's review. */
  | ({ type: 'spec_proposal' } & CodeSpecProposal)
  /**
   * The session's OpenSpec stage changed — an approved proposal, a ticked task,
   * an archived change. Carries the refreshed change so the process panel and
   * its progress counter move without a round trip.
   */
  | { type: 'spec_stage'; stage: CodeSpecStage; change?: CodeSpecChange }
  /**
   * What the model is shown before the conversation — emitted once, right after
   * the agent is assembled, so the browser can account for the half of the
   * context window it cannot see.
   */
  | { type: 'context'; context: CodeContextReport };

/**
 * `POST /code/setup` on the local connector: bootstraps a prepared workspace —
 * installs the stack's dependencies inside the container and makes sure the
 * session has a project memory — streaming {@link CodeSetupEvent}s as it goes.
 *
 * Kept out of `/code/clone` on purpose: an install can run for minutes, and the
 * user should watch its log in the session rather than a spinner in the connect
 * dialog.
 */
export interface CodeSetupRequest {
  /** The session's workspace (must have been prepared via `/code/clone`). */
  sessionId: string;
  /**
   * LLM used for the one-shot project summary written into the generated
   * memory. Omitted = only the deterministic part of the file is written.
   */
  llm?: CodeLlmParams;
  /** Phases to run; omitted = all of them. */
  phases?: CodeSetupPhase[];
  /**
   * Run even when there is nothing to do — the lock files are unchanged since
   * the last install, or the session already has a memory. This is what
   * `/install` and `/memory` send.
   */
  force?: boolean;
  /** Install command to use instead of the detected one (also remembered). */
  installCommand?: string;
  /** Environment variables for the commands this bootstrap runs. */
  env?: CodeEnvVar[];
  /** Language-server policy; see {@link CodeRunRequest.lsp}. */
  lsp?: CodeLspConfig;
}

/**
 * A progress event streamed while a workspace is bootstrapped
 * (`POST /code/setup`, one per SSE `data:` frame).
 */
export type CodeSetupEvent =
  /** A phase changed state; `detail` explains a `skipped` / `failed` one. */
  | {
      type: 'phase';
      phase: CodeSetupPhase;
      state: CodeSetupState;
      detail?: string;
      /** Exit code of a finished install, so the UI can offer the fix action. */
      exitCode?: number | null;
    }
  /** Output of the running install command, in order, already line-buffered. */
  | { type: 'log'; chunk: string }
  /** A failure; `fatal` ends the bootstrap, otherwise it carries on. */
  | { type: 'error'; message: string; fatal: boolean }
  /** Terminal frame: the bootstrap result and the refreshed workspace status. */
  | { type: 'done'; setup: CodeSetupInfo; status: CodeWorkspaceStatus };

/**
 * A deterministic operation run directly on a session's workspace, no LLM
 * involved:
 * - `branch` / `checkout` — create or switch a work branch;
 * - `commit` — stage everything and commit;
 * - `push` — push the current branch to `origin` (needs credentials);
 * - `pr` — push, then open a pull request via the Bitbucket REST API;
 * - `exec` — run a shell command inside the container (the `/run` escape hatch);
 * - `test` / `build` — the detected toolchain's test / build command;
 * - `revert` — discard a path's changes (`git checkout -- <path>`).
 */
export type CodeCommandName =
  'branch' | 'checkout' | 'commit' | 'push' | 'pr' | 'exec' | 'test' | 'build' | 'revert' | 'lsp';

/**
 * `POST /code/command` on the local connector: run one deterministic operation on
 * the session's workspace. `push` / `pr` carry the repo coordinates because the
 * checkout's `origin` deliberately holds no token; the credentials themselves
 * come from the adopted configuration.
 */
export interface CodeCommandRequest {
  /** The session's workspace (must have been prepared via `/code/clone`). */
  sessionId: string;
  command: CodeCommandName;
  /**
   * Branch name (`branch` / `checkout`), commit message (`commit`), PR title
   * (`pr`), shell command (`exec`), or path (`revert`).
   */
  arg?: string;
  /** Repo coordinates for the network calls; required for `push` / `pr`. */
  repo?: CodeRepoRef;
  /** Environment variables for `exec` / `test` / `build`. */
  env?: CodeEnvVar[];
}

/** Result of a `POST /code/command`, with the refreshed workspace state. */
export interface CodeCommandResult {
  /** False when the command ran but reported failure (e.g. non-zero tests). */
  ok: boolean;
  /** Human-readable summary / command output rendered in the transcript. */
  output: string;
  /** True when `output` was cut to the connector's cap. */
  truncated?: boolean;
  /** Exit code for the shell-backed commands (`exec` / `test` / `build`). */
  exitCode?: number | null;
  /** Workspace git status after the operation. */
  status: CodeWorkspaceStatus;
  /** Working diff after the operation. */
  diff: CodeDiff;
  /** The opened pull request's URL (set by `pr`). */
  prUrl?: string;
}

/**
 * `POST /code/remove` on the local connector: drop a session's container and,
 * unless the user asked to keep it, its checkout on disk.
 */
export interface CodeRemoveRequest {
  sessionId: string;
  /** Keep the checkout (only stop + remove the container). */
  keepFiles?: boolean;
}

/** One workspace the connector holds on disk (`GET /code/sessions`). */
export interface CodeWorkspaceSummary {
  sessionId: string;
  repo: CodeRepoRef;
  branch: string;
  image: string;
  /** Bytes on disk, or `null` when it could not be measured. */
  sizeBytes: number | null;
  containerRunning: boolean;
  updatedAt: number;
}

/** Response of `GET /code/sessions`. */
export interface CodeWorkspaceListResponse {
  workspaces: CodeWorkspaceSummary[];
}

/**
 * `GET /api/code/config`: the non-secret Code settings declared in the YAML
 * config (`code:` block), read by the browser. Docker images are **not** here —
 * the connector detects them per repository and the user overrides them in the
 * app settings.
 */
export interface CodeConfig {
  /** Default base branch when the repo's default is unknown. */
  defaultBaseBranch: string;
  /** Optional allow-list of Bitbucket base URLs the Code tab may clone from. */
  baseUrlAllowlist?: string[];
  /**
   * Language-server policy: whether the Code tab may run them and, in a closed
   * network, which internal mirrors to install them from.
   */
  lsp?: CodeLspConfig;
}
