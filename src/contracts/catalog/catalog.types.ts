import { type McpLibraryEntry } from '../mcp/mcp.types';
import { type Plugin } from '../plugins/plugins.types';
import { type Skill } from '../skills/skills.types';
import { type RepoRef } from '../vcs/vcs.types';

/**
 * The **catalogue**: everything an embedding app offers its users out of the
 * box — plugins, skills and MCP servers — read from one or more git
 * repositories rather than shipped with the app.
 *
 * This is one route rather than three because it is one walk: a repository is
 * listed once, at one commit, and the three kinds are told apart by the file
 * that opens a package (`plugin.json`, `SKILL.md`, `mcp.json`). Asking for them
 * separately would list the same tree three times and could return three
 * different commits for what the user reads as one catalogue.
 */

/**
 * `POST /catalog/repo/list` — read the whole catalogue of every named
 * repository.
 *
 * The daemon caches each repository's answer on disk against the commit it was
 * read at, so a second call for an unchanged branch costs one request (resolving
 * the branch) instead of downloading every package again.
 */
export interface CatalogRepoListRequest {
  repos: RepoRef[];
  /**
   * Read the repositories even when the cache is warm. What an explicit refresh
   * in the host's UI sends; an ordinary load leaves it off and lets the commit
   * decide.
   */
  refresh?: boolean;
}

/** A file left out of a package, and why the daemon skipped it. */
export interface CatalogSkippedFile {
  /** Path relative to the repository root. */
  path: string;
  reason: 'binary' | 'too-large';
}

/** One repository's catalogue, whole, as of a single commit. */
export interface RepoCatalog {
  /** The reference this entry answers, as the caller sent it. */
  repo: RepoRef;
  /** The branch actually read — resolved when the request named none. */
  ref: string;
  /** Commit that branch pointed at; every package was read at this revision. */
  commit: string;
  /** Packages holding a `plugin.json`. */
  plugins: Plugin[];
  /** Packages holding a `SKILL.md`, excluding those a plugin bundles. */
  skills: Skill[];
  /** Directories holding an `mcp.json`, excluding those inside a plugin. */
  mcpServers: McpLibraryEntry[];
  skipped: CatalogSkippedFile[];
  /**
   * Why this repository could not be read, when it could not be.
   *
   * A failure is reported per repository rather than as a status: with several
   * configured, one unreachable host (or one the user has no credentials for
   * yet) must not blank the whole catalogue. The other entries carry their
   * packages, this one carries the reason, and the UI can say which is which.
   */
  error?: string;
}

export interface CatalogRepoListResponse {
  repos: RepoCatalog[];
}
