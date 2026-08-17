/**
 * The tool-building half of `deep-agent.ts`: what the agent is handed before it
 * runs. Split from `deep-agent.test.ts`, which covers the other half — how the
 * turn that follows is projected into stream events. One 1300-line module, two
 * concerns, two files.
 */
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { describe, test } from 'node:test';

import { type Connector } from './connector';
import {
  type ChatCompletionTool,
  type DeepAgentRunRequest,
  type DeepAgentStreamEvent,
  type DeepAgentSubAgent,
  MCP_LOAD_TOOLS,
  MCP_LOAD_TOOLS_DESCRIPTION,
  type McpTool,
  type McpToolCallResponse,
  McpToolMode,
  type McpServerConfig,
  type McpToolSource,
  McpTransport,
} from './contracts';
import {
  bridgeTools,
  type BridgedTools,
  buildAskUserTool,
  buildClientTools,
  buildDeferredGate,
  buildSubAgents,
  buildTaskTools,
  buildWriteArtifactTool,
  filesPromptSection,
  type loadDeps,
  type PendingAnswers,
} from './deep-agent';
import { buildHideToolsMiddleware } from './hide-builtin-tools';
import { BackgroundTasks } from './tasks/background-tasks';

type Deps = Awaited<ReturnType<typeof loadDeps>>;
type ToolFactory = Deps['tool'];

/** What the stub `tool()` factory produces — a LangChain tool reduced to its parts. */
interface StubTool {
  name: string;
  description?: string;
  schema?: unknown;
  invoke: (args: Record<string, unknown>) => unknown;
}

/**
 * Stands in for LangChain's `tool()`. The real one lives behind the lazy ESM
 * import in `loadDeps`, and everything these tests are about — which tools get
 * built, under what names, and what their bodies do — is visible without it.
 */
const stubTool = ((fn: (args: Record<string, unknown>) => unknown, meta: object) => ({
  ...meta,
  invoke: fn,
})) as unknown as ToolFactory;

/** A `tool()` that refuses the schemas matching `rejects`, the way a bad JSON Schema does. */
function pickyTool(rejects: RegExp): ToolFactory {
  return ((fn: (args: Record<string, unknown>) => unknown, meta: { name: string }) => {
    if (rejects.test(meta.name)) {
      throw new Error(`unsupported schema for ${meta.name}`);
    }
    return { ...meta, invoke: fn };
  }) as unknown as ToolFactory;
}

const stubDeps = {
  tool: stubTool,
  createMiddleware: (config: unknown) => config,
} as unknown as Deps;

function asStub(built: unknown): StubTool {
  return built as StubTool;
}

const CONFIG: McpServerConfig = { transport: McpTransport.Http, url: 'https://mcp.example.test' };

/** Records what the bridged tools asked the pool to do. */
interface ConnectorCalls {
  listed: { config: McpServerConfig; signal?: AbortSignal }[];
  called: { toolName: string; args: Record<string, unknown>; signal?: AbortSignal }[];
}

/**
 * A stand-in MCP pool. The real one is covered end-to-end in `connector.test.ts`;
 * here it only has to answer, so the bridging around it is what gets asserted.
 */
function fakeConnector(
  tools: Record<string, McpTool[]> | McpTool[],
  callTool: (toolName: string, args: Record<string, unknown>) => Promise<McpToolCallResponse>,
): { connector: Connector; calls: ConnectorCalls } {
  const calls: ConnectorCalls = { listed: [], called: [] };
  const byUrl = Array.isArray(tools) ? null : tools;

  const listTools = (config: McpServerConfig, signal?: AbortSignal) => {
    calls.listed.push({ config, signal });
    const list = byUrl ? byUrl[config.url ?? ''] : tools;
    if (!list) {
      return Promise.reject(new Error(`server ${String(config.url)} unreachable`));
    }
    return Promise.resolve(list);
  };

  const connector = {
    listTools,
    // What bridging actually calls: the real one answers from the catalog and
    // only falls back to a listing (which starts the server) when it has none.
    catalogTools: listTools,
    callTool: (
      _config: McpServerConfig,
      toolName: string,
      args: Record<string, unknown>,
      signal?: AbortSignal,
    ) => {
      calls.called.push({ toolName, args, signal });
      return callTool(toolName, args);
    },
  } as unknown as Connector;

  return { connector, calls };
}

function mcpTool(name: string, description = `description ${name}`): McpTool {
  return { name, description, inputSchema: { type: 'object' } };
}

