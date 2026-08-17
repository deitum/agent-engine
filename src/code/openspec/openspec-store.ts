import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  type CodeSpecArtifact,
  type CodeSpecChange,
  type CodeSpecChangeSummary,
  type CodeSpecDelta,
  type CodeSpecIssue,
  type CodeSpecStage,
  type CodeSpecState,
  OPENSPEC_ARCHIVE_DIR,
  OPENSPEC_ARTIFACT_FILES,
  OPENSPEC_CHANGES_DIR,
  OPENSPEC_DIR,
  OPENSPEC_EMPTY_TASKS,
  OPENSPEC_SPEC_FILE,
  OPENSPEC_SPECS_DIR,
  OPENSPEC_STATE_FILE,
} from '../../contracts';

import {
  mergeIntoSpec,
  type ParsedRequirement,
  parseRequirements,
  parseTasks,
  setTaskDone,
  titleOf,
  toRequirement,
} from './openspec-parse';
import { type DeltaInput, validateChange } from './openspec-validate';
import {
  CAPABILITY_PATTERN,
  CHANGE_ID_MAX_LENGTH,
  CHANGE_ID_PATTERN,
  MAX_LISTED_CHANGES,
  STATE_VERSION,
} from './openspec.constants';

/**
 * What `state.json` holds: which change is in flight and when each was approved.
 *
 * Only what cannot be read off the tree. The **stage** deliberately is not here
 * — it is derived on every read (see {@link deriveStage}), so a state file that
 * fell behind the folders it describes cannot put an approved, half-implemented
 * change back into review.
 */
export interface OpenspecState {
  version?: number;
  /** The change the next turn works on. */
  activeChangeId?: string;
  /** Per-change bookkeeping, keyed by change id. */
  changes?: Record<string, { createdAt?: number; approvedAt?: number }>;
}

/** One capability's delta as the propose tool receives it. */
export interface DeltaDraft {
  capability: string;
  /** The delta file's markdown: `## ADDED Requirements`, `### Requirement:`, … */
  spec: string;
}

/** What `openspec_propose` and the panel's create action both hand over. */
export interface ChangeDraft {
  id: string;
  proposal: string;
  design?: string;
  tasks: string;
  deltas: DeltaDraft[];
}

/** Root of the OpenSpec tree inside a checkout. */
export function openspecRoot(dir: string): string {
  return join(dir, OPENSPEC_DIR);
}

/** True once the tree exists. Everything else reads as «not initialized». */
export function isInitialized(dir: string): boolean {
  return existsSync(join(openspecRoot(dir), OPENSPEC_SPECS_DIR));
}

/**
 * Creates the tree. Idempotent: re-running it on an initialised checkout adds
 * nothing and destroys nothing, which is what makes it safe to call from the
 * settings screen's button and from a run that found no tree.
 */
export async function initOpenspec(dir: string, project?: string): Promise<void> {
  const root = openspecRoot(dir);
  await mkdir(join(root, OPENSPEC_SPECS_DIR), { recursive: true });
  await mkdir(join(root, OPENSPEC_CHANGES_DIR), { recursive: true });
  await mkdir(join(root, OPENSPEC_ARCHIVE_DIR), { recursive: true });

  const projectFile = join(root, 'project.md');
  if (!existsSync(projectFile)) {
    await writeFile(projectFile, project?.trim() || DEFAULT_PROJECT_FILE, 'utf8');
  }
  if (!existsSync(join(root, OPENSPEC_STATE_FILE))) {
    await writeState(dir, { version: STATE_VERSION });
  }
}

/** Skeleton of `project.md` — context every proposal is written against. */
const DEFAULT_PROJECT_FILE = [
  '# Project context',
  '',
  'Filled in as work goes on: what this system is, who uses it,',
  'and which constraints matter when designing a change.',
  '',
  '## Capabilities',
  '',
  'The list appears on its own once the first change is archived.',
  '',
].join('\n');

