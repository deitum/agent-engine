import { type RepoProvider } from '../contracts';

/**
 * What the engine needs from a git host, and nothing more.
 *
 * The two implementations behind it — Bitbucket Server and GitHub — agree on
 * none of the details: the clone URL is built differently, the REST payloads
 * name different fields, and a duplicate pull request is a 409 on one and a 422
 * on the other. So the interface is drawn where the *callers* stop caring: the
 * skills importer wants a tree and some files pinned to one commit, and the
 * coding sandbox wants a pull request. Neither wants to know whose REST API
 * answered.
 *
 * Built per request from the credentials the client handed over at configuration
 * time, and thrown away with it. Nothing here is persisted.
 */
export interface RepoClient {
  readonly provider: RepoProvider;

  /** The repository's default branch (`master`, `main`, …). */
  defaultBranch(): Promise<string>;

  /**
   * The commit a ref points at. Every later read is pinned to it, so a listing
   * and the files fetched from it describe one tree even if someone pushes while
   * the user is choosing what to import.
   */
  resolveCommit(ref: string): Promise<string>;

  /** Every file path under `path`, recursively and relative to it. */
  listFiles(path: string, at: string): Promise<string[]>;

  /**
   * Raw bytes of one file at a revision. A buffer rather than text because the
   * caller has to decide what to do with a picture, and that decision needs the
   * bytes.
   */
  readFile(path: string, at: string): Promise<Buffer>;

  /**
   * Opens a pull request and returns its web URL.
   *
   * `existed: true` when one was already open for this branch — which is the
   * normal outcome of a second `/pr` on the same branch, and what the command is
   * *for* once work continues. Both hosts report that case with a status of
   * their own, and both are turned into this instead of an error.
   */
  openPullRequest(
    branch: string,
    baseBranch: string,
    title: string,
  ): Promise<{ url: string; existed: boolean }>;
}
