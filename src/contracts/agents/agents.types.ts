import { type ArtifactPayload } from '../artifacts/artifacts.types';
import { type ChatCompletionTool, type ChatMessage, type CompletionUsage } from '../llm/llm.types';
import { type Manifest } from '../manifest/manifest.types';
import { type McpToolSource } from '../mcp/mcp.types';
import { type Skill } from '../skills/skills.types';

/**
 * The skill fields the connector needs to materialize a skill package into a
 * deep agent's workspace (its `SKILL.md` + bundled files). A subset of
 * {@link Skill} that both shared skills and the browser's personal skills
 * satisfy, so timestamps don't have to be carried into the run request.
 */
export type DeepAgentSkill = Pick<Skill, 'id' | 'name' | 'description' | 'instructions' | 'files'>;

/**
 * One reference file from a project's knowledge base, materialized by the
 * connector into the agent's workspace under `files/` so the agent can read it
 * with its filesystem tools. Mirrors {@link SkillFile}, but these belong to the
 * project rather than to a skill package.
 */
export interface DeepAgentFile {
  /** Relative path inside the workspace's `files/` dir, e.g. `spec.md`. */
  path: string;
  /** Plain-text content (already extracted from docx/xlsx by the browser). */
  content: string;
}

/**
 * Optional model sampling parameters for a deep agent. Each is passed straight
 * to the connector's `ChatOpenAI` (and forwarded verbatim by the API proxy), so
 * an omitted field means "use the provider's default". `reasoningEffort` only
 * applies to reasoning-capable models; other providers may ignore it.
 */
export interface DeepAgentModelParams {
  /** Sampling temperature (typically 0–2). Omitted = deterministic default (0). */
  temperature?: number;
  /** Nucleus sampling probability (0–1). */
  topP?: number;
  /** Maximum number of tokens to generate in the reply. */
  maxTokens?: number;
  /** Penalty for token frequency (OpenAI `frequency_penalty`). */
  frequencyPenalty?: number;
  /** Penalty for token presence (OpenAI `presence_penalty`). */
  presencePenalty?: number;
  /** Reasoning effort for reasoning models (`reasoning_effort`). */
  reasoningEffort?: 'low' | 'medium' | 'high';
}

/**
 * A sub-agent within a {@link DeepAgent}. Maps onto `deepagentsjs`'s
 * `subagents[]` entries: a named, described specialist with its own system
 * prompt and an optional allow-list of tool names it may use. `tools` is a list
 * of MCP tool **names** (portable across shared/personal agents) rather than
 * browser-local connection ids; omitted/empty means it inherits every tool in
 * the chat's MCP scope.
 */
export interface DeepAgentSubAgent {
  name: string;
  description: string;
  systemPrompt: string;
  /** Allow-list of MCP tool names; omitted or empty = all chat-scope tools. */
  tools?: string[];
}

/**
 * An agent's setup manifest — the shared {@link Manifest} shape (required /
 * recommended MCP servers + recommended settings). Aliased here for readability
 * at agent call sites.
 */
export type DeepAgentManifest = Manifest;

/**
 * OpenAI-compatible LLM parameters the connector uses to build its `ChatOpenAI`.
 * Neither an address nor a credential: the connector resolves the gateway and
 * the user's token from the configuration it was handed when the browser
 * connected (see {@link EngineConfigRequest}). What is left is the part that
 * genuinely belongs to this run — the model the agent picked and how it samples.
 */
export interface DeepAgentLlmParams extends DeepAgentModelParams {
  model: string;
}

/**
 * Where a background task stands. Mirrors deepagents' own `AsyncTaskStatus`
 * minus the states only a remote Agent Protocol server can report — ours runs
 * in the daemon, so it is either going, done, broken or stopped.
 */
export type BackgroundTaskStatus = 'running' | 'success' | 'error' | 'cancelled';

