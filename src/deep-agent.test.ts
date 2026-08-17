import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { type DeepAgentStreamEvent, EXIT_PLAN_MODE_TOOL } from './contracts';
import {
  materializeFiles,
  materializeSkills,
  safeRelPath,
  type StreamableAgent,
  streamAgentUpdates,
  sweepWorkspaces,
  toAgentMessages,
  toolCallEvents,
  uniqueExposedName,
} from './deep-agent';

/** A minimal langgraph-ish state message with the accessor our projection reads. */
function aiMessage(id: string, content: string, toolCalls: unknown[] = []) {
  return { id, content, tool_calls: toolCalls, getType: () => 'ai' };
}

/** A tool-result message as the graph reports it. */
function toolMessage(toolCallId: string, content: string) {
  return { tool_call_id: toolCallId, content, getType: () => 'tool' };
}

/** An agent whose stream replays the canned `updates` it was built with. */
function fakeAgent(updates: Record<string, unknown>[]): StreamableAgent {
  return {
    stream: () =>
      Promise.resolve(
        (async function* () {
          for (const update of updates) {
            yield update;
          }
        })(),
      ),
  };
}

/** An agent whose stream throws `error` instead of yielding anything. */
function failingAgent(error: unknown): StreamableAgent {
  return { stream: () => Promise.reject(error) };
}

/** An agent that replays `updates` and then fails, as a graph does mid-work. */
function agentFailingAfter(updates: Record<string, unknown>[], error: unknown): StreamableAgent {
  return {
    stream: () =>
      Promise.resolve(
        (async function* () {
          for (const update of updates) {
            yield update;
          }
          throw error;
        })(),
      ),
  };
}

/** A throwaway directory, removed when `body` returns. */
function withTempDir(body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'engine-deep-agent-'));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Collects the events one turn produces. */
async function run(
  updates: Record<string, unknown>[],
  history: Parameters<typeof toAgentMessages>[0],
  projection?: Parameters<typeof streamAgentUpdates>[4],
) {
  const events: DeepAgentStreamEvent[] = [];
  await streamAgentUpdates(
    fakeAgent(updates),
    toAgentMessages(history),
    (event) => events.push(event),
    new AbortController().signal,
    projection,
  );
  return events;
}

/** Collects the events of a turn driven by an arbitrary agent, signal and projection. */
async function collect(
  agent: StreamableAgent,
  options: { signal?: AbortSignal; projection?: Parameters<typeof streamAgentUpdates>[4] } = {},
) {
  const events: DeepAgentStreamEvent[] = [];
  await streamAgentUpdates(
    agent,
    toAgentMessages([{ role: 'user', content: 'task' }]),
    (event) => events.push(event),
    options.signal ?? new AbortController().signal,
    options.projection,
  );
  return events;
}

/** An AI message announcing one tool call, plus the update that carries it. */
function callUpdate(id: string, name = 'jira_search') {
  return { model: { messages: [aiMessage(`ai-${id}`, '', [{ id, name, args: {} }])] } };
}

/** The `tool_result` events of a turn, which is where interruptions land. */
function results(events: DeepAgentStreamEvent[]) {
  return events.filter((event) => event.type === 'tool_result');
}

test('toAgentMessages keeps tool calls and their results, so a turn remembers its work', () => {
  const messages = toAgentMessages([
    { role: 'user', content: 'hello' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }],
    },
    { role: 'tool', content: 'contents', tool_call_id: 'c1', name: 'read_file' },
  ]);

  assert.deepEqual(messages, [
    { role: 'user', content: 'hello', id: 'hist-0' },
    {
      role: 'assistant',
      content: '',
      id: 'hist-1',
      // OpenAI encodes arguments as a JSON string; langchain wants an object.
      tool_calls: [{ id: 'c1', name: 'read_file', args: { path: 'a.ts' } }],
    },
    { role: 'tool', content: 'contents', id: 'hist-2', tool_call_id: 'c1', name: 'read_file' },
  ]);
});

