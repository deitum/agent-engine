import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from '../contracts';
import { type loadDeps } from '../deep-agent';

import { buildSearchTools } from './search-tools';
import { type SearxngContainer } from './searxng-container';

type ToolFactory = Awaited<ReturnType<typeof loadDeps>>['tool'];

/** A LangChain tool reduced to what these assertions need. */
interface StubTool {
  name: string;
  description?: string;
  schema?: unknown;
  invoke: (args: Record<string, unknown>) => Promise<string>;
}

/** Stands in for LangChain's `tool()`; the real one is behind a lazy ESM import. */
const stubTool = ((fn: (args: Record<string, unknown>) => unknown, meta: object) => ({
  ...meta,
  invoke: fn,
})) as unknown as ToolFactory;

/** A container that reports whatever URL the test wants it to. */
function fakeContainer(url: string | null): SearxngContainer {
  return { resolveUrl: async () => url } as unknown as SearxngContainer;
}

const running = fakeContainer('http://127.0.0.1:50881');

test('no tools when the run carries no search config', async () => {
  assert.deepEqual(await buildSearchTools(stubTool, { config: undefined, container: running }), []);
});

test('no tools when the deployment or the user turned search off', async () => {
  const tools = await buildSearchTools(stubTool, {
    config: { enabled: false },
    container: running,
  });
  assert.deepEqual(tools, []);
});

test('no tools when nothing is running to serve them', async () => {
  const tools = await buildSearchTools(stubTool, {
    config: { enabled: true },
    container: fakeContainer(null),
  });
  // A tool that answers every call with «search is not configured» costs the model a
  // round-trip each time it believes the promise; better not to make it.
  assert.deepEqual(tools, []);
});

test('both tools are built once there is a backend', async () => {
  const tools = (await buildSearchTools(stubTool, {
    config: { enabled: true },
    container: running,
  })) as unknown as StubTool[];

  assert.deepEqual(
    tools.map((entry) => entry.name),
    [WEB_SEARCH_TOOL, WEB_FETCH_TOOL],
  );
  assert.match(tools[0].description ?? '', /web_fetch/);
  assert.match(tools[1].description ?? '', /read its text/);
});

test('an external instance wins over the connector’s own container', async () => {
  // Asserted through the failure text, which names the URL that was called.
  const tools = (await buildSearchTools(stubTool, {
    config: { enabled: true, baseUrl: 'https://searx.corp.local/', timeoutMs: 1 },
    container: running,
  })) as unknown as StubTool[];

  const result = await tools[0].invoke({ query: 'x' });
  assert.match(result, /^Error: /);
  assert.match(result, /searx\.corp\.local/);
  assert.doesNotMatch(result, /127\.0\.0\.1/);
});

test('a missing argument is reported to the model, not thrown', async () => {
  const tools = (await buildSearchTools(stubTool, {
    config: { enabled: true },
    container: running,
  })) as unknown as StubTool[];

  assert.match(await tools[0].invoke({}), /`query` is required/);
  assert.match(await tools[1].invoke({}), /`url` is required/);
});

test('a refused URL comes back as this call’s result, not as a thrown turn', async () => {
  const tools = (await buildSearchTools(stubTool, {
    config: { enabled: true },
    container: running,
  })) as unknown as StubTool[];

  const result = await tools[1].invoke({ url: 'http://169.254.169.254/latest/meta-data' });
  assert.match(result, /^Error: /);
  assert.match(result, /internal network/);
});