/**
 * A delegation the connector runs **outside the turn that asked for it**: the
 * agent calls `delegate_task`, gets a `taskId` back immediately, and the task
 * plays out in the daemon whether or not the browser is still watching.
 *
 * This is the record both sides agree on — the connector owns the run, the
 * browser owns the transcript (a sub-chat) and the index that survives a retry
 * of the parent turn. Shaped after deepagents' `AsyncTask` so the fields mean
 * the same thing they do there.
 */
export interface BackgroundTask {
  /** Stable id, shown to the model in full and naming the task's workspace. */
  taskId: string;
  /** The chat that delegated — the connector's `sessionId` for the parent run. */
  parentSessionId: string;
  /** Which sub-agent is running it (`subagent_type`). */
  agentName: string;
  /** Three-to-five words naming the task, for the card in the transcript. */
  title: string;
  /** The full brief the parent handed down. */
  prompt: string;
  status: BackgroundTaskStatus;
  createdAt: number;
  /** Last status change or follow-up message. */
  updatedAt: number;
  /** When it reached a terminal status; absent while running. */
  finishedAt?: number;
  /**
   * Head of the task's answer, capped connector-side. The parent reads the full
   * result through `check_task`; this is what the UI shows on the card and what
   * travels back into a re-run turn so it can be recognised without re-running.
   */
  resultPreview?: string;
  /** Why it failed, when `status` is `error`. */
  error?: string;
}

/** `GET /tasks/list?parentSessionId=` — every task the daemon still holds for a chat. */
export interface BackgroundTaskListResponse {
  tasks: BackgroundTask[];
}

/**
 * `POST /tasks/message` — a follow-up for a task, keeping its own conversation
 * intact. Both the parent agent (`send_to_task`) and the user (the sub-chat's
 * composer) reach a running or finished task through this one route.
 */
export interface BackgroundTaskMessageRequest {
  taskId: string;
  text: string;
}

/** `POST /tasks/stop` — cancel a task that is no longer wanted. */
export interface BackgroundTaskStopRequest {
  taskId: string;
}

/**
 * One frame of `GET /tasks/events?taskId=&from=N`: a task's progress event with
 * its **absolute** position in the task's stream.
 *
 * The index is what makes reconnecting exact. A browser that reloads mid-task
 * asks to resume from the position after the last event it wrote into the
 * sub-chat, and the daemon replays from there — rather than from the start,
 * which would duplicate the transcript, or from "now", which would lose the
 * middle of it.
 */
export interface BackgroundTaskFrame {
  index: number;
  event: DeepAgentStreamEvent;
}

/**
 * `POST /deepagent/stream` on the local connector. The browser resolves the
 * chat's deep agent, MCP scope and LLM settings, then forwards everything (incl.
 * MCP secrets) to the connector, which runs `deepagentsjs` locally and streams
 * OpenAI-shaped SSE chunks back.
 */
