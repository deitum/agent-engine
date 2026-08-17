/**
 * Where a session that works by the OpenSpec process currently stands.
 *
 * - `idle` — the mode is on but nothing is in flight; the next task starts a change;
 * - `proposal` — the agent is researching read-only and drafting the change;
 * - `review` — the draft is written and waiting for the user's verdict;
 * - `implement` — the change was approved and its `tasks.md` is being worked through;
 * - `archive` — every task is done; the deltas are ready to fold into the specs.
 *
 * `review` is a stage of its own rather than a flavour of `proposal` because it
 * is the one the *user* is in: the agent is blocked, and the UI has to offer a
 * decision instead of a progress indicator.
 */
export type CodeSpecStage = 'idle' | 'proposal' | 'review' | 'implement' | 'archive';

/** What a delta does to a requirement: OpenSpec's three categories. */
export type CodeSpecDeltaKind = 'added' | 'modified' | 'removed';

/** A change's markdown artefacts. `design` is optional; the other two are not. */
export type CodeSpecArtifact = 'proposal' | 'design' | 'tasks';

/**
 * One requirement of a capability, with the scenarios that make it testable.
 *
 * Scenarios are kept as raw markdown blocks rather than parsed into
 * WHEN/THEN pairs: the format allows several of each and any prose between them,
 * and the only thing the product does with them is render and count them.
 */
export interface CodeSpecRequirement {
  kind: CodeSpecDeltaKind;
  /** Text after `### Requirement:`, e.g. «Sign in with SSO». */
  title: string;
  /** Each `#### Scenario:` block, heading included. */
  scenarios: string[];
}

/** One capability's delta file inside a change. */
export interface CodeSpecDelta {
  /** Folder name under `specs/`, kebab-case — e.g. `auth`, `order-history`. */
  capability: string;
  /** Path relative to the checkout, for the panel's file list. */
  path: string;
  requirements: CodeSpecRequirement[];
}

/** One line of a change's `tasks.md`. */
export interface CodeSpecTask {
  /**
   * Stable within the file: the 1-based index of the checklist item. Positional
   * because the file is the source of truth and a task carries no id of its own
   * — renumbering after an edit is correct, inventing a uuid to store elsewhere
   * would be a second source of truth.
   */
  id: number;
  text: string;
  done: boolean;
  /** The `##` heading the item sits under, when the checklist has any. */
  section?: string;
}

/** How badly a validation finding blocks the process. */
export type CodeSpecSeverity = 'error' | 'warning';

/**
 * One thing wrong with a change, as the panel shows it and as the agent is told
 * it. An `error` refuses the proposal outright — the agent gets the list back and
 * revises; a `warning` is shown to the user and lets the change through.
 */
export interface CodeSpecIssue {
  severity: CodeSpecSeverity;
  message: string;
  /** Path relative to the checkout, when the finding is about one file. */
  path?: string;
}

/** A change as it appears in a list: enough for a row, not the whole document. */
export interface CodeSpecChangeSummary {
  id: string;
  title: string;
  createdAt: number;
  /** Set once the change was approved. */
  approvedAt?: number;
  /** Set once the change was archived, and then it names the archive folder. */
  archivedAt?: number;
  tasksTotal: number;
  tasksDone: number;
}

/** A change in full: its artefacts, its deltas, its checklist and its findings. */
export interface CodeSpecChange extends CodeSpecChangeSummary {
  /** `proposal.md` verbatim. */
  proposal: string;
  /** `design.md` verbatim, when the change has one. */
  design?: string;
  /** `tasks.md` verbatim, so the panel can show and edit the raw file too. */
  tasksMarkdown: string;
  tasks: CodeSpecTask[];
  deltas: CodeSpecDelta[];
  issues: CodeSpecIssue[];
}

/**
 * `GET /code/spec`: everything the process panel renders for one session.
 *
 * `stage` is derived from the same state the run reads, so the panel and the
 * next turn can never disagree about where the session is.
 */
export interface CodeSpecState {
  /** False until the OpenSpec tree has been created in the checkout. */
  initialized: boolean;
  stage: CodeSpecStage;
  /** The change in flight, when there is one. */
  active?: CodeSpecChange;
  /** Changes that exist but are not the active one. */
  changes: CodeSpecChangeSummary[];
  archived: CodeSpecChangeSummary[];
  /** Capabilities the specs currently describe, with their requirement counts. */
  capabilities: { capability: string; requirements: number }[];
  /** True when an `openspec/` folder also exists at the checkout root. */
  exported: boolean;
}

/**
 * What a `POST /code/spec` does:
 * - `init` — create the OpenSpec tree in the checkout;
 * - `activate` — make an existing change the active one;
 * - `write` — replace one artefact of the active change (the panel's editor);
 * - `task` — tick one checklist entry on or off by hand;
 * - `archive` — fold the active change's deltas into the specs and file it away;
 * - `discard` — drop the active change (its folder is deleted);
 * - `export` — copy the tree to `openspec/` at the checkout root, so it can be
 *   committed. The one operation that makes any of this visible to git.
 */
export type CodeSpecOp = 'init' | 'activate' | 'write' | 'task' | 'archive' | 'discard' | 'export';

/** `POST /code/spec` on the local connector. */
export interface CodeSpecWriteRequest {
  sessionId: string;
  op: CodeSpecOp;
  /** Target change; defaults to the active one. Required for `activate`. */
  changeId?: string;
  /** Which artefact `write` replaces. */
  artifact?: CodeSpecArtifact;
  /** New contents for `write`. */
  content?: string;
  /** Which checklist entry `task` flips, and to what. */
  taskId?: number;
  done?: boolean;
}

/** Result of a `POST /code/spec`, with the refreshed state. */
export interface CodeSpecWriteResult {
  ok: boolean;
  /** Why an operation was refused, in the user's language. */
  message?: string;
  state: CodeSpecState;
}

/**
 * A drafted change the agent put to the user for review (its `openspec_propose`
 * tool). Structurally the plan proposal of plan mode — it blocks on the same
 * `pending` map and is answered through the same `POST /code/answer` — but what
 * the user judges is a set of files on disk rather than a message, so the event
 * carries the change and the panel is where it is read.
 *
 * Answering {@link CODE_PLAN_APPROVE} lifts the turn's read-only guard and the
 * agent implements the change without waiting for another message; anything else
 * is handed back as review comments and the workspace stays read-only.
 */
export interface CodeSpecProposal {
  /** Correlates the emitted proposal with the answer that resumes the run. */
  id: string;
  change: CodeSpecChange;
}

/** Per-turn OpenSpec settings forwarded on `POST /code/stream`. */
export interface CodeSpecRunConfig {
  /**
   * Whether this session works by the process. Only the switch travels: the
   * *stage* is read from the connector's own state, so a stale browser cannot
   * put an approved change back into planning.
   */
  enabled: boolean;
}
