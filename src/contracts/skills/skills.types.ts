import { type Manifest } from '../manifest/manifest.types';
import { type PackageSource, type RepoRef } from '../vcs/vcs.types';

/**
 * A single file bundled with a skill (modelled on Anthropic Agent Skills: a
 * `SKILL.md` plus optional resource/reference files). The primary instructions
 * live on {@link Skill.instructions}; `files` carries any extra resources whose
 * contents are surfaced to the model when the skill is active.
 */
export interface SkillFile {
  /** Relative path inside the skill package, e.g. `references/style.md`. */
  path: string;
  content: string;
}

/**
 * A reusable instruction package ("skill") the user can attach to a chat. Its
 * `instructions` (the `SKILL.md` body) are injected as a system message; bundled
 * {@link SkillFile}s are appended as reference material.
 *
 * Shared skills are declared in the YAML config file (read-only at runtime);
 * personal skills mirror this shape in the browser. Both are picked per chat.
 */
export interface Skill {
  id: string;
  /** Display name (skill frontmatter `name`). */
  name: string;
  /** When-to-use summary (skill frontmatter `description`). */
  description: string;
  /** The `SKILL.md` body — the main system prompt applied to the chat. */
  instructions: string;
  /** Optional bundled resource files. */
  files: SkillFile[];
  /**
   * Setup manifest: required / recommended MCP servers and recommended settings.
   * Documentation surfaced by the UI (see {@link Manifest}).
   */
  manifest?: Manifest;
  /** Where this copy came from, when it was imported from a repository. */
  source?: SkillSource;
  createdAt: string;
  updatedAt: string;
}

/**
 * Where an imported skill came from — {@link PackageSource} under the name this
 * app has always spelled it. The shape moved to `vcs.types.ts` when plugins
 * gained the same import: it describes a repository, not a skill. The alias
 * stays because the name is written into every stored copy's type imports.
 */
export type SkillSource = PackageSource;

/**
 * `POST /skills/repo/list` on the local connector daemon — walk a
 * repository and report every Agent Skills package in it (a directory holding a
 * `SKILL.md`), without downloading their resources.
 *
 * The credentials are not here: they belong to the configuration the browser
 * hands over when it connects (see {@link EngineConfigRequest}).
 */
export interface SkillRepoListRequest {
  repo: RepoRef;
}

/** One package found in a repository, described from its `SKILL.md` alone. */
export interface RepoSkillSummary {
  /** Package directory relative to the repository root, e.g. `skills/tdd`. */
  path: string;
  /** Directory name — the id the package gets when written to a folder. */
  id: string;
  name: string;
  description: string;
  /** Resource paths relative to the package directory (`SKILL.md` excluded). */
  files: string[];
}

export interface SkillRepoListResponse {
  /** The branch actually read — resolved when the request named none. */
  ref: string;
  /** Commit that branch pointed at; every path was listed at this revision. */
  commit: string;
  skills: RepoSkillSummary[];
}

/**
 * `POST /skills/repo/fetch` — download whole packages named by
 * {@link RepoSkillSummary.path}, resources and all, ready to be stored as
 * personal skills or written into a folder.
 */
export interface SkillRepoFetchRequest {
  repo: RepoRef;
  /** Package directories to download, as the listing reported them. */
  paths: string[];
}

/** A file left out of a fetched package, and why the connector skipped it. */
export interface SkillRepoSkippedFile {
  /** Path relative to the repository root. */
  path: string;
  reason: 'binary' | 'too-large';
}

export interface SkillRepoFetchResponse {
  ref: string;
  commit: string;
  /** One per requested path, each carrying its {@link Skill.source}. */
  skills: Skill[];
  /**
   * Files that could not travel as text. A skill is instructions plus reference
   * material, both of which are read by a model, so a picture or an archive has
   * nothing to contribute — but the user is told rather than left wondering why
   * the package on disk is thinner than the one in the repository.
   */
  skipped: SkillRepoSkippedFile[];
}

/**
 * `POST /skills/list` on the local connector daemon — read the Agent Skills
 * packages sitting in a directory on the user's own machine. `dir` may start
 * with `~` (expanded by the connector).
 */
export interface LocalSkillsListRequest {
  dir: string;
}

export interface LocalSkillsListResponse {
  /** The absolute directory actually read (after `~` expansion), for the UI. */
  dir: string;
  skills: Skill[];
}

/**
 * `POST /skills/write` on the local connector daemon — write one skill into
 * `<dir>/<id>/` as an Agent Skills package (a `SKILL.md` plus its bundled
 * files). Existing files are overwritten; nothing is deleted unless `prune`
 * asks for it.
 */
export interface LocalSkillWriteRequest {
  dir: string;
  /**
   * The skill to write. Its `id` is the desired **package directory name**, not
   * the store id — callers send a slug (the connector sanitises it further), so
   * re-syncing the same skill overwrites its own package.
   */
  skill: Pick<
    Skill,
    'id' | 'name' | 'description' | 'instructions' | 'files' | 'manifest' | 'source'
  >;
  /**
   * Delete files already in the package that `skill.files` no longer carries
   * (`SKILL.md` always survives). Off by default, because a plain
   * Sync push must not throw away whatever else the user keeps
   * next to the package; the editor's in-place save turns it on, since deleting
   * a resource there has to reach the disk.
   */
  prune?: boolean;
}

export interface LocalSkillWriteResponse {
  /** Absolute path of the written package directory. */
  path: string;
  /** True when that directory already existed and was overwritten. */
  overwritten: boolean;
  /** Relative paths deleted by `prune`, so the UI can report what it removed. */
  pruned: string[];
}

/**
 * `POST /skills/delete` on the local connector daemon — remove one package from
 * the folder. `id` is the package **directory name** (same field as on
 * {@link LocalSkillWriteRequest}); a directory holding no `SKILL.md` is refused,
 * so this can only ever delete a skill package.
 */
export interface LocalSkillDeleteRequest {
  dir: string;
  id: string;
}

export interface LocalSkillDeleteResponse {
  /** Absolute path of the package directory that was removed. */
  path: string;
}
