import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { readRepoCatalog } from './catalog-repo';
import { describeCodeContext, runCodeStream } from './code/code-agent';
import { runCodeCommand } from './code/code-command';
import { readMemoryReport, tidyMemoryText, writeMemory } from './code/code-memory';
import { runCodeSetup } from './code/code-setup';
import { CodeWorkspaces } from './code/code-workspace';
import { readSpecState } from './code/openspec/openspec-store';
import { writeSpec } from './code/openspec/openspec-write';
import { adoptEngineConfig, configVersion, requireConfig } from './config/engine-config';
import { Connector, ConnectorError } from './connector';
import {
  type BackgroundTask,
  type BackgroundTaskFrame,
  type BackgroundTaskListResponse,
  type BackgroundTaskMessageRequest,
  type BackgroundTaskStopRequest,
  type CatalogRepoListRequest,
  type CatalogRepoListResponse,
  type ChatCompletionRequest,
  type CodeCloneRequest,
  type CodeCommandRequest,
  type CodeCommandResult,
  type CodeDiff,
  type CodeDiffMode,
  type CodeRemoveRequest,
  type CodeRunRequest,
  type CodeMemoryWriteRequest,
  type CodeSetupEvent,
  type CodeSetupRequest,
  type CodeSpecWriteRequest,
  type CodeStreamEvent,
  type CodeWorkspaceListResponse,
  type CodeWorkspaceStatus,
  type EngineConfigRequest,
  type EngineConfigResponse,
  type DeepAgentAnswerRequest,
  type DeepAgentClientToolResult,
  type DeepAgentRunRequest,
  type DeepAgentStreamEvent,
  type IntegrationConfigPatchRequest,
  type IntegrationConfigReadRequest,
  type IntegrationConfigReadResponse,
  type IntegrationConfigWriteRequest,
  type IntegrationConfigWriteResponse,
  type IntegrationListRequest,
  type IntegrationListResponse,
  type LocalFilesWriteRequest,
  type LocalFilesWriteResponse,
  type LocalPluginDeleteRequest,
  type LocalPluginDeleteResponse,
  type LocalPluginsListRequest,
  type LocalPluginsListResponse,
  type LocalPluginWriteRequest,
  type LocalPluginWriteResponse,
  type LocalSkillDeleteRequest,
  type LocalSkillDeleteResponse,
  type LocalSkillsListRequest,
  type LocalSkillsListResponse,
  type LocalSkillWriteRequest,
  type LocalSkillWriteResponse,
  type LlmChatRequest,
  type McpConnectorPing,
  type McpListToolsRequest,
  type McpListToolsResponse,
  type McpToolCallRequest,
  type McpToolCallResponse,
  type ModelsListResponse,
  type PluginRepoFetchRequest,
  type PluginRepoFetchResponse,
  type PluginRepoListRequest,
  type PluginRepoListResponse,
  type RepoCheckRequest,
  type RepoCheckResponse,
  type SearchStartRequest,
  type SkillRepoFetchRequest,
  type SkillRepoFetchResponse,
  type SkillRepoListRequest,
  type SkillRepoListResponse,
  type StorageDocumentGetRequest,
  type StorageDocumentGetResponse,
  type StorageDocumentRemoveRequest,
  type StorageDocumentSetRequest,
  type StorageOkResponse,
  type StorageRecordsClearRequest,
  type StorageRecordsDeleteRequest,
  type StorageRecordsListRequest,
  type StorageRecordsListResponse,
  type StorageRecordsPutRequest,
  repoProvider,
} from './contracts';
import { type PendingAnswers, runDeepAgentStream, sweepWorkspaces } from './deep-agent';
import {
  patchIntegrationConfig,
  readIntegrationConfig,
  writeIntegrationConfig,
} from './integration-config';
import { listIntegrationTargets } from './integration-targets';
import { chatCompletion, listModels } from './llm/llm-client';
import { writeLocalFiles } from './local-files';
import { deleteLocalPlugin, listLocalPlugins, writeLocalPlugin } from './local-plugins';
import { deleteLocalSkill, listLocalSkills, writeLocalSkill } from './local-skills';
import { PACKAGE_NAME, PACKAGE_VERSION } from './package.constants';
import { fetchRepoPlugins, listRepoPlugins } from './plugin-repo';
import { SearxngContainer } from './search/searxng-container';
import { fetchRepoSkills, listRepoSkills } from './skill-repo';
import { StateDb } from './storage/state-db';
import { BackgroundTasks, TaskError } from './tasks/background-tasks';
import { checkRepoCredentials } from './vcs/vcs';

/**
 * With `AGENT_ENGINE_DEBUG_EVENTS=1` every progress event a turn emits is echoed to the
 * daemon's console (text truncated). This is the only place where what the agent
 * actually streamed can be read back, which is what you need when the chat shows
 * something the transcript cannot explain.
 */
function logEvent(event: DeepAgentStreamEvent | CodeStreamEvent): void {
  if (process.env.AGENT_ENGINE_DEBUG_EVENTS !== '1') {
    return;
  }
  const detail = JSON.stringify(event);
  console.log(`[event] ${detail.length > 300 ? `${detail.slice(0, 300)}…` : detail}`);
}

const MAX_BODY_BYTES = 5_000_000;

/** The only thing the storage write routes have to say. */
const STORAGE_OK: StorageOkResponse = { status: 'ok' };