test('a call whose arguments merely have noise after them keeps its result', () => {
  // What a streamed zero-argument call comes back as — `{}` plus a stray
  // fragment. The arguments are all there, so dropping the exchange would cost
  // the turn work it actually did.
  const messages = toAgentMessages([
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', function: { name: 'component_list', arguments: '{}""' } }],
    },
    { role: 'tool', content: 'list', tool_call_id: 'c1', name: 'component_list' },
  ]);

  assert.deepEqual(messages, [
    {
      role: 'assistant',
      content: '',
      id: 'hist-0',
      tool_calls: [{ id: 'c1', name: 'component_list', args: {} }],
    },
    { role: 'tool', content: 'list', id: 'hist-1', tool_call_id: 'c1', name: 'component_list' },
  ]);
});

test('a call whose arguments will not parse is dropped together with its result', () => {
  // Half a pair is exactly what a provider rejects, so both halves go.
  const messages = toAgentMessages([
    {
      role: 'assistant',
      content: 'editing',
      tool_calls: [{ id: 'c1', function: { name: 'edit_file', arguments: '{"path":' } }],
    },
    { role: 'tool', content: 'ok', tool_call_id: 'c1' },
  ]);

  assert.deepEqual(messages, [{ role: 'assistant', content: 'editing', id: 'hist-0' }]);
});

test('pairing is repaired in both directions', () => {
  const orphanDropped = toAgentMessages([
    { role: 'user', content: 'task' },
    { role: 'tool', content: 'nobody’s result', tool_call_id: 'nobody' },
  ]);
  assert.deepEqual(orphanDropped, [{ role: 'user', content: 'task', id: 'hist-0' }]);

  const answered = toAgentMessages([
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', function: { name: 'grep', arguments: '{}' } }],
    },
  ]);
  // The call is evidence of work that happened; a synthesized result is a truer
  // account of an interrupted turn than pretending the call never occurred.
  assert.equal(answered.length, 2);
  assert.deepEqual(
    { role: answered[1].role, tool_call_id: answered[1].tool_call_id },
    { role: 'tool', tool_call_id: 'c1' },
  );
  assert.match(answered[1].content, /was not stored/);
});

test('the input history is not replayed as fresh tool activity', async () => {
  // The history now carries tool calls, and a middleware node's update carries the
  // whole merged state — so without seeding the dedupe sets from the input, every
  // step of every earlier turn would be streamed again as if it were happening now.
  const past = aiMessage('hist-1', 'previous turn', [
    { id: 'old-call', name: 'read_file', args: { path: 'a.ts' } },
  ]);
  const pastResult = toolMessage('old-call', 'the old output');
  const fresh = aiMessage('ai-1', 'new answer');

  const events = await run(
    [{ PostModelHook: { messages: [past, pastResult, fresh] } }],
    [
      { role: 'user', content: 'task' },
      {
        role: 'assistant',
        content: 'previous turn',
        tool_calls: [
          { id: 'old-call', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
        ],
      },
      { role: 'tool', content: 'the old output', tool_call_id: 'old-call' },
    ],
    { visibleBuiltins: new Set(['read_file']) },
  );

  assert.deepEqual(
    events.filter((event) => event.type === 'tool_call' || event.type === 'tool_result'),
    [],
    'nothing from the history is re-announced',
  );
  assert.deepEqual(
    events.filter((event) => event.type === 'text').map((event) => event.delta),
    ['new answer'],
  );
});

test('a middleware node replaying the whole state does not repeat past turns', async () => {
  const previous = aiMessage('hist-1', 'the previous turn’s answer');
  const fresh = aiMessage('ai-1', 'new answer');

  const events = await run(
    [
      { model: { messages: [fresh] } },
      // A middleware node returns the merged state, history included.
      { PostModelHook: { messages: [previous, fresh] } },
    ],
    [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'the previous turn’s answer' },
      { role: 'user', content: 'second question' },
    ],
  );

  assert.deepEqual(events, [{ type: 'text', delta: 'new answer' }]);
});

