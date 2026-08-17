import { LOCAL_DIR } from './code.constants';
import {
  type CodeSpecArtifact,
  type CodeSpecDeltaKind,
  type CodeSpecStage,
} from './openspec.types';

/**
 * Root of the OpenSpec tree inside a session's checkout.
 *
 * Under {@link LOCAL_DIR} on purpose: that prefix is already in the checkout's
 * `.git/info/exclude` (see `LOCAL_DIR_ENTRY` in the engine's
 * `code-workspace.ts`), so the whole process — proposals, specs, the archive —
 * stays out of the user's diff panel and out of their pull request without a
 * single new exclude entry. Moving it into the repository is a deliberate act,
 * the session settings' «export to the repository».
 */
export const OPENSPEC_DIR = `${LOCAL_DIR}/openspec`;

/**
 * Where the process itself is recorded, relative to {@link OPENSPEC_DIR}.
 *
 * The stage lives on the connector rather than in the browser because it has to
 * survive a connector restart and the idle sweep: an approved change that is
 * half-implemented must not come back as «no active change» because a tab was
 * closed. The browser only ever says *that* the session works by the process.
 */
export const OPENSPEC_STATE_FILE = 'state.json';

/** Sub-directories of {@link OPENSPEC_DIR}, relative to it. */
export const OPENSPEC_SPECS_DIR = 'specs';
export const OPENSPEC_CHANGES_DIR = 'changes';
export const OPENSPEC_ARCHIVE_DIR = 'archive';

/** The file every capability's requirements live in, inside its own folder. */
export const OPENSPEC_SPEC_FILE = 'spec.md';

/**
 * File names of a change's artefacts, keyed by {@link CodeSpecArtifact}. Shared
 * so the connector's writer and the browser's editor cannot drift apart — the
 * panel edits a file by artefact name, and the connector resolves the path.
 */
export const OPENSPEC_ARTIFACT_FILES = {
  proposal: 'proposal.md',
  design: 'design.md',
  tasks: 'tasks.md',
} as const satisfies Record<CodeSpecArtifact, string>;

/**
 * Names of the tools the coding agent is granted while the session works by the
 * process. Registered per stage — see the connector's `openspec-tools.ts` — so
 * the model cannot propose twice or archive a change nobody approved.
 *
 * In the contracts for the same reason {@link EXIT_PLAN_MODE_TOOL} is: the
 * connector needs them in two places that must not import each other (the tools
 * themselves and the stream projection that keeps them out of the timeline).
 */
export const OPENSPEC_TOOLS = {
  /** Draft the change and block for the user's review. */
  propose: 'openspec_propose',
  /** Tick one entry of `tasks.md` off. */
  task: 'openspec_task',
  /** Fold the approved deltas into the specs and archive the change. */
  archive: 'openspec_archive',
} as const;

/** Every OpenSpec tool name, for the places that need to recognise one. */
export const OPENSPEC_TOOL_NAMES: readonly string[] = Object.values(OPENSPEC_TOOLS);

/**
 * The headings a delta file groups its requirements under, keyed by kind. These
 * are OpenSpec's own, in English and capitalised exactly as the format spells
 * them — a file written here has to stay readable by the upstream `openspec`
 * CLI, which is the whole reason for following the convention rather than
 * inventing one.
 */
export const OPENSPEC_DELTA_HEADINGS = {
  added: 'ADDED Requirements',
  modified: 'MODIFIED Requirements',
  removed: 'REMOVED Requirements',
} as const satisfies Record<CodeSpecDeltaKind, string>;

/** Order the stages are shown in, and the order they actually happen in. */
export const OPENSPEC_STAGES = [
  'proposal',
  'review',
  'implement',
  'archive',
] as const satisfies readonly Exclude<CodeSpecStage, 'idle'>[];

/**
 * Skeleton of `tasks.md` for a change whose agent gave us no checklist. An empty
 * file would leave the implementation stage with nothing to tick off and the
 * panel with an empty progress bar, which reads as a bug rather than as a change
 * that has no tasks.
 */
export const OPENSPEC_EMPTY_TASKS = '## Tasks\n\n- [ ] Implement the proposal\n';
