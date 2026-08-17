import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  type DeepAgentRunRequest,
  type DeepAgentStreamEvent,
  type DeepAgentSubAgent,
  McpTransport,
} from '../contracts';

import { BackgroundTasks, TaskError, type TaskRunner } from './background-tasks';
import { MAX_TASKS_PER_CHAT } from './tasks.constants';

/** Lets the detached run's `.then` chain settle before asserting on it. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface FakeRun {
  request: DeepAgentRunRequest;
  emit: (event: DeepAgentStreamEvent) => void;
  signal: AbortSignal;
  finish: () => void;
  fail: (error: Error) => void;
}

/** A runner that hands each started run back to the test to drive by hand. */
function fakeRunner(): { runner: TaskRunner; runs: FakeRun[] } {
  const runs: FakeRun[] = [];
  const runner: TaskRunner = (request, onEvent, signal) =>
    new Promise<void>((resolve, reject) => {
      runs.push({ request, emit: onEvent, signal, finish: resolve, fail: reject });
    });
  return { runner, runs };
}

const RESEARCHER: DeepAgentSubAgent = {
  name: 'researcher',
  description: 'Researches the question',
  systemPrompt: 'You are a researcher.',
};

function parentRequest(overrides: Partial<DeepAgentRunRequest> = {}): DeepAgentRunRequest {
  return {
    messages: [],
    instructions: 'You are an assistant.',
    subAgents: [RESEARCHER],
    llm: { model: 'gpt-5' },
    tools: [],
    sessionId: 'chat-1',
    ...overrides,
  };
}

function startResearch(tasks: BackgroundTasks, prompt = 'Research X') {
  return tasks.start({
    parent: parentRequest(),
    agentName: 'researcher',
    title: 'Research X',
    prompt,
  });
}

describe('BackgroundTasks.start', () => {
  test('registers the task and starts it without waiting for the run', () => {
    const { runner, runs } = fakeRunner();
    const tasks = new BackgroundTasks(runner);

    const { task, cached } = startResearch(tasks);

    assert.equal(cached, false);
    assert.equal(task.status, 'running');
    assert.equal(task.agentName, 'researcher');
    assert.equal(task.parentSessionId, 'chat-1');
    assert.equal(runs.length, 1);
    // Its own working directory, and no recursion in delegation.
    assert.equal(runs[0]!.request.sessionId, task.taskId);
    assert.deepEqual(runs[0]!.request.subAgents, []);
    assert.match(runs[0]!.request.instructions, /You are a researcher\./);
    assert.match(runs[0]!.request.instructions, /There is no user present/);
  });

  test('an unknown agent type is an error listing what is available', () => {
    const tasks = new BackgroundTasks(fakeRunner().runner);

    assert.throws(
      () => tasks.start({ parent: parentRequest(), agentName: 'nobody', title: 'x', prompt: 'y' }),
      (error: unknown) =>
        error instanceof TaskError &&
        /Unknown agent type/.test(error.message) &&
        /researcher/.test(error.message),
    );
  });

  test('general-purpose is available even with no sub-agents configured', () => {
    const { runner, runs } = fakeRunner();
    const tasks = new BackgroundTasks(runner);

    const { task } = tasks.start({
      parent: parentRequest({ subAgents: [] }),
      agentName: 'general-purpose',
      title: 'Figure it out',
      prompt: 'Figure it out',
    });

    assert.equal(task.agentName, 'general-purpose');
    assert.match(runs[0]!.request.instructions, /general-purpose worker/);
  });

  test('hits the per-chat task limit', () => {
    const tasks = new BackgroundTasks(fakeRunner().runner);
    for (let index = 0; index < MAX_TASKS_PER_CHAT; index += 1) {
      startResearch(tasks, `Research ${index}`);
    }

    assert.throws(
      () => startResearch(tasks, 'Research more'),
      (error: unknown) => error instanceof TaskError && /background tasks/.test(error.message),
    );
  });

  test('delegating again with the same brief returns the finished result from cache', async () => {
    const { runner, runs } = fakeRunner();
    const tasks = new BackgroundTasks(runner);

    const first = startResearch(tasks);
    runs[0]!.emit({ type: 'text', delta: 'A ready answer' });
    runs[0]!.finish();
    await tick();

    const second = startResearch(tasks);

    assert.equal(second.cached, true);
    assert.equal(second.task.taskId, first.task.taskId);
    assert.equal(second.task.status, 'success');
    assert.equal(second.task.resultPreview, 'A ready answer');
    // No second run: that is the point — retrying the turn costs nothing.
    assert.equal(runs.length, 1);
  });

  test('the cache misses on a different brief and on a failed task', async () => {
    const { runner, runs } = fakeRunner();
    const tasks = new BackgroundTasks(runner);

    startResearch(tasks, 'Research X');
    runs[0]!.fail(new Error('failed'));
    await tick();
    startResearch(tasks, 'Research X');
    startResearch(tasks, 'Research Y');

    assert.equal(runs.length, 3);
  });
});

