import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  CODE_MEMORY_SECTIONS,
  type CodeCommandFailure,
  type CodeMemoryFileInfo,
  type CodeMemoryManifest,
  type CodeMemoryKind,
  type CodeMemoryReport,
  type CodeMemorySection,
  type CodeMemorySectionInfo,
  type CodeMemoryWriteRequest,
  type CodeMemoryWriteResult,
  type CodeMemoryWriteStatus,
  FAILURES_BLOCK_END,
  FAILURES_BLOCK_START,
  LEGACY_BLOCK_MARKERS,
  PROJECT_BLOCK_END,
  PROJECT_BLOCK_START,
  REMEMBER_TOOL,
  SESSION_MEMORY_PATH,
} from '../contracts';
import { loadDeps } from '../deep-agent';
import { buildChatModel } from '../llm/chat-model';

import {
  CHARS_PER_TOKEN,
  FAILURE_COMMAND_MAX_CHARS,
  FAILURE_DETAIL_MAX_CHARS,
  FAILURES_HEADING,
  MAX_FAILURE_ENTRIES,
  MEMORY_ENTRY_MAX_CHARS,
  MEMORY_NOTES_MAX_CHARS,
  MEMORY_SECTION_MAX_CHARS,
} from './code-memory.constants';

/**
 * Memory files the repository may bring itself, in the order they are looked
 * for. Any one of them means the project already documents itself for agents, so
 * nothing is generated next to it.
 *
 * Lives here rather than in `code-setup.ts` because the bootstrap needs the
 * notes file and the notes file needs to know what the repository already has —
 * one direction only.
 */
export const REPO_MEMORY_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  '.github/copilot-instructions.md',
  '.cursorrules',
] as const;

/** Where the connector writes the memory it generates and the agent's notes. */
export const GENERATED_MEMORY_FILE = SESSION_MEMORY_PATH;

/** The notes file, split into the sections the `remember` tool writes into. */
export interface ParsedNotes {
  /** Everything before the first heading: the banner and any hand-written prose. */
  preamble: string;
  /** Body of each known section, verbatim (entries are bullet lines within it). */
  sections: Record<CodeMemorySection, string>;
  /**
   * Headings this parser does not own, in the order they appeared. Preserved so
   * a file someone edited by hand survives a round-trip untouched.
   */
  extra: { heading: string; body: string }[];
}

/** Heading text of a section, e.g. `pitfalls` → «Pitfalls». */
export function headingOf(section: CodeMemorySection): string {
  return CODE_MEMORY_SECTIONS.find((entry) => entry.section === section)?.heading ?? section;
}

/** The section a heading names, or `null` when it is one we do not own. */
function sectionOf(heading: string): CodeMemorySection | null {
  const wanted = heading.trim().toLowerCase();
  return (
    CODE_MEMORY_SECTIONS.find((entry) => entry.heading.toLowerCase() === wanted)?.section ?? null
  );
}

/** The banner every notes file opens with. */
export const NOTES_BANNER = [
  '<!-- Agent notes. This file lives outside git (.git/info/exclude) and never reaches a pull request. -->',
  '',
  '# Project memory',
  '',
  'The agent reads this file at the start of every turn, so it has to stay short:',
  'only what outlives the task belongs here — a non-obvious command, a convention, a trap,',
  'where something lives. Refer to files by path rather than copying their contents.',
].join('\n');

/**
 * A fresh notes file: the banner, an optional description of the project, then
 * the empty sections.
 *
 * The description uses `###` headings on purpose — {@link parseNotes} only owns
 * `##`, so everything the bootstrap generates stays in the preamble above the
 * sections and keeps its place no matter how many entries are appended later.
 */
export function renderFreshNotes(description = ''): string {
  const project = renderProjectBlock(description);
  return [
    NOTES_BANNER,
    ...(project ? [project] : []),
    ...CODE_MEMORY_SECTIONS.map((entry) => `## ${entry.heading}`),
  ].join('\n\n');
}

