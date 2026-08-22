/**
 * One file of a bundle written to the user's machine: where it goes relative to
 * the request's `dir`, and what it says.
 */
export interface LocalFileWrite {
  /**
   * Path relative to `dir`, forward-slashed (`commands/deploy.md`). The
   * connector refuses anything absolute or climbing out with `..` — the same
   * rule a skill package's bundled files go through.
   */
  path: string;
  content: string;
}

/**
 * `POST /files/write` on the local connector daemon — drop a set of text files
 * into a folder on the user's own machine (`dir` may start with `~`).
 *
 * Exists for the parts of an integration bundle that the target agent reads as
 * loose files rather than from its config: Kilo Code's `commands/*.md`, Claude
 * Code's `commands/` and `agents/`. Skill *packages* keep going through
 * `POST /skills/write`, which knows the Agent Skills layout; this route is for
 * files that have no shape of their own.
 */
export interface LocalFilesWriteRequest {
  dir: string;
  files: LocalFileWrite[];
}

export interface LocalFilesWriteResponse {
  /** The absolute directory actually written into (after `~` expansion). */
  dir: string;
  /** Relative paths written, in request order — what the UI reports back. */
  paths: string[];
}

/**
 * `POST /files/delete` — take those same loose files back out.
 *
 * The other half of `/files/write`, and the reason uninstalling a bundle can be
 * exact: a target that reads its commands as files has no config key to clear,
 * so without this route the markdown outlives the thing that put it there.
 *
 * A path that is already gone is not an error — removing what is not there is
 * the outcome the caller asked for, and an uninstall that fails halfway because
 * the user tidied one file by hand is worse than one that finishes.
 */
export interface LocalFilesDeleteRequest {
  dir: string;
  /** Paths relative to `dir`, forward-slashed — same rule as a write. */
  paths: string[];
}

export interface LocalFilesDeleteResponse {
  /** The absolute directory (after `~` expansion). */
  dir: string;
  /** The paths that were actually on disk and are now gone. */
  removed: string[];
}