// ─── state.json ───────────────────────────────────────────────────────────────

/** Reads `state.json`; a missing or unparseable file reads as an empty state. */
export async function readState(dir: string): Promise<OpenspecState> {
  try {
    const raw = await readFile(join(openspecRoot(dir), OPENSPEC_STATE_FILE), 'utf8');
    const parsed = JSON.parse(raw) as OpenspecState;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    // The tree is the real record; `state.json` only says which change is in
    // flight. Losing it costs one «make active», not the work.
    return {};
  }
}

/**
 * Persists `state.json` **atomically** — temp file plus `rename`, the same
 * discipline `workspace.json` uses and for the same reason: an interrupted write
 * that left truncated JSON would read back as «no active change» and orphan a
 * change someone had already approved.
 */
export async function writeState(dir: string, state: OpenspecState): Promise<void> {
  const target = join(openspecRoot(dir), OPENSPEC_STATE_FILE);
  const temp = `${target}.tmp`;
  try {
    await mkdir(openspecRoot(dir), { recursive: true });
    await writeFile(temp, JSON.stringify({ ...state, version: STATE_VERSION }, null, 2), 'utf8');
    await rename(temp, target);
  } catch {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

// ─── changes ──────────────────────────────────────────────────────────────────

/** Path of a change's folder, whether or not it exists. */
function changeDir(dir: string, id: string): string {
  return join(openspecRoot(dir), OPENSPEC_CHANGES_DIR, id);
}

/**
 * Rejects an id that could not be a folder name.
 *
 * An id becomes a directory under `changes/`, so this is the boundary that keeps
 * `../../etc` out of it. Checked here rather than only at the tool, because the
 * panel writes through the same functions.
 */
export function assertChangeId(id: string): string {
  const trimmed = id.trim().toLowerCase();
  if (!CHANGE_ID_PATTERN.test(trimmed) || trimmed.length > CHANGE_ID_MAX_LENGTH) {
    throw new Error(
      `«${id}» will not do as a change id: kebab-case of up to ${CHANGE_ID_MAX_LENGTH} characters is expected, e.g. add-sso-login.`,
    );
  }
  return trimmed;
}

/** The same rule for a capability, whose name is a folder under `specs/`. */
export function assertCapability(capability: string): string {
  const trimmed = capability.trim().toLowerCase();
  if (!CAPABILITY_PATTERN.test(trimmed)) {
    throw new Error(`«${capability}» will not do as a capability name: kebab-case is expected.`);
  }
  return trimmed;
}

/**
 * Writes a drafted change to disk and makes it the active one.
 *
 * Validation happens **before** anything is written (`validateChange`), so a
 * refused proposal leaves no half-change behind for the next turn to trip over.
 */
export async function createChange(
  dir: string,
  draft: ChangeDraft,
): Promise<{ change: CodeSpecChange; issues: CodeSpecIssue[] }> {
  const id = assertChangeId(draft.id);
  const deltas = draft.deltas.map((delta) => ({
    capability: assertCapability(delta.capability),
    spec: delta.spec,
  }));

  const tasksMarkdown = draft.tasks.trim() ? draft.tasks : OPENSPEC_EMPTY_TASKS;
  const issues = validateChange({
    proposal: draft.proposal,
    tasks: parseTasks(tasksMarkdown),
    deltas: await Promise.all(deltas.map((delta) => toDeltaInput(dir, delta))),
  });
  if (issues.some((issue) => issue.severity === 'error')) {
    return { change: draftToChange(id, draft, tasksMarkdown, issues), issues };
  }

  const target = changeDir(dir, id);
  // A re-proposal under the same id replaces the draft rather than merging into
  // it: a leftover delta file from the previous attempt would be approved
  // silently along with the new ones.
  await rm(target, { recursive: true, force: true });
  await mkdir(join(target, OPENSPEC_SPECS_DIR), { recursive: true });

  await writeFile(join(target, OPENSPEC_ARTIFACT_FILES.proposal), draft.proposal, 'utf8');
  await writeFile(join(target, OPENSPEC_ARTIFACT_FILES.tasks), tasksMarkdown, 'utf8');
  if (draft.design?.trim()) {
    await writeFile(join(target, OPENSPEC_ARTIFACT_FILES.design), draft.design, 'utf8');
  }
  for (const delta of deltas) {
    const path = join(target, OPENSPEC_SPECS_DIR, delta.capability);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, OPENSPEC_SPEC_FILE), delta.spec, 'utf8');
  }

  const state = await readState(dir);
  await writeState(dir, {
    ...state,
    activeChangeId: id,
    changes: { ...state.changes, [id]: { createdAt: Date.now() } },
  });

  const change = await readChange(dir, id);
  return { change: change ?? draftToChange(id, draft, tasksMarkdown, issues), issues };
}