/** The generated description of the project, markers included. */
function renderProjectBlock(description: string): string {
  const body = description.trim();
  return body ? [PROJECT_BLOCK_START, body, PROJECT_BLOCK_END].join('\n') : '';
}

/** An empty body for every known section. */
function emptySections(): Record<CodeMemorySection, string> {
  return Object.fromEntries(CODE_MEMORY_SECTIONS.map((entry) => [entry.section, ''])) as Record<
    CodeMemorySection,
    string
  >;
}

/**
 * Splits a notes file into its sections. Deliberately forgiving: an unknown
 * heading, prose in the middle of a section, a missing section — all survive and
 * come back out of {@link renderNotes} unchanged. The file is a human-editable
 * document that a tool also writes to, and the tool must not eat what a person
 * put there.
 */
export function parseNotes(text: string): ParsedNotes {
  const parsed: ParsedNotes = { preamble: '', sections: emptySections(), extra: [] };
  const lines = text.split('\n');

  // Where the current run of lines is going: the preamble until the first
  // heading, then whichever section that heading opened.
  let target:
    | { kind: 'preamble' }
    | { kind: 'section'; section: CodeMemorySection }
    | {
        kind: 'extra';
        index: number;
      } = { kind: 'preamble' };
  const buffers: string[] = [];

  const flush = (): void => {
    const body = buffers.join('\n');
    buffers.length = 0;
    if (target.kind === 'preamble') {
      parsed.preamble = body;
    } else if (target.kind === 'section') {
      // A section repeated later in the file appends rather than replaces.
      const current = parsed.sections[target.section];
      parsed.sections[target.section] = current ? `${current}\n${body}` : body;
    } else {
      parsed.extra[target.index].body = body;
    }
  };

  for (const line of lines) {
    const heading = /^##\s+(.*)$/.exec(line);
    if (!heading) {
      buffers.push(line);
      continue;
    }
    flush();
    const section = sectionOf(heading[1]);
    if (section) {
      target = { kind: 'section', section };
    } else {
      parsed.extra.push({ heading: heading[1].trim(), body: '' });
      target = { kind: 'extra', index: parsed.extra.length - 1 };
    }
  }
  flush();
  return parsed;
}

/** Renders parsed notes back to markdown, sections in their canonical order. */
export function renderNotes(parsed: ParsedNotes): string {
  const parts = [trimBlank(parsed.preamble)];
  for (const { section, heading } of CODE_MEMORY_SECTIONS) {
    parts.push(`## ${heading}`, trimBlank(parsed.sections[section]));
  }
  for (const { heading, body } of parsed.extra) {
    parts.push(`## ${heading}`, trimBlank(body));
  }
  return `${parts.filter((part) => part !== '').join('\n\n')}\n`;
}

/** Drops leading/trailing blank lines while keeping the inner shape. */
function trimBlank(body: string): string {
  return body.replace(/^\s*\n/, '').replace(/\s+$/, '');
}

/**
 * Reduces a raw note to the single line that goes into the file: no bullet, no
 * newlines, no double spaces, capped. Multi-line prose in a bullet list breaks
 * both the parser's entry counting and the reader's eye.
 */