export interface EngineServerOptions {
  token: string;
  /**
   * The MCP connection pool. Injectable so a test can drive the routes without
   * connecting to real servers; production always builds its own.
   */
  connector?: Connector;
  /** The Code workspace manager, injectable for the same reason. */
  workspaces?: CodeWorkspaces;
  /** The managed SearXNG instance, injectable so a test never runs Docker. */
  searxng?: SearxngContainer;
  /**
   * The client database on this machine. Injectable so a test points it at a
   * temporary file instead of the real `~/.agent-engine/state.db`, which holds
   * the user's chats.
   */
  stateDb?: StateDb;
  /**
   * The background-task registry. Injectable so a test can drive `/tasks/*`
   * with a runner of its own instead of a real agent loop.
   */
  tasks?: BackgroundTasks;
  /**
   * Root of the per-chat deep-agent workspaces swept at startup. Overridable so
   * a test never ages out the real `~/.agent-engine/deep-agents`.
   */
  sweepRoot?: string;
  /**
   * Called when an authenticated `POST /shutdown` asks the daemon to stop.
   *
   * The route exists for an embedding shell that owns this process and has to
   * end it when its window closes. It cannot do that with a
   * signal: Windows has no `SIGTERM`, and killing the process outright skips
   * the container cleanup in {@link EngineServer.shutdownConnector} — the
   * user finds the coding sandbox containers still running afterwards. An HTTP call
   * behaves the same on both platforms.
   *
   * The handler owns the exit; this module never calls `process.exit` itself,
   * so a test (and an embedder) can observe the request without dying.
   */
  onShutdownRequest?: () => void;
}

/**
 * The connector's HTTP server plus the hook a supervisor needs to stop it.
 *
 * `Server.close()` alone never finishes here: it waits for open connections, and
 * an SSE stream has no reason to end on its own — so Ctrl+C used to hang the
 * daemon forever, and the `close` handler that stops MCP connections and Docker
 * containers never ran at all.
 */
export interface EngineServer extends Server {
  /**
   * Aborts every in-flight stream, drops the sockets, then closes the MCP pool
   * and stops the session containers. Safe to call more than once.
   */
  shutdownConnector(): Promise<void>;
}

/**
 * Creates the local connector's HTTP server. Endpoints mirror the API's MCP
 * routes (`POST /mcp/tools`, `POST /mcp/tools/call`) with identical request /
 * response shapes so the web client is transport-agnostic. `GET /ping` is the
 * unauthenticated connectivity/version probe.
 */