describe('BackgroundTasks.subscribe', () => {
  test('hands live events to a subscriber', () => {
    const { runner, runs } = fakeRunner();
    const tasks = new BackgroundTasks(runner);
    const { task } = startResearch(tasks);

    const seen: DeepAgentStreamEvent[] = [];
    tasks.subscribe(
      task.taskId,
      0,
      (event) => seen.push(event),
      () => {},
    );
    runs[0]!.emit({ type: 'text', delta: 'one' });
    runs[0]!.emit({ type: 'todos', todos: [] });

    assert.deepEqual(seen, [
      { type: 'text', delta: 'one' },
      { type: 'todos', todos: [] },
    ]);
  });

  test('resubscribing from an absolute index does not repeat what was already shown', () => {
    const { runner, runs } = fakeRunner();
    const tasks = new BackgroundTasks(runner);
    const { task } = startResearch(tasks);

    runs[0]!.emit({ type: 'text', delta: 'one' });
    runs[0]!.emit({ type: 'text', delta: 'two' });

    const replayed: DeepAgentStreamEvent[] = [];
    tasks.subscribe(
      task.taskId,
      1,
      (event) => replayed.push(event),
      () => {},
    );

    assert.deepEqual(replayed, [{ type: 'text', delta: 'two' }]);
  });

  test('subscribing to a finished task replays the buffer and closes at once', async () => {
    const { runner, runs } = fakeRunner();
    const tasks = new BackgroundTasks(runner);
    const { task } = startResearch(tasks);
    runs[0]!.emit({ type: 'text', delta: 'all' });
    runs[0]!.finish();
    await tick();

    const seen: DeepAgentStreamEvent[] = [];
    let done = false;
    tasks.subscribe(
      task.taskId,
      0,
      (event) => seen.push(event),
      () => {
        done = true;
      },
    );

    assert.deepEqual(seen, [{ type: 'text', delta: 'all' }]);
    assert.equal(done, true);
  });

  test('finishing a task closes the live subscriptions', async () => {
    const { runner, runs } = fakeRunner();
    const tasks = new BackgroundTasks(runner);
    const { task } = startResearch(tasks);

    let done = false;
    tasks.subscribe(
      task.taskId,
      0,
      () => {},
      () => {
        done = true;
      },
    );
    runs[0]!.finish();
    await tick();

    assert.equal(done, true);
  });
});

describe('BackgroundTasks.message', () => {
  test('continues a task with its own history', async () => {
    const { runner, runs } = fakeRunner();
    const tasks = new BackgroundTasks(runner);
    const { task } = startResearch(tasks);
    runs[0]!.emit({ type: 'text', delta: 'First answer' });
    runs[0]!.finish();
    await tick();

    await tasks.message(task.taskId, 'And now in detail');

    assert.equal(runs.length, 2);
    assert.deepEqual(
      runs[1]!.request.messages.map((message) => message.content),
      ['Research X', 'First answer', 'And now in detail'],
    );
    assert.equal(tasks.get(task.taskId)?.status, 'running');
  });

  test('interrupts a running task without declaring it finished', async () => {
    const { runner, runs } = fakeRunner();
    const tasks = new BackgroundTasks(runner);
    const { task } = startResearch(tasks);

    let done = false;
    tasks.subscribe(
      task.taskId,
      0,
      () => {},
      () => {
        done = true;
      },
    );

    const pending = tasks.message(task.taskId, 'wait, something else');
    // The run sees the abort and ends — but the record is no longer its own.
    assert.equal(runs[0]!.signal.aborted, true);
    runs[0]!.finish();
    await pending;

    assert.equal(done, false, 'a sub-chat subscriber must not receive «task finished»');
    assert.equal(tasks.get(task.taskId)?.status, 'running');
    assert.equal(runs.length, 2);
  });
});

