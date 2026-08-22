import {
  type BackgroundTask,
  type BackgroundTaskFrame,
  type BackgroundTaskListResponse,
  type CatalogRepoListRequest,
  type CatalogRepoListResponse,
  type ChatCompletionRequest,
  type CodeCloneRequest,
  type CodeCommandRequest,
  type CodeCommandResult,
  type CodeContextReport,
  type CodeDiff,
  type CodeDiffMode,
  type CodeMemoryReport,
  type CodeMemoryWriteRequest,
  type CodeMemoryWriteResult,
  type CodeRemoveRequest,
  type CodeRunRequest,
  type CodeSetupEvent,
  type CodeSetupRequest,
  type CodeSpecState,
  type CodeSpecWriteRequest,
  type CodeSpecWriteResult,
  type CodeStreamEvent,
  type CodeWorkspaceListResponse,
  type CodeWorkspaceStatus,
  type DeepAgentClientToolResult,
  type DeepAgentRunRequest,
  type DeepAgentStreamEvent,
  type EngineConfigRequest,
  type EngineConfigResponse,
  type IntegrationConfigPatchRequest,
  type IntegrationConfigReadRequest,
  type IntegrationConfigReadResponse,
  type IntegrationConfigWriteRequest,
  type IntegrationConfigWriteResponse,
  type IntegrationListRequest,
  type IntegrationListResponse,
  type LocalFilesDeleteRequest,
  type LocalFilesDeleteResponse,
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
  type SearchStatus,
  type SkillRepoFetchRequest,
  type SkillRepoFetchResponse,
  type SkillRepoListRequest,
  type SkillRepoListResponse,
  type StorageDocumentGetResponse,
  type StorageOkResponse,
  type StorageRecordsListResponse,
} from '../contracts';

import { type EngineClientOptions, type FetchFn, type RequestOptions } from './client.types';
import {
  CONFIG_MISSING_STATUS,
  EngineError,
  EngineUnreachableError,
  errorMessage,
} from './engine-error';
import { streamEvents } from './sse';

/** Default port the daemon listens on. */
export const DEFAULT_ENGINE_PORT = 50880;

/**
 * A typed client for one running agent-engine daemon.
 *
 * Every method is the HTTP route it names and nothing more — no caching, no
 * state, no retries beyond the one the configuration handshake requires. That is
 * on purpose: an app already has opinions about caching and retrying, and a
 * client that has its own fights them.
 *
 * ```ts
 * const engine = new EngineClient({ port: 50880, token });
 *
 * await engine.config({ version, llm: { baseUrl, apiKey } });
 * for await (const event of engine.deepAgent.stream(request)) {
 *   render(event);
 * }
 * ```
 *
 * Safe to bundle for a browser: nothing here touches `node:` anything.
 */
export class EngineClient {
  readonly baseUrl: string;

  private readonly token: string;
  private readonly fetchFn: FetchFn;
  private readonly options: EngineClientOptions;