test('a repeated update does not duplicate steps or results', async () => {
  const call = { id: 'call-1', name: 'jira_search', args: { jql: 'project = ACME' } };
  const withCall = aiMessage('ai-1', '', [call]);
  const result = toolMessage('call-1', 'found 12 tasks');

  const events = await run(
    [
      { model: { messages: [withCall] } },
      { tools: { messages: [result] } },
      { PostModelHook: { messages: [withCall, result] } },
    ],
    [{ role: 'user', content: 'find the tasks' }],
  );

  assert.deepEqual(events, [
    {
      type: 'tool_call',
      id: 'call-1',
      kind: 'tool',
      name: 'jira_search',
      args: '{"jql":"project = ACME"}',
    },
    { type: 'tool_result', id: 'call-1', isError: false },
  ]);
});

test('the turn reports the token usage of every model call, counted once', async () => {
  const first = {
    ...aiMessage('ai-1', 'first step'),
    usage_metadata: { input_tokens: 100, output_tokens: 20 },
  };
  const second = {
    ...aiMessage('ai-2', 'second step'),
    usage_metadata: { input_tokens: 130, output_tokens: 30 },
  };

  const events = await run(
    [
      { model: { messages: [first] } },
      { model: { messages: [second] } },
      // A middleware node replaying the whole state must not double-count.
      { PostModelHook: { messages: [first, second] } },
    ],
    [{ role: 'user', content: 'question' }],
  );

  assert.deepEqual(events.at(-1), {
    type: 'usage',
    usage: { prompt_tokens: 230, completion_tokens: 50, total_tokens: 280 },
  });
});

/**
 * With the token stream on (`llm/token-stream.ts`) the user has already read the
 * answer by the time its step completes. Only the text is dropped — the tool
 * calls and the token spend of that same message are new here, and dropping them
 * with it would lose the step from the timeline and the turn from the counter.
 */
test('text already streamed as tokens is not sent again by its completed step', async () => {
  const answered = {
    ...aiMessage('ai-1', 'already read as tokens', [
      { id: 'call-1', name: 'jira_search', args: {} },
    ]),
    usage_metadata: { input_tokens: 100, output_tokens: 20 },
  };

  const events = await run(
    [{ model: { messages: [answered] } }],
    [{ role: 'user', content: 'question' }],
    { streamedIds: new Set(['ai-1']) },
  );

  assert.deepEqual(events, [
    { type: 'tool_call', id: 'call-1', kind: 'tool', name: 'jira_search' },
    {
      type: 'tool_result',
      id: 'call-1',
      isError: true,
      interrupted: true,
      preview: 'The turn ended while this call was still running.',
    },
    { type: 'usage', usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } },
  ]);
});

/** A message nobody streamed still carries its text, set or no set. */
test('a message outside the streamed set keeps its text', async () => {
  const events = await run(
    [{ model: { messages: [aiMessage('ai-2', 'nobody saw this')] } }],
    [{ role: 'user', content: 'question' }],
    { streamedIds: new Set(['ai-1']) },
  );

  assert.deepEqual(events, [{ type: 'text', delta: 'nobody saw this' }]);
});

/**
 * Streaming moves the abort inside the model call, so it surfaces as a thrown
 * `AbortError` instead of the loop noticing the signal between two steps. A turn
 * the user stopped must still end quietly — a rethrow here becomes a red,
 * retriable error on a message the user deliberately cut short.
 */
test('an abort raised from inside the model call ends the turn quietly', async () => {
  const controller = new AbortController();
  const abort = new Error('This operation was aborted');
  abort.name = 'AbortError';
  const events: DeepAgentStreamEvent[] = [];

  await streamAgentUpdates(
    agentFailingAfter([callUpdate('call-1')], abort),
    toAgentMessages([{ role: 'user', content: 'task' }]),
    (event) => events.push(event),
    controller.signal,
  );

  assert.deepEqual(results(events), [
    {
      type: 'tool_result',
      id: 'call-1',
      isError: true,
      interrupted: true,
      preview: 'Stopped by the user.',
    },
  ]);
});