export function normalizeEntry(raw: string): string {
  // Trim before stripping the bullet: an indented «  - note» keeps its marker
  // otherwise, and the marker would then be part of the de-duplication key.
  const flat = raw
    .trim()
    .replace(/^[-*+]\s*/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return flat.length > MEMORY_ENTRY_MAX_CHARS
    ? `${flat.slice(0, MEMORY_ENTRY_MAX_CHARS).trimEnd()}…`
    : flat;
}

/**
 * The form two entries are compared in. Case and trailing punctuation differ
 * between two writings of the same fact far more often than the fact does, so
 * ignoring them is what makes de-duplication actually catch repeats.
 */
function entryKey(entry: string): string {
  return entry
    .toLowerCase()
    .replace(/[.;,!]+$/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** The bullet entries of a section body. */
export function entriesOf(body: string): string[] {
  return body
    .split('\n')
    .map((line) => /^\s*[-*+]\s+(.*)$/.exec(line)?.[1]?.trim() ?? '')
    .filter((entry) => entry.length > 0);
}

/** Outcome of an append: the new text, plus why nothing changed if it did not. */
export interface AppendResult {
  text: string;
  status: CodeMemoryWriteStatus;
}

/**
 * Appends one entry to a section, refusing a repeat and refusing to overflow the
 * budget. Both refusals are answers, not errors: the caller (the `remember` tool
 * or the `#` shortcut) tells the agent or the user what to do instead.
 *
 * The failures block is stripped before measuring and put back afterwards — it
 * is regenerated every turn from the workspace metadata, so charging the agent's
 * write budget for it would make the budget depend on how badly the last build
 * went.
 */
export function appendNote(text: string, section: CodeMemorySection, raw: string): AppendResult {
  const entry = normalizeEntry(raw);
  if (!entry) {
    return { text, status: 'duplicate' };
  }

  const { text: withoutFailures, block } = stripFailuresBlock(text);
  const parsed = parseNotes(withoutFailures);

  const key = entryKey(entry);
  const seen = Object.values(parsed.sections).flatMap((body) => entriesOf(body).map(entryKey));
  if (seen.includes(key)) {
    return { text, status: 'duplicate' };
  }

  const body = parsed.sections[section];
  const nextBody = body ? `${trimBlank(body)}\n- ${entry}` : `- ${entry}`;
  if (nextBody.length > MEMORY_SECTION_MAX_CHARS) {
    return { text, status: 'over-budget' };
  }

  const next = { ...parsed, sections: { ...parsed.sections, [section]: nextBody } };
  const rendered = renderNotes(next);
  if (writableChars(rendered) > MEMORY_NOTES_MAX_CHARS) {
    return { text, status: 'over-budget' };
  }
  return { text: insertBlock(rendered, block), status: 'ok' };
}

/** The injected block listing commands that failed recently, markers included. */
export function renderFailuresBlock(failures: CodeCommandFailure[]): string {
  if (failures.length === 0) {
    return '';
  }
  const rows = failures.map((failure) => {
    const code = failure.exitCode === null ? 'interrupted' : `exit ${failure.exitCode}`;
    return `- \`${failure.command}\` — ${code}${failure.detail ? `: ${failure.detail}` : ''}`;
  });
  return [
    FAILURES_BLOCK_START,
    `## ${FAILURES_HEADING}`,
    '',
    'These commands have already failed in this workspace. Do not retry them blindly — work out why,',
    `and once you know, record the conclusion under «${headingOf('pitfalls')}» with \`remember\`, and the entry leaves this block.`,
    '',
    ...rows,
    FAILURES_BLOCK_END,
  ].join('\n');
}

/**
 * Splits a generated block out of a notes file. Everything the connector writes
 * into a file a human also edits is fenced this way, so regenerating it replaces
 * exactly its own text and leaves the rest of the file alone.
 */
function stripBlock(
  text: string,
  startMarker: string,
  endMarker: string,
): {
  text: string;
  block: string;
} {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) {
    return { text, block: '' };
  }
  const block = text.slice(start, end + endMarker.length);
  const without = `${text.slice(0, start)}${text.slice(end + endMarker.length)}`;
  return { text: without.replace(/\n{3,}/gu, '\n\n'), block };
}

/**
 * Inserts a generated block directly before the first section, i.e. after the
 * banner and any hand-written preamble. A warning the reader meets below four
 * sections of notes is a warning they have already scrolled past.
 */
function insertBlock(text: string, block: string): string {
  if (!block) {
    return text;
  }
  const at = text.search(/^##\s+/mu);
  if (at === -1) {
    return `${text.replace(/\s+$/u, '')}\n\n${block}\n`;
  }
  return `${text.slice(0, at)}${block}\n\n${text.slice(at)}`;
}

/**
 * Drops any block left under a marker pair this engine no longer writes. Run on
 * the way into every strip, so a notes file written by an older build is cleaned
 * up the first time it is regenerated instead of accumulating a second copy.
 */
function stripLegacyBlocks(text: string): string {
  return LEGACY_BLOCK_MARKERS.reduce(
    (carry, [start, end]) => stripBlock(carry, start, end).text,
    text,
  );
}

/** Splits the generated failures block off a notes file. */
export function stripFailuresBlock(text: string): { text: string; block: string } {
  return stripBlock(stripLegacyBlocks(text), FAILURES_BLOCK_START, FAILURES_BLOCK_END);
}

/** Splits the generated project description off a notes file. */
export function stripProjectBlock(text: string): { text: string; block: string } {
  return stripBlock(stripLegacyBlocks(text), PROJECT_BLOCK_START, PROJECT_BLOCK_END);
}

/** Replaces (or removes) the failures block, leaving everything else in place. */
export function applyFailuresBlock(text: string, failures: CodeCommandFailure[]): string {
  const { text: without } = stripFailuresBlock(text);
  return insertBlock(without, renderFailuresBlock(failures));
}

/**
 * The part of a notes file that counts against the write budget: everything the
 * connector generates is excluded, so how much room the agent has left does not
 * depend on how badly the last build went.
 */
export function writableChars(text: string): number {
  return stripProjectBlock(stripFailuresBlock(text).text).text.trim().length;
}

/** Per-section entry counts and sizes of a notes file. */
export function sectionsOf(text: string): CodeMemorySectionInfo[] {
  const parsed = parseNotes(stripFailuresBlock(text).text);
  return CODE_MEMORY_SECTIONS.map(({ section }) => {
    const body = trimBlank(parsed.sections[section]);
    return { section, entries: entriesOf(body).length, chars: body.length };
  });
}

/** Estimated tokens of a string, by the same ratio deepagents uses internally. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Reads a checkout-relative file, or `null` when absent / unreadable. */
function readIfPresent(dir: string, relPath: string): string | null {
  try {
    return readFileSync(join(dir, relPath), 'utf8');
  } catch {
    return null;
  }
}

/** The repository's own memory file, when it ships one. */
export function findRepoMemory(dir: string): string | null {
  return REPO_MEMORY_FILES.find((file) => existsSync(join(dir, file))) ?? null;
}

/**
 * The memory paths handed to deepagents' `memory` option, most general first.
 * Derived from the checkout rather than fixed, so a repository that documents
 * itself and one that does not both get exactly the files that exist.
 */
export function memorySources(dir: string): string[] {
  const repo = findRepoMemory(dir);
  return [...(repo ? [`/${repo}`] : []), `/${SESSION_MEMORY_PATH}`];
}

/**
 * Creates the notes file when the checkout has none, so the instruction telling
 * the agent to record what it learns always has somewhere to land — including in
 * a repository that already ships its own `AGENTS.md`.
 */
export async function ensureNotesFile(dir: string, description = ''): Promise<void> {
  const target = join(dir, SESSION_MEMORY_PATH);
  if (existsSync(target)) {
    return;
  }
  await writeNotesFile(dir, renderFreshNotes(description));
}

/**
 * Replaces the generated project description while keeping every entry the agent
 * (or the user) wrote. Regenerating the description is a routine act — `/memory
 * refresh` after switching branches — and it must not cost the session the
 * lessons it has accumulated.
 */
export function withDescription(text: string, description: string): string {
  const { text: withoutFailures, block: failures } = stripFailuresBlock(text);
  const { text: bare } = stripProjectBlock(withoutFailures);
  const withProject = insertBlock(bare.trimEnd(), renderProjectBlock(description));
  return insertBlock(withProject, failures);
}

/** Writes the notes file, creating `.agent-engine/` on the way. */
export async function writeNotesFile(dir: string, text: string): Promise<void> {
  const target = join(dir, SESSION_MEMORY_PATH);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${text.replace(/\s+$/u, '')}\n`, 'utf8');
}

/** Rewrites the notes file's failures block from the workspace metadata. */
export async function syncFailuresBlock(
  dir: string,
  failures: CodeCommandFailure[],
): Promise<void> {
  const target = join(dir, SESSION_MEMORY_PATH);
  const current = readIfPresent(dir, SESSION_MEMORY_PATH);
  if (current === null) {
    return;
  }
  const next = applyFailuresBlock(current, failures);
  if (next !== current) {
    await writeFile(target, next, 'utf8');
  }
}

/** What one memory file costs, as it reaches the prompt. */
function fileInfo(dir: string, kind: 'repo' | 'notes', relPath: string): CodeMemoryFileInfo {
  const content = readIfPresent(dir, relPath);
  const chars = content?.length ?? 0;
  return {
    kind,
    path: relPath,
    exists: content !== null,
    chars,
    tokens: estimateTokens(content ?? ''),
    ...(kind === 'notes' && content !== null ? { sections: sectionsOf(content) } : {}),
  };
}

/** The cost of everything injected as memory, per file and per section. */
export function memoryManifest(dir: string, failures: CodeCommandFailure[]): CodeMemoryManifest {
  const repo = findRepoMemory(dir);
  const files = [
    ...(repo ? [fileInfo(dir, 'repo', repo)] : []),
    fileInfo(dir, 'notes', SESSION_MEMORY_PATH),
  ];
  const notes = readIfPresent(dir, SESSION_MEMORY_PATH) ?? '';
  return {
    files,
    totalChars: files.reduce((sum, file) => sum + file.chars, 0),
    totalTokens: files.reduce((sum, file) => sum + file.tokens, 0),
    notesBudgetChars: MEMORY_NOTES_MAX_CHARS,
    overBudget: writableChars(notes) > MEMORY_NOTES_MAX_CHARS,
    failures,
  };
}

/** JSON Schema of the {@link REMEMBER_TOOL} arguments. */
const REMEMBER_SCHEMA = {
  type: 'object',
  properties: {
    section: {
      type: 'string',
      enum: CODE_MEMORY_SECTIONS.map((entry) => entry.section),
      description:
        'commands — a command you verified; conventions — a project convention; pitfalls — a trap or an error you worked out; map — where something lives.',
    },
    text: {
      type: 'string',
      description:
        'One line that will be useful in a later session. No preamble, no retelling of the current task.',
    },
  },
  required: ['section', 'text'],
} as const;

/** What the coding agent's memory-write tool needs to do its job. */
export interface RememberToolContext {
  dir: string;
  /** Reads the journal so a written lesson can retire the matching failure. */
  failures: () => Promise<CodeCommandFailure[]>;
  /** Drops the journal entries a lesson covers. */
  clearFailures: (lesson: string) => Promise<void>;
}

/**
 * Builds the coding agent's memory-write tool.
 *
 * The agent could reach the notes file with `write_file`, and that is exactly the
 * problem: memory is injected into the system prompt on every single turn, so an
 * unbounded file is a permanent cost, and a file with no structure cannot be
 * de-duplicated. Routing writes through a tool makes the budget and the repeat
 * check visible to the writer — a refusal it can act on, rather than a file that
 * quietly grows until it is worthless.
 */
export function buildRememberTool(
  tool: Awaited<ReturnType<typeof loadDeps>>['tool'],
  context: RememberToolContext,
): unknown {
  return tool(
    async (args: Record<string, unknown>): Promise<string> => {
      const section = CODE_MEMORY_SECTIONS.find((entry) => entry.section === args.section)?.section;
      const text = typeof args.text === 'string' ? args.text : '';
      if (!section) {
        return `Unknown section. Allowed: ${CODE_MEMORY_SECTIONS.map((entry) => entry.section).join(', ')}.`;
      }
      const entry = normalizeEntry(text);
      if (!entry) {
        return 'The note is empty — there is nothing to write.';
      }

      const current = readIfPresent(context.dir, SESSION_MEMORY_PATH);
      if (current === null) {
        return 'The notes file is unavailable, so nothing was written.';
      }

      const result = appendNote(current, section, entry);
      if (result.status === 'duplicate') {
        return `Already recorded (or nothing new): «${entry}». Do not duplicate — if the wording is stale, edit the notes file as an ordinary file.`;
      }
      if (result.status === 'over-budget') {
        return `Memory is full (the limit is ${MEMORY_NOTES_MAX_CHARS} characters of notes and ${MEMORY_SECTION_MAX_CHARS} per section). Delete or merge stale entries under «${headingOf(section)}» and try again.`;
      }

      await writeNotesFile(context.dir, result.text);
      // A lesson about a command that was failing retires it from the journal:
      // the point of writing the lesson is that the warning is no longer news.
      if (section === 'pitfalls') {
        const before = await context.failures();
        if (before.length > 0) {
          await context.clearFailures(entry);
        }
      }
      return `Recorded under «${headingOf(section)}»: ${entry}`;
    },
    {
      name: REMEMBER_TOOL,
      description:
        'Remember one fact about the project for later (memory is read at the start of every turn). Durable things only: a non-obvious command, a convention, an error you worked out, where something lives. Duplicates and anything over budget are refused.',
      schema: REMEMBER_SCHEMA,
    },
  );
}

/** Both memory files with their text, for the editor. */
export function readMemoryReport(dir: string, failures: CodeCommandFailure[]): CodeMemoryReport {
  const manifest = memoryManifest(dir, failures);
  return {
    manifest,
    files: manifest.files.map((file) => ({
      kind: file.kind,
      path: file.path,
      exists: file.exists,
      content: readIfPresent(dir, file.path) ?? '',
    })),
  };
}

/** Resolves a memory kind to the one path it may touch. */
function pathOfKind(dir: string, kind: CodeMemoryKind): string | null {
  if (kind === 'notes') {
    return SESSION_MEMORY_PATH;
  }
  // `repo` is whichever file the repository actually ships; creating `AGENTS.md`
  // in a repository that has none is a tracked change and the UI asks first.
  return findRepoMemory(dir) ?? REPO_MEMORY_FILES[0];
}

/**
 * Applies one memory write and returns the refreshed report. The path is derived
 * from a closed set of kinds, so no caller-supplied path ever reaches the
 * filesystem.
 */
export async function writeMemory(
  dir: string,
  request: CodeMemoryWriteRequest,
  context: {
    failures: () => Promise<CodeCommandFailure[]>;
    clearFailures: (lesson: string) => Promise<void>;
    tidy: (text: string) => Promise<string>;
  },
): Promise<CodeMemoryWriteResult> {
  const relPath = pathOfKind(dir, request.kind);
  if (relPath === null) {
    return { status: 'ok', report: readMemoryReport(dir, await context.failures()) };
  }
  const target = join(dir, relPath);
  const current = readIfPresent(dir, relPath) ?? '';
  let status: CodeMemoryWriteStatus = 'ok';

  if (request.op === 'append') {
    const section = CODE_MEMORY_SECTIONS.find(
      (entry) => entry.section === request.section,
    )?.section;
    const entry = normalizeEntry(request.text ?? '');
    if (!section || !entry) {
      status = 'duplicate';
    } else if (request.kind === 'notes') {
      const result = appendNote(current || renderFreshNotes(), section, entry);
      status = result.status;
      if (result.status === 'ok') {
        await writeNotesFile(dir, result.text);
        if (section === 'pitfalls') {
          await context.clearFailures(entry);
        }
      }
    } else {
      // The repository's own file has no sections we own; append as a plain line.
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, `${current.replace(/\s+$/u, '')}\n- ${entry}\n`, 'utf8');
    }
  } else if (request.op === 'write') {
    const text = request.text ?? '';
    if (request.kind === 'notes' && writableChars(text) > MEMORY_NOTES_MAX_CHARS) {
      status = 'over-budget';
    } else if (request.kind === 'notes') {
      await writeNotesFile(dir, text);
    } else {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, `${text.replace(/\s+$/u, '')}\n`, 'utf8');
    }
  } else {
    await tidyNotes(dir, current, context.tidy);
  }

  return { status, report: readMemoryReport(dir, await context.failures()) };
}

/** The system prompt of the tidy-up. */
const TIDY_SYSTEM = [
  'You are tidying an engineering agent’s memory file. The input is markdown with sections',
  `${CODE_MEMORY_SECTIONS.map((entry) => `«${entry.heading}»`).join(', ')}.`,
  'Return ONLY that same file, in the same format (the same `##` headings, entries as `- ` bullets):',
  '- merge entries about the same thing into one;',
  '- drop anything that contradicts another entry or is plainly stale;',
  '- shorten the wording without losing facts (commands, paths, names);',
  '- invent nothing and add nothing of your own.',
  'No explanation before or after the file.',
].join('\n');

/**
 * One model call that merges duplicates and shortens the notes. Returns the
 * proposed file; the caller decides whether to accept it.
 */
export async function tidyMemoryText(
  request: CodeMemoryWriteRequest,
  text: string,
): Promise<string> {
  const llm = request.llm;
  if (!llm) {
    return '';
  }
  const { ChatOpenAI } = await loadDeps();
  const model = buildChatModel(ChatOpenAI, llm);
  const response = await model.invoke([
    { role: 'system', content: TIDY_SYSTEM },
    { role: 'user', content: text },
  ]);
  return flattenContent(response.content);
}

/** Flattens a LangChain message `content` (string or block array) to text. */
function flattenContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((block) =>
      block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : '',
    )
    .join('');
}

/**
 * Merges duplicates and drops what has gone stale, using one model call.
 *
 * Guarded deterministically: a tidy-up that came back *longer* than what went in
 * did not tidy anything, and a model that returns prose instead of the file would
 * otherwise silently replace the session's memory with an essay about it.
 */
async function tidyNotes(
  dir: string,
  current: string,
  tidy: (text: string) => Promise<string>,
): Promise<void> {
  const { text: bare, block: failures } = stripFailuresBlock(current);
  const { text: writable, block: project } = stripProjectBlock(bare);
  if (writableChars(current) === 0) {
    return;
  }

  const next = (await tidy(writable)).trim();
  const parsed = parseNotes(next);
  const hasEntries = CODE_MEMORY_SECTIONS.some(
    (entry) => entriesOf(parsed.sections[entry.section]).length > 0,
  );
  if (!next || !hasEntries || next.length >= writable.trim().length) {
    return;
  }

  await writeNotesFile(dir, insertBlock(insertBlock(renderNotes(parsed), project), failures));
}

/**
 * Normalises one recorded failure: a command and a single readable line of
 * output. The full log is already in the transcript — what memory needs is
 * enough to recognise the same mistake, not to re-read it.
 */
export function toFailure(
  command: string,
  exitCode: number | null,
  output: string,
): CodeCommandFailure {
  const detail =
    output
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';
  return {
    command: command.slice(0, FAILURE_COMMAND_MAX_CHARS),
    exitCode,
    detail: detail.slice(0, FAILURE_DETAIL_MAX_CHARS),
    at: Date.now(),
  };
}

/**
 * Adds a failure to the journal: the same command re-failing refreshes its entry
 * instead of adding a second one, and the list is capped so an agent stuck in a
 * loop cannot fill the prompt with one mistake.
 */
export function addFailure(
  failures: CodeCommandFailure[],
  failure: CodeCommandFailure,
): CodeCommandFailure[] {
  const rest = failures.filter((entry) => entry.command !== failure.command);
  return [...rest, failure].slice(-MAX_FAILURE_ENTRIES);
}

/**
 * Drops the journal entries a lesson covers. Matching is by substring both ways
 * so «`gradle test` fails without --no-daemon» clears the recorded `gradle test`:
 * the agent writes the lesson in its own words, not the command verbatim.
 */
export function clearFailures(
  failures: CodeCommandFailure[],
  lesson: string,
): CodeCommandFailure[] {
  const text = lesson.toLowerCase();
  return failures.filter((entry) => !text.includes(entry.command.toLowerCase()));
}
