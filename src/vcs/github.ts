import { isSafeBranchName, isSafeRepoSegment } from '../code/git-parse';
import { ConnectorError } from '../connector';
import { GITHUB_API_URL, type RepoCredentials, type RepoRef } from '../contracts';

import { type RepoClient } from './repo-client';
import { REQUEST_TIMEOUT_MS, encodePath } from './vcs.constants';

/**
 * GitHub — the public instance and Enterprise Server alike, reached over the
 * REST v3 API.
 *
 * Two differences from Bitbucket Server shape everything here. The tree is read
 * in **one** request (`git/trees?recursive=1`) rather than page by page, which
 * is cheaper but comes with a server-side cap that GitHub reports as
 * `truncated` — a flag that must not be ignored, because a truncated tree looks
 * exactly like a small repository. And a duplicate pull request is a 422 whose
 * body does *not* carry the existing one, so finding it costs a second request.
 */

/** API root for a reference: `api.github.com`, or `<host>/api/v3` for Enterprise. */
function apiRoot(baseUrl: string | undefined): string {
  const trimmed = (baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) {
    return GITHUB_API_URL;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ConnectorError(400, `Invalid GitHub address: «${baseUrl}».`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConnectorError(400, 'The GitHub address must use http or https.');
  }
  // A host that is already an API root is taken as one; anything else is an
  // Enterprise Server web root, whose API lives under `/api/v3`.
  if (parsed.host === 'api.github.com' || parsed.pathname.replace(/\/+$/, '').endsWith('/api/v3')) {
    return trimmed;
  }
  return parsed.host === 'github.com' ? GITHUB_API_URL : `${trimmed}/api/v3`;
}

/** Turns a transport or status failure into a message the user can act on. */
function describeFailure(status: number, url: string): ConnectorError {
  if (status === 401) {
    return new ConnectorError(401, 'GitHub rejected the credentials — check the token.');
  }
  if (status === 403) {
    // GitHub answers 403 both for "no access" and for a spent rate limit; the
    // token is the thing the user can act on either way.
    return new ConnectorError(
      403,
      'No access to this repository in GitHub (or the rate limit is spent).',
    );
  }
  if (status === 404) {
    // A private repository reads as 404 to an unauthorised token, so the message
    // has to name both possibilities rather than insist it does not exist.
    return new ConnectorError(
      404,
      `GitHub could not find ${url} (it may be private to this token).`,
    );
  }
  return new ConnectorError(502, `GitHub answered ${status}`);
}

export class GithubClient implements RepoClient {
  readonly provider = 'github' as const;

  private readonly api: string;
  private readonly owner: string;
  private readonly repo: string;
  private readonly token: string;

  constructor(ref: RepoRef, credentials: RepoCredentials) {
    const owner = ref.owner.trim();
    if (!isSafeRepoSegment(owner) || !isSafeRepoSegment(ref.repo)) {
      throw new ConnectorError(400, 'Invalid owner or repository name.');
    }
    if (!credentials.token.trim()) {
      throw new ConnectorError(400, 'No GitHub token is set — fill it in the settings.');
    }
    this.api = apiRoot(ref.baseUrl);
    this.owner = owner;
    this.repo = ref.repo;
    this.token = credentials.token;
  }

  /** `<api>/repos/<owner>/<repo><suffix>`. */
  private restUrl(suffix: string): string {
    return `${this.api}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(
      this.repo,
    )}${suffix}`;
  }

  private headers(accept = 'application/vnd.github+json'): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  private async request(url: string, accept?: string): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: this.headers(accept),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ConnectorError(502, `GitHub is not responding: ${this.api}`);
    }
    if (!response.ok) {
      throw describeFailure(response.status, url);
    }
    return response;
  }

  private async json<T>(url: string): Promise<T> {
    const response = await this.request(url);
    try {
      return (await response.json()) as T;
    } catch {
      throw new ConnectorError(502, 'GitHub returned an unexpected (non-JSON) response.');
    }
  }

  async defaultBranch(): Promise<string> {
    const repo = await this.json<{ default_branch?: string }>(this.restUrl(''));
    const name = repo.default_branch?.trim();
    if (!name) {
      throw new ConnectorError(502, 'GitHub did not report a default branch.');
    }
    return name;
  }

  async resolveCommit(ref: string): Promise<string> {
    if (!isSafeBranchName(ref)) {
      throw new ConnectorError(400, `Invalid branch name: «${ref}».`);
    }
    const commits = await this.json<{ sha?: string }[]>(
      this.restUrl(`/commits?per_page=1&sha=${encodeURIComponent(ref)}`),
    );
    const sha = commits[0]?.sha?.trim();
    if (!sha) {
      throw new ConnectorError(404, `GitHub has no branch «${ref}».`);
    }
    return sha;
  }

  /**
   * The whole tree in one request, filtered to `path`. GitHub returns every blob
   * in the repository, so the filtering happens here rather than upstream —
   * which is also why `truncated` matters: past its cap the answer is a partial
   * tree, and reporting it as complete would silently drop packages.
   */
  async listFiles(path: string, at: string): Promise<string[]> {
    const tree = await this.json<{
      tree?: { path?: string; type?: string }[];
      truncated?: boolean;
    }>(this.restUrl(`/git/trees/${encodeURIComponent(at)}?recursive=1`));

    if (tree.truncated) {
      throw new ConnectorError(
        422,
        'This repository has too many files for one listing — point at a sub-directory holding the skills.',
      );
    }

    const root = path.replace(/^\/+|\/+$/g, '');
    const prefix = root ? `${root}/` : '';
    return (tree.tree ?? [])
      .filter((entry) => entry.type === 'blob' && typeof entry.path === 'string')
      .map((entry) => entry.path as string)
      .filter((entry) => (prefix ? entry.startsWith(prefix) : true))
      .map((entry) => (prefix ? entry.slice(prefix.length) : entry));
  }

  async readFile(path: string, at: string): Promise<Buffer> {
    const url = this.restUrl(`/contents/${encodePath(path)}?ref=${encodeURIComponent(at)}`);
    // `raw` gets the bytes themselves rather than a base64 envelope with a size
    // cap of its own.
    const response = await this.request(url, 'application/vnd.github.raw');
    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * `POST …/pulls`. A duplicate is a 422 that names no pull request, so the open
   * one is looked up by head branch — the extra request is the price of GitHub
   * not reporting it the way Bitbucket does.
   */
  async openPullRequest(
    branch: string,
    baseBranch: string,
    title: string,
  ): Promise<{ url: string; existed: boolean }> {
    const response = await fetch(this.restUrl('/pulls'), {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, head: branch, base: baseBranch }),
    });

    if (response.ok) {
      const body = (await response.json()) as { html_url?: string };
      return { url: body.html_url ?? '', existed: false };
    }

    if (response.status === 422) {
      const existing = await this.findOpenPullRequest(branch);
      if (existing) {
        return { url: existing, existed: true };
      }
    }

    const detail = await response.text().catch(() => '');
    throw new ConnectorError(
      response.status === 401 || response.status === 403 ? 401 : 500,
      `Could not open a pull request (${response.status}): ${detail.slice(0, 500)}`,
    );
  }

  /** The web URL of the open pull request whose head is `branch`, if any. */
  private async findOpenPullRequest(branch: string): Promise<string | null> {
    try {
      const open = await this.json<{ html_url?: string }[]>(
        this.restUrl(`/pulls?state=open&head=${encodeURIComponent(`${this.owner}:${branch}`)}`),
      );
      return open[0]?.html_url ?? null;
    } catch {
      // The 422 is the failure worth reporting; losing its cause to a follow-up
      // request that also failed would help nobody.
      return null;
    }
  }
}

/** Verifies a credential against a host, without naming a repository. */
export async function checkGithubCredentials(
  baseUrl: string | undefined,
  credentials: RepoCredentials,
): Promise<void> {
  const api = apiRoot(baseUrl);
  const url = `${api}/user`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${credentials.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ConnectorError(502, `GitHub is not responding: ${api}`);
  }
  if (!response.ok) {
    throw describeFailure(response.status, url);
  }
}
