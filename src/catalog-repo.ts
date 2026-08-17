import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  type CatalogRepoListRequest,
  type CatalogRepoListResponse,
  type CatalogSkippedFile,
  type McpLibraryEntry,
  type Plugin,
  type RepoCatalog,
  type RepoRef,
  type Skill,
  repoProvider,
} from './contracts';
import { findMcpDirs, MCP_CATALOG_FILE, parseMcpCatalogFile } from './mcp-repo';
import { engineHome } from './platform';
import { findPluginDirs, readPluginPackage } from './plugin-repo';
import {
  decodeFile,
  joinPath,
  mapWithLimit,
  normalizePath,
  READ_CONCURRENCY,
  repoClientFor,
  resolveRevision,
  sourceOf,
  under,
} from './repo-package';
import { groupPackages, readSkillPackage } from './skill-repo';

/**
 * The catalogue an embedding app offers out of the box, read from git.
 *
 * One walk, three kinds of package. The app used to ship its plugins and skills
 * as a directory inside its own image and its MCP servers as a block of YAML;
 * all three now live in a repository the operator names, which is what lets the
 * people who write these practices publish them without a release of the app.
 *
 * Two things make that affordable. Everything is read **at one commit**, so a
 * catalogue is one consistent tree even if someone pushes mid-request; and the
 * answer is cached on disk against that commit, so the second load resolves the
 * branch, sees the same id and downloads nothing.
 */

/** Cache file format. Versioned so a future shape is ignored, not misread. */
interface CatalogCacheFile {
  version: 1;
  commit: string;
  catalog: RepoCatalog;
}

const CACHE_VERSION = 1;
const CACHE_DIR = join('cache', 'catalog');

/**
 * Identity of a catalogue read: everything that decides **which tree** is being
 * read. Credentials are outside it, as in `mcp-catalog.ts` — a rotated token
 * must not throw the cache away.
 */
export function catalogIdentity(repo: RepoRef): string {
  const normalized = JSON.stringify({
    provider: repoProvider(repo),
    baseUrl: (repo.baseUrl ?? '').replace(/\/+$/, ''),
    owner: repo.owner,
    repo: repo.repo,
    ref: repo.ref ?? '',
    path: normalizePath(repo.path),
  });
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * One repository's catalogue as it was at one commit, on disk.
 *
 * Every failure is swallowed: a cache that cannot be read or written must never
 * be the reason the catalogue is empty, and the worst case — a miss — is just
 * the walk this class exists to skip.
 */
export class CatalogCache {
  private readonly dir: string;

  constructor(options: { dir?: string } = {}) {
    this.dir = options.dir ?? join(engineHome(), CACHE_DIR);
  }

  /** The catalogue read from this repository at {@link commit}, or `null`. */
  get(repo: RepoRef, commit: string): RepoCatalog | null {
    try {
      const file = JSON.parse(
        readFileSync(this.pathFor(repo), 'utf8'),
      ) as Partial<CatalogCacheFile>;
      return file.version === CACHE_VERSION && file.commit === commit && file.catalog
        ? file.catalog
        : null;
    } catch {
      return null;
    }
  }

  put(repo: RepoRef, catalog: RepoCatalog): void {
    const path = this.pathFor(repo);
    const file: CatalogCacheFile = { version: CACHE_VERSION, commit: catalog.commit, catalog };
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(temporary, JSON.stringify(file), 'utf8');
      renameSync(temporary, path);
    } catch {
      // The walk already produced an answer; the next call simply repeats it.
    }
  }

  private pathFor(repo: RepoRef): string {
    return join(this.dir, `${catalogIdentity(repo)}.json`);
  }
}

/**
 * Reads every named repository's catalogue.
 *
 * Repositories are read one after another rather than at once: each one is
 * already dozens of requests against a host that is usually an on-prem Bitbucket
 * with one user's credentials behind it.
 */
export async function readRepoCatalog(
  request: CatalogRepoListRequest,
  cache: CatalogCache = new CatalogCache(),
): Promise<CatalogRepoListResponse> {
  const repos: RepoCatalog[] = [];

  for (const repo of request.repos) {
    try {
      repos.push(await readOneRepo(repo, Boolean(request.refresh), cache));
    } catch (error) {
      // One unreachable repository — a host that is down, credentials the user
      // has not entered yet — must not blank the catalogue of the others.
      repos.push({
        repo,
        ref: repo.ref ?? '',
        commit: '',
        plugins: [],
        skills: [],
        mcpServers: [],
        skipped: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { repos };
}

async function readOneRepo(
  repo: RepoRef,
  refresh: boolean,
  cache: CatalogCache,
): Promise<RepoCatalog> {
  const client = repoClientFor(repo);
  const root = normalizePath(repo.path);
  const { ref, commit } = await resolveRevision(client, repo.ref);

  if (!refresh) {
    const cached = cache.get(repo, commit);
    if (cached) {
      return cached;
    }
  }

  const paths = await client.listFiles(root, commit);
  const fetchedAt = new Date().toISOString();
  const skipped: CatalogSkippedFile[] = [];
  const onSkipped = (file: CatalogSkippedFile): void => {
    skipped.push(file);
  };

  const pluginDirs = findPluginDirs(paths);

  const plugins = await mapWithLimit(pluginDirs, READ_CONCURRENCY, async (dir): Promise<Plugin> => {
    const path = joinPath(root, dir);
    return readPluginPackage({
      client,
      path,
      files: under(paths, dir),
      commit,
      fetchedAt,
      source: sourceOf(repo, path, ref, commit, fetchedAt),
      fallbackId: repo.repo,
      onSkipped,
    });
  });

  // A `skills/<name>/` package inside a plugin is that plugin's, and it is
  // already in the bundle above — offering it again as a standalone skill would
  // put the same instructions in the catalogue twice under one name.
  const standalone = groupPackages(paths).filter(
    ({ dir }) => !pluginDirs.some((plugin) => dir === plugin || dir.startsWith(`${plugin}/`)),
  );

  const skills = await mapWithLimit(
    standalone,
    READ_CONCURRENCY,
    async ({ dir, files }): Promise<Skill> => {
      const path = joinPath(root, dir);
      return readSkillPackage({
        client,
        path,
        files,
        commit,
        fetchedAt,
        source: sourceOf(repo, path, ref, commit, fetchedAt),
        fallbackId: repo.repo,
        onSkipped,
      });
    },
  );

  const mcpServers = (
    await mapWithLimit(
      findMcpDirs(paths, pluginDirs),
      READ_CONCURRENCY,
      async (dir): Promise<McpLibraryEntry[]> => {
        const path = joinPath(root, dir);
        const decoded = decodeFile(await client.readFile(joinPath(path, MCP_CATALOG_FILE), commit));
        if (!('content' in decoded)) {
          onSkipped({ path: joinPath(path, MCP_CATALOG_FILE), reason: decoded.reason });
          return [];
        }
        return parseMcpCatalogFile(decoded.content, dir.split('/').pop() ?? repo.repo, fetchedAt);
      },
    )
  ).flat();

  const catalog: RepoCatalog = { repo, ref, commit, plugins, skills, mcpServers, skipped };
  cache.put(repo, catalog);
  return catalog;
}
