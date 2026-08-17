import {
  type CodeSpecDeltaKind,
  type CodeSpecRequirement,
  type CodeSpecTask,
  OPENSPEC_DELTA_HEADINGS,
} from '../../contracts';

/**
 * A requirement plus the markdown it was read from.
 *
 * The block is kept verbatim because archiving a change **moves text**: an
 * approved `MODIFIED` requirement replaces the one in the capability's spec
 * word for word. Re-rendering it from `title` + `scenarios` would quietly drop
 * the prose between them — which is where the requirement itself is written.
 */
export interface ParsedRequirement extends CodeSpecRequirement {
  /** The whole `### Requirement:` block, its heading included. */
  raw: string;
}

/** `## ADDED Requirements` and friends — the heading that switches the kind. */
const KIND_HEADING = /^##\s+(ADDED|MODIFIED|REMOVED)\s+Requirements\s*$/i;

/** `### Requirement: <title>` — where a requirement block starts. */
const REQUIREMENT_HEADING = /^###\s+Requirement:\s*(.+?)\s*$/;

/** `#### Scenario: <title>` — where a scenario block starts. */
const SCENARIO_HEADING = /^####\s+Scenario:\s*(.+?)\s*$/;

/** Any heading of level 1–3: it ends the requirement block that was open. */
const BLOCK_BOUNDARY = /^#{1,3}\s/;

/** `- [ ] text` / `- [x] text`, with the marker captured. */
const TASK_LINE = /^(\s*[-*]\s+\[)([ xX])(\]\s*)(.*)$/;

/** `## Section` — the heading a checklist item is filed under. */
const SECTION_HEADING = /^##+\s+(.+?)\s*$/;

/** The heading text of each delta kind, lower-cased for lookup. */
const KIND_BY_HEADING: ReadonlyMap<string, CodeSpecDeltaKind> = new Map(
  Object.entries(OPENSPEC_DELTA_HEADINGS).map(([kind, heading]) => [
    heading.toLowerCase(),
    kind as CodeSpecDeltaKind,
  ]),
);

/**
 * Reads the requirements out of a spec or delta file.
 *
 * `defaultKind` is what a requirement written before any `## ADDED Requirements`
 * heading counts as — `added` for a capability's own spec, which has no kind
 * headings at all because everything in it is simply true.
 */
export function parseRequirements(
  markdown: string,
  defaultKind: CodeSpecDeltaKind = 'added',
): ParsedRequirement[] {
  const lines = markdown.split('\n');
  const requirements: ParsedRequirement[] = [];
  let kind = defaultKind;
  let open: { title: string; kind: CodeSpecDeltaKind; lines: string[] } | null = null;

  /** Closes the block that was open, if any, and files it. */
  const close = (): void => {
    if (!open) {
      return;
    }
    const raw = open.lines.join('\n').replace(/\s+$/, '');
    requirements.push({
      kind: open.kind,
      title: open.title,
      scenarios: parseScenarios(open.lines),
      raw,
    });
    open = null;
  };

  for (const line of lines) {
    const heading = KIND_HEADING.exec(line);
    if (heading) {
      close();
      kind = KIND_BY_HEADING.get(`${heading[1].toLowerCase()} requirements`) ?? defaultKind;
      continue;
    }

    const requirement = REQUIREMENT_HEADING.exec(line);
    if (requirement) {
      close();
      open = { title: requirement[1], kind, lines: [line] };
      continue;
    }

    if (open) {
      // Any other heading of level 1–3 ends the block; a `####` scenario does not.
      if (BLOCK_BOUNDARY.test(line)) {
        close();
        continue;
      }
      open.lines.push(line);
    }
  }
  close();

  return requirements;
}

/** The `#### Scenario:` blocks inside one requirement's lines, verbatim. */
function parseScenarios(lines: string[]): string[] {
  const scenarios: string[] = [];
  let open: string[] | null = null;

  for (const line of lines) {
    if (SCENARIO_HEADING.test(line)) {
      if (open) {
        scenarios.push(open.join('\n').replace(/\s+$/, ''));
      }
      open = [line];
      continue;
    }
    if (open) {
      open.push(line);
    }
  }
  if (open) {
    scenarios.push(open.join('\n').replace(/\s+$/, ''));
  }

  return scenarios;
}

