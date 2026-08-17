import { resolveRepoCredentials } from './config/engine-config';
import { GITHUB_WEB_URL, type PackageSource, type RepoRef, repoProvider } from './contracts';
import { type RepoClient } from './vcs/repo-client';
import { createRepoClient } from './vcs/vcs';

/**
 * The half of a repository import that does not care what a package *is* —
 * shared by `skill-repo.ts` and `plugin-repo.ts`.
 *
 * Both walk one repository at one commit, read a manifest per candidate
 * directory, and pull whole packages out as text. What differs is only the file
 * that opens a package (`SKILL.md` versus `plugin.json`) and what is built from
 * it, so everything up to that point lives here.
 */

/** Bytes per file. Well past any instruction file, well short of an asset dump. */
export const MAX_FILE_BYTES = 1024 * 1024;

/** Files per skill package. A skill is reference material, not a source tree. */
export const MAX_PACKAGE_FILES = 200;

/**
 * Files per plugin package. Higher than a skill's, because a plugin is a bundle
 * of them: six skills with their references, plus commands and sub-agents.
 */
export const MAX_PLUGIN_FILES = 1000;

/** Packages read in parallel while listing — polite to an on-prem Bitbucket. */
export const READ_CONCURRENCY = 5;

/** Joins path segments the way a repository spells them, skipping empties. */
export function joinPath(...segments: string[]): string {
  return segments.filter((segment) => segment !== '').join('/');
}

/** Directory part of a repository path, `''` when the file sits at the root. */
export function dirOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

/** Last segment of a path — the package id when the path is a package dir. */
export function baseOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}

/** Paths under `dir`, made relative to it. `dir === ''` is the whole listing. */
export function under(paths: string[], dir: string): string[] {
  return dir === ''
    ? paths
    : paths.filter((path) => path.startsWith(`${dir}/`)).map((path) => path.slice(dir.length + 1));
}

/** Runs `worker` over `items` with a small ceiling on parallelism. */
export async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const runner = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

/**
 * Decodes a downloaded file, or reports why it cannot travel as package
 * content. Contents are handed to a model as text, so bytes that are not text
 * have nothing to contribute — but the user is told rather than left to wonder
 * why the package is thinner than the one in the repository.
 */
export function decodeFile(
  buffer: Buffer,
): { content: string } | { reason: 'binary' | 'too-large' } {
  if (buffer.byteLength > MAX_FILE_BYTES) {
    return { reason: 'too-large' };
  }
  if (buffer.includes(0)) {
    return { reason: 'binary' };
  }
  const content = buffer.toString('utf8');
  // A lossy decode means the bytes were not UTF-8 to begin with.
  return Buffer.compare(Buffer.from(content, 'utf8'), buffer) === 0
    ? { content }
    : { reason: 'binary' };
}

/**
 * The client for a request's repository, built from the credentials adopted for
 * that repository's provider.
 */
export function repoClientFor(repo: RepoRef): RepoClient {
  return createRepoClient(repo, resolveRepoCredentials(repoProvider(repo), repo.baseUrl));
}

/** Resolves the branch and the commit every read of one request is pinned to. */
export async function resolveRevision(
  client: RepoClient,
  ref: string | undefined,
): Promise<{ ref: string; commit: string }> {
  const branch = ref?.trim() ? ref.trim() : await client.defaultBranch();
  return { ref: branch, commit: await client.resolveCommit(branch) };
}

/**
 * Where a fetched package says it came from.
 *
 * The host is recorded even when the reference omitted it, because a stored
 * package has to stay resolvable on its own: `github.com` is a default at
 * request time and a fact afterwards.
 */
export function sourceOf(
  repo: RepoRef,
  path: string,
  ref: string,
  commit: string,
  fetchedAt: string,
): PackageSource {
  const provider = repoProvider(repo);
  return {
    kind: provider === 'github' ? 'github' : 'bitbucket',
    baseUrl: (repo.baseUrl ?? (provider === 'github' ? GITHUB_WEB_URL : '')).replace(/\/+$/, ''),
    project: repo.owner.trim(),
    repo: repo.repo,
    path,
    ref,
    commit,
    fetchedAt,
  };
}

/** Trims a repository path of its surrounding slashes. */
export function normalizePath(path: string | undefined): string {
  return (path ?? '').trim().replace(/^\/+|\/+$/g, '');
}