test('an exhausted step budget ends the turn as a limit, not as a failure', async () => {
  const events: DeepAgentStreamEvent[] = [];
  const recursion = new Error('Recursion limit of 150 reached without hitting a stop condition.');
  recursion.name = 'GraphRecursionError';

  await streamAgentUpdates(
    failingAgent(recursion),
    toAgentMessages([{ role: 'user', content: 'a big task' }]),
    (event) => events.push(event),
    new AbortController().signal,
  );

  assert.deepEqual(events, [{ type: 'limit' }]);
});

/**
 * A guard of the caller's — the repetition watch is the one that exists — cuts
 * the turn by aborting it, which is indistinguishable here from the user's Stop.
 * `interrupted` is what tells them apart, and a turn cut by a guard ends the way
 * an exhausted budget does: cut short, with everything written so far kept.
 */
test('an abort the caller owns ends the turn as a limit, not as a stop', async () => {
  const controller = new AbortController();
  // The shape a guard's cut takes: work is under way, the guard aborts, and the
  // model call it was in raises — exactly what Stop looks like from here.
  const cutting: StreamableAgent = {
    stream: () =>
      Promise.resolve(
        (async function* () {
          yield callUpdate('call-1');
          controller.abort();
          const abort = new Error('This operation was aborted');
          abort.name = 'AbortError';
          throw abort;
        })(),
      ),
  };

  const events = await collect(cutting, {
    signal: controller.signal,
    projection: { interrupted: () => 'limit' },
  });

  assert.ok(events.some((event) => event.type === 'limit'));
  assert.deepEqual(results(events), [
    {
      type: 'tool_result',
      id: 'call-1',
      isError: true,
      interrupted: true,
      preview: 'The per-turn step limit was reached.',
    },
  ]);
});

/** The user's Stop is not an outcome to report back to them. */
test('a turn the user stopped stays a stop even with the guard in place', async () => {
  const controller = new AbortController();
  controller.abort();
  const abort = new Error('This operation was aborted');
  abort.name = 'AbortError';

  const events = await collect(failingAgent(abort), {
    signal: controller.signal,
    projection: { interrupted: () => null },
  });

  assert.equal(
    events.some((event) => event.type === 'limit'),
    false,
  );
});

test('any other stream failure is rethrown with its detail', async () => {
  await assert.rejects(
    streamAgentUpdates(
      failingAgent({ status: 401, error: { message: 'Invalid API key' } }),
      [],
      () => {},
      new AbortController().signal,
    ),
    /401 Invalid API key/,
  );
});

test('a failure reason is dug out of whichever shape the provider used', async () => {
  const reject = (error: unknown) =>
    streamAgentUpdates(failingAgent(error), [], () => {}, new AbortController().signal);

  // A Nest-style API's validation errors arrive as an array of problems.
  await assert.rejects(
    reject({ status: 400, error: { message: ['model is required', 'messages is empty'] } }),
    /400 model is required; messages is empty/,
  );
  // Axios-style clients put the parsed body on `response.data`.
  await assert.rejects(
    reject({ response: { data: { message: 'quota exhausted' } } }),
    /quota exhausted/,
  );
  // Nothing structured to read — the error's own message will do.
  await assert.rejects(reject(new Error('socket hang up')), /socket hang up/);
  await assert.rejects(reject('a string instead of an error'), /a string instead of an error/);
});