function source(config: McpServerConfig, policies?: McpToolSource['policies']): McpToolSource {
  return { config, ...(policies ? { policies } : {}) };
}

const ok = (content: string): Promise<McpToolCallResponse> =>
  Promise.resolve({ content, isError: false });

describe('bridgeTools', () => {
  test('bridges the available tools and reports the deferred ones', async () => {
    const { connector } = fakeConnector(
      [mcpTool('jira_search'), mcpTool('jira_delete'), mcpTool('jira_create')],
      () => ok('done'),
    );

    const bridged = await bridgeTools(
      connector,
      [
        source(CONFIG, [
          { toolName: 'jira_delete', mode: McpToolMode.Disabled },
          { toolName: 'jira_create', mode: McpToolMode.Deferred },
        ]),
      ],
      stubTool,
    );

    assert.deepEqual([...bridged.byName.keys()], ['jira_search', 'jira_create']);
    assert.deepEqual([...bridged.deferred], ['jira_create']);
  });

  /**
   * `byName` is keyed by the *raw* MCP name because a sub-agent's allow-list
   * references those; `deferred` holds the *exposed* name because that is what
   * the gate's middleware filters on. Conflating the two silently breaks one of
   * the two features.
   */
  test('renames a tool clashing with a deepagents built-in but keeps its raw key', async () => {
    const { connector } = fakeConnector([mcpTool('read_file')], () => ok('done'));

    const bridged = await bridgeTools(
      connector,
      [source(CONFIG, [{ toolName: '*', mode: McpToolMode.Deferred }])],
      stubTool,
    );

    assert.deepEqual([...bridged.byName.keys()], ['read_file'], 'the allow-list key stays raw');
    assert.equal(asStub(bridged.byName.get('read_file')).name, 'mcp_read_file');
    assert.deepEqual([...bridged.deferred], ['mcp_read_file'], 'the gate filters the exposed name');
  });

  test('two servers offering the same tool keep the first', async () => {
    const second: McpServerConfig = { transport: McpTransport.Http, url: 'https://other.test' };
    const { connector } = fakeConnector(
      {
        'https://mcp.example.test': [mcpTool('search', 'from the first')],
        'https://other.test': [mcpTool('search', 'from the second')],
      },
      () => ok('done'),
    );

    const bridged = await bridgeTools(connector, [source(CONFIG), source(second)], stubTool);

    assert.equal(bridged.byName.size, 1);
    assert.equal(asStub(bridged.byName.get('search')).description, 'from the first');
  });

  /**
   * The servers are listed in parallel — five cold stdio servers one after
   * another is most of the wait before the first token. Which of them answers
   * first must not decide anything: the scope is ordered, so the tool names are
   * settled in that order, whatever the network did.
   */
  test('a slow first server still keeps the contested name', async () => {
    const second: McpServerConfig = { transport: McpTransport.Http, url: 'https://other.test' };
    const started: string[] = [];
    const connector = {
      catalogTools: async (config: McpServerConfig): Promise<McpTool[]> => {
        started.push(config.url ?? '');
        const slow = config.url === CONFIG.url;
        await new Promise((resolve) => setTimeout(resolve, slow ? 20 : 0));
        return [mcpTool('search', slow ? 'from the first' : 'from the second')];
      },
    } as unknown as Connector;

    const bridged = await bridgeTools(connector, [source(CONFIG), source(second)], stubTool);

    assert.deepEqual(started, [CONFIG.url, second.url], 'both were asked without waiting');
    assert.equal(asStub(bridged.byName.get('search')).description, 'from the first');
  });

  /**
   * A server that will not connect is simply absent from the model's tool list,
   * which reads exactly like an agent that chose not to use it. Say so instead,
   * and keep bridging the servers that do answer.
   */
  test('an unreachable server is a warning, not the end of the turn', async () => {
    const dead: McpServerConfig = { transport: McpTransport.Http, url: 'https://dead.test' };
    const { connector } = fakeConnector({ 'https://mcp.example.test': [mcpTool('search')] }, () =>
      ok('done'),
    );
    const warnings: string[] = [];

    const bridged = await bridgeTools(
      connector,
      [source(dead), source(CONFIG)],
      stubTool,
      (message) => warnings.push(message),
    );

    assert.deepEqual([...bridged.byName.keys()], ['search']);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /The MCP server is unavailable/);
  });

  test('a tool with an unusable schema costs only itself', async () => {
    const { connector } = fakeConnector([mcpTool('good'), mcpTool('broken')], () => ok('done'));
    const warnings: string[] = [];

    const bridged = await bridgeTools(
      connector,
      [source(CONFIG)],
      pickyTool(/^broken$/),
      (message) => warnings.push(message),
    );

    assert.deepEqual([...bridged.byName.keys()], ['good']);
    assert.match(warnings[0], /Tool «broken» was skipped/);
  });

  describe('the bridged body', () => {
    test('returns the tool text', async () => {
      const { connector } = fakeConnector([mcpTool('search')], () => ok('12 tasks'));
      const bridged = await bridgeTools(connector, [source(CONFIG)], stubTool);

      assert.equal(await asStub(bridged.byName.get('search')).invoke({ jql: 'x' }), '12 tasks');
    });

    test('marks a tool-reported error so the model can read it', async () => {
      const { connector } = fakeConnector([mcpTool('search')], () =>
        Promise.resolve({ content: 'access denied', isError: true }),
      );
      const bridged = await bridgeTools(connector, [source(CONFIG)], stubTool);

      assert.equal(await asStub(bridged.byName.get('search')).invoke({}), 'Error: access denied');
    });

    test('says something even when the tool returns nothing', async () => {
      const { connector } = fakeConnector([mcpTool('search')], () => ok(''));
      const bridged = await bridgeTools(connector, [source(CONFIG)], stubTool);

      assert.equal(await asStub(bridged.byName.get('search')).invoke({}), '(empty result)');
    });

    /**
     * A timeout or an abort comes back as this call's result rather than a throw:
     * one unreachable server should cost its own call, leaving the model free to
     * work around it instead of ending the turn.
     */
    test('a thrown failure becomes the result, not an exception', async () => {
      const { connector } = fakeConnector([mcpTool('search')], () =>
        Promise.reject(new Error('the wait timed out')),
      );
      const bridged = await bridgeTools(connector, [source(CONFIG)], stubTool);

      assert.equal(
        await asStub(bridged.byName.get('search')).invoke({}),
        'Error: the wait timed out',
      );
    });

    /**
     * An agent that cannot find what it is looking for repeats itself literally:
     * the same tool, the same arguments, several times in one turn. The repeat
     * is answered from the turn's own record, and told that it is a repeat —
     * unlabelled, the model reads its own earlier output as fresh progress.
     */
    test('a call repeated verbatim is answered from the memo, not the server', async () => {
      const { connector, calls } = fakeConnector([mcpTool('grep')], () => ok('0 matches'));
      const bridged = await bridgeTools(connector, [source(CONFIG)], stubTool);
      const grep = asStub(bridged.byName.get('grep'));

      await grep.invoke({ repository: 'example-libs', query: 'CommissionService' });
      const repeat = await grep.invoke({
        query: 'CommissionService',
        repository: 'example-libs',
      });

      assert.equal(calls.called.length, 1);
      assert.match(String(repeat), /already called/);
      assert.match(String(repeat), /0 matches/);
    });

    test('a call with different arguments still goes to the server', async () => {
      const { connector, calls } = fakeConnector([mcpTool('grep')], () => ok('0 matches'));
      const bridged = await bridgeTools(connector, [source(CONFIG)], stubTool);
      const grep = asStub(bridged.byName.get('grep'));

      await grep.invoke({ repository: 'example-libs' });
      await grep.invoke({ repository: 'example-api' });

      assert.equal(calls.called.length, 2);
    });

    /** Repeating a call that failed is a retry, and a retry has to actually run. */
    test('a failed call is not remembered', async () => {
      const answers = [
        Promise.resolve({ content: 'server unreachable', isError: true }),
        ok('12 tasks'),
      ];
      const { connector, calls } = fakeConnector(
        [mcpTool('search')],
        () => answers.shift() ?? ok(''),
      );
      const bridged = await bridgeTools(connector, [source(CONFIG)], stubTool);
      const search = asStub(bridged.byName.get('search'));

      assert.equal(await search.invoke({ jql: 'x' }), 'Error: server unreachable');
      assert.equal(await search.invoke({ jql: 'x' }), '12 tasks');
      assert.equal(calls.called.length, 2);
    });

    test('carries the turn’s abort signal into both MCP requests', async () => {
      const signal = new AbortController().signal;
      const { connector, calls } = fakeConnector([mcpTool('search')], () => ok('done'));

      const bridged = await bridgeTools(connector, [source(CONFIG)], stubTool, () => {}, signal);
      await asStub(bridged.byName.get('search')).invoke({ jql: 'x' });

      assert.equal(calls.listed[0].signal, signal);
      assert.equal(calls.called[0].signal, signal);
      assert.deepEqual(calls.called[0].args, { jql: 'x' });
    });
  });
});

