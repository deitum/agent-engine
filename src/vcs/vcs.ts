import { isSafeRepoSegment } from '../code/git-parse';
import { ConnectorError } from '../connector';
import {
  GITHUB_WEB_URL,
  type RepoCredentials,
  type RepoProvider,
  type RepoRef,
  repoProvider,
} from '../contracts';

import { BitbucketServerClient, checkBitbucketCredentials } from './bitbucket-server';
import { GithubClient, checkGithubCredentials } from './github';
import { type RepoClient } from './repo-client';
import { basicAuth } from './vcs.constants';

/**
 * Picking a repository host, and the two git-level operations that are not the
 * host's REST API: building a clone URL and authenticating a `git` invocation.
 *
 * Those two live here rather than on {@link RepoClient} because the coding
 * sandbox needs them before it has credentials for a client — it clones first
 * and reads the repository through git afterwards, never through REST.
 */

/** The client for one repository, built from the credentials for its provider. */
export function createRepoClient(ref: RepoRef, credentials: RepoCredentials): RepoClient {
  return repoProvider(ref) === 'github'
    ? new GithubClient(ref, credentials)
    : new BitbucketServerClient(ref, credentials);
}

/** Verifies a credential against a host, without naming a repository. */
export async function checkRepoCredentials(
  provider: RepoProvider,
  baseUrl: string | undefined,
  credentials: RepoCredentials,
): Promise<void> {
  if (provider === 'github') {
    await checkGithubCredentials(baseUrl, credentials);
    return;
  }
  await checkBitbucketCredentials(baseUrl ?? '', credentials);
}

/**
 * A credential-free clone URL.
 *
 * Credential-free on purpose: the token travels per invocation in
 * {@link gitAuthArgs} instead, so it never lands in the checkout's
 * `.git/config` — where it would outlive the session and be readable by
 * anything that can read the workspace.
 */
export function cloneUrl(ref: RepoRef): string {
  const owner = ref.owner.trim();
  if (!isSafeRepoSegment(owner) || !isSafeRepoSegment(ref.repo)) {
    throw new ConnectorError(400, 'Invalid owner or repository name.');
  }

  const provider = repoProvider(ref);
  const root = (ref.baseUrl ?? (provider === 'github' ? GITHUB_WEB_URL : '')).trim();

  let base: URL;
  try {
    base = new URL(root);
  } catch {
    throw new ConnectorError(400, `Invalid repository address: «${ref.baseUrl ?? ''}».`);
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new ConnectorError(400, 'The repository address must use http or https.');
  }

  const path = base.pathname.replace(/\/+$/, '');
  return provider === 'github'
    ? `${base.protocol}//${base.host}${path}/${owner}/${ref.repo}.git`
    : `${base.protocol}//${base.host}${path}/scm/${owner}/${ref.repo}.git`;
}

/**
 * Reads a clone URL built by {@link cloneUrl} back into its coordinates.
 *
 * Used to rebuild a workspace whose `workspace.json` was lost or corrupted: the
 * checkout's own `origin` remote still knows where it came from, so the session
 * can be recovered instead of being declared missing. Returns `null` for a URL
 * that matches neither shape.
 */
export function parseCloneUrl(url: string): RepoRef | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  // Bitbucket Server is the unambiguous one — `/scm/` appears in no GitHub URL.
  const bitbucket = /^(.*)\/scm\/([^/]+)\/(.+?)(?:\.git)?$/.exec(parsed.pathname);
  if (bitbucket) {
    const [, prefix, owner, repo] = bitbucket;
    return {
      provider: 'bitbucket-server',
      baseUrl: `${parsed.protocol}//${parsed.host}${prefix}`,
      owner: decodeURIComponent(owner),
      repo: decodeURIComponent(repo),
    };
  }

  const github = /^\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(parsed.pathname);
  if (github && parsed.host === 'github.com') {
    const [, owner, repo] = github;
    return {
      provider: 'github',
      baseUrl: GITHUB_WEB_URL,
      owner: decodeURIComponent(owner),
      repo: decodeURIComponent(repo),
    };
  }

  return null;
}

/**
 * Per-invocation git credentials: an `Authorization: Basic` header passed with
 * `-c`, which (unlike embedding `user:token@` in the remote URL) never lands in
 * the checkout's `.git/config`.
 *
 * Basic covers every case: Bitbucket Server HTTP access tokens and app
 * passwords take it directly, and GitHub accepts a PAT as the password against
 * the conventional `x-access-token` user.
 */
export function gitAuthArgs(credentials: RepoCredentials | undefined): string[] {
  if (!credentials?.token) {
    return [];
  }
  return [
    '-c',
    `http.extraHeader=Authorization: ${basicAuth(credentials.username ?? '', credentials.token)}`,
  ];
}

export { type RepoClient } from './repo-client';