test('the plan is streamed, and entries that are not plan items are dropped', async () => {
  const events = await run(
    [
      {
        model: {
          todos: [
            { content: 'read the code', status: 'completed' },
            { content: 'make the edits', status: 'in_progress' },
            { content: 'no status' },
            { status: 'pending' },
            'junk',
          ],
        },
      },
    ],
    [{ role: 'user', content: 'do it' }],
  );

  assert.deepEqual(events, [
    {
      type: 'todos',
      todos: [
        { content: 'read the code', status: 'completed' },
        { content: 'make the edits', status: 'in_progress' },
      ],
    },
  ]);
});

test('a state update without todos does not emit an empty plan', async () => {
  const events = await run(
    [{ model: { messages: [aiMessage('ai-1', 'answer')] } }],
    [{ role: 'user', content: 'question' }],
  );

  assert.ok(!events.some((event) => event.type === 'todos'));
});

test('a message exposing the private accessor is still projected', async () => {
  const legacy = { id: 'ai-1', content: 'the old interface', tool_calls: [], _getType: () => 'ai' };

  const events = await run([{ model: { messages: [legacy] } }], [{ role: 'user', content: 'x' }]);

  assert.deepEqual(events, [{ type: 'text', delta: 'the old interface' }]);
});

/**
 * The Code timeline shows what a tool actually returned, so a failing test run is
 * readable without asking the agent to repeat it. The chat path asks for no
 * preview at all, and must not start carrying one.
 */
test('a tool result carries a preview only when the caller asked for one', async () => {
  const updates = [
    callUpdate('call-1'),
    { tools: { messages: [toolMessage('call-1', `  ${'é'.repeat(50)}  `)] } },
  ];

  const [previewed] = results(
    await collect(fakeAgent(updates), { projection: { previewChars: 10 } }),
  );
  assert.equal(previewed.type === 'tool_result' && previewed.preview, `${'é'.repeat(10)}…`);

  const [plain] = results(await collect(fakeAgent(updates)));
  assert.ok(plain.type === 'tool_result' && !('preview' in plain));
});

/**
 * The regression this projection carries its `inFlight` set for: a `tool_call`
 * without a matching `tool_result` leaves the step spinning, and the browser
 * persists the transcript — so the spinner survived a reload with no way to clear
 * it. There are several ways to end a turn mid-call, and each has to say which.
 */
test('a call still in flight when the turn ends is closed out, saying why', async () => {
  const ended = results(await collect(fakeAgent([callUpdate('call-1')])));
  assert.deepEqual(ended, [
    {
      type: 'tool_result',
      id: 'call-1',
      isError: true,
      interrupted: true,
      preview: 'The turn ended while this call was still running.',
    },
  ]);

  const recursion = new Error('Recursion limit of 150 reached');
  recursion.name = 'GraphRecursionError';
  const limited = await collect(agentFailingAfter([callUpdate('call-2')], recursion));
  assert.deepEqual(
    limited.map((event) => event.type),
    ['tool_call', 'limit', 'tool_result'],
    'the limit is reported before the calls it cut short',
  );
  assert.match(
    (results(limited)[0] as { preview?: string }).preview ?? '',
    /per-turn step limit was reached/,
  );
});

test('a call in flight when the graph throws is closed out before the error propagates', async () => {
  const events: DeepAgentStreamEvent[] = [];

  await assert.rejects(
    streamAgentUpdates(
      agentFailingAfter([callUpdate('call-1')], new Error('graph exploded')),
      [],
      (event) => events.push(event),
      new AbortController().signal,
    ),
    /graph exploded/,
  );

  assert.match((results(events)[0] as { preview?: string }).preview ?? '', /cut short by an error/);
});

/**
 * Stop has to stop the turn, not just the response the user was reading: no
 * further updates are projected, the open call is closed as interrupted, and the
 * partial spend is not reported as if the turn had finished.
 */
