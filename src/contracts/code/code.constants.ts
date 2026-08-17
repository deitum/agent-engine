import { type CodeMemorySection } from './code.types';

/**
 * Name of the coding agent's plan-approval tool. Registered only while a Code
 * turn runs in plan mode: calling it puts the drafted plan to the user and, once
 * approved, lifts the read-only guard for the rest of the turn.
 *
 * Lives in the contracts because the connector needs it in two places that must
 * not import each other — the tool itself and the stream projection that keeps
 * it out of the activity timeline.
 */
export const EXIT_PLAN_MODE_TOOL = 'exit_plan_mode';

/**
 * The answer the browser sends to approve a plan. Anything else the user replies
 * is read as «keep planning», so this exact token is the one thing both sides
 * have to agree on.
 */
export const CODE_PLAN_APPROVE = 'approve';

/**
 * Everything the engine itself writes into a session's checkout lives under this
 * one directory, relative to the checkout root: the agent's notes, the OpenSpec
 * tree, the summarizer's offloaded history.
 *
 * Every path below is derived from it, and so is the `.git/info/exclude` entry
 * that keeps them out of the user's diff (see `LOCAL_DIR_ENTRY` in the engine's
 * `code-workspace.ts`). That is the point of the constant: spelling the name out
 * in both places is how the writers and the exclusion came to disagree once, and
 * a directory nobody excludes ends up in the user's pull request.
 */
export const LOCAL_DIR = '.agent-engine';

/**
 * Where a session's skills are materialised — a sibling of {@link LOCAL_DIR},
 * not a child: deepagents discovers skills by directory, and nesting them under
 * a directory holding markdown notes would offer the agent its own memory as a
 * skill.
 */
export const LOCAL_SKILLS_DIR = '.agent-engine-skills';

/**
 * The notes file the coding agent maintains, relative to the checkout. Kept out
 * of git (`.git/info/exclude`), so it never reaches a diff or a pull request, and
 * always present — the agent is told to write here, and an instruction pointing
 * at a file that does not exist is worse than no instruction.
 */
export const SESSION_MEMORY_PATH = `${LOCAL_DIR}/AGENTS.md`;

/**
 * Name of the coding agent's memory-write tool. The agent does not edit the
 * notes file directly: a free-form `write_file` grows without bound, and memory
 * is injected into the prompt on *every* turn, so an unbounded file is a
 * permanent tax. This tool validates the section, de-duplicates the entry and
 * enforces the budget instead.
 */
export const REMEMBER_TOOL = 'remember';

/**
 * Names of the language-server tools the coding agent is given.
 *
 * Shared rather than spelled out on each side: the connector registers them and
 * the browser labels them in the activity timeline, and a step whose name does
 * not match renders as an anonymous tool call.
 */
export const LSP_TOOLS = {
  definition: 'find_definition',
  references: 'find_references',
  documentSymbols: 'document_symbols',
  workspaceSymbols: 'workspace_symbols',
  hover: 'hover',
  /** Registered only outside plan mode — it is the one that writes. */
  rename: 'rename_symbol',
} as const;

/**
 * Names of the git tools the coding agent is given for the operations that need
 * the user's repository credentials.
 *
 * They exist because the sandbox deliberately has none: the checkout's `origin`
 * carries no token and the container is never handed one, so a `git push` run
 * inside it fails with «could not read Username». These tools run the same
 * operation on the host, where the credentials from the connector's
 * configuration handshake live — the same path `/push` and `/pr` take.
 */
export const CODE_GIT_TOOLS = {
  push: 'git_push',
  fetch: 'git_fetch',
  pullRequest: 'open_pull_request',
} as const;

/**
 * The notes file's sections, in the order they are rendered. Shared so the
 * connector's parser and the browser's editor cannot drift apart.
 */
export const CODE_MEMORY_SECTIONS = [
  { section: 'commands', heading: 'Commands' },
  { section: 'conventions', heading: 'Conventions' },
  { section: 'pitfalls', heading: 'Pitfalls' },
  { section: 'map', heading: 'Code map' },
] as const satisfies readonly { section: CodeMemorySection; heading: string }[];

/**
 * Markers around the block of recently-failed commands. The connector rebuilds
 * the block before every turn from the workspace metadata, so it has to be able
 * to replace exactly its own text and leave hand-written notes alone.
 */
export const FAILURES_BLOCK_START = '<!-- agent-engine:failures -->';
export const FAILURES_BLOCK_END = '<!-- /agent-engine:failures -->';

/**
 * Markers around the generated description of the project. Same reasoning as the
 * failures block, for a different writer: `/memory refresh` regenerates the
 * description, and it must replace only its own text — never prose someone added
 * above the sections.
 */
export const PROJECT_BLOCK_START = '<!-- agent-engine:project -->';
export const PROJECT_BLOCK_END = '<!-- /agent-engine:project -->';

/**
 * Marker pairs these blocks have been written under before, as
 * `[start, end]`. A notes file lives in the user's repository and is commonly
 * committed, so a rename cannot simply take effect: the old block would stop
 * matching, survive every regeneration, and sit next to the new one forever.
 * Stripped alongside the current pair, never written. Droppable once no
 * checkout can still hold one.
 */
export const LEGACY_BLOCK_MARKERS: readonly (readonly [string, string])[] = [
  ['<!-- aft:failures -->', '<!-- /aft:failures -->'],
  ['<!-- aft:project -->', '<!-- /aft:project -->'],
];