/** A refused draft, described well enough for the error the agent gets back. */
function draftToChange(
  id: string,
  draft: ChangeDraft,
  tasksMarkdown: string,
  issues: CodeSpecIssue[],
): CodeSpecChange {
  const tasks = parseTasks(tasksMarkdown);
  return {
    id,
    title: titleOf(draft.proposal) || id,
    createdAt: Date.now(),
    tasksTotal: tasks.length,
    tasksDone: tasks.filter((task) => task.done).length,
    proposal: draft.proposal,
    ...(draft.design?.trim() ? { design: draft.design } : {}),
    tasksMarkdown,
    tasks,
    deltas: draft.deltas.map((delta) => ({
      capability: delta.capability,
      path: `${OPENSPEC_DIR}/${OPENSPEC_CHANGES_DIR}/${id}/${OPENSPEC_SPECS_DIR}/${delta.capability}/${OPENSPEC_SPEC_FILE}`,
      requirements: parseRequirements(delta.spec).map(toRequirement),
    })),
    issues,
  };
}

/** Reads one change in full, or `null` when its folder is gone. */
export async function readChange(dir: string, id: string): Promise<CodeSpecChange | null> {
  const target = changeDir(dir, id);
  if (!existsSync(target)) {
    return null;
  }

  const proposal = await readText(join(target, OPENSPEC_ARTIFACT_FILES.proposal));
  const design = await readText(join(target, OPENSPEC_ARTIFACT_FILES.design));
  const tasksMarkdown = await readText(join(target, OPENSPEC_ARTIFACT_FILES.tasks));
  const tasks = parseTasks(tasksMarkdown);
  const deltas = await readDeltas(dir, id);

  const state = await readState(dir);
  const meta = state.changes?.[id] ?? {};
  const createdAt = meta.createdAt ?? (await mtimeOf(target));

  return {
    id,
    title: titleOf(proposal) || id,
    createdAt,
    ...(meta.approvedAt ? { approvedAt: meta.approvedAt } : {}),
    tasksTotal: tasks.length,
    tasksDone: tasks.filter((task) => task.done).length,
    proposal,
    ...(design ? { design } : {}),
    tasksMarkdown,
    tasks,
    deltas,
    issues: await validateStoredChange(dir, proposal, tasks, id),
  };
}

/** Re-runs validation over what is on disk, for the panel's findings list. */
async function validateStoredChange(
  dir: string,
  proposal: string,
  tasks: ReturnType<typeof parseTasks>,
  id: string,
): Promise<CodeSpecIssue[]> {
  const target = changeDir(dir, id);
  const capabilities = await listDirs(join(target, OPENSPEC_SPECS_DIR));
  const deltas = await Promise.all(
    capabilities.map(async (capability) =>
      toDeltaInput(dir, {
        capability,
        spec: await readText(join(target, OPENSPEC_SPECS_DIR, capability, OPENSPEC_SPEC_FILE)),
      }),
    ),
  );
  return validateChange({ proposal, tasks, deltas });
}