describe('BackgroundTasks.stop and wait', () => {
  test('stop cancels the task and releases everyone waiting', async () => {
    const { runner, runs } = fakeRunner();
    const tasks = new BackgroundTasks(runner);
    const { task } = startResearch(tasks);

    const waiting = tasks.wait(task.taskId, new AbortController().signal);
    const stopped = tasks.stop(task.taskId);
    runs[0]!.finish();

    assert.equal(stopped.status, 'cancelled');
    assert.equal(runs[0]!.signal.aborted, true);
    assert.equal((await waiting).status, 'cancelled');
  });

  test('wait blocks for the result — that is what synchronous mode is', async () => {
    const { runner, runs } = fakeRunner();
    const tasks = new BackgroundTasks(runner);
    const { task } = startResearch(tasks);

    const waiting = tasks.wait(task.taskId, new AbortController().signal);
    runs[0]!.emit({ type: 'text', delta: 'Result' });
    runs[0]!.finish();

    assert.equal((await waiting).status, 'success');
    assert.equal(tasks.result(task.taskId), 'Result');
  });

  test('an aborted turn releases the waiter but leaves the task alone', async () => {
    const { runner, runs } = fakeRunner();
    const tasks = new BackgroundTasks(runner);
    const { task } = startResearch(tasks);
    const controller = new AbortController();

    const waiting = tasks.wait(task.taskId, controller.signal);
    controller.abort();

    await assert.rejects(waiting, /aborted/);
    assert.equal(tasks.get(task.taskId)?.status, 'running');
    assert.equal(runs[0]!.signal.aborted, false);
  });

  test('a failed run becomes an error status with a reason', async () => {
    const { runner, runs } = fakeRunner();
    const tasks = new BackgroundTasks(runner);
    const { task } = startResearch(tasks);

    runs[0]!.emit({ type: 'error', message: 'gateway unreachable', fatal: true });
    runs[0]!.finish();
    await tick();

    const settled = tasks.get(task.taskId);
    assert.equal(settled?.status, 'error');
    assert.equal(settled?.error, 'gateway unreachable');
  });
});

describe('BackgroundTasks — cleanup', () => {
  test('finished tasks age out and stop holding a run’s secrets', async () => {
    const { runner, runs } = fakeRunner();
    let now = 1_000;
    const tasks = new BackgroundTasks(runner, () => now);

    const { task } = startResearch(tasks);
    runs[0]!.finish();
    await tick();

    now += 7 * 60 * 60_000;
    startResearch(tasks, 'Something else entirely');

    assert.equal(tasks.get(task.taskId), undefined);
  });

  test('running tasks are not swept', async () => {
    const { runner } = fakeRunner();
    let now = 1_000;
    const tasks = new BackgroundTasks(runner, () => now);

    const { task } = startResearch(tasks);
    now += 7 * 60 * 60_000;
    startResearch(tasks, 'Something else entirely');

    assert.equal(tasks.get(task.taskId)?.status, 'running');
  });

  test('shutdown cuts off everything still running', async () => {
    const { runner, runs } = fakeRunner();
    const tasks = new BackgroundTasks(runner);
    const { task } = startResearch(tasks);

    const shutdown = tasks.shutdown();
    runs[0]!.finish();
    await shutdown;

    assert.equal(runs[0]!.signal.aborted, true);
    assert.equal(tasks.get(task.taskId), undefined);
  });
});

describe('scopeToolSources through buildTaskRequest', () => {
  test('a sub-agent’s allow-list cuts tools down by policy', () => {
    const { runner, runs } = fakeRunner();
    const tasks = new BackgroundTasks(runner);
    const parent = parentRequest({
      subAgents: [{ ...RESEARCHER, tools: ['search_issues'] }],
      tools: [{ config: { transport: McpTransport.Http, url: 'http://jira' } }],
    });

    tasks.start({ parent, agentName: 'researcher', title: 'Tickets', prompt: 'Find the tickets' });

    assert.deepEqual(runs[0]!.request.tools[0]!.policies, [
      { toolName: '*', mode: 'disabled' },
      { toolName: 'search_issues', mode: 'available' },
    ]);
  });

  test('without an allow-list the sources travel as they are', () => {
    const { runner, runs } = fakeRunner();
    const tasks = new BackgroundTasks(runner);
    const parent = parentRequest({
      tools: [{ config: { transport: McpTransport.Http, url: 'http://jira' } }],
    });

    tasks.start({ parent, agentName: 'researcher', title: 'Tickets', prompt: 'Find the tickets' });

    assert.equal(runs[0]!.request.tools[0]!.policies, undefined);
  });
});
