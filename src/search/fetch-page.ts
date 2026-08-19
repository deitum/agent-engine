import { SEARCH_TIMEOUT_MS, type SearchConfig, WEB_FETCH_MAX_CHARS } from '../contracts';

import { htmlTitle, htmlToText } from './html-text';
import { FETCH_MAX_BYTES, FETCH_TEXT_TYPES, FETCH_USER_AGENT } from './search.constants';
import { withTimeout } from './searxng-client';

/** One page, as far as it was read. */
export interface FetchedPage {
  url: string;
  title: string | null;
  text: string;
  /** True when the page was longer than the character budget. */
  truncated: boolean;
}

/**
 * Hostnames `web_fetch` refuses unless the deployment opts in.
 *
 * The URL comes from the model, and the connector runs inside the user's own
 * network — so an unguarded fetch turns the agent into a probe of their router,
 * their cloud metadata endpoint and every internal service they can reach. A
 * corporate deployment whose agent should read the internal wiki flips
 * `fetch.allowPrivateNetwork` and takes that trade knowingly.
 */
const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\./,
  /^\[?::1\]?$/,
  // Unique-local and link-local IPv6.
  /^\[?f[cd][0-9a-f]{2}:/i,
  /^\[?fe80:/i,
];

/** True for a host the model must not reach without an explicit opt-in. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|]$/g, '');
  return PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(host));
}

/**
 * Validates a URL the model asked to open, returning the reason it was refused
 * or `null` when it is allowed. Separate from the fetch so the rule is testable
 * and so both the pre-flight check and the post-redirect re-check share it.
 */
export function checkUrl(raw: string, config: SearchConfig): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `«${raw}» does not look like a URL. Pass a full address, including http:// or https://.`;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `The ${url.protocol} scheme is not supported — only http and https.`;
  }
  if (!config.fetch?.allowPrivateNetwork && isPrivateHost(url.hostname)) {
    return `${url.hostname} is on an internal network; the configuration forbids opening such pages.`;
  }
  return null;
}

/** True when a `Content-Type` names something we can turn into text. */
export function isTextualType(contentType: string): boolean {
  const type = contentType.split(';')[0].trim().toLowerCase();
  return FETCH_TEXT_TYPES.includes(type) || type.endsWith('+json') || type.endsWith('+xml');
}

/**
 * Reads at most {@link FETCH_MAX_BYTES} of a response body.
 *
 * A `Content-Length` is advisory and often absent, so the ceiling is enforced
 * while streaming: without it one large download would sit in the daemon's
 * memory before being thrown away for exceeding the character budget anyway.
 */
async function readCapped(response: Response): Promise<string> {
  const body = response.body;
  if (!body) {
    return '';
  }
  const decoder = new TextDecoder('utf-8');
  const reader = body.getReader();
  let text = '';
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (bytes >= FETCH_MAX_BYTES) {
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text + decoder.decode();
}

/**
 * Opens one page and returns its readable text. Throws with a sentence the
 * model can act on — the caller turns that into the tool's `Error: …` result
 * rather than failing the turn.
 */
export async function fetchPage(
  raw: string,
  config: SearchConfig,
  signal?: AbortSignal,
): Promise<FetchedPage> {
  const refusal = checkUrl(raw, config);
  if (refusal) {
    throw new Error(refusal);
  }

  let response: Response;
  try {
    response = await fetch(raw, {
      headers: {
        'User-Agent': FETCH_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        'Accept-Language': config.language ?? 'ru,en;q=0.8',
      },
      redirect: 'follow',
      signal: withTimeout(config.timeoutMs ?? SEARCH_TIMEOUT_MS, signal),
    });
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    throw new Error(`Could not open ${raw}: ${asMessage(error)}`, { cause: error });
  }

  // `fetch` follows redirects itself, so the guard is applied again to where we
  // actually landed — a public shortener can point anywhere.
  const landed = checkUrl(response.url || raw, config);
  if (landed) {
    throw new Error(`A redirect landed on a forbidden address. ${landed}`);
  }

  if (!response.ok) {
    throw new Error(`${raw} answered ${response.status}.`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType && !isTextualType(contentType)) {
    throw new Error(
      `${raw} serves «${contentType.split(';')[0].trim()}» — that is not a text page and cannot be read.`,
    );
  }

  const raws = await readCapped(response);
  const isHtml = contentType.includes('html') || /^\s*<(!doctype|html)\b/i.test(raws);
  const text = isHtml ? htmlToText(raws) : raws.trim();
  const limit = config.fetch?.maxChars ?? WEB_FETCH_MAX_CHARS;

  return {
    url: response.url || raw,
    title: isHtml ? htmlTitle(raws) : null,
    text: text.slice(0, limit),
    truncated: text.length > limit,
  };
}

/** Formats a fetched page as the text the model reads. */
export function formatPage(page: FetchedPage): string {
  if (!page.text) {
    return `${page.url} opened, but holds no readable text (its content may be drawn by scripts).`;
  }
  const header = [page.title ? `# ${page.title}` : '', `Source: ${page.url}`, '']
    .filter((line) => line !== '')
    .join('\n');
  const tail = page.truncated
    ? '\n\n[Only the start of the page is shown — the rest was cut. If what you need is missing, look for it in another source.]'
    : '';
  return `${header}\n\n${page.text}${tail}`;
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