test('stopping mid-stream drops the rest of the turn and its usage', async () => {
  const controller = new AbortController();
  const first = {
    ...aiMessage('ai-1', 'started', [{ id: 'call-1', name: 'jira_search', args: {} }]),
    usage_metadata: { input_tokens: 100, output_tokens: 20 },
  };

  const aborting: StreamableAgent = {
    stream: () =>
      Promise.resolve(
        (async function* () {
          yield { model: { messages: [first] } };
          controller.abort();
          yield { model: { messages: [aiMessage('ai-2', 'nobody is waiting for this any more')] } };
        })(),
      ),
  };

  const events = await collect(aborting, { signal: controller.signal });

  assert.deepEqual(events, [
    { type: 'text', delta: 'started' },
    { type: 'tool_call', id: 'call-1', kind: 'tool', name: 'jira_search' },
    {
      type: 'tool_result',
      id: 'call-1',
      isError: true,
      interrupted: true,
      preview: 'Stopped by the user.',
    },
  ]);
});

/** Without a label the Code timeline reads as a list of bare tool names. */
test('a step is labelled by the most telling argument of its call', () => {
  const [shell] = toolCallEvents(
    aiMessage('ai-1', '', [
      {
        id: 'a',
        name: 'execute',
        args: { command: './gradlew   build\n  --info', file_path: '/x' },
      },
    ]),
    new Set(['execute']),
  );
  assert.equal(shell.type === 'tool_call' && shell.label, './gradlew build --info');

  const [read] = toolCallEvents(
    aiMessage('ai-2', '', [{ id: 'b', name: 'read_file', args: { file_path: '/src/app.ts' } }]),
    new Set(['read_file']),
  );
  assert.equal(read.type === 'tool_call' && read.label, '/src/app.ts');

  const [bare] = toolCallEvents(aiMessage('ai-3', '', [{ id: 'c', name: 'jira_me', args: {} }]));
  assert.ok(bare.type === 'tool_call' && !('label' in bare) && !('args' in bare));
});

test('the raw arguments travel back, capped so one call cannot flood the stream', () => {
  const [event] = toolCallEvents(
    aiMessage('ai-1', '', [{ id: 'a', name: 'jira_search', args: { jql: 'x'.repeat(1000) } }]),
  );

  const raw = event.type === 'tool_call' ? (event.args ?? '') : '';
  assert.equal(raw.length, 401, '400 characters plus the ellipsis');
  assert.ok(raw.endsWith('…'));
});

test('toolCallEvents surfaces delegations, hides built-ins and the silent tools', () => {
  const events = toolCallEvents(
    aiMessage('ai-1', '', [
      {
        id: 'a',
        name: 'task',
        args: { subagent_type: 'researcher', description: 'find the facts' },
      },
      { id: 'b', name: 'ask_user', args: { question: 'which one?' } },
      { id: 'c', name: 'write_artifact', args: { key: 'doc' } },
      { id: 'd', name: 'write_todos', args: {} },
      { id: 'e', name: 'read_file', args: { file_path: '/spec.md' } },
      { id: 'f', name: 'jira_search', args: { jql: 'x' } },
      // Plan mode's approval tool: it has its own card, so a step row for it
      // would put the same plan on screen twice.
      { id: 'g', name: EXIT_PLAN_MODE_TOOL, args: { plan: '## Plan' } },
    ]),
  );

  assert.deepEqual(
    events.map((event) => (event.type === 'tool_call' ? event.name : event.type)),
    ['researcher', 'jira_search'],
  );

  // The Code path opts its file tools back in; `write_todos` stays hidden
  // either way, because the plan card already shows it.
  const withBuiltins = toolCallEvents(
    aiMessage('ai-2', '', [
      { id: 'd', name: 'write_todos', args: {} },
      { id: 'e', name: 'read_file', args: { file_path: '/spec.md' } },
    ]),
    new Set(['read_file']),
  );
  assert.deepEqual(
    withBuiltins.map((event) => (event.type === 'tool_call' ? event.name : event.type)),
    ['read_file'],
  );
});

