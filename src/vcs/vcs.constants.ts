/** How many entries one page of a listing asks for. */
export const PAGE_LIMIT = 1000;

/** Ceiling on paged reads, so a huge repository cannot spin forever. */
export const MAX_PAGES = 50;

/** Per-request budget: a silent host must fail the call, not hang it. */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Username git and the REST APIs are given when a credential carries none.
 *
 * GitHub accepts a personal access token as the password against any username,
 * and this is the one it documents; Bitbucket Server needs a real one, and
 * refuses the request itself when it is missing.
 */
export const DEFAULT_GIT_USERNAME = 'x-access-token';

/**
 * `Authorization: Basic` — works for Bitbucket Server HTTP access tokens, app
 * passwords, and GitHub PATs alike, which is why it is the one scheme used for
 * both git and REST.
 */
export function basicAuth(username: string, token: string): string {
  const user = username.trim() || DEFAULT_GIT_USERNAME;
  return `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;
}

/** Percent-encodes a repository path, keeping its separators readable. */
export function encodePath(path: string): string {
  return path
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}