export interface DeepAgentRunRequest {
  /** Conversation so far, in OpenAI chat-message shape. */
  messages: ChatMessage[];
  /** The agent's main system prompt (a project rule is prepended by the web). */
  instructions: string;
  subAgents: DeepAgentSubAgent[];
  llm: DeepAgentLlmParams;
  /**
   * Scope-resolved MCP servers the agent (and its sub-agents) may use, each with
   * the tool policies of its selected preset.
   */
  tools: McpToolSource[];
  /**
   * Stable per-chat id (the chat id). Names the connector's on-disk workspace
   * directory so sandbox files persist across the turns of one chat.
   */
  sessionId: string;
  /**
   * Resolved skill contents the connector materializes into the workspace's
   * `/skills/` dir and exposes to the agent (deepagents `skills`). Empty/omitted
   * = no skills.
   */
  skills?: DeepAgentSkill[];
  /**
   * The project's knowledge-base files. The connector writes them into the
   * workspace's `/files/` dir and lists their paths in the system prompt so the
   * agent knows to read them. Empty/omitted = no reference files.
   */
  files?: DeepAgentFile[];
  /** Enable the real local sandbox (`LocalShellBackend` + `execute`). */
  sandbox?: boolean;
  /**
   * Current memory content of the chat's project when memory is enabled. The
   * connector seeds it into `MEMORY.md`, loads it via deepagents `memory`, and
   * streams the updated content back as a {@link DeepAgentStreamEvent} `memory`
   * event. When memory is disabled this is omitted.
   */
  memory?: string;
  /**
   * Tools the connector offers to the model but does **not** execute: it emits a
   * {@link DeepAgentStreamEvent} `client_tool` and blocks until the browser runs
   * the call and answers with {@link DeepAgentClientToolResult}. This is how a
   * tool whose side effects only exist in the browser — a drawing surface's
   * store and its render sandbox — reaches an agent that runs on the connector.
   *
   * Only the schemas travel; the implementation stays in the browser.
   */
  clientTools?: ChatCompletionTool[];
  /**
   * Whether to offer the built-in `write_artifact` tool. Defaults to `true`;
   * a host whose own canvas is the deliverable sends `false`, because offering
   * both invites the model to save its screen as an artifact nobody would open.
   */
  artifacts?: boolean;
  /**
   * Whether this run may delegate through {@link BackgroundTask}s. When on, the
   * connector offers the `delegate_task` family and **hides deepagents' built-in
   * `task`**, so there is exactly one way to delegate; when off, nothing changes
   * and `task` stays. Defaults to `false` — the browser turns it on only for a
   * daemon whose `GET /ping` advertises `backgroundTasks`.
   */
  allowTasks?: boolean;
  /**
   * The chat's already-known background tasks, listed in the system prompt so a
   * turn does not re-delegate work that is running or already done.
   *
   * It has to travel in the request: a task's own record lives in deepagents'
   * graph state, and this app runs each turn without a checkpointer *and*
   * without the previous turn's tool messages in the history — so nothing else
   * would carry it across. Same route the project's `memory` takes, for the
   * same reason.
   */
  tasks?: BackgroundTask[];
  /**
   * The plan as this conversation left it, seeded into the run's state and
   * listed in the system prompt.
   *
   * It travels for the same reason {@link DeepAgentRunRequest.tasks} does — no
   * checkpointer, and a history the app sends as text — but the consequence is
   * sharper: langchain's todo middleware puts the list in front of the model
   * only as the `write_todos` tool result, which is a message the next turn does
   * not have. Without this the agent starts every turn believing it has never
   * planned anything, so «keep the plan up to date» is not something it can
   * obey.
   */
  todos?: DeepAgentTodo[];
  /**
   * Whether this run must open with a plan. When set, the engine forces
   * `write_todos` on the first model call of a turn that has none
   * (`plan/plan-nudge.ts`); when unset, planning stays the agent's own call,
   * nudged but never compelled.
   *
   * For a surface whose whole promise is a plan — a research turn, a coding turn
   * in plan mode — leaving it to the model means the mode silently does not
   * happen on models that do not reach for optional tools.
   */
  requirePlan?: boolean;
}

/**
 * `POST /deepagent/client-tool` on the local connector: the outcome of a
 * {@link DeepAgentStreamEvent} `client_tool` call the browser executed on the
 * agent's behalf, which unblocks the tool and resumes the still-open
 * `/deepagent/stream` turn.
 */
export interface DeepAgentClientToolResult {
  /** The `client_tool` event's `id` being answered. */
  id: string;
  /** The tool result, as the model should see it. */
  text: string;
  /** True when the call failed; the text is then the failure the model reads. */
  isError?: boolean;
}

/** A single item of a deep agent's live plan (deepagents' `write_todos`). */
export interface DeepAgentTodo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/**
 * A choice the agent puts to the user via its built-in `ask_user` tool
 * (human-in-the-loop). The connector emits this as an {@link DeepAgentStreamEvent}
 * and blocks the tool until the browser answers with {@link DeepAgentAnswerRequest};
 * the web renders `options` as interactive buttons.
 */