test('uniqueExposedName steps around deepagents built-ins and the connector tools', () => {
  const taken = new Set<string>();
  // Nothing reserved: kept as-is.
  assert.equal(uniqueExposedName('jira_search', taken), 'jira_search');
  // A deepagents built-in — `createDeepAgent` would throw on a collision.
  assert.equal(uniqueExposedName('read_file', taken), 'mcp_read_file');
  // The connector's own tools do not throw, they silently duplicate.
  assert.equal(uniqueExposedName('ask_user', taken), 'mcp_ask_user');
  assert.equal(uniqueExposedName('write_artifact', taken), 'mcp_write_artifact');
  assert.equal(uniqueExposedName('mcp_load_tools', taken), 'mcp_mcp_load_tools');
  // And a second server reusing the renamed form still gets its own name.
  assert.equal(uniqueExposedName('mcp_read_file', new Set(['mcp_read_file'])), 'mcp_mcp_read_file');
});

test('safeRelPath confines a caller-supplied path to one subtree', () => {
  assert.equal(safeRelPath('notes.md'), 'notes.md');
  assert.equal(safeRelPath('refs/style.md'), 'refs/style.md');
  assert.equal(safeRelPath('../../.ssh/id_rsa'), '.ssh/id_rsa');
  assert.equal(safeRelPath('/etc/passwd'), 'etc/passwd');
  assert.equal(safeRelPath('C:\\Windows\\system32'), 'Windows/system32');
  assert.equal(safeRelPath('./a/./b'), 'a/b');
  assert.equal(safeRelPath('../..'), '');
});

test('materializing skills replaces what a previous turn left behind', () => {
  withTempDir((dir) => {
    const skill = (id: string) => ({
      id,
      name: id,
      description: `description ${id}`,
      instructions: `# ${id}`,
      files: [{ path: 'refs/notes.md', content: 'notes' }],
    });

    assert.deepEqual(materializeSkills(dir, [skill('alpha'), skill('beta')]), ['/skills/']);
    assert.deepEqual(readdirSync(join(dir, 'skills')).sort(), ['alpha', 'beta']);

    // deepagents discovers skills by scanning the source directory, so a skill
    // detached from the project has to disappear from disk or it stays loaded.
    assert.deepEqual(materializeSkills(dir, [skill('alpha')]), ['/skills/']);
    assert.deepEqual(readdirSync(join(dir, 'skills')), ['alpha']);

    assert.equal(materializeSkills(dir, []), undefined);
    assert.deepEqual(readdirSync(dir), []);
  });
});

test('materializing project files replaces what a previous turn left behind', () => {
  withTempDir((dir) => {
    assert.deepEqual(
      materializeFiles(dir, [
        { path: 'spec.md', content: 'specification' },
        { path: '../escape.md', content: 'not allowed' },
      ]),
      ['/files/spec.md', '/files/escape.md'],
    );

    assert.deepEqual(materializeFiles(dir, [{ path: 'spec.md', content: 'v2' }]), [
      '/files/spec.md',
    ]);
    assert.deepEqual(readdirSync(join(dir, 'files')), ['spec.md']);

    assert.equal(materializeFiles(dir, []), undefined);
  });
});

test('the workspace sweep drops only what has aged out', () => {
  withTempDir((root) => {
    const fresh = join(root, 'fresh-chat');
    const stale = join(root, 'stale-chat');
    materializeFiles(fresh, [{ path: 'a.md', content: 'a' }]);
    materializeFiles(stale, [{ path: 'b.md', content: 'b' }]);

    // Twenty-nine days is still inside the window; thirty-one is not.
    const day = 24 * 60 * 60_000;
    assert.equal(sweepWorkspaces(root, Date.now() + 29 * day), 0);
    assert.deepEqual(readdirSync(root).sort(), ['fresh-chat', 'stale-chat']);

    assert.equal(sweepWorkspaces(root, Date.now() + 31 * day), 2);
    assert.deepEqual(readdirSync(root), []);
  });

  // A root that was never created is not an error worth failing a startup over.
  assert.equal(sweepWorkspaces(join(tmpdir(), 'engine-nonexistent-workspaces')), 0);
});