/** The delta files of a change, parsed for the panel. */
async function readDeltas(dir: string, id: string): Promise<CodeSpecDelta[]> {
  const root = join(changeDir(dir, id), OPENSPEC_SPECS_DIR);
  const capabilities = await listDirs(root);
  return Promise.all(
    capabilities.map(async (capability) => ({
      capability,
      path: `${OPENSPEC_DIR}/${OPENSPEC_CHANGES_DIR}/${id}/${OPENSPEC_SPECS_DIR}/${capability}/${OPENSPEC_SPEC_FILE}`,
      requirements: parseRequirements(
        await readText(join(root, capability, OPENSPEC_SPEC_FILE)),
      ).map(toRequirement),
    })),
  );
}

/** The same, but keeping the raw blocks — what archiving needs. */
async function readDeltaBlocks(
  dir: string,
  id: string,
): Promise<{ capability: string; requirements: ParsedRequirement[] }[]> {
  const root = join(changeDir(dir, id), OPENSPEC_SPECS_DIR);
  const capabilities = await listDirs(root);
  return Promise.all(
    capabilities.map(async (capability) => ({
      capability,
      requirements: parseRequirements(await readText(join(root, capability, OPENSPEC_SPEC_FILE))),
    })),
  );
}

/** Pairs a delta with what the capability's spec already says, for validation. */
async function toDeltaInput(dir: string, delta: DeltaDraft): Promise<DeltaInput> {
  const specPath = join(
    openspecRoot(dir),
    OPENSPEC_SPECS_DIR,
    delta.capability,
    OPENSPEC_SPEC_FILE,
  );
  const specExists = existsSync(specPath);
  const existing = specExists ? parseRequirements(await readText(specPath)) : [];
  return {
    capability: delta.capability,
    markdown: delta.spec,
    requirements: parseRequirements(delta.spec),
    existingTitles: existing.map((requirement) => requirement.title),
    specExists,
  };
}

/** Replaces one artefact of a change (the panel's editor). */
export async function writeArtifact(
  dir: string,
  id: string,
  artifact: CodeSpecArtifact,
  content: string,
): Promise<void> {
  const target = changeDir(dir, assertChangeId(id));
  if (!existsSync(target)) {
    throw new Error(`Change «${id}» was not found.`);
  }
  await writeFile(join(target, OPENSPEC_ARTIFACT_FILES[artifact]), content, 'utf8');
}

/**
 * Flips one checklist entry. Returns `false` when the change has no entry with
 * that id — which is how the agent finds out its checklist moved under it.
 */
export async function toggleTask(
  dir: string,
  id: string,
  taskId: number,
  done: boolean,
): Promise<boolean> {
  const path = join(changeDir(dir, assertChangeId(id)), OPENSPEC_ARTIFACT_FILES.tasks);
  if (!existsSync(path)) {
    return false;
  }
  const next = setTaskDone(await readText(path), taskId, done);
  if (next === null) {
    return false;
  }
  await writeFile(path, next, 'utf8');
  return true;
}

/** Marks the active change approved; the run's guard is lifted by the caller. */
export async function approveChange(dir: string, id: string): Promise<void> {
  const state = await readState(dir);
  await writeState(dir, {
    ...state,
    activeChangeId: id,
    changes: { ...state.changes, [id]: { ...state.changes?.[id], approvedAt: Date.now() } },
  });
}

/** Makes an existing change the active one. */
export async function activateChange(dir: string, id: string): Promise<void> {
  const wanted = assertChangeId(id);
  if (!existsSync(changeDir(dir, wanted))) {
    throw new Error(`Change «${id}» was not found.`);
  }
  await writeState(dir, { ...(await readState(dir)), activeChangeId: wanted });
}