describe('buildDeferredGate', () => {
  /** Builds a gate over `deferred`, plus the tool entries the middleware filters. */
  async function gateOver(deferred: string[], available: string[] = []) {
    const names = [...deferred, ...available];
    const { connector } = fakeConnector(
      names.map((name) => mcpTool(name)),
      () => ok('done'),
    );
    const bridged = await bridgeTools(
      connector,
      [
        source(
          CONFIG,
          deferred.map((name) => ({ toolName: name, mode: McpToolMode.Deferred })),
        ),
      ],
      stubTool,
    );
    const gate = buildDeferredGate(stubDeps, bridged);
    return { gate, bridged };
  }

  /** Runs the gate's middleware over a tool list and returns the names that survive. */
  function visibleTools(gate: { middleware: unknown }, names: string[]): string[] {
    const middleware = gate.middleware as {
      wrapModelCall: (
        request: { tools: { name: string }[] },
        handler: (request: { tools: { name: string }[] }) => { tools: { name: string }[] },
      ) => { tools: { name: string }[] };
    };
    const request = { tools: names.map((name) => ({ name })) };
    return middleware.wrapModelCall(request, (next) => next).tools.map((entry) => entry.name);
  }

  test('is absent when nothing is deferred', async () => {
    const { gate } = await gateOver([], ['search']);
    assert.equal(gate, null);
  });

  test('lists the deferred tools in the meta-tool’s schema, and only there', async () => {
    const { gate } = await gateOver(['jira_create', 'jira_delete']);
    const loadTools = asStub(gate!.tool);

    assert.equal(loadTools.name, MCP_LOAD_TOOLS);
    assert.deepEqual(
      (loadTools.schema as { properties: { names: { items: { enum: string[] } } } }).properties
        .names.items.enum,
      ['jira_create', 'jira_delete'],
    );
    // Not in the description as well: this tool travels in every request of the
    // turn, and naming each tool twice — once in prose, once in the enum — is
    // what made it the largest single entry in it.
    assert.equal(loadTools.description, MCP_LOAD_TOOLS_DESCRIPTION);
    assert.doesNotMatch(loadTools.description ?? '', /jira_create/);
  });

  test('hides the deferred tools from a model call and keeps the meta-tool', async () => {
    const { gate } = await gateOver(['jira_create'], ['search']);

    assert.deepEqual(visibleTools(gate!, ['search', 'jira_create', MCP_LOAD_TOOLS]), [
      'search',
      MCP_LOAD_TOOLS,
    ]);
  });

  test('loading a tool promotes it for the rest of the run', async () => {
    const { gate } = await gateOver(['jira_create']);

    assert.match(
      String(asStub(gate!.tool).invoke({ names: ['jira_create'] })),
      /Loaded tools: jira_create/,
    );
    assert.deepEqual(visibleTools(gate!, ['jira_create']), ['jira_create']);
  });

  /** Once everything is loaded the meta-tool has nothing left to offer. */
  test('the meta-tool drops out of the list once nothing is hidden', async () => {
    const { gate } = await gateOver(['jira_create']);

    assert.deepEqual(visibleTools(gate!, ['jira_create', MCP_LOAD_TOOLS]), [MCP_LOAD_TOOLS]);
    asStub(gate!.tool).invoke({ names: ['jira_create'] });
    assert.deepEqual(visibleTools(gate!, ['jira_create', MCP_LOAD_TOOLS]), ['jira_create']);
  });

  test('asking for a tool that is not deferred changes nothing', async () => {
    const { gate } = await gateOver(['jira_create']);

    assert.equal(asStub(gate!.tool).invoke({ names: ['nope'] }), 'No matching tools to load.');
    assert.equal(
      asStub(gate!.tool).invoke({ names: 'not an array' }),
      'No matching tools to load.',
    );
    assert.deepEqual(visibleTools(gate!, ['jira_create']), []);
  });
});

