import { createHash, randomUUID } from 'node:crypto';

import {
  type BackgroundTask,
  type BackgroundTaskStatus,
  type ChatMessage,
  ChatRole,
  type DeepAgentRunRequest,
  type DeepAgentStreamEvent,
  type DeepAgentSubAgent,
} from '../contracts';

import { buildTaskRequest, openingMessage } from './task-request';
import {
  MAX_TASK_EVENTS,
  MAX_TASKS_KEPT,
  MAX_TASKS_PER_CHAT,
  MAX_TASKS_RUNNING,
  TASK_PREVIEW_CHARS,
  TASK_RESULT_CHARS,
  TASK_RETENTION_MS,
} from './tasks.constants';

/** The `subagent_type` standing for "no configured sub-agent, just do it". */
export const GENERAL_PURPOSE_AGENT = 'general-purpose';

/**
 * Runs one agent turn. Injected rather than imported so this module does not
 * depend on `deep-agent.ts` (which depends on *it*, for the delegation tools),
 * and so a test can drive the whole lifecycle without a model.
 */
export type TaskRunner = (
  request: DeepAgentRunRequest,
  onEvent: (event: DeepAgentStreamEvent) => void,
  signal: AbortSignal,
) => Promise<void>;

/** A refusal the delegating model should read and act on, not a crash. */
export class TaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskError';
  }
}

/** What one live subscriber to a task's stream is given. */
interface Subscriber {
  onEvent: (event: DeepAgentStreamEvent, index: number) => void;
  onDone: () => void;
}

/** Everything the daemon holds about one background task. */
interface TaskRecord {
  id: string;
  parentSessionId: string;
  agentName: string;
  title: string;
  prompt: string;
  cacheKey: string;
  status: BackgroundTaskStatus;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  error?: string;
  /**
   * The task's own conversation. This is what makes a follow-up a *continuation*
   * rather than a fresh delegation: `send_to_task` (and the sub-chat's composer)
   * append to it and re-run, so the task keeps everything it worked out.
   */
  messages: ChatMessage[];
  /** The last run's answer, capped — what `check_task` hands back. */
  result: string;
  /** Replay buffer; `dropped` counts events already evicted from its head. */
  events: DeepAgentStreamEvent[];
  dropped: number;
  /**
   * The snapshot the task runs from — MCP configs with their secrets and the
   * user's LLM token. Held in memory only, and dropped when the record is, which
   * is why finished tasks are swept rather than kept forever.
   */
  parent: DeepAgentRunRequest;
  subAgent: DeepAgentSubAgent | null;
  controller: AbortController | null;
  /** The in-flight run, so a follow-up can wait for the interrupt to settle. */
  running: Promise<void> | null;
  subscribers: Set<Subscriber>;
  /** Resolved when the task reaches a terminal status. */
  waiters: Set<() => void>;
}

export interface StartTaskParams {
  parent: DeepAgentRunRequest;
  agentName: string;
  title: string;
  prompt: string;
}

export interface StartTaskResult {
  task: BackgroundTask;
  /**
   * True when this delegation was answered by a task that had already finished
   * with the same brief. That is what makes re-running the parent turn cheap:
   * a retry replays the same delegation and pays nothing for it.
   */
  cached: boolean;
}

/** A finished task's status; the two the browser stops subscribing on. */
const TERMINAL: ReadonlySet<BackgroundTaskStatus> = new Set<BackgroundTaskStatus>([
  'success',
  'error',
  'cancelled',
]);

/**
 * The daemon's background tasks: delegations that outlive the request that
 * started them.
 *
 * The whole point is the detachment. A turn's own stream is tied to the browser
 * (`openSse` aborts the run when the client disconnects — deliberately, since a
 * turn nobody is reading is burning tokens for nobody), but a task is started
 * *by the agent* and has to keep going when the tab closes, the user navigates
 * away, or the parent turn ends. So a task owns its own `AbortController`, its
 * events are buffered for whoever comes back to read them, and its result
 * survives the turn that asked for it — which is what lets a retried turn reuse
 * the work instead of paying for it twice.
 *
 * Pooled like `CodeWorkspaces`, and swept for the same reason: nothing tells the
 * daemon when a chat is deleted.
 */