  constructor(options: EngineClientOptions) {
    this.options = options;
    this.baseUrl = (
      options.baseUrl ?? `http://127.0.0.1:${options.port ?? DEFAULT_ENGINE_PORT}`
    ).replace(/\/+$/, '');
    this.token = options.token;
    // Read through a closure rather than captured now: a test that swaps the
    // global `fetch` out after construction should still be obeyed.
    this.fetchFn = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  // ─── connectivity and configuration ──────────────────────────────────────

  /**
   * The daemon's capability flags and the configuration version it holds.
   *
   * Unauthenticated on the daemon's side, but the token is still sent: the
   * answer reports whether it matched, which is what lets an app tell «the
   * daemon is down» apart from «the token is wrong» before it tries a real call.
   */
  async ping(options?: RequestOptions): Promise<McpConnectorPing> {
    const response = await this.send('GET', '/ping', undefined, options);
    return (await response.json()) as McpConnectorPing;
  }

  /** Hands the daemon the configuration it runs on. See {@link EngineConfigRequest}. */
  config(request: EngineConfigRequest, options?: RequestOptions): Promise<EngineConfigResponse> {
    // Deliberately not wrapped in the 428 retry: this *is* the answer to a 428.
    return this.json('/config', request, options, { handleConfigMissing: false });
  }

  /** Asks the daemon to stop, cleaning up its containers on the way out. */
  shutdown(options?: RequestOptions): Promise<StorageOkResponse> {
    return this.json('/shutdown', {}, options);
  }

  // ─── MCP ─────────────────────────────────────────────────────────────────

  readonly mcp = {
    listTools: (request: McpListToolsRequest, options?: RequestOptions) =>
      this.json<McpListToolsResponse>('/mcp/tools', request, options),
    callTool: (request: McpToolCallRequest, options?: RequestOptions) =>
      this.json<McpToolCallResponse>('/mcp/tools/call', request, options),
  };

  // ─── deep agents ─────────────────────────────────────────────────────────

  readonly deepAgent = {
    /** Runs one turn, yielding its progress events until the turn ends. */
    stream: (request: DeepAgentRunRequest, options?: RequestOptions) =>
      this.stream<DeepAgentStreamEvent>('/deepagent/stream', request, options),
    /** Answers a pending `ask_user` question inside an open turn. */
    answer: (id: string, answer: string, options?: RequestOptions) =>
      this.json<StorageOkResponse>('/deepagent/answer', { id, answer }, options),
    /** Returns the result of a tool the app executed on the agent's behalf. */
    clientTool: (result: DeepAgentClientToolResult, options?: RequestOptions) =>
      this.json<StorageOkResponse>('/deepagent/client-tool', result, options),
  };

  // ─── background tasks ────────────────────────────────────────────────────

  readonly tasks = {
    list: (parentSessionId: string, options?: RequestOptions) =>
      this.get<BackgroundTaskListResponse>(
        `/tasks/list?parentSessionId=${encodeURIComponent(parentSessionId)}`,
        options,
      ),
    /**
     * One task's events from `from` onwards, then live.
     *
     * Closing this does **not** cancel the task — that is the difference from a
     * deep-agent turn, and the reason background tasks exist. Use {@link stop}.
     */
    events: (taskId: string, from = 0, options?: RequestOptions) =>
      this.streamGet<BackgroundTaskFrame>(
        `/tasks/events?taskId=${encodeURIComponent(taskId)}&from=${from}`,
        options,
      ),
    message: (taskId: string, text: string, options?: RequestOptions) =>
      this.json<BackgroundTask>('/tasks/message', { taskId, text }, options),
    stop: (taskId: string, options?: RequestOptions) =>
      this.json<BackgroundTask>('/tasks/stop', { taskId }, options),
  };

  // ─── the coding sandbox ──────────────────────────────────────────────────

  readonly code = {
    clone: (request: CodeCloneRequest, options?: RequestOptions) =>
      this.json<CodeWorkspaceStatus>('/code/clone', request, options),
    status: (sessionId: string, options?: RequestOptions) =>
      this.get<CodeWorkspaceStatus>(
        `/code/status?sessionId=${encodeURIComponent(sessionId)}`,
        options,
      ),
    diff: (sessionId: string, mode: CodeDiffMode = 'worktree', options?: RequestOptions) =>
      this.get<CodeDiff>(
        `/code/diff?sessionId=${encodeURIComponent(sessionId)}&mode=${mode}`,
        options,
      ),
    sessions: (options?: RequestOptions) =>
      this.get<CodeWorkspaceListResponse>('/code/sessions', options),
    /** Installs the stack's dependencies and seeds the project memory. */
    setup: (request: CodeSetupRequest, options?: RequestOptions) =>
      this.stream<CodeSetupEvent>('/code/setup', request, options),
    /** Runs one coding-agent turn inside the session's container. */
    stream: (request: CodeRunRequest, options?: RequestOptions) =>
      this.stream<CodeStreamEvent>('/code/stream', request, options),
    /** Runs one deterministic git command — no model involved. */
    command: (request: CodeCommandRequest, options?: RequestOptions) =>
      this.json<CodeCommandResult>('/code/command', request, options),
    memory: (sessionId: string, options?: RequestOptions) =>
      this.get<CodeMemoryReport>(
        `/code/memory?sessionId=${encodeURIComponent(sessionId)}`,
        options,
      ),
    writeMemory: (request: CodeMemoryWriteRequest, options?: RequestOptions) =>
      this.json<CodeMemoryWriteResult>('/code/memory', request, options),
    /** What the model is shown before the conversation, recomputed on demand. */
    context: (sessionId: string, contextLength?: number, options?: RequestOptions) =>
      this.get<CodeContextReport>(
        `/code/context?sessionId=${encodeURIComponent(sessionId)}${
          contextLength ? `&contextLength=${contextLength}` : ''
        }`,
        options,
      ),
    spec: (sessionId: string, options?: RequestOptions) =>
      this.get<CodeSpecState>(`/code/spec?sessionId=${encodeURIComponent(sessionId)}`, options),
    writeSpec: (request: CodeSpecWriteRequest, options?: RequestOptions) =>
      this.json<CodeSpecWriteResult>('/code/spec', request, options),
    remove: (request: CodeRemoveRequest, options?: RequestOptions) =>
      this.json<StorageOkResponse>('/code/remove', request, options),
    answer: (id: string, answer: string, options?: RequestOptions) =>
      this.json<StorageOkResponse>('/code/answer', { id, answer }, options),
  };

  // ─── skills, plugins, loose files ────────────────────────────────────────

  readonly skills = {
    list: (request: LocalSkillsListRequest, options?: RequestOptions) =>
      this.json<LocalSkillsListResponse>('/skills/list', request, options),
    write: (request: LocalSkillWriteRequest, options?: RequestOptions) =>
      this.json<LocalSkillWriteResponse>('/skills/write', request, options),
    delete: (request: LocalSkillDeleteRequest, options?: RequestOptions) =>
      this.json<LocalSkillDeleteResponse>('/skills/delete', request, options),
    /** Every skill package in a repository, from its `SKILL.md` alone. */
    repoList: (request: SkillRepoListRequest, options?: RequestOptions) =>
      this.json<SkillRepoListResponse>('/skills/repo/list', request, options),
    /** Downloads the chosen packages whole, resources and all. */
    repoFetch: (request: SkillRepoFetchRequest, options?: RequestOptions) =>
      this.json<SkillRepoFetchResponse>('/skills/repo/fetch', request, options),
  };

  readonly plugins = {
    list: (request: LocalPluginsListRequest, options?: RequestOptions) =>
      this.json<LocalPluginsListResponse>('/plugins/list', request, options),
    write: (request: LocalPluginWriteRequest, options?: RequestOptions) =>
      this.json<LocalPluginWriteResponse>('/plugins/write', request, options),
    delete: (request: LocalPluginDeleteRequest, options?: RequestOptions) =>
      this.json<LocalPluginDeleteResponse>('/plugins/delete', request, options),
    /** Every plugin package in a repository, from its `plugin.json` alone. */
    repoList: (request: PluginRepoListRequest, options?: RequestOptions) =>
      this.json<PluginRepoListResponse>('/plugins/repo/list', request, options),
    /** Downloads the chosen packages whole, bundled skills and all. */
    repoFetch: (request: PluginRepoFetchRequest, options?: RequestOptions) =>
      this.json<PluginRepoFetchResponse>('/plugins/repo/fetch', request, options),
  };

  readonly files = {
    write: (request: LocalFilesWriteRequest, options?: RequestOptions) =>
      this.json<LocalFilesWriteResponse>('/files/write', request, options),
    /** Takes those same files back out; a path already gone is not an error. */
    delete: (request: LocalFilesDeleteRequest, options?: RequestOptions) =>
      this.json<LocalFilesDeleteResponse>('/files/delete', request, options),
  };

  // ─── other agents on this machine ────────────────────────────────────────

  readonly integrations = {
    /** Where each known agent keeps its config and packages, on *this* host. */
    list: (request: IntegrationListRequest, options?: RequestOptions) =>
      this.json<IntegrationListResponse>('/integrations/list', request, options),
    /** One config document, verbatim, with the `mtimeMs` a write hands back. */
    read: (request: IntegrationConfigReadRequest, options?: RequestOptions) =>
      this.json<IntegrationConfigReadResponse>('/integrations/config/read', request, options),
    /** Replaces the document wholesale, keeping a copy of what it replaced. */
    write: (request: IntegrationConfigWriteRequest, options?: RequestOptions) =>
      this.json<IntegrationConfigWriteResponse>('/integrations/config/write', request, options),
    /** Sets or removes named keys, leaving every other byte of the file alone. */
    patch: (request: IntegrationConfigPatchRequest, options?: RequestOptions) =>
      this.json<IntegrationConfigWriteResponse>('/integrations/config/patch', request, options),
  };

  // ─── the catalogue ───────────────────────────────────────────────────────

  readonly catalog = {
    /**
     * Everything the named repositories offer — plugins, skills and MCP servers
     * — read whole at one commit and cached on the daemon's disk against it.
     */
    repoList: (request: CatalogRepoListRequest, options?: RequestOptions) =>
      this.json<CatalogRepoListResponse>('/catalog/repo/list', request, options),
  };

  // ─── repositories ────────────────────────────────────────────────────────

  readonly repos = {
    /** Verifies a credential against its host. Nothing is stored. */
    check: (request: RepoCheckRequest, options?: RequestOptions) =>
      this.json<RepoCheckResponse>('/repos/check', request, options),
  };

  // ─── the model ───────────────────────────────────────────────────────────

  readonly llm = {
    /**
     * One assistant turn. The daemon relays the gateway's SSE frame for frame,
     * so what arrives here is the provider's own chunk shape rather than one of
     * ours — hence `unknown` unless the caller says otherwise.
     */
    chat: <TChunk = unknown>(request: ChatCompletionRequest, options?: RequestOptions) =>
      this.stream<TChunk>('/llm/chat/completions', { request }, options),
    models: (options?: RequestOptions) => this.json<ModelsListResponse>('/llm/models', {}, options),
  };

  // ─── web search ──────────────────────────────────────────────────────────

  readonly search = {
    status: (options?: RequestOptions) => this.get<SearchStatus>('/search/status', options),
    /**
     * Brings the managed instance up. Answers as soon as the work is scheduled —
     * a first start pulls hundreds of megabytes, which no request should wait
     * on, so progress is read back from {@link status}.
     */
    start: (request: SearchStartRequest, options?: RequestOptions) =>
      this.json<SearchStatus>('/search/start', request, options),
    stop: (options?: RequestOptions) => this.json<SearchStatus>('/search/stop', {}, options),
  };

  // ─── storage ─────────────────────────────────────────────────────────────

  readonly storage = {
    list: (collection: string, options?: RequestOptions) =>
      this.json<StorageRecordsListResponse>('/storage/records/list', { collection }, options),
    put: (collection: string, records: readonly unknown[], options?: RequestOptions) =>
      this.json<StorageOkResponse>('/storage/records/put', { collection, records }, options),
    delete: (collection: string, ids: readonly string[], options?: RequestOptions) =>
      this.json<StorageOkResponse>('/storage/records/delete', { collection, ids }, options),
    clear: (collection: string, options?: RequestOptions) =>
      this.json<StorageOkResponse>('/storage/records/clear', { collection }, options),
    getDocument: (key: string, options?: RequestOptions) =>
      this.json<StorageDocumentGetResponse>('/storage/documents/get', { key }, options),
    setDocument: (key: string, value: unknown, options?: RequestOptions) =>
      this.json<StorageOkResponse>('/storage/documents/set', { key, value }, options),
    removeDocument: (key: string, options?: RequestOptions) =>
      this.json<StorageOkResponse>('/storage/documents/remove', { key }, options),
  };

  // ─── transport ───────────────────────────────────────────────────────────

  private get<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.send('GET', path, undefined, options).then(
      (response) => response.json() as Promise<T>,
    );
  }