describe('buildAskUserTool', () => {
  /** An `ask_user` tool wired to a fresh event log, pending map and abort controller. */
  function askUser() {
    const events: DeepAgentStreamEvent[] = [];
    const pending: PendingAnswers = new Map();
    const controller = new AbortController();
    const tool = asStub(
      buildAskUserTool(stubTool, (event) => events.push(event), pending, controller.signal),
    );
    return { tool, events, pending, controller };
  }

  test('puts the question to the user and returns what they picked', async () => {
    const { tool, events, pending } = askUser();

    const answer = tool.invoke({
      question: 'Which branch?',
      options: ['main', 'develop'],
      multi: true,
    }) as Promise<string>;

    // The event carries the id the browser answers with.
    const [event] = events;
    assert.equal(event.type, 'ask_user');
    assert.deepEqual(
      { question: event.question, options: event.options, multi: event.multi },
      { question: 'Which branch?', options: ['main', 'develop'], multi: true },
    );
    assert.equal(pending.size, 1);

    pending.get(event.id)!({ text: 'develop' });
    assert.equal(await answer, 'develop');
    assert.equal(pending.size, 0, 'the answered question is no longer pending');
  });

  test('defaults to a single choice', async () => {
    const { tool, events, pending } = askUser();

    const answer = tool.invoke({ question: 'Continue?', options: ['Yes'] }) as Promise<string>;
    assert.equal(events[0].type === 'ask_user' && events[0].multi, false);
    pending.get((events[0] as { id: string }).id)!({ text: 'Yes' });
    await answer;
  });

  /** Buttons are the whole point; a question with none belongs in the prose. */
  test('a question without options is refused without asking anything', async () => {
    const { tool, events, pending } = askUser();

    const result = await (tool.invoke({ question: 'what next?' }) as Promise<string>);
    assert.match(result, /ask the user in plain text/);
    assert.deepEqual(events, []);
    assert.equal(pending.size, 0);
  });

  test('stopping the turn while a question is open rejects it', async () => {
    const { tool, controller, pending } = askUser();

    const answer = tool.invoke({ question: 'waiting', options: ['yes'] }) as Promise<string>;
    controller.abort();

    await assert.rejects(() => answer, /aborted/);
    assert.equal(pending.size, 0, 'an abandoned question is cleaned up too');
  });

  test('a turn already stopped never asks at all', async () => {
    const { tool, controller } = askUser();
    controller.abort();

    await assert.rejects(
      () => tool.invoke({ question: 'too late', options: ['yes'] }) as Promise<string>,
      /aborted/,
    );
  });

  /**
   * One abort signal lives for the whole turn, so an agent that asks repeatedly
   * used to pile listeners onto it until Node warned about a leak — which is why
   * the handler is hoisted and detached in a `finally`.
   */
  test('asking many times does not accumulate abort listeners', async () => {
    const { tool, pending, controller } = askUser();

    for (let index = 0; index < 30; index += 1) {
      const answer = tool.invoke({
        question: `question ${index}`,
        options: ['yes'],
      }) as Promise<string>;
      const [id] = [...pending.keys()];
      pending.get(id)!({ text: 'yes' });
      await answer;
    }

    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });
});