export class BackgroundTasks {
  private readonly tasks = new Map<string, TaskRecord>();

  constructor(
    private readonly runner: TaskRunner,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Registers a task and starts it. Returns as soon as it is registered — the
   * run itself is detached, so the caller's turn continues.
   *
   * @throws {TaskError} when the sub-agent is unknown or a cap is reached; both
   * are things the delegating model should be told about in words.
   */
  start({ parent, agentName, title, prompt }: StartTaskParams): StartTaskResult {
    this.prune();

    const subAgent = this.resolveSubAgent(parent.subAgents, agentName);
    const parentSessionId = parent.sessionId;
    const cacheKey = taskCacheKey(parentSessionId, agentName, prompt);

    const cached = [...this.tasks.values()].find(
      (task) => task.cacheKey === cacheKey && task.status === 'success',
    );
    if (cached) {
      return { task: snapshot(cached), cached: true };
    }

    const running = [...this.tasks.values()].filter((task) => task.status === 'running');
    if (running.length >= MAX_TASKS_RUNNING) {
      throw new TaskError(
        `The limit of concurrent background tasks (${MAX_TASKS_RUNNING}) has been reached. Wait for the running ones or stop the ones you no longer need with \`stop_task\`.`,
      );
    }
    if (
      running.filter((task) => task.parentSessionId === parentSessionId).length >=
      MAX_TASKS_PER_CHAT
    ) {
      throw new TaskError(
        `This chat already has ${MAX_TASKS_PER_CHAT} background tasks. Wait for them or stop the ones you no longer need with \`stop_task\`.`,
      );
    }

    const at = this.now();
    const record: TaskRecord = {
      id: randomUUID(),
      parentSessionId,
      agentName: subAgent?.name ?? GENERAL_PURPOSE_AGENT,
      title: title.trim() || prompt.slice(0, 60),
      prompt,
      cacheKey,
      status: 'running',
      createdAt: at,
      updatedAt: at,
      messages: [openingMessage(prompt)],
      result: '',
      events: [],
      dropped: 0,
      parent,
      subAgent,
      controller: null,
      running: null,
      subscribers: new Set(),
      waiters: new Set(),
    };
    this.tasks.set(record.id, record);
    this.run(record);

    return { task: snapshot(record), cached: false };
  }

  /** One task's current state, or `undefined` if the daemon no longer has it. */
  get(taskId: string): BackgroundTask | undefined {
    const record = this.tasks.get(taskId);
    return record ? snapshot(record) : undefined;
  }

  /** A finished task's full answer (capped at {@link TASK_RESULT_CHARS}). */
  result(taskId: string): string {
    return this.tasks.get(taskId)?.result ?? '';
  }

  /** Every task of one chat, newest last. */
  list(parentSessionId: string): BackgroundTask[] {
    return [...this.tasks.values()]
      .filter((task) => task.parentSessionId === parentSessionId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(snapshot);
  }

  /**
   * Replays the task's events from absolute index `from`, then follows it live.
   * Returns the unsubscribe function.
   *
   * `from` is absolute rather than an offset into the current buffer, so a
   * browser that reloads mid-task resumes exactly where its transcript stopped.
   * If the buffer has since evicted that far back, replay starts at the oldest
   * event still held — a gap in a very long task's transcript, which is a better
   * outcome than replaying events the chat already shows.
   */
  subscribe(
    taskId: string,
    from: number,
    onEvent: (event: DeepAgentStreamEvent, index: number) => void,
    onDone: () => void,
  ): () => void {
    const record = this.tasks.get(taskId);
    if (!record) {
      onDone();
      return () => {};
    }

    const start = Math.max(from - record.dropped, 0);
    for (let index = start; index < record.events.length; index += 1) {
      onEvent(record.events[index]!, record.dropped + index);
    }
    if (TERMINAL.has(record.status)) {
      onDone();
      return () => {};
    }

    const subscriber: Subscriber = { onEvent, onDone };
    record.subscribers.add(subscriber);
    return () => record.subscribers.delete(subscriber);
  }

  /**
   * Adds a message to a task and runs it again with its whole conversation —
   * the parent agent's `send_to_task` and the sub-chat's composer both land
   * here. A task still working is interrupted first: the follow-up is new
   * instructions, and letting the old run finish would answer the wrong
   * question.
   */
  async message(taskId: string, text: string): Promise<BackgroundTask> {
    const record = this.tasks.get(taskId);
    if (!record) {
      throw new TaskError(`Background task ${taskId} was not found.`);
    }

    if (record.status === 'running') {
      // Detached from the record *before* it is aborted, so the run that is
      // about to end sees it no longer owns the task and settles nothing. Were
      // it allowed to, everyone watching the sub-chat would be told the task
      // finished — a moment before it starts again with the follow-up.
      const previous = record.controller;
      record.controller = null;
      previous?.abort();
      await record.running?.catch(() => {});
    }

    record.messages.push({ role: ChatRole.User, content: text });
    record.status = 'running';
    record.updatedAt = this.now();
    delete record.finishedAt;
    delete record.error;
    this.run(record);
    return snapshot(record);
  }

  /** Cancels a task; a finished one is left as it is. */
  stop(taskId: string): BackgroundTask {
    const record = this.tasks.get(taskId);
    if (!record) {
      throw new TaskError(`Background task ${taskId} was not found.`);
    }
    if (record.status === 'running') {
      record.controller?.abort();
      this.settle(record, 'cancelled');
    }
    return snapshot(record);
  }

  /**
   * Resolves once the task reaches a terminal status — what `delegate_task`
   * awaits when it was asked for a synchronous run. Rejects if the *caller's*
   * turn is aborted, leaving the task itself running.
   */
  async wait(taskId: string, signal: AbortSignal): Promise<BackgroundTask> {
    const record = this.tasks.get(taskId);
    if (!record) {
      throw new TaskError(`Background task ${taskId} was not found.`);
    }
    if (TERMINAL.has(record.status)) {
      return snapshot(record);
    }

    let onAbort = (): void => {};
    let waiter = (): void => {};
    try {
      await new Promise<void>((resolve, reject) => {
        onAbort = () => reject(new Error('aborted'));
        if (signal.aborted) {
          onAbort();
          return;
        }
        waiter = resolve;
        record.waiters.add(waiter);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    } finally {
      signal.removeEventListener('abort', onAbort);
      record.waiters.delete(waiter);
    }
    return snapshot(record);
  }

  /** Aborts every running task — the daemon is going away. */
  async shutdown(): Promise<void> {
    const inFlight = [...this.tasks.values()].map((record) => {
      record.controller?.abort();
      return record.running?.catch(() => {}) ?? Promise.resolve();
    });
    await Promise.allSettled(inFlight);
    this.tasks.clear();
  }

  /** Starts (or restarts) a record's run, detached from any request. */
  private run(record: TaskRecord): void {
    const controller = new AbortController();
    record.controller = controller;
    record.status = 'running';
    record.updatedAt = this.now();

    const request = buildTaskRequest({
      parent: record.parent,
      subAgent: record.subAgent,
      messages: [...record.messages],
      taskId: record.id,
    });

    let answer = '';
    let failure: string | undefined;

    const sink = (event: DeepAgentStreamEvent): void => {
      if (event.type === 'text') {
        answer = (answer + event.delta).slice(0, TASK_RESULT_CHARS);
      }
      // A fatal error is reported as an event rather than thrown by the runner
      // the server uses, so the outcome has to be read off the stream as well.
      if (event.type === 'error' && event.fatal) {
        failure = event.message;
      }
      this.emit(record, event);
    };

    record.running = this.runner(request, sink, controller.signal)
      .catch((error: unknown) => {
        failure = error instanceof Error ? error.message : String(error);
      })
      .then(() => {
        // Already settled by `stop`, or superseded by a follow-up that started
        // a newer run — either way this run no longer owns the record.
        if (record.controller !== controller || TERMINAL.has(record.status)) {
          return;
        }
        record.result = answer;
        if (answer.trim()) {
          record.messages.push({ role: ChatRole.Assistant, content: answer });
        }
        if (controller.signal.aborted) {
          this.settle(record, 'cancelled');
          return;
        }
        if (failure) {
          record.error = failure;
          this.settle(record, 'error');
          return;
        }
        this.settle(record, 'success');
      });
  }

  /** Buffers an event and hands it to everyone currently reading the task. */
  private emit(record: TaskRecord, event: DeepAgentStreamEvent): void {
    record.events.push(event);
    if (record.events.length > MAX_TASK_EVENTS) {
      record.events.shift();
      record.dropped += 1;
    }
    const index = record.dropped + record.events.length - 1;
    for (const subscriber of record.subscribers) {
      subscriber.onEvent(event, index);
    }
  }

  /** Moves a record to a terminal status and releases everyone waiting on it. */
  private settle(record: TaskRecord, status: BackgroundTaskStatus): void {
    record.status = status;
    record.finishedAt = this.now();
    record.updatedAt = record.finishedAt;
    record.controller = null;
    for (const subscriber of record.subscribers) {
      subscriber.onDone();
    }
    record.subscribers.clear();
    for (const waiter of record.waiters) {
      waiter();
    }
    record.waiters.clear();
  }

  /**
   * Drops finished tasks that are old or simply too many. Running ones are never
   * pruned — and because a record holds the run's secrets, ageing them out is
   * how those stop being held, not merely how memory is reclaimed.
   */
  private prune(): void {
    const cutoff = this.now() - TASK_RETENTION_MS;
    const finished = [...this.tasks.values()]
      .filter((task) => TERMINAL.has(task.status))
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));

    for (const task of finished) {
      if ((task.finishedAt ?? 0) < cutoff) {
        this.tasks.delete(task.id);
      }
    }
    let excess = this.tasks.size - MAX_TASKS_KEPT;
    for (const task of finished) {
      if (excess <= 0) {
        break;
      }
      if (this.tasks.delete(task.id)) {
        excess -= 1;
      }
    }
  }

  /**
   * Finds the sub-agent a delegation names. `general-purpose` is the one name
   * that always resolves — a chat without configured sub-agents can still hand
   * work off, exactly as deepagents' own default sub-agent lets it.
   */
  private resolveSubAgent(
    subAgents: DeepAgentSubAgent[],
    agentName: string,
  ): DeepAgentSubAgent | null {
    const wanted = agentName.trim().toLowerCase();
    if (!wanted || wanted === GENERAL_PURPOSE_AGENT) {
      return null;
    }
    const found = subAgents.find((agent) => agent.name.trim().toLowerCase() === wanted);
    if (found) {
      return found;
    }
    const known = [GENERAL_PURPOSE_AGENT, ...subAgents.map((agent) => agent.name)]
      .map((name) => `\`${name}\``)
      .join(', ');
    throw new TaskError(`Unknown agent type \`${agentName}\`. Available: ${known}.`);
  }
}

/** Stable key for "this chat asked this agent to do this" — the retry cache. */
export function taskCacheKey(parentSessionId: string, agentName: string, prompt: string): string {
  return createHash('sha256')
    .update(`${parentSessionId} ${agentName.trim().toLowerCase()} ${prompt.trim()}`)
    .digest('hex');
}

/** The wire shape of a record — everything but the secrets it runs from. */
function snapshot(record: TaskRecord): BackgroundTask {
  return {
    taskId: record.id,
    parentSessionId: record.parentSessionId,
    agentName: record.agentName,
    title: record.title,
    prompt: record.prompt,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
    ...(record.result ? { resultPreview: record.result.slice(0, TASK_PREVIEW_CHARS) } : {}),
    ...(record.error ? { error: record.error } : {}),
  };
}