  private json<T>(
    path: string,
    body: unknown,
    options?: RequestOptions,
    behaviour?: { handleConfigMissing: boolean },
  ): Promise<T> {
    return this.send('POST', path, body, options, behaviour).then(
      (response) => response.json() as Promise<T>,
    );
  }

  private async *stream<TEvent>(
    path: string,
    body: unknown,
    options?: RequestOptions,
  ): AsyncGenerator<TEvent> {
    const response = await this.send('POST', path, body, options);
    yield* streamEvents<TEvent>(response);
  }

  private async *streamGet<TEvent>(path: string, options?: RequestOptions): AsyncGenerator<TEvent> {
    const response = await this.send('GET', path, undefined, options);
    yield* streamEvents<TEvent>(response);
  }

  /**
   * One request, with the two things every call needs: an unreachable daemon
   * reported as such, and a `428` answered by handing over the configuration and
   * trying once more.
   *
   * The retry is deliberately once and only for `428`. A daemon that answers
   * `428` twice is not one a third attempt will help — it is one whose
   * configuration the app cannot produce, and looping would hide that.
   */
  private async send(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    options?: RequestOptions,
    behaviour: { handleConfigMissing: boolean } = { handleConfigMissing: true },
  ): Promise<Response> {
    const response = await this.attempt(method, path, body, options);

    if (response.status === CONFIG_MISSING_STATUS && behaviour.handleConfigMissing) {
      const bundle = await this.options.onConfigMissing?.();
      if (bundle) {
        await this.config(bundle, options);
        return this.check(await this.attempt(method, path, body, options));
      }
    }

    return this.check(response);
  }

  private async attempt(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<Response> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    try {
      return await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...((options?.signal ?? this.options.signal)
          ? { signal: options?.signal ?? this.options.signal }
          : {}),
      });
    } catch (error) {
      // An abort is the caller's own doing and has to reach them as itself,
      // not disguised as an unreachable daemon.
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }
      throw new EngineUnreachableError(this.baseUrl, error);
    }
  }

  /** Turns a refusal into an {@link EngineError} before anyone reads the body. */
  private async check(response: Response): Promise<Response> {
    if (!response.ok) {
      throw new EngineError(response.status, await errorMessage(response));
    }
    return response;
  }
}