describe('buildClientTools', () => {
  const CHECK_DESIGN: ChatCompletionTool = {
    type: 'function',
    function: {
      name: 'check_design',
      description: 'Render the mock-up and return a report.',
      parameters: { properties: { viewport: { type: 'string' } } },
    },
  };

  /** The request's client tools wired to a fresh event log, pending map and controller. */
  function clientTools(defs: ChatCompletionTool[] = [CHECK_DESIGN], factory = stubTool) {
    const events: DeepAgentStreamEvent[] = [];
    const warnings: string[] = [];
    const pending: PendingAnswers = new Map();
    const controller = new AbortController();
    const built = buildClientTools(
      defs,
      factory,
      (event) => events.push(event),
      pending,
      controller.signal,
      (message) => warnings.push(message),
    ).map(asStub);
    return { built, events, warnings, pending, controller };
  }

  test('hands the call to the browser and returns what it answered', async () => {
    const { built, events, pending } = clientTools();

    assert.equal(built.length, 1);
    assert.equal(built[0].name, 'check_design');
    const result = built[0].invoke({ viewport: 'mobile' }) as Promise<string>;

    const [event] = events;
    assert.equal(event.type, 'client_tool');
    assert.equal(event.type === 'client_tool' && event.name, 'check_design');
    // Arguments travel verbatim — the browser owns the implementation.
    assert.equal(event.type === 'client_tool' && event.args, '{"viewport":"mobile"}');
    assert.equal(pending.size, 1);

    pending.get((event as { id: string }).id)!({ text: 'The check passed.' });
    assert.equal(await result, 'The check passed.');
    assert.equal(pending.size, 0, 'the answered call is no longer pending');
  });

  /** A failure has to reach the model as one, not as a result it might act on. */
  test('an error result is marked for the model', async () => {
    const { built, events, pending } = clientTools();

    const result = built[0].invoke({}) as Promise<string>;
    pending.get((events[0] as { id: string }).id)!({
      text: 'The mock-up was deleted.',
      isError: true,
    });

    assert.equal(await result, 'Error: The mock-up was deleted.');
  });

  test('aborting the turn rejects the waiting call and drops it', async () => {
    const { built, pending, controller } = clientTools();

    const result = built[0].invoke({}) as Promise<string>;
    controller.abort();

    await assert.rejects(result, /aborted/);
    assert.equal(pending.size, 0);
  });

  /** A signal lives for the whole turn; an agent that checks repeatedly must not leak. */
  test('does not pile up abort listeners across calls', async () => {
    const { built, pending, controller } = clientTools();

    for (let index = 0; index < 30; index += 1) {
      const result = built[0].invoke({}) as Promise<string>;
      const [id] = [...pending.keys()];
      pending.get(id)!({ text: 'ok' });
      await result;
    }

    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });

  /** `createDeepAgent` throws on a name it already owns — that must cost one tool. */
  test('skips a definition whose name is reserved', () => {
    const { built, warnings } = clientTools([
      { type: 'function', function: { name: 'write_file', parameters: {} } },
      CHECK_DESIGN,
    ]);

    assert.deepEqual(
      built.map((entry) => entry.name),
      ['check_design'],
    );
    assert.match(warnings[0], /write_file/);
  });

  test('a schema the factory refuses costs its own tool, not the turn', () => {
    const { built, warnings } = clientTools(
      [CHECK_DESIGN, { type: 'function', function: { name: 'read_design', parameters: {} } }],
      pickyTool(/read_design/),
    );

    assert.deepEqual(
      built.map((entry) => entry.name),
      ['check_design'],
    );
    assert.match(warnings[0], /read_design/);
  });
});