export function createEngineServer(options: EngineServerOptions): EngineServer {
  const { token } = options;
  const connector = options.connector ?? new Connector();
  const workspaces = options.workspaces ?? new CodeWorkspaces();
  const searxng = options.searxng ?? new SearxngContainer();
  const stateDb = options.stateDb ?? new StateDb();

  // Probed once, at startup, and only for the flag: `/ping` has to answer
  // whether this daemon *could* hold the app's database before any of it is
  // moved here — a user who finds out on the first write has already switched.
  // The probe loads `node:sqlite` and nothing else; the file is still created
  // lazily, so a daemon nobody points at leaves no database behind.
  const storageSupported = StateDb.isSupported();

  // Every open SSE stream, so shutdown can end them instead of waiting for
  // clients that have no reason to disconnect.
  const openStreams = new Set<AbortController>();

  // A deep-agent workspace is named after its chat, and nothing tells the daemon
  // when that chat is deleted — so old ones are aged out at startup instead.
  sweepWorkspaces(options.sweepRoot);

  // Resolvers for in-flight `ask_user` questions across every open deep-agent /
  // code stream, keyed by question id. Shared so `POST /deepagent/answer` (and
  // `/code/answer`) can resume the tool blocking inside a still-open stream.
  const pendingAnswers: PendingAnswers = new Map();

  // Background tasks run the same agent loop, minus `ask_user` and minus the
  // token stream: a task outlives the request that started it, so a question
  // would block it against a browser that may no longer be there to answer —
  // and its events double as the replay buffer a returning browser reads, which
  // per-token text would overrun (see `tasks/tasks.constants.ts`).
  const tasks =
    options.tasks ??
    new BackgroundTasks((request, onEvent, taskSignal) =>
      runDeepAgentStream(connector, searxng, request, onEvent, taskSignal, pendingAnswers, {
        askUser: false,
      }),
    );

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      sendError(res, error);
    });
  }) as EngineServer;

  let shutdownOnce: Promise<void> | null = null;
  server.shutdownConnector = (): Promise<void> => {
    shutdownOnce ??= (async () => {
      for (const controller of openStreams) {
        controller.abort();
      }
      openStreams.clear();
      // Destroying the sockets is what lets `server.close()` ever complete.
      server.closeAllConnections();
      await Promise.allSettled([
        connector.shutdown(),
        workspaces.shutdown(),
        tasks.shutdown(),
        stateDb.close(),
      ]);
    })();
    return shutdownOnce;
  };

  // A close initiated some other way (a test, a supervisor) still cleans up.
  server.on('close', () => void server.shutdownConnector());

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    setCors(req, res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    const { pathname } = new URL(req.url ?? '/', 'http://localhost');

    // Health probe stays unauthenticated so the UI can detect a running daemon
    // even when the token is wrong — but it reports whether the token matched,
    // so the UI can tell "daemon down" from "token wrong" instead of calling
    // itself connected and then 401-ing on every turn.
    if (req.method === 'GET' && pathname === '/ping') {
      const body: McpConnectorPing = {
        status: 'ok',
        name: PACKAGE_NAME,
        version: PACKAGE_VERSION,
        authorized: bearerOf(req) === token,
        // Empty until the browser hands one over — which is exactly what tells
        // it to hand one over, whether the daemon has just started or its
        // settings have changed underneath it.
        configVersion: configVersion(),
        storage: await storageSupported,
      };
      sendJson(res, 200, body);
      return;
    }

    requireAuth(req);

    // The connection handshake: everything this daemon needs that is
    // configuration rather than content — the API it belongs to (from which it
    // reads the gateway address and the deployment's CA certificates), the
    // user's LLM token, the web-search policy and the Bitbucket access. Repeated
    // whenever `/ping` reports a version other than the browser's, so a daemon
    // that has just restarted is told again without the user doing anything.
    if (req.method === 'POST' && pathname === '/config') {
      const request = await readJson<EngineConfigRequest>(req);
      const response: EngineConfigResponse = await adoptEngineConfig(request);
      sendJson(res, 200, response);
      return;
    }

    // Answered before anything is torn down, so the caller learns the request
    // was accepted rather than seeing a dropped socket and having to guess.
    if (req.method === 'POST' && pathname === '/shutdown') {
      sendJson(res, 200, { status: 'ok' });
      res.on('finish', () => options.onShutdownRequest?.());
      return;
    }

    if (req.method === 'POST' && pathname === '/mcp/tools') {
      const { config } = await readJson<McpListToolsRequest>(req);
      const response: McpListToolsResponse = { tools: await connector.listTools(config) };
      sendJson(res, 200, response);
      return;
    }

    if (req.method === 'POST' && pathname === '/mcp/tools/call') {
      const { config, toolName, arguments: args } = await readJson<McpToolCallRequest>(req);
      const response: McpToolCallResponse = await connector.callTool(config, toolName, args);
      sendJson(res, 200, response);
      return;
    }

    if (req.method === 'POST' && pathname === '/deepagent/stream') {
      const request = await readJson<DeepAgentRunRequest>(req);
      // Before the stream is opened, not inside it: a turn on an unconfigured
      // daemon has to come back as a status the browser can answer (hand the
      // configuration over, retry), not as a fatal error event in a stream it
      // has already committed to reading.
      requireConfig();
      await streamDeepAgent(res, connector, request);
      return;
    }

    // Answers a pending `ask_user` question, unblocking the tool inside the
    // matching open `/deepagent/stream` turn. 404 if the question is unknown
    // (e.g. the stream already ended or was aborted).
    if (req.method === 'POST' && pathname === '/deepagent/answer') {
      const { id, answer } = await readJson<DeepAgentAnswerRequest>(req);
      const resolve = pendingAnswers.get(id);
      if (!resolve) {
        throw new ConnectorError(404, 'No pending question with that id');
      }
      pendingAnswers.delete(id);
      resolve({ text: answer });
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    // Returns the result of a `client_tool` call the browser executed on the
    // agent's behalf, unblocking the tool inside the matching open
    // `/deepagent/stream` turn. Shares `pendingAnswers` with `ask_user` — both
    // are a connector-side tool waiting on the browser. 404 if the call is
    // unknown (the stream already ended, or the turn was aborted underneath it).
    if (req.method === 'POST' && pathname === '/deepagent/client-tool') {
      const { id, text, isError } = await readJson<DeepAgentClientToolResult>(req);
      const resolve = pendingAnswers.get(id);
      if (!resolve) {
        throw new ConnectorError(404, 'No pending client tool call with that id');
      }
      pendingAnswers.delete(id);
      resolve({ text, ...(isError ? { isError } : {}) });
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    // Background tasks — everything the daemon still holds for one chat, so a
    // browser that reloaded can find the tasks its transcript refers to and
    // re-attach to the ones still running.
    if (req.method === 'GET' && pathname === '/tasks/list') {
      const parentSessionId = query(req).get('parentSessionId');
      if (!parentSessionId) {
        throw new ConnectorError(400, 'parentSessionId query parameter is required');
      }
      const response: BackgroundTaskListResponse = { tasks: tasks.list(parentSessionId) };
      sendJson(res, 200, response);
      return;
    }

    // Background tasks — one task's stream: everything from `from` onwards,
    // then live. Closing it does **not** cancel the task; that is the whole
    // point of a background task, and the difference from `/deepagent/stream`.
    if (req.method === 'GET' && pathname === '/tasks/events') {
      const params = query(req);
      const taskId = params.get('taskId');
      if (!taskId) {
        throw new ConnectorError(400, 'taskId query parameter is required');
      }
      if (!tasks.get(taskId)) {
        throw new ConnectorError(404, 'No task with that id');
      }
      streamTaskEvents(res, taskId, Number(params.get('from')) || 0);
      return;
    }

    // Background tasks — a follow-up, from the agent's `send_to_task` or from
    // the sub-chat's composer. The task keeps its own context either way.
    if (req.method === 'POST' && pathname === '/tasks/message') {
      const { taskId, text } = await readJson<BackgroundTaskMessageRequest>(req);
      if (!taskId || !text?.trim()) {
        throw new ConnectorError(400, 'taskId and a non-empty text are required');
      }
      sendJson(res, 200, await runTaskAction(() => tasks.message(taskId, text)));
      return;
    }

    if (req.method === 'POST' && pathname === '/tasks/stop') {
      const { taskId } = await readJson<BackgroundTaskStopRequest>(req);
      if (!taskId) {
        throw new ConnectorError(400, 'taskId is required');
      }
      sendJson(res, 200, await runTaskAction(() => tasks.stop(taskId)));
      return;
    }

    // Code tab — prepare a session's Docker workspace (clone + container).
    if (req.method === 'POST' && pathname === '/code/clone') {
      const request = await readJson<CodeCloneRequest>(req);
      const status: CodeWorkspaceStatus = await workspaces.prepare(request);
      sendJson(res, 200, status);
      return;
    }

    // Code tab — the current git + toolchain state of a prepared workspace.
    if (req.method === 'GET' && pathname === '/code/status') {
      const sessionId = query(req).get('sessionId');
      if (!sessionId) {
        throw new ConnectorError(400, 'sessionId query parameter is required');
      }
      sendJson(res, 200, await workspaces.status(sessionId));
      return;
    }

    // Code tab — the workspace diff (`worktree` by default, or the whole branch).
    if (req.method === 'GET' && pathname === '/code/diff') {
      const params = query(req);
      const sessionId = params.get('sessionId');
      if (!sessionId) {
        throw new ConnectorError(400, 'sessionId query parameter is required');
      }
      const mode: CodeDiffMode = params.get('mode') === 'branch' ? 'branch' : 'worktree';
      const diff: CodeDiff = await workspaces.diff(sessionId, mode);
      sendJson(res, 200, diff);
      return;
    }

    // Code tab — every workspace held on disk (for the settings screen / cleanup).
    if (req.method === 'GET' && pathname === '/code/sessions') {
      const response: CodeWorkspaceListResponse = { workspaces: await workspaces.list() };
      sendJson(res, 200, response);
      return;
    }

    // Code tab — install the stack's dependencies and seed the project memory
    // (SSE stream). Kept out of `/code/clone` because an install runs for
    // minutes and its log belongs in the session, not behind a spinner.
    if (req.method === 'POST' && pathname === '/code/setup') {
      const request = await readJson<CodeSetupRequest>(req);
      requireConfig();
      await streamSetup(res, request);
      return;
    }

    // Code tab — run the built-in coding agent for one turn (SSE stream).
    if (req.method === 'POST' && pathname === '/code/stream') {
      const request = await readJson<CodeRunRequest>(req);
      // Checked before the stream opens, for the same reason as on the
      // deep-agent route.
      requireConfig();
      await streamCode(res, request);
      return;
    }

    // Code tab — run a deterministic git command (/branch, /commit, /pr), no LLM.
    if (req.method === 'POST' && pathname === '/code/command') {
      const request = await readJson<CodeCommandRequest>(req);
      const controller = new AbortController();
      onClientGone(res, () => controller.abort());
      await workspaces.acquire(request.sessionId);
      try {
        const result: CodeCommandResult = await runCodeCommand(
          workspaces,
          request,
          controller.signal,
        );
        sendJson(res, 200, result);
      } finally {
        workspaces.release(request.sessionId);
      }
      return;
    }

    // Code tab — what the coding agent's memory holds, for the `/memory` editor.
    if (req.method === 'GET' && pathname === '/code/memory') {
      const sessionId = query(req).get('sessionId');
      if (!sessionId) {
        throw new ConnectorError(400, 'sessionId query parameter is required');
      }
      const info = await workspaces.backendInfo(sessionId);
      sendJson(res, 200, readMemoryReport(info.dir, await workspaces.failures(sessionId)));
      return;
    }

    // Code tab — what the model is shown before the conversation: the prompt, the
    // memory files, the skills and the tool schemas. Recomputed without running a
    // turn, so `/context` can answer at any time.
    if (req.method === 'GET' && pathname === '/code/context') {
      const sessionId = query(req).get('sessionId');
      if (!sessionId) {
        throw new ConnectorError(400, 'sessionId query parameter is required');
      }
      const contextLength = Number(query(req).get('contextLength'));
      sendJson(
        res,
        200,
        await describeCodeContext(
          workspaces,
          sessionId,
          Number.isFinite(contextLength) && contextLength > 0 ? contextLength : undefined,
        ),
      );
      return;
    }

    // Code tab — write memory: one appended entry (the composer's `#`), a whole
    // file (the editor), or a tidy-up. Takes the session lock so it cannot race a
    // turn that is rewriting the same file.
    if (req.method === 'POST' && pathname === '/code/memory') {
      const request = await readJson<CodeMemoryWriteRequest>(req);
      if (!request.sessionId) {
        throw new ConnectorError(400, 'sessionId is required');
      }
      const info = await workspaces.backendInfo(request.sessionId);
      await workspaces.acquire(request.sessionId);
      try {
        const result = await writeMemory(info.dir, request, {
          failures: () => workspaces.failures(request.sessionId),
          clearFailures: (lesson) => workspaces.clearFailures(request.sessionId, lesson),
          tidy: (text) => tidyMemoryText(request, text),
        });
        sendJson(res, 200, result);
      } finally {
        workspaces.release(request.sessionId);
      }
      return;
    }

    // Code tab — where the session's OpenSpec process stands: the active change
    // with its artefacts, the checklist, the deltas and the findings. Read from
    // the checkout on every call, so the panel and the next turn can never
    // disagree about the stage.
    if (req.method === 'GET' && pathname === '/code/spec') {
      const sessionId = query(req).get('sessionId');
      if (!sessionId) {
        throw new ConnectorError(400, 'sessionId query parameter is required');
      }
      const info = await workspaces.backendInfo(sessionId);
      sendJson(res, 200, await readSpecState(info.dir));
      return;
    }

    // Code tab — act on the process: create it, edit an artefact, tick a task,
    // archive or discard a change, export the tree into the repository. Takes
    // the session lock, so a click cannot race the turn that is rewriting the
    // same files.
    if (req.method === 'POST' && pathname === '/code/spec') {
      const request = await readJson<CodeSpecWriteRequest>(req);
      if (!request.sessionId) {
        throw new ConnectorError(400, 'sessionId is required');
      }
      const info = await workspaces.backendInfo(request.sessionId);
      await workspaces.acquire(request.sessionId);
      try {
        sendJson(res, 200, await writeSpec(info.dir, request));
      } finally {
        workspaces.release(request.sessionId);
      }
      return;
    }

    // Code tab — drop a session's container and (optionally) its checkout.
    if (req.method === 'POST' && pathname === '/code/remove') {
      const { sessionId, keepFiles } = await readJson<CodeRemoveRequest>(req);
      if (!sessionId) {
        throw new ConnectorError(400, 'sessionId is required');
      }
      await workspaces.remove(sessionId, keepFiles === true);
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    // Skills — read the Agent Skills packages in a folder on the user's machine.
    // POST rather than GET so the path travels in a JSON body (spaces, unicode,
    // Windows separators all survive without URL encoding).
    if (req.method === 'POST' && pathname === '/skills/list') {
      const { dir } = await readJson<LocalSkillsListRequest>(req);
      const response: LocalSkillsListResponse = listLocalSkills(dir);
      sendJson(res, 200, response);
      return;
    }

    // Skills — write one skill back out as a package in that same folder.
    if (req.method === 'POST' && pathname === '/skills/write') {
      const request = await readJson<LocalSkillWriteRequest>(req);
      const response: LocalSkillWriteResponse = writeLocalSkill(request);
      sendJson(res, 200, response);
      return;
    }

    // Skills — remove one package from that folder. POST rather than DELETE for
    // the same reason as the other two: the path travels in a JSON body.
    if (req.method === 'POST' && pathname === '/skills/delete') {
      const request = await readJson<LocalSkillDeleteRequest>(req);
      const response: LocalSkillDeleteResponse = deleteLocalSkill(request);
      sendJson(res, 200, response);
      return;
    }

    // Skills — every package in a Bitbucket repository, described from its
    // `SKILL.md` alone. Runs here rather than in the browser or the API because
    // this daemon is already inside the network the on-prem Bitbucket sits in.
    if (req.method === 'POST' && pathname === '/skills/repo/list') {
      const request = await readJson<SkillRepoListRequest>(req);
      const response: SkillRepoListResponse = await listRepoSkills(request);
      sendJson(res, 200, response);
      return;
    }

    // Skills — download the chosen packages whole, resources and all.
    if (req.method === 'POST' && pathname === '/skills/repo/fetch') {
      const request = await readJson<SkillRepoFetchRequest>(req);
      const response: SkillRepoFetchResponse = await fetchRepoSkills(request);
      sendJson(res, 200, response);
      return;
    }

    // Verifies the repository credentials the settings screen holds, against the
    // host they are for. Nothing is stored — the answer is the whole point of
    // the call.
    if (req.method === 'POST' && pathname === '/repos/check') {
      const { provider, baseUrl, credentials } = await readJson<RepoCheckRequest>(req);
      await checkRepoCredentials(repoProvider({ provider }), baseUrl, credentials);
      const response: RepoCheckResponse = { ok: true };
      sendJson(res, 200, response);
      return;
    }

    // Plugins — read the Agent Plugins packages in a folder on the user's
    // machine (skills + MCP servers + commands + sub-agents), same
    // POST-with-a-body reasoning as `/skills/list`.
    if (req.method === 'POST' && pathname === '/plugins/list') {
      const { dir } = await readJson<LocalPluginsListRequest>(req);
      const response: LocalPluginsListResponse = listLocalPlugins(dir);
      sendJson(res, 200, response);
      return;
    }

    // Plugins — write one plugin back out as a package in that same folder.
    if (req.method === 'POST' && pathname === '/plugins/write') {
      const request = await readJson<LocalPluginWriteRequest>(req);
      const response: LocalPluginWriteResponse = writeLocalPlugin(request);
      sendJson(res, 200, response);
      return;
    }

    // Plugins — remove one package from that folder, the counterpart of
    // `/skills/delete`.
    if (req.method === 'POST' && pathname === '/plugins/delete') {
      const request = await readJson<LocalPluginDeleteRequest>(req);
      const response: LocalPluginDeleteResponse = deleteLocalPlugin(request);
      sendJson(res, 200, response);
      return;
    }

    // Plugins — every package in a repository, described from its manifest
    // alone. Here rather than in the browser for the same reason the skills
    // walk is: this daemon is already inside the network the host sits in.
    if (req.method === 'POST' && pathname === '/plugins/repo/list') {
      const request = await readJson<PluginRepoListRequest>(req);
      const response: PluginRepoListResponse = await listRepoPlugins(request);
      sendJson(res, 200, response);
      return;
    }

    // Plugins — download the chosen packages whole, bundled skills and all.
    if (req.method === 'POST' && pathname === '/plugins/repo/fetch') {
      const request = await readJson<PluginRepoFetchRequest>(req);
      const response: PluginRepoFetchResponse = await fetchRepoPlugins(request);
      sendJson(res, 200, response);
      return;
    }

    // Catalogue — the plugins, skills and MCP servers an embedding app offers
    // out of the box, read whole from the repositories it names. One walk for
    // all three: they live in one tree and have to be read at one commit.
    if (req.method === 'POST' && pathname === '/catalog/repo/list') {
      const request = await readJson<CatalogRepoListRequest>(req);
      const response: CatalogRepoListResponse = await readRepoCatalog(request);
      sendJson(res, 200, response);
      return;
    }

    // Files — the loose halves of an integration bundle: the command and agent
    // markdown that Kilo Code and Claude Code read from disk rather than from
    // their config. Everything with a layout of its own (a skill package, a
    // plugin package) goes through the route that knows that layout.
    if (req.method === 'POST' && pathname === '/files/write') {
      const request = await readJson<LocalFilesWriteRequest>(req);
      const response: LocalFilesWriteResponse = writeLocalFiles(request);
      sendJson(res, 200, response);
      return;
    }

    // Integrations — where the other coding agents on this machine keep their
    // configuration. Resolved here because every input is a fact about this
    // host: the home directory, the platform's separators, and the environment
    // variables each tool honours. An embedder cannot know any of them.
    if (req.method === 'POST' && pathname === '/integrations/list') {
      const request = await readJson<IntegrationListRequest>(req);
      const response: IntegrationListResponse = listIntegrationTargets(request);
      sendJson(res, 200, response);
      return;
    }

    // Integrations — one such config document, verbatim. The `mtimeMs` it
    // reports comes back on the next write, so an edit made in the user's own
    // editor meanwhile is refused rather than overwritten.
    if (req.method === 'POST' && pathname === '/integrations/config/read') {
      const request = await readJson<IntegrationConfigReadRequest>(req);
      const response: IntegrationConfigReadResponse = readIntegrationConfig(request);
      sendJson(res, 200, response);
      return;
    }

    // Integrations — replace that document wholesale, for the screen's editor.
    if (req.method === 'POST' && pathname === '/integrations/config/write') {
      const request = await readJson<IntegrationConfigWriteRequest>(req);
      const response: IntegrationConfigWriteResponse = writeIntegrationConfig(request);
      sendJson(res, 200, response);
      return;
    }

    // Integrations — change named keys and leave every other byte alone. This
    // is what installing one MCP server goes through: these are the user's own
    // files, and a parse / re-serialise round trip to add a key would reformat
    // the whole document and drop its comments.
    if (req.method === 'POST' && pathname === '/integrations/config/patch') {
      const request = await readJson<IntegrationConfigPatchRequest>(req);
      const response: IntegrationConfigWriteResponse = patchIntegrationConfig(request);
      sendJson(res, 200, response);
      return;
    }

    // LLM — one assistant turn for the browser. The gateway's SSE is relayed
    // frame for frame, so the chunks the browser parses are the provider's own.
    if (req.method === 'POST' && pathname === '/llm/chat/completions') {
      const { request } = await readJson<LlmChatRequest>(req);
      await streamChatCompletion(res, request);
      return;
    }

    // LLM — the model list, with the context window normalized across providers.
    if (req.method === 'POST' && pathname === '/llm/models') {
      const response: ModelsListResponse = await listModels();
      sendJson(res, 200, response);
      return;
    }

    // Web search — what the connector's own SearXNG is doing. Polled by the
    // settings screen while a cold start pulls the image.
    if (req.method === 'GET' && pathname === '/search/status') {
      sendJson(res, 200, await searxng.status());
      return;
    }

    // Web search — bring that instance up. Answers as soon as the work is
    // scheduled: a first start pulls ~300 MB, which no HTTP request should wait
    // on, so progress is read back from `/search/status`.
    if (req.method === 'POST' && pathname === '/search/start') {
      const request = await readJson<SearchStartRequest>(req);
      sendJson(res, 200, await searxng.start(request));
      return;
    }

    // Web search — stop and remove it. The container deliberately outlives the
    // daemon, so this is the only way to get rid of it from the app.
    if (req.method === 'POST' && pathname === '/search/stop') {
      sendJson(res, 200, await searxng.stop());
      return;
    }

    // Storage — the client database kept on this machine instead of in the
    // browser. POST throughout, reads included: `setCors` only ever advertises
    // GET/POST/OPTIONS, and a document key (`meta:data-version`) is happier in a
    // body than in a query string. `/mcp/tools` already reads the same way.
    if (req.method === 'POST' && pathname === '/storage/records/list') {
      const { collection } = await readJson<StorageRecordsListRequest>(req);
      const response: StorageRecordsListResponse = { records: await stateDb.getAll(collection) };
      sendJson(res, 200, response);
      return;
    }

    if (req.method === 'POST' && pathname === '/storage/records/put') {
      const { collection, records } = await readJson<StorageRecordsPutRequest>(req);
      await stateDb.put(collection, records);
      sendJson(res, 200, STORAGE_OK);
      return;
    }

    if (req.method === 'POST' && pathname === '/storage/records/delete') {
      const { collection, ids } = await readJson<StorageRecordsDeleteRequest>(req);
      await stateDb.delete(collection, ids);
      sendJson(res, 200, STORAGE_OK);
      return;
    }

    if (req.method === 'POST' && pathname === '/storage/records/clear') {
      const { collection } = await readJson<StorageRecordsClearRequest>(req);
      await stateDb.clear(collection);
      sendJson(res, 200, STORAGE_OK);
      return;
    }

    if (req.method === 'POST' && pathname === '/storage/documents/get') {
      const { key } = await readJson<StorageDocumentGetRequest>(req);
      const response: StorageDocumentGetResponse = { value: await stateDb.getDocument(key) };
      sendJson(res, 200, response);
      return;
    }

    if (req.method === 'POST' && pathname === '/storage/documents/set') {
      const { key, value } = await readJson<StorageDocumentSetRequest>(req);
      await stateDb.setDocument(key, value);
      sendJson(res, 200, STORAGE_OK);
      return;
    }

    if (req.method === 'POST' && pathname === '/storage/documents/remove') {
      const { key } = await readJson<StorageDocumentRemoveRequest>(req);
      await stateDb.removeDocument(key);
      sendJson(res, 200, STORAGE_OK);
      return;
    }

    // Code tab — answers a pending `ask_user` question (shares the deep-agent map).
    if (req.method === 'POST' && pathname === '/code/answer') {
      const { id, answer } = await readJson<DeepAgentAnswerRequest>(req);
      const resolve = pendingAnswers.get(id);
      if (!resolve) {
        throw new ConnectorError(404, 'No pending question with that id');
      }
      pendingAnswers.delete(id);
      resolve({ text: answer });
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    throw new ConnectorError(404, `Not found: ${req.method} ${pathname}`);
  }

  /**
   * Relays one chat completion from the gateway to the browser, byte for byte.
   *
   * Deliberately not {@link openSse}: nothing here is an event of ours, so the
   * frames stay the provider's own — including its terminal `[DONE]` — and the
   * browser parses exactly what it parsed when the API proxied this call.
   * A rejection by the gateway is thrown before anything is written, so it still
   * arrives as a status code with a message rather than as an empty stream.
   */
  async function streamChatCompletion(
    res: ServerResponse,
    request: ChatCompletionRequest,
  ): Promise<void> {
    const upstream = await chatCompletion(request);

    const controller = new AbortController();
    openStreams.add(controller);
    onClientGone(res, () => controller.abort());

    res.writeHead(200, {
      // Relayed rather than assumed: whatever the gateway called this body is
      // what the browser has to read it as.
      'Content-Type': upstream.headers.get('content-type') ?? 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });

    const reader = upstream.body!.getReader();
    controller.signal.addEventListener('abort', () => void reader.cancel());

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || res.writableEnded || res.destroyed) {
          break;
        }
        res.write(value);
      }
    } finally {
      openStreams.delete(controller);
      res.end();
    }
  }

  /**
   * Runs a deep-agent turn and relays its progress as SSE frames, one
   * {@link DeepAgentStreamEvent} JSON object per `data:` line (assistant text,
   * the live plan, and tool / sub-agent activity). The stream ends with the
   * terminal `[DONE]` sentinel. The run is aborted when the browser disconnects.
   */
  async function streamDeepAgent(
    res: ServerResponse,
    connector: Connector,
    request: DeepAgentRunRequest,
  ): Promise<void> {
    const sse = openSse<DeepAgentStreamEvent>(res, openStreams);

    try {
      await runDeepAgentStream(connector, searxng, request, sse.send, sse.signal, pendingAnswers, {
        tasks,
        // Somebody is reading this one: its text arrives token by token rather
        // than a paragraph at a time (`llm/token-stream.ts`).
        tokens: true,
      });
    } catch (error) {
      // A failure is its own event, not assistant prose: the browser records it
      // on the message so the turn can be retried instead of leaving the error
      // text in the transcript (and in the model's history next turn).
      if (!sse.signal.aborted) {
        sse.send({ type: 'error', message: describeFailure(error), fatal: true });
      }
    } finally {
      sse.done();
    }
  }

  /**
   * Relays one background task's progress: its buffered events from `from`
   * onwards, then whatever it produces next, each frame carrying its absolute
   * index so a later reconnect can resume exactly here.
   *
   * Deliberately **not** wired to `onClientGone` the way every other stream is.
   * A turn nobody is reading should stop; a background task is the opposite
   * case — it was started so the user could close the tab — so a client going
   * away only unsubscribes it. The task keeps its own abort controller, reached
   * through `POST /tasks/stop` and nothing else.
   */
  function streamTaskEvents(res: ServerResponse, taskId: string, from: number): void {
    const sse = openSse<BackgroundTaskFrame>(res, openStreams);
    const unsubscribe = tasks.subscribe(
      taskId,
      from,
      (event, index) => sse.send({ index, event }),
      () => sse.done(),
    );
    sse.signal.addEventListener('abort', unsubscribe, { once: true });
  }

  /** Runs a task mutation, turning its refusals into a status the caller reads. */
  async function runTaskAction(action: () => BackgroundTask | Promise<BackgroundTask>) {
    try {
      return await action();
    } catch (error) {
      throw error instanceof TaskError ? new ConnectorError(404, error.message) : error;
    }
  }

  /**
   * Runs a coding-agent turn inside the session's Docker workspace and relays
   * its progress as SSE frames, one {@link CodeStreamEvent} JSON object per
   * `data:` line (assistant text, plan, tool activity, plus post-turn
   * `git_status` / `diff`). Ends with the terminal `[DONE]` sentinel; aborts when
   * the browser disconnects.
   */
  async function streamCode(res: ServerResponse, request: CodeRunRequest): Promise<void> {
    const sse = openSse<CodeStreamEvent>(res, openStreams);

    try {
      await workspaces.acquire(request.sessionId);
    } catch (error) {
      // The stream is already open, so a 409 cannot be sent — report it as an
      // error event instead.
      sse.send({ type: 'error', message: describeFailure(error), fatal: true });
      sse.done();
      return;
    }

    try {
      await runCodeStream(
        connector,
        workspaces,
        searxng,
        request,
        sse.send,
        sse.signal,
        pendingAnswers,
      );
    } catch (error) {
      if (!sse.signal.aborted) {
        sse.send({ type: 'error', message: describeFailure(error), fatal: true });
      }
    } finally {
      workspaces.release(request.sessionId);
      sse.done();
    }
  }

  /**
   * Bootstraps a session's workspace and relays its progress as SSE frames.
   * Holds the same session lock as an agent turn, so a task cannot start on top
   * of a half-installed checkout — and Stop in the browser kills the install
   * inside the container, like any other command.
   */
  async function streamSetup(res: ServerResponse, request: CodeSetupRequest): Promise<void> {
    const sse = openSse<CodeSetupEvent>(res, openStreams);

    try {
      await workspaces.acquire(request.sessionId);
    } catch (error) {
      sse.send({ type: 'error', message: describeFailure(error), fatal: true });
      sse.done();
      return;
    }

    try {
      await runCodeSetup(workspaces, request, sse.send, sse.signal);
    } catch (error) {
      if (!sse.signal.aborted) {
        sse.send({ type: 'error', message: describeFailure(error), fatal: true });
      }
    } finally {
      workspaces.release(request.sessionId);
      sse.done();
    }
  }

  function requireAuth(req: IncomingMessage): void {
    if (bearerOf(req) !== token) {
      throw new ConnectorError(401, 'Invalid or missing bearer token');
    }
  }

  return server;
}

