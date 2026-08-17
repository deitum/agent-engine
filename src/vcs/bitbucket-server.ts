import { isSafeBranchName, isSafeRepoSegment } from '../code/git-parse';
import { ConnectorError } from '../connector';
import { type RepoCredentials, type RepoRef } from '../contracts';

import { type RepoClient } from './repo-client';
import { MAX_PAGES, PAGE_LIMIT, REQUEST_TIMEOUT_MS, basicAuth, encodePath } from './vcs.constants';

/**
 * Bitbucket **Server / Data Center** — the on-prem flavour, reached over its
 * `rest/api/1.0` API.
 *
 * Everything here is what that API asks for and nothing else: paged listings,
 * `at=<commit>` on every read, and `DuplicatePullRequestException` carrying the
 * pull request that already exists.
 */

/** One page of a Bitbucket paged REST response. */
interface Page<T> {
  values?: T[];
  isLastPage?: boolean;
  nextPageStart?: number | null;
}

/** The `self` link of a Bitbucket entity, as its REST payloads spell it. */
function selfLink(entity: { links?: { self?: { href?: string }[] } } | undefined): string {
  return entity?.links?.self?.[0]?.href ?? '';
}

/** Normalises the base URL and refuses anything that is not http(s). */
export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = (baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) {
    throw new ConnectorError(400, 'No Bitbucket address was given.');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ConnectorError(400, `Invalid Bitbucket address: «${baseUrl}».`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConnectorError(400, 'The Bitbucket address must use http or https.');
  }
  return trimmed;
}

/** Turns a transport or status failure into a message the user can act on. */
function describeFailure(status: number, url: string): ConnectorError {
  if (status === 401) {
    return new ConnectorError(
      401,
      'Bitbucket rejected the credentials — check the username and token.',
    );
  }
  if (status === 403) {
    return new ConnectorError(403, 'No access to this repository in Bitbucket.');
  }
  if (status === 404) {
    return new ConnectorError(404, `Bitbucket could not find ${url}`);
  }
  return new ConnectorError(502, `Bitbucket answered ${status}`);
}

/** Verifies a credential against a host, without naming a repository. */
export async function checkBitbucketCredentials(
  baseUrl: string,
  credentials: RepoCredentials,
): Promise<void> {
  const base = normalizeBaseUrl(baseUrl);
  // The cheapest authenticated endpoint Bitbucket Server has — it needs no
  // repository, so a wrong token is told apart from a wrong repository.
  const url = `${base}/rest/api/1.0/inbox/pull-requests/count`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Authorization: basicAuth(credentials.username ?? '', credentials.token),
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ConnectorError(502, `Bitbucket is not responding: ${base}`);
  }
  if (!response.ok) {
    throw describeFailure(response.status, url);
  }
}

export class BitbucketServerClient implements RepoClient {
  readonly provider = 'bitbucket-server' as const;

  private readonly baseUrl: string;
  private readonly owner: string;
  private readonly repo: string;
  private readonly authorization: string;

  constructor(ref: RepoRef, credentials: RepoCredentials) {
    const owner = ref.owner.trim();
    if (!isSafeRepoSegment(owner) || !isSafeRepoSegment(ref.repo)) {
      throw new ConnectorError(400, 'Invalid project key or repository name.');
    }
    if (!credentials.token.trim()) {
      throw new ConnectorError(400, 'No Bitbucket token is set — fill it in the settings.');
    }
    this.baseUrl = normalizeBaseUrl(ref.baseUrl ?? '');
    this.owner = owner;
    this.repo = ref.repo;
    this.authorization = basicAuth(credentials.username ?? '', credentials.token);
  }

  /** `<base>/rest/api/1.0/projects/<key>/repos/<slug><suffix>`. */
  private restUrl(suffix: string): string {
    return `${this.baseUrl}/rest/api/1.0/projects/${encodeURIComponent(
      this.owner,
    )}/repos/${encodeURIComponent(this.repo)}${suffix}`;
  }

  private async request(url: string): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: this.authorization, Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ConnectorError(502, `Bitbucket is not responding: ${this.baseUrl}`);
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
      throw new ConnectorError(502, 'Bitbucket returned an unexpected (non-JSON) response.');
    }
  }

  async defaultBranch(): Promise<string> {
    const branch = await this.json<{ displayId?: string }>(this.restUrl('/branches/default'));
    const name = branch.displayId?.trim();
    if (!name) {
      throw new ConnectorError(502, 'Bitbucket did not report a default branch.');
    }
    return name;
  }

  async resolveCommit(ref: string): Promise<string> {
    if (!isSafeBranchName(ref)) {
      throw new ConnectorError(400, `Invalid branch name: «${ref}».`);
    }
    const page = await this.json<Page<{ id?: string }>>(
      this.restUrl(`/commits?limit=1&until=${encodeURIComponent(ref)}`),
    );
    const id = page.values?.[0]?.id?.trim();
    if (!id) {
      throw new ConnectorError(404, `Bitbucket has no branch «${ref}».`);
    }
    return id;
  }

  async listFiles(path: string, at: string): Promise<string[]> {
    const suffix = path ? `/files/${encodePath(path)}` : '/files';
    const paths: string[] = [];
    let start = 0;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body = await this.json<Page<string>>(
        this.restUrl(`${suffix}?at=${encodeURIComponent(at)}&limit=${PAGE_LIMIT}&start=${start}`),
      );
      paths.push(...(body.values ?? []));
      if (body.isLastPage !== false || typeof body.nextPageStart !== 'number') {
        return paths;
      }
      start = body.nextPageStart;
    }

    throw new ConnectorError(
      422,
      'This repository has too many files — point at a sub-directory holding the skills.',
    );
  }

  async readFile(path: string, at: string): Promise<Buffer> {
    const url = this.restUrl(`/raw/${encodePath(path)}?at=${encodeURIComponent(at)}`);
    const response = await this.request(url);
    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * `POST …/pull-requests`, authenticated with the access token as a bearer.
   *
   * A 409 still yields a URL: `DuplicatePullRequestException` carries the
   * offending `existingPullRequest` in its body, so a second `/pr` on the same
   * branch reports the open one rather than nothing at all, and without a second
   * request.
   */
  async openPullRequest(
    branch: string,
    baseBranch: string,
    title: string,
  ): Promise<{ url: string; existed: boolean }> {
    const response = await fetch(this.restUrl('/pull-requests'), {
      method: 'POST',
      headers: {
        Authorization: this.authorization,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        title,
        fromRef: { id: `refs/heads/${branch}` },
        toRef: { id: `refs/heads/${baseBranch}` },
      }),
    });

    if (response.status === 409) {
      const body = (await response.json().catch(() => null)) as {
        errors?: { existingPullRequest?: { links?: { self?: { href?: string }[] } } }[];
      } | null;
      return { url: selfLink(body?.errors?.[0]?.existingPullRequest), existed: true };
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new ConnectorError(
        response.status === 401 || response.status === 403 ? 401 : 500,
        `Could not open a pull request (${response.status}): ${detail.slice(0, 500)}`,
      );
    }

    const body = (await response.json()) as { links?: { self?: { href?: string }[] } };
    return { url: selfLink(body), existed: false };
  }
}