describe('buildWriteArtifactTool', () => {
  function writeArtifact() {
    const events: DeepAgentStreamEvent[] = [];
    return {
      tool: asStub(buildWriteArtifactTool(stubTool, (event) => events.push(event))),
      events,
    };
  }

  test('emits the artifact and tells the model not to repeat it', () => {
    const { tool, events } = writeArtifact();

    const result = tool.invoke({
      key: 'plan',
      title: 'Work plan',
      kind: 'markdown',
      content: '# Plan',
      language: 'md',
    });

    assert.deepEqual(events, [
      {
        type: 'artifact',
        key: 'plan',
        title: 'Work plan',
        kind: 'markdown',
        language: 'md',
        content: '# Plan',
      },
    ]);
    assert.match(String(result), /do not repeat its content/);
  });

  test('falls back to the key as a title and to markdown as a kind', () => {
    const { tool, events } = writeArtifact();

    tool.invoke({ key: 'notes', content: 'text', kind: 'spreadsheet' });

    assert.equal(events[0].type === 'artifact' && events[0].title, 'notes');
    assert.equal(events[0].type === 'artifact' && events[0].kind, 'markdown');
  });

  test('refuses to save an artifact with no key or no content', () => {
    const { tool, events } = writeArtifact();

    assert.match(String(tool.invoke({ content: 'text' })), /required/);
    assert.match(String(tool.invoke({ key: 'plan' })), /required/);
    assert.deepEqual(events, []);
  });
});

