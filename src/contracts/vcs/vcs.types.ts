/**
 * Repository access — the coordinates and credentials the engine spends on git
 * hosts.
 *
 * Two features need them: the coding sandbox's clone / push / pull-request, and
 * the skills catalogue's repository import. Both run on the **user's own
 * machine**, which is what makes an on-prem host reachable at all — the daemon
 * is already inside that network, already holds the credentials for the length
 * of a request, and is not subject to CORS. Nothing here is persisted.
 */

/**
 * Which flavour of host a repository lives on. The two differ in every detail
 * that matters here — clone URL, REST shape, how a duplicate pull request is
 * reported — so the provider is carried explicitly rather than sniffed.
 */
export type RepoProvider = 'bitbucket-server' | 'github';

/** The provider assumed when a reference or credential does not name one. */
export const DEFAULT_REPO_PROVIDER: RepoProvider = 'bitbucket-server';

/** Where the public GitHub's API lives, when a reference names no host. */
export const GITHUB_API_URL = 'https://api.github.com';

/** Where the public GitHub's repositories live, for clone URLs and web links. */
export const GITHUB_WEB_URL = 'https://github.com';

/**
 * One credential the user has configured, for one provider.
 *
 * `username` is optional because only Bitbucket Server needs it: GitHub accepts
 * a personal access token as the password against any username, and the engine
 * fills in the conventional `x-access-token` when none is given.
 */
export interface RepoCredentials {
  /** Omitted = {@link DEFAULT_REPO_PROVIDER}. */
  provider?: RepoProvider;
  username?: string;
  /** HTTP access token, app password or PAT. */
  token: string;
  /**
   * Host these credentials belong to. Omitted = every host of that provider,
   * which is the normal case: a user has one Bitbucket and one GitHub account.
   */
  baseUrl?: string;
}

/** Coordinates of a repository, plus what part of it a caller cares about. */
export interface RepoRef {
  /** Omitted = {@link DEFAULT_REPO_PROVIDER}. */
  provider?: RepoProvider;
  /**
   * Host root, e.g. `https://git.example.net`. Omitted is only meaningful for
   * GitHub, where it defaults to the public instance.
   */
  baseUrl?: string;
  /** Project key on Bitbucket Server, owner or organisation on GitHub. */
  owner: string;
  /** Repository slug. */
  repo: string;
  /** Branch or tag; omitted = the repository's default branch. */
  ref?: string;
  /** Sub-directory to look at; omitted = the whole repository. */
  path?: string;
}

/**
 * `POST /repos/check` — verifies that a credential is accepted by the host it
 * names. Nothing is stored: the answer is the whole point of the call.
 */
export interface RepoCheckRequest {
  provider?: RepoProvider;
  baseUrl?: string;
  credentials: RepoCredentials;
}

export interface RepoCheckResponse {
  /** Always `true` — a rejected credential is an error status, not a `false`. */
  ok: true;
}

/**
 * Where an imported package came from, and the state of the repository it was
 * taken at. Recorded on the copy — in the browser store, in the `SKILL.md`
 * frontmatter of a skill written to disk, in the `plugin.json` extension object
 * of a plugin — so that a copy can be measured against its origin later
 * («differs from the repository») and updated from it.
 *
 * `commit` is what makes the comparison honest: the diff is against the exact
 * tree the copy was taken from, not against whatever the branch has drifted to
 * since, until the user asks for a fresh listing.
 */
export interface PackageSource {
  /**
   * Which host this came from.
   *
   * `'bitbucket'` rather than `'bitbucket-server'` because this value is written
   * into stored packages and into files on disk — changing the spelling would
   * orphan every copy already taken. New providers are added alongside it.
   */
  kind: 'bitbucket' | 'github';
  baseUrl: string;
  /** Project key on Bitbucket Server, owner or organisation on GitHub. */
  project: string;
  repo: string;
  /** Package directory inside the repository, e.g. `skills/tdd`. */
  path: string;
  /** Branch or tag the copy was taken from. */
  ref: string;
  /** Commit id that branch pointed at. */
  commit: string;
  fetchedAt: string;
}

/** The provider a reference or credential names, or the default. */
export function repoProvider(of: { provider?: RepoProvider }): RepoProvider {
  return of.provider ?? DEFAULT_REPO_PROVIDER;
}