/**
 * Runs `onGone` when the client is no longer there to receive the response.
 *
 * Deliberately the **response**, not the request: a handler only reaches this
 * point after `readJson` has drained the request body, and a fully-read
 * `IncomingMessage` is already destroyed — its `close` fired before any listener
 * could be attached, so `req.on('close')` never runs. `res` stays alive until
 * the socket does, which is what "the browser went away" actually means.
 */
function onClientGone(res: ServerResponse, onGone: () => void): void {
  res.on('close', () => {
    if (!res.writableFinished) {
      onGone();
    }
  });
}

/** An open SSE response: frames out, an abort signal in, one terminal sentinel. */
interface SseStream<TEvent> {
  /** Writes one event as a `data:` frame; a no-op once the client is gone. */
  send: (event: TEvent) => void;
  /** Aborted as soon as the browser disconnects, so the run stops with it. */
  signal: AbortSignal;
  /** Writes the terminal `[DONE]` sentinel and ends the response. */
  done: () => void;
}

/**
 * Opens an SSE response and ties an {@link AbortSignal} to the client staying
 * connected. Writing to a dead socket is silently dropped by Node rather than
 * throwing, so without the signal a disconnected turn would run to completion
 * unnoticed — burning tokens, executing tools and mutating the workspace for a
 * user who already pressed Stop.
 */