describe('buildSubAgents', () => {
  const BUILTINS = [{ name: 'ask_user' }, { name: 'write_artifact' }];
  const GATE = { tool: { name: MCP_LOAD_TOOLS }, middleware: { name: 'DeferredMcpTools' } };
  const REPAIR = { name: 'RepairToolCallArguments' };

  function context(overrides: Partial<Parameters<typeof buildSubAgents>[1]> = {}) {
    const bridged: BridgedTools = {
      byName: new Map<string, unknown>([
        ['jira_search', { name: 'jira_search' }],
        ['confluence_read', { name: 'confluence_read' }],
      ]),
      deferred: new Set<string>(),
    };
    return {
      bridged,
      tools: [...BUILTINS, ...bridged.byName.values()],
      builtins: BUILTINS,
      gate: GATE,
      repair: REPAIR,
      onWarn: () => {},
      ...overrides,
    } as Parameters<typeof buildSubAgents>[1];
  }

  function sub(overrides: Partial<DeepAgentSubAgent> = {}): DeepAgentSubAgent {
    return {
      name: 'researcher',
      description: 'looks for facts',
      systemPrompt: 'You are a researcher.',
      ...overrides,
    } as DeepAgentSubAgent;
  }

  function names(entry: unknown): string[] {
    return (entry as { tools: { name: string }[] }).tools.map((tool) => tool.name);
  }

  /**
   * Without the built-ins a delegation could neither ask the user anything nor
   * save its result — the allow-list is about MCP access, not about those.
   */
  test('an allow-list grants exactly those MCP tools plus the built-ins', () => {
    const [built] = buildSubAgents([sub({ tools: ['jira_search'] })], context());

    assert.deepEqual(names(built), ['ask_user', 'write_artifact', 'jira_search']);
    assert.deepEqual(
      (built as { middleware: unknown[] }).middleware,
      [REPAIR],
      'an explicit allow-list is not filtered by the deferred gate',
    );
  });

  test('a sub-agent without an allow-list inherits the full set and the gate', () => {
    const [built] = buildSubAgents([sub()], context());

    assert.deepEqual(names(built), [
      'ask_user',
      'write_artifact',
      'jira_search',
      'confluence_read',
    ]);
    assert.deepEqual((built as { middleware: unknown[] }).middleware, [GATE.middleware, REPAIR]);
  });

  /**
   * A delegation that ends on a call whose arguments would not parse looks
   * exactly like one that decided to do nothing, so the repair is granted
   * whatever else the sub-agent gets.
   */
  test('every sub-agent gets the tool-call repair, allow-list or not', () => {
    const [restricted] = buildSubAgents([sub({ tools: ['jira_search'] })], context());
    const [inheriting] = buildSubAgents([sub()], context({ gate: null }));

    for (const built of [restricted, inheriting]) {
      assert.ok((built as { middleware: unknown[] }).middleware.includes(REPAIR));
    }
  });

  /**
   * A sub-agent with zero tools looks like a model refusing to work, which is far
   * harder to diagnose than a warning — so an allow-list naming only tools that
   * are gone falls back to the full set.
   */
  test('an allow-list that resolves to nothing warns and falls back', () => {
    const warnings: string[] = [];
    const [built] = buildSubAgents(
      [sub({ tools: ['jira_renamed', 'gone'] })],
      context({ onWarn: (message: string) => warnings.push(message) }),
    );

    assert.deepEqual(names(built), [
      'ask_user',
      'write_artifact',
      'jira_search',
      'confluence_read',
    ]);
    assert.match(warnings[0], /Sub-agent «researcher»/);
    assert.match(warnings[0], /jira_renamed, gone/);
  });

  test('carries the name, description and prompt through unchanged', () => {
    const [built] = buildSubAgents([sub()], context());

    assert.deepEqual(
      { ...(built as Record<string, unknown>), tools: undefined, middleware: undefined },
      {
        name: 'researcher',
        description: 'looks for facts',
        systemPrompt: 'You are a researcher.',
        tools: undefined,
        middleware: undefined,
      },
    );
  });

  /** deepagents gives custom sub-agents none of the parent's skills, so they are passed on. */
  test('passes the run’s skills down when there are any', () => {
    const [withSkills] = buildSubAgents([sub()], context({ skillsPaths: ['/skills/'] }));
    const [without] = buildSubAgents([sub()], context());

    assert.deepEqual((withSkills as { skills: string[] }).skills, ['/skills/']);
    assert.ok(!('skills' in (without as object)));
  });
});

describe('filesPromptSection', () => {
  /** The files are readable but invisible until the prompt names them. */
  test('names every project file under a heading', () => {
    assert.equal(
      filesPromptSection(['/files/spec.md', '/files/api.md']),
      [
        '## Project files',
        'The following reference files from this project are available in your workspace.',
        'Read the ones relevant to the request before answering.',
        '- /files/spec.md',
        '- /files/api.md',
      ].join('\n'),
    );
  });
});

