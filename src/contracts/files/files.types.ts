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
