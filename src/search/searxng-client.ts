import {
  SEARCH_MAX_RESULTS,
  SEARCH_TIMEOUT_MS,
  type SearchConfig,
  type WebSearchResult,
} from '../contracts';

/** The arguments one `web_search` call may narrow its query with. */
export interface SearchArgs {
  query: string;
  maxResults?: number;
  category?: string;
  timeRange?: 'day' | 'week' | 'month' | 'year';
}

/** A SearXNG JSON reply, as much of it as we read. */
interface SearxngResponse {
  results?: {
    url?: unknown;
    title?: unknown;
    content?: unknown;
    engine?: unknown;
    publishedDate?: unknown;
  }[];
  /** Direct answers (calculator, definitions) — worth putting above the list. */
  answers?: unknown[];
}

/** What a search returned: the rows, plus any direct answers the engine had. */
export interface SearchOutcome {
  results: WebSearchResult[];
  answers: string[];
}

/**
 * Builds the query URL for one search. Split out so a test can assert the
 * parameters without a server: which ones are sent is the whole contract with
 * the engine, and `format=json` in particular is what a misconfigured instance
 * rejects.
 */
export function searchUrl(baseUrl: string, config: SearchConfig, args: SearchArgs): string {
  const url = new URL('/search', ensureTrailingRoot(baseUrl));
  url.searchParams.set('q', args.query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('pageno', '1');
  const categories = args.category ? [args.category] : config.categories;
  if (categories && categories.length > 0) {
    url.searchParams.set('categories', categories.join(','));
  }
  if (config.language) {
    url.searchParams.set('language', config.language);
  }
  if (config.safeSearch !== undefined) {
    url.searchParams.set('safesearch', String(config.safeSearch));
  }
  if (args.timeRange) {
    url.searchParams.set('time_range', args.timeRange);
  }
  return url.toString();
}

/**
 * Reads a SearXNG JSON reply into the rows we show the model, capped at the
 * configured result count. Tolerant of missing fields: engines disagree about
 * what they fill in, and a row with a URL and a title is already useful.
 */
export function parseSearxng(payload: unknown, limit: number): SearchOutcome {
  const body = (payload ?? {}) as SearxngResponse;
  const results: WebSearchResult[] = [];
  for (const row of body.results ?? []) {
    const url = typeof row.url === 'string' ? row.url : '';
    if (!url) {
      continue;
    }
    results.push({
      title: typeof row.title === 'string' && row.title.trim() ? row.title.trim() : url,
      url,
      snippet: typeof row.content === 'string' ? row.content.trim() : '',
      ...(typeof row.engine === 'string' ? { engine: row.engine } : {}),
      ...(typeof row.publishedDate === 'string' && row.publishedDate
        ? { publishedAt: row.publishedDate }
        : {}),
    });
    if (results.length >= limit) {
      break;
    }
  }
  const answers = (body.answers ?? [])
    .map((answer) => (typeof answer === 'string' ? answer : readAnswer(answer)))
    .filter((answer): answer is string => Boolean(answer));
  return { results, answers };
}

/** Newer SearXNG builds wrap an answer in `{ answer, url }` instead of a string. */
function readAnswer(value: unknown): string | null {
  if (value && typeof value === 'object') {
    const answer = (value as { answer?: unknown }).answer;
    if (typeof answer === 'string' && answer.trim()) {
      return answer.trim();
    }
  }
  return null;
}

/**
 * Turns a failed search into a sentence the user can act on.
 *
 * The two that matter are not network failures: a stock SearXNG serves HTML
 * only and answers `format=json` with a 403, and its bot limiter answers a
 * non-browser client with a 429. Both leave an instance that looks perfectly
 * healthy in a browser tab while every tool call fails, so they are named
 * outright rather than reported as «the search returned 403».
 */
export function describeSearchFailure(status: number, baseUrl: string): string {
  if (status === 403) {
    return `SearXNG at ${baseUrl} does not serve JSON. Add to its settings.yml: search.formats: [json].`;
  }
  if (status === 429) {
    return `SearXNG at ${baseUrl} rate-limited the request (limiter). Turn off server.limiter in its settings.yml.`;
  }
  return `SearXNG at ${baseUrl} answered ${status}.`;
}

/**
 * Runs one search against a SearXNG instance. `signal` is the turn's abort
 * signal, combined with the request budget — Stop has to reach the HTTP
 * request, not just the response the user was reading.
 */
export async function searchSearxng(
  baseUrl: string,
  config: SearchConfig,
  args: SearchArgs,
  signal?: AbortSignal,
): Promise<SearchOutcome> {
  const timeout = config.timeoutMs ?? SEARCH_TIMEOUT_MS;
  const limit = Math.max(
    1,
    Math.min(args.maxResults ?? config.maxResults ?? SEARCH_MAX_RESULTS, 25),
  );

  let response: Response;
  try {
    response = await fetch(searchUrl(baseUrl, config, args), {
      headers: { Accept: 'application/json' },
      signal: withTimeout(timeout, signal),
    });
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    throw new Error(`SearXNG is unreachable at ${baseUrl}: ${asMessage(error)}`);
  }

  if (!response.ok) {
    throw new Error(describeSearchFailure(response.status, baseUrl));
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(
      `SearXNG at ${baseUrl} answered with something other than JSON — check search.formats in its settings.yml.`,
    );
  }
  return parseSearxng(payload, limit);
}

/** Formats a search outcome as the text the model reads. */
export function formatResults(outcome: SearchOutcome, query: string): string {
  if (outcome.results.length === 0 && outcome.answers.length === 0) {
    return `Nothing was found for «${query}». Try different wording or other keywords.`;
  }
  const lines: string[] = [];
  for (const answer of outcome.answers) {
    lines.push(`The engine's direct answer: ${answer}`, '');
  }
  outcome.results.forEach((result, index) => {
    const dated = result.publishedAt ? ` (${result.publishedAt.slice(0, 10)})` : '';
    lines.push(`${index + 1}. ${result.title}${dated}`, `   ${result.url}`);
    if (result.snippet) {
      lines.push(`   ${result.snippet}`);
    }
  });
  lines.push(
    '',
    'These are snippets only. Before asserting anything of substance, open the relevant links with web_fetch.',
  );
  return lines.join('\n');
}

/** The engine's own root, tolerating a base URL written with or without a slash. */
function ensureTrailingRoot(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}

/**
 * The turn's abort signal plus this request's own ceiling. Without the ceiling a
 * silent instance holds the tool call — and the turn — open indefinitely.
 */
export function withTimeout(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const budget = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, budget]) : budget;
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