describe('buildTaskTools', () => {
  const PARENT: DeepAgentRunRequest = {
    messages: [],
    instructions: 'You are an assistant.',
    subAgents: [
      { name: 'researcher', description: 'Researches', systemPrompt: 'You are a researcher.' },
    ],
    llm: { model: 'gpt-5' },
    tools: [],
    sessionId: 'chat-1',
    allowTasks: true,
  };

  /** Builds the five tools over a registry whose runs the test drives by hand. */
  function harness() {
    const runs: { emit: (event: DeepAgentStreamEvent) => void; finish: () => void }[] = [];
    const tasks = new BackgroundTasks(
      (_request, onEvent, signal) =>
        new Promise<void>((resolve) => {
          runs.push({ emit: onEvent, finish: resolve });
          signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    );
    const events: DeepAgentStreamEvent[] = [];
    const controller = new AbortController();
    const built = buildTaskTools(
      tasks,
      PARENT,
      stubTool,
      (event) => events.push(event),
      controller.signal,
    ).map(asStub);
    const byName = new Map(built.map((entry) => [entry.name, entry]));
    return { tasks, runs, events, byName };
  }

  const delegation = {
    subagent_type: 'researcher',
    description: 'Research X',
    prompt: 'Research X and come back with conclusions',
  };

  test('delegates to the background by default: returns an id and does not wait', async () => {
    const { byName, events } = harness();

    const result = (await byName.get('delegate_task')!.invoke(delegation)) as string;

    assert.match(result, /Started background task/);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, 'task_started');
  });

  test('run_in_background: false waits for the task’s answer', async () => {
    const { byName, runs, events } = harness();

    const pending = byName.get('delegate_task')!.invoke({
      ...delegation,
      run_in_background: false,
    }) as Promise<string>;
    await new Promise((resolve) => setImmediate(resolve));
    runs[0]!.emit({ type: 'text', delta: 'Verdict: all good' });
    runs[0]!.finish();

    assert.match(await pending, /Verdict: all good/);
    assert.deepEqual(
      events.map((event) => event.type),
      ['task_started', 'task_status'],
    );
  });

  /** Why a retry of the turn is cheap: the same brief answers with the finished result. */
  test('repeating the same delegation answers from cache instead of starting a second run', async () => {
    const { byName, runs, events } = harness();
    await byName.get('delegate_task')!.invoke(delegation);
    runs[0]!.emit({ type: 'text', delta: 'Done' });
    runs[0]!.finish();
    await new Promise((resolve) => setImmediate(resolve));

    const again = (await byName.get('delegate_task')!.invoke(delegation)) as string;

    assert.match(again, /has already run in this chat/);
    assert.match(again, /Done/);
    assert.equal(runs.length, 1);
    assert.equal(events.filter((event) => event.type === 'task_started').length, 2);
  });

  /** A refusal is a tool result, not a failed turn. */
  test('an unknown agent type comes back as text listing what is available', async () => {
    const { byName, events } = harness();

    const result = (await byName.get('delegate_task')!.invoke({
      ...delegation,
      subagent_type: 'nobody',
    })) as string;

    assert.match(result, /Unknown agent type/);
    assert.match(result, /researcher/);
    assert.equal(events.length, 0);
  });

  test('check_task says plainly that the task is still running, and will not let the status be paraphrased', async () => {
    const { byName } = harness();
    const started = (await byName.get('delegate_task')!.invoke(delegation)) as string;
    const taskId = /`([0-9a-f-]{36})`/.exec(started)![1]!;

    const status = (await byName.get('check_task')!.invoke({ taskId })) as string;

    assert.match(status, /is still running/);
    assert.match(status, /will be stale/);
  });

  test('list_tasks lists the chat’s tasks, and an empty chat says so outright', async () => {
    const { byName } = harness();

    assert.match(
      (await byName.get('list_tasks')!.invoke({})) as string,
      /no background tasks in this chat/,
    );
    await byName.get('delegate_task')!.invoke(delegation);
    assert.match((await byName.get('list_tasks')!.invoke({})) as string, /Research X/);
  });
});

describe('buildHideToolsMiddleware', () => {
  /**
   * deepagents keeps `SubAgentMiddleware` mandatory, so `task` cannot be left
   * out — it is filtered out of the request instead, or the model would see two
   * ways to delegate and the built-in would win half the time.
   */
  test('cuts the built-in task out of the list the model sees', async () => {
    const middleware = buildHideToolsMiddleware((config: unknown) => config, new Set(['task'])) as {
      wrapModelCall: (request: unknown, handler: (request: unknown) => unknown) => Promise<unknown>;
    };
    let seen: { name: string }[] = [];

    await middleware.wrapModelCall(
      { tools: [{ name: 'task' }, { name: 'delegate_task' }, { name: 'write_todos' }] },
      (request) => {
        seen = (request as { tools: { name: string }[] }).tools;
        return request;
      },
    );

    assert.deepEqual(
      seen.map((tool) => tool.name),
      ['delegate_task', 'write_todos'],
    );
  });

  test('a request with no tool list passes through untouched', async () => {
    const middleware = buildHideToolsMiddleware((config: unknown) => config, new Set(['task'])) as {
      wrapModelCall: (request: unknown, handler: (request: unknown) => unknown) => Promise<unknown>;
    };

    const passed = await middleware.wrapModelCall({ messages: [] }, (request) => request);

    assert.deepEqual(passed, { messages: [] });
  });
});