export interface DeepAgentAsk {
  /** Correlates the emitted question with the answer that resumes the run. */
  id: string;
  /** The question shown above the buttons. */
  question: string;
  /** The selectable options. */
  options: string[];
  /** True when the user may pick several options before answering. */
  multi: boolean;
}

/**
 * `POST /deepagent/answer` on the local connector: the user's answer to a pending
 * {@link DeepAgentAsk}, which unblocks the agent's `ask_user` tool and resumes the
 * still-open `/deepagent/stream` turn.
 */
export interface DeepAgentAnswerRequest {
  /** The {@link DeepAgentAsk.id} being answered. */
  id: string;
  /** The chosen option(s), already joined into the reply text. */
  answer: string;
}

/**
 * A progress event streamed from the connector as a deep agent runs its turn
 * (`POST /deepagent/stream`, one per SSE `data:` frame). The connector consumes
 * the deepagents graph with langgraph `streamMode: "updates"` and projects each
 * step into one of these so the web client can show live progress instead of
 * only the final text.
 */
export type DeepAgentStreamEvent =
  /** Incremental assistant text (the agent's narration and its final answer). */
  | { type: 'text'; delta: string }
  /** The current plan snapshot, replacing any previous one. */
  | { type: 'todos'; todos: DeepAgentTodo[] }
  /**
   * A tool call or sub-agent delegation the agent just started. `kind` is
   * `subagent` for the built-in `task` tool (then `name` is the sub-agent and
   * `label` its instruction), else `tool` (an MCP tool, or — on the Code path —
   * a filesystem / shell built-in, by its exposed name). `label` is the single
   * most telling argument (a path, a pattern, the command) so the timeline reads
   * as «edit_file src/app.ts» rather than a bare tool name; `args` is the call's
   * raw arguments (JSON, already truncated connector-side), shown when the user
   * expands the step to see what was actually called.
   */
  | {
      type: 'tool_call';
      id: string;
      name: string;
      kind: 'tool' | 'subagent';
      label?: string;
      args?: string;
      /**
       * True when `args` was cut to the connector's cap, so it is no longer
       * valid JSON. Consumers that replay a call to the model must fall back to
       * a textual summary of the step rather than emitting a `tool_calls` entry
       * a provider would reject.
       */
      argsTruncated?: boolean;
    }
  /**
   * A previously-started tool call or delegation finished. `preview` carries the
   * head of the tool's output (already truncated connector-side) so the UI can
   * show a build/test failure without asking the agent to repeat it.
   *
   * `interrupted` marks a call the connector closed out because the turn ended
   * underneath it rather than because the tool reported anything — the step is
   * over, but nothing is known about its outcome.
   */
  | {
      type: 'tool_result';
      id: string;
      isError?: boolean;
      interrupted?: boolean;
      preview?: string;
      exitCode?: number;
      /**
       * True when `preview` is only the head of a longer output. Shown in the
       * UI, and stated to the model when the step is replayed, so it knows to
       * repeat the call rather than treat the tail as absent.
       */
      truncated?: boolean;
    }
  /**
   * The agent's memory (`MEMORY.md`) after the turn, replacing the previous
   * snapshot. Emitted only when memory is enabled; the browser persists it per
   * project (memory is browser-owned, the workspace file is scratch).
   */
  | { type: 'memory'; content: string }
  /**
   * The agent is asking the user to choose (its `ask_user` tool). The turn's
   * stream stays open and blocked until the browser answers via
   * `POST /deepagent/answer` (see {@link DeepAgentAnswerRequest}).
   */
  | ({ type: 'ask_user' } & DeepAgentAsk)
  /**
   * The agent called one of the run's {@link DeepAgentRunRequest.clientTools} —
   * a tool the connector offers but cannot run, because its side effects only
   * exist in the browser. The turn's stream stays open and blocked until the
   * browser executes it and answers via `POST /deepagent/client-tool` (see
   * {@link DeepAgentClientToolResult}).
   *
   * `args` is the call's raw JSON arguments, forwarded verbatim — the browser
   * parses them, since it owns the implementation.
   */
  | { type: 'client_tool'; id: string; name: string; args: string }
  /**
   * The agent saved an artifact (its `write_artifact` tool) — a document, code,
   * an HTML page or a React component the browser persists per chat and renders
   * in its artifact panel. Re-writing the same `key` adds a new version.
   */
  | ({ type: 'artifact' } & ArtifactPayload)
  /**
   * The turn failed, or degraded in a way the user should know about. `fatal`
   * separates the two: a fatal error ended the turn and is recorded on the
   * message so it can be retried, while a non-fatal one (an MCP server that
   * would not connect, a tool whose schema could not be bridged) is a warning
   * beside a turn that carries on. Without this the connector could only report
   * a failure as assistant `text`, which left it unretriable and fed the error
   * back to the model as history on the next turn.
   */
  | { type: 'error'; message: string; fatal: boolean }
  /**
   * The turn hit the connector's step budget (langgraph's `recursionLimit`) and
   * was cut short. Not a failure — everything done so far stands — so the web
   * records it as a terminal notice, the same way the in-browser tool loop ends
   * when it exhausts its own iteration cap.
   */
  | { type: 'limit' }
  /**
   * Token usage for the whole turn, summed over every model call the agent made.
   * Emitted once, at the end: unlike the browser's tool loop the connector talks
   * to the model itself, so without this a deep-agent turn would report no spend
   * at all.
   */
  | { type: 'usage'; usage: CompletionUsage }
  /**
   * The in-graph summarizer compacted the conversation mid-turn, keeping
   * `keptMessages` of them verbatim. Surfaced because a context that silently
   * shrinks is indistinguishable, from the outside, from an agent that has
   * started forgetting.
   */
  | { type: 'summarized'; keptMessages: number }
  /**
   * The agent delegated a {@link BackgroundTask}. Emitted the moment the task is
   * registered, not when it finishes — the browser opens the sub-chat that will
   * hold its transcript and subscribes to `GET /tasks/events` off the back of
   * this. `cached` marks a delegation answered straight from a task that had
   * already completed with the same brief, which is what makes retrying the
   * parent turn cheap.
   */
  | { type: 'task_started'; task: BackgroundTask; cached?: boolean }
  /**
   * A tracked task changed state (finished, failed, was cancelled). The task's
   * own event stream carries its work; this is the parent turn learning that
   * something it is waiting on is over.
   */
  | { type: 'task_status'; taskId: string; status: BackgroundTaskStatus };

/** One entry of the persisted activity timeline (a resolved {@link DeepAgentStreamEvent}). */
export interface DeepAgentStep {
  id: string;
  name: string;
  kind: 'tool' | 'subagent';
  label?: string;
  /**
   * `interrupted` is its own outcome, not an error: the turn ended (stopped, out
   * of steps, or failed elsewhere) while this call was still in flight, so
   * nothing is known about how it went. Without it such a step keeps its
   * `running` status forever — and because the transcript is persisted, the
   * spinner survives a reload and the session looks permanently stuck.
   */
  status: 'running' | 'done' | 'error' | 'interrupted';
  /** When the call started, for the elapsed-time counter on a running step. */
  startedAt?: number;
  /**
   * The call's raw arguments (JSON), shown when the step row is expanded — and,
   * on the Code path, what the next turn replays the call from.
   */
  args?: string;
  /** True when `args` was cut and is therefore no longer valid JSON. */
  argsTruncated?: boolean;
  /** Head of the tool's output, shown when the step row is expanded. */
  preview?: string;
  /** True when `preview` is only the head of a longer output. */
  truncated?: boolean;
  /** Shell exit code, for the steps backed by a command. */
  exitCode?: number;
}