/** Drops a change and everything in it. */
export async function discardChange(dir: string, id: string): Promise<void> {
  const wanted = assertChangeId(id);
  await rm(changeDir(dir, wanted), { recursive: true, force: true });
  const state = await readState(dir);
  const changes = { ...state.changes };
  delete changes[wanted];
  await writeState(dir, {
    ...state,
    ...(state.activeChangeId === wanted ? { activeChangeId: undefined } : {}),
    changes,
  });
}

/**
 * Folds an approved change's deltas into the capability specs and files it away.
 *
 * The merge happens before the move, and the move is a `rename`: if writing a
 * spec fails halfway the change is still in `changes/` with its folder intact,
 * so the operation can be retried. Re-archiving a change that is already in the
 * archive is a no-op rather than an error — the button and the agent's tool can
 * both reach it, and the second one to arrive should not report a failure.
 */
export async function archiveChange(dir: string, id: string): Promise<{ archivedAs: string }> {
  const wanted = assertChangeId(id);
  const source = changeDir(dir, wanted);
  if (!existsSync(source)) {
    const already = (await listArchived(dir)).find((entry) => entry.id === wanted);
    if (already) {
      return { archivedAs: wanted };
    }
    throw new Error(`Change «${id}» was not found.`);
  }

  for (const delta of await readDeltaBlocks(dir, wanted)) {
    const specDir = join(openspecRoot(dir), OPENSPEC_SPECS_DIR, delta.capability);
    const specPath = join(specDir, OPENSPEC_SPEC_FILE);
    const current = existsSync(specPath) ? await readText(specPath) : '';
    await mkdir(specDir, { recursive: true });
    await writeFile(specPath, mergeIntoSpec(current, delta.capability, delta.requirements), 'utf8');
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const archivedAs = `${stamp}-${wanted}`;
  const target = join(openspecRoot(dir), OPENSPEC_ARCHIVE_DIR, archivedAs);
  await mkdir(join(openspecRoot(dir), OPENSPEC_ARCHIVE_DIR), { recursive: true });
  await rm(target, { recursive: true, force: true });
  await rename(source, target);

  const state = await readState(dir);
  await writeState(dir, {
    ...state,
    ...(state.activeChangeId === wanted ? { activeChangeId: undefined } : {}),
  });

  return { archivedAs };
}

/**
 * Copies the tree to `openspec/` at the checkout root, where git can see it.
 *
 * The one operation that makes any of this reach a commit — everything else
 * lives under `.agent-engine/`, which the checkout excludes. Mirrors the same
 * export for the agent's notes: the process is local until someone
 * decides the team should have it.
 */
export async function exportToRepo(dir: string): Promise<string> {
  const source = openspecRoot(dir);
  if (!existsSync(source)) {
    throw new Error('This session has no openspec yet — there is nothing to create.');
  }
  const target = join(dir, 'openspec');
  await cp(source, target, { recursive: true });
  // `state.json` is this connector's bookkeeping, not part of the specs; leaving
  // it in the export would put one machine's «active change» into everyone's
  // repository.
  await rm(join(target, OPENSPEC_STATE_FILE), { force: true });
  return 'openspec';
}

// ─── reading the whole state ─────────────────────────────────────────────────

/**
 * Where the session stands, derived from the tree rather than stored.
 *
 * `proposal` is never returned: it is the stage where the agent is *drafting*,
 * which is a property of the running turn and not of the disk. The browser shows
 * it while a turn streams over an `idle` state — see the process stepper.
 */
export function deriveStage(change: CodeSpecChange | null | undefined): CodeSpecStage {
  if (!change) {
    return 'idle';
  }
  if (!change.approvedAt) {
    return 'review';
  }
  return change.tasksTotal > 0 && change.tasksDone >= change.tasksTotal ? 'archive' : 'implement';
}

/** Everything the process panel renders, and what a run reads its stage from. */
export async function readSpecState(dir: string): Promise<CodeSpecState> {
  if (!isInitialized(dir)) {
    return {
      initialized: false,
      stage: 'idle',
      changes: [],
      archived: [],
      capabilities: [],
      exported: existsSync(join(dir, 'openspec')),
    };
  }

  const state = await readState(dir);
  const active = state.activeChangeId ? await readChange(dir, state.activeChangeId) : null;
  const changes = await listChanges(dir);

  return {
    initialized: true,
    stage: deriveStage(active),
    ...(active ? { active } : {}),
    changes: changes.filter((entry) => entry.id !== active?.id),
    archived: await listArchived(dir),
    capabilities: await listCapabilities(dir),
    exported: existsSync(join(dir, 'openspec')),
  };
}

/** Every change still in flight, newest first. */
export async function listChanges(dir: string): Promise<CodeSpecChangeSummary[]> {
  const state = await readState(dir);
  const ids = await listDirs(join(openspecRoot(dir), OPENSPEC_CHANGES_DIR));
  const summaries = await Promise.all(
    ids.map(async (id) => summarize(join(openspecRoot(dir), OPENSPEC_CHANGES_DIR, id), id, state)),
  );
  return sortNewest(summaries);
}

/** Every archived change, newest first. */
export async function listArchived(dir: string): Promise<CodeSpecChangeSummary[]> {
  const root = join(openspecRoot(dir), OPENSPEC_ARCHIVE_DIR);
  const folders = await listDirs(root);
  const state = await readState(dir);
  const summaries = await Promise.all(
    folders.map(async (folder) => {
      // `<YYYY-MM-DD>-<id>`; a folder that predates the stamp is read as a bare id.
      const stamped = /^(\d{4}-\d{2}-\d{2})-(.+)$/.exec(folder);
      const id = stamped ? stamped[2] : folder;
      const summary = await summarize(join(root, folder), id, state);
      return { ...summary, archivedAt: await mtimeOf(join(root, folder)) };
    }),
  );
  return sortNewest(summaries);
}

/** A change's row, read from its folder. */
async function summarize(
  path: string,
  id: string,
  state: OpenspecState,
): Promise<CodeSpecChangeSummary> {
  const proposal = await readText(join(path, OPENSPEC_ARTIFACT_FILES.proposal));
  const tasks = parseTasks(await readText(join(path, OPENSPEC_ARTIFACT_FILES.tasks)));
  const meta = state.changes?.[id] ?? {};
  return {
    id,
    title: titleOf(proposal) || id,
    createdAt: meta.createdAt ?? (await mtimeOf(path)),
    ...(meta.approvedAt ? { approvedAt: meta.approvedAt } : {}),
    tasksTotal: tasks.length,
    tasksDone: tasks.filter((task) => task.done).length,
  };
}

/** The capabilities the specs describe, with how much each one says. */
export async function listCapabilities(
  dir: string,
): Promise<{ capability: string; requirements: number }[]> {
  const root = join(openspecRoot(dir), OPENSPEC_SPECS_DIR);
  const names = await listDirs(root);
  return Promise.all(
    names.map(async (capability) => ({
      capability,
      requirements: parseRequirements(await readText(join(root, capability, OPENSPEC_SPEC_FILE)))
        .length,
    })),
  );
}

// ─── small helpers ────────────────────────────────────────────────────────────

/** A file's contents, or an empty string when it is not there. */
async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

/** Sub-directory names of a path, or none when the path does not exist. */
async function listDirs(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** A path's mtime in epoch ms, or now when it cannot be read. */
async function mtimeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return Date.now();
  }
}

/** Newest first, capped — the panel is a list, not an audit log. */
function sortNewest(summaries: CodeSpecChangeSummary[]): CodeSpecChangeSummary[] {
  return summaries
    .sort(
      (left, right) => (right.archivedAt ?? right.createdAt) - (left.archivedAt ?? left.createdAt),
    )
    .slice(0, MAX_LISTED_CHANGES);
}
