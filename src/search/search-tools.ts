import {
  SEARCH_MAX_RESULTS,
  type SearchConfig,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
} from '../contracts';
import { type loadDeps } from '../deep-agent';

import { fetchPage, formatPage } from './fetch-page';
import { formatResults, searchSearxng } from './searxng-client';
import { type SearxngContainer } from './searxng-container';

/** Where a run's search backend comes from. */
export interface SearchContext {
  /** The run request's search policy, or `undefined` when it carried none. */
  config: SearchConfig | undefined;
  /** The connector's own instance, used when the config names no `baseUrl`. */
  container: SearxngContainer;
}

const WEB_SEARCH_SCHEMA = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description:
        'What to search for. Write it the way a person would type it into a search box; prefer several narrow searches over one broad one.',
    },
    maxResults: {
      type: 'number',
      description: `How many results to return (default ${SEARCH_MAX_RESULTS}, max 25).`,
    },
    category: {
      type: 'string',
      description:
        'Restrict to one engine category, e.g. "general", "news", "it", "science". Omit for the default.',
    },
    timeRange: {
      type: 'string',
      enum: ['day', 'week', 'month', 'year'],
      description: 'Only results published within this period. Use it for anything time-sensitive.',
    },
  },
  required: ['query'],
} as const;

const WEB_FETCH_SCHEMA = {
  type: 'object',
  properties: {
    url: {
      type: 'string',
      description: 'Full http(s) URL of the page to read, usually one returned by web_search.',
    },
    maxChars: {
      type: 'number',
      description: 'Characters of the page to return; lower it when you only need the beginning.',
    },
  },
  required: ['url'],
} as const;

const WEB_SEARCH_DESCRIPTION = [
  'Search the internet and get a list of results (title, URL, snippet).',
  'Use it whenever the answer depends on anything you cannot know: current events, prices, releases, versions, library documentation, error messages.',
  'The snippets are not an answer — open the promising results with web_fetch before stating anything as fact.',
].join(' ');

const WEB_FETCH_DESCRIPTION = [
  'Open one web page and read its text.',
  'Use it on results returned by web_search, or on a URL the user gave you.',
  'Returns readable text only; scripts, styles and navigation are stripped, and a long page is truncated.',
].join(' ');

/**
 * Builds the connector's two web tools, or `[]` when this run has no search
 * backend — the config disabled it, or nothing is running to serve it.
 *
 * Returning nothing rather than a tool that always fails is deliberate: a tool
 * in the list is a promise to the model, and one that answers every call with
 * «search is not configured» costs a round-trip each time it believes the promise.
 *
 * The base URL is the config's own instance when it names one (an existing
 * corporate SearXNG reachable from the user's machine), otherwise the container
 * the connector manages itself. Nothing here ever runs in the cluster: the API
 * has no internet access, which is why search lives in the daemon at all.
 */
export async function buildSearchTools(
  tool: Awaited<ReturnType<typeof loadDeps>>['tool'],
  ctx: SearchContext,
  signal?: AbortSignal,
): Promise<unknown[]> {
  const config = ctx.config;
  if (!config || config.enabled === false) {
    return [];
  }

  const external = config.baseUrl?.trim().replace(/\/+$/, '');
  const baseUrl = external || (await ctx.container.resolveUrl());
  if (!baseUrl) {
    return [];
  }

  const search = tool(
    async (args: Record<string, unknown>): Promise<string> => {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) {
        return 'Error: `query` is required.';
      }
      try {
        const outcome = await searchSearxng(
          baseUrl,
          config,
          {
            query,
            ...(typeof args.maxResults === 'number' ? { maxResults: args.maxResults } : {}),
            ...(typeof args.category === 'string' ? { category: args.category } : {}),
            ...(isTimeRange(args.timeRange) ? { timeRange: args.timeRange } : {}),
          },
          signal,
        );
        return formatResults(outcome, query);
      } catch (error) {
        // Same contract as a bridged MCP tool: a failure is this call's result,
        // not the turn's, so the model can rephrase or work without it.
        return `Error: ${asMessage(error)}`;
      }
    },
    { name: WEB_SEARCH_TOOL, description: WEB_SEARCH_DESCRIPTION, schema: WEB_SEARCH_SCHEMA },
  );

  const read = tool(
    async (args: Record<string, unknown>): Promise<string> => {
      const url = typeof args.url === 'string' ? args.url.trim() : '';
      if (!url) {
        return 'Error: `url` is required.';
      }
      const limited =
        typeof args.maxChars === 'number' && args.maxChars > 0
          ? { ...config, fetch: { ...config.fetch, maxChars: args.maxChars } }
          : config;
      try {
        return formatPage(await fetchPage(url, limited, signal));
      } catch (error) {
        return `Error: ${asMessage(error)}`;
      }
    },
    { name: WEB_FETCH_TOOL, description: WEB_FETCH_DESCRIPTION, schema: WEB_FETCH_SCHEMA },
  );

  return [search, read];
}

function isTimeRange(value: unknown): value is 'day' | 'week' | 'month' | 'year' {
  return value === 'day' || value === 'week' || value === 'month' || value === 'year';
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
