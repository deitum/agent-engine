/**
 * Version of the shape written into `state.json`. Read like `workspace.json`'s:
 * a file without one is a pre-versioning snapshot and is taken as-is.
 */
export const STATE_VERSION = 1;

/**
 * Longest a change id may be, and the characters it may use. Ids become
 * directory names, so they are constrained the same way a branch name is —
 * kebab-case, no separators that would let one escape its parent.
 */
export const CHANGE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const CHANGE_ID_MAX_LENGTH = 60;

/** Capability folder names live under `specs/` and follow the same rule. */
export const CAPABILITY_PATTERN = CHANGE_ID_PATTERN;

/**
 * Caps on what one proposal may carry. Not a matter of disk: every artefact is
 * read back into the review card and into the panel, and a model asked for «the
 * whole design» will happily produce a hundred kilobytes of it.
 */
export const ARTIFACT_MAX_CHARS = 40_000;
export const MAX_DELTAS_PER_CHANGE = 20;
export const MAX_TASKS_PER_CHANGE = 100;

/**
 * How many changes the panel lists. The tree is per-checkout and long-lived, so
 * an archive of a hundred entries is ordinary; the panel shows the newest and
 * the folder keeps the rest.
 */
export const MAX_LISTED_CHANGES = 50;