/** Drops the `raw` block, leaving what travels over the wire. */
export function toRequirement(parsed: ParsedRequirement): CodeSpecRequirement {
  return { kind: parsed.kind, title: parsed.title, scenarios: parsed.scenarios };
}

/** Reads a `tasks.md` checklist. Ids are positional — see {@link CodeSpecTask.id}. */
export function parseTasks(markdown: string): CodeSpecTask[] {
  const tasks: CodeSpecTask[] = [];
  let section: string | undefined;
  let id = 0;

  for (const line of markdown.split('\n')) {
    const item = TASK_LINE.exec(line);
    if (item) {
      id += 1;
      tasks.push({
        id,
        text: item[4].trim(),
        done: item[2] !== ' ',
        ...(section ? { section } : {}),
      });
      continue;
    }
    // Only a heading that is not itself a checklist item may open a section, so
    // this is checked second.
    const heading = SECTION_HEADING.exec(line);
    if (heading) {
      section = heading[1];
    }
  }

  return tasks;
}

/**
 * Flips one checklist entry in place, returning the rewritten file — or `null`
 * when the file has no entry with that id.
 *
 * Rewriting the one line rather than re-rendering the file is the point: the
 * checklist is a document someone may have written notes into, and a round trip
 * through a parsed model would return it as a bare list.
 */
export function setTaskDone(markdown: string, id: number, done: boolean): string | null {
  const lines = markdown.split('\n');
  let seen = 0;
  let found = false;

  const next = lines.map((line) => {
    const item = TASK_LINE.exec(line);
    if (!item) {
      return line;
    }
    seen += 1;
    if (seen !== id) {
      return line;
    }
    found = true;
    return `${item[1]}${done ? 'x' : ' '}${item[3]}${item[4]}`;
  });

  return found ? next.join('\n') : null;
}

/** The `# Heading` a document opens with, for a change's human title. */
export function titleOf(markdown: string): string {
  for (const line of markdown.split('\n')) {
    const heading = /^#\s+(.+?)\s*$/.exec(line);
    if (heading) {
      return heading[1];
    }
  }
  return '';
}

/**
 * Folds a change's approved requirements into a capability's spec.
 *
 * `ADDED` and `MODIFIED` are treated the same on arrival — replace the block
 * with this title, append it when there is none. Deliberately: the difference
 * between them is a claim about the *previous* state, which validation already
 * checked, and applying them differently here would mean an `ADDED` that turned
 * out to exist either duplicates a requirement or fails at the last step, after
 * the user approved it. `REMOVED` drops the block.
 */
export function mergeIntoSpec(
  specMarkdown: string,
  capability: string,
  requirements: ParsedRequirement[],
): string {
  const existing = parseRequirements(specMarkdown, 'added');
  const header = headerOf(specMarkdown, capability, existing);

  const blocks = existing.map((entry) => ({ title: entry.title, raw: entry.raw }));
  for (const requirement of requirements) {
    const at = blocks.findIndex((block) => sameTitle(block.title, requirement.title));
    if (requirement.kind === 'removed') {
      if (at >= 0) {
        blocks.splice(at, 1);
      }
      continue;
    }
    // The block is re-emitted without the kind heading it sat under: in a
    // capability's own spec every requirement is simply current.
    const block = { title: requirement.title, raw: requirement.raw };
    if (at >= 0) {
      blocks[at] = block;
    } else {
      blocks.push(block);
    }
  }

  return `${header}\n\n${blocks.map((block) => block.raw).join('\n\n')}\n`.replace(
    /\n{3,}/g,
    '\n\n',
  );
}

/**
 * Everything before the first requirement — the title and whatever prose the
 * capability opens with — or a skeleton when the file has neither.
 */
function headerOf(specMarkdown: string, capability: string, existing: ParsedRequirement[]): string {
  const skeleton = `# ${capability}\n\n## Requirements`;
  if (existing.length === 0) {
    return specMarkdown.trim() || skeleton;
  }

  const lines = specMarkdown.split('\n');
  const at = lines.findIndex((line) => REQUIREMENT_HEADING.test(line));
  // A file that opens straight on a requirement has no header to keep, and one
  // whose header is only blank lines is the same case.
  const header = at > 0 ? lines.slice(0, at).join('\n').replace(/\s+$/, '') : '';
  return header || skeleton;
}

/** Requirement titles match case- and whitespace-insensitively. */
export function sameTitle(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}