export function openSse<TEvent>(
  res: ServerResponse,
  registry?: Set<AbortController>,
): SseStream<TEvent> {
  const controller = new AbortController();
  onClientGone(res, () => controller.abort());
  registry?.add(controller);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  // `writeHead` only records the headers; Node sends them with the first write.
  // A stream whose first event is slow would therefore leave the client's
  // `fetch` unresolved — it is still waiting for the response to *begin*. That
  // is the normal state of a background task nobody has produced an event for
  // yet, and it looked exactly like a hung daemon.
  res.flushHeaders();

  const write = (frame: string): void => {
    if (!res.writableEnded && !res.destroyed) {
      res.write(frame);
    }
  };

  return {
    send: (event) => {
      logEvent(event as DeepAgentStreamEvent | CodeStreamEvent);
      write(`data: ${JSON.stringify(event)}\n\n`);
    },
    signal: controller.signal,
    done: () => {
      registry?.delete(controller);
      write('data: [DONE]\n\n');
      res.end();
    },
  };
}

/** The readable reason behind a thrown value, for an `error` stream event. */
function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reflects the request origin so a browser page can call the daemon directly. */
function setCors(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Vary', 'Origin');
}

/** The bearer token carried by a request, or `''` when it has none. */
function bearerOf(req: IncomingMessage): string {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
}

/** The request's query parameters. */
function query(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? '/', 'http://localhost').searchParams;
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      throw new ConnectorError(413, 'Request body too large');
    }
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new ConnectorError(400, 'Invalid JSON body');
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(payload);
}

function sendError(res: ServerResponse, error: unknown): void {
  const status = error instanceof ConnectorError ? error.status : 500;
  const message = error instanceof Error ? error.message : String(error);
  if (!res.headersSent) {
    // `Connection: close` because an error can leave the request body unread —
    // an oversized upload is rejected mid-stream — and the bytes still in the
    // socket would otherwise be parsed as the start of the next request,
    // breaking every subsequent call on that keep-alive connection.
    res
      .writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' })
      .end(JSON.stringify({ message }));
  } else {
    res.end();
  }
}
