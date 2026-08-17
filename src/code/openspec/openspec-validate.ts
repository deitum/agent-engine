import { type CodeSpecIssue, type CodeSpecTask } from '../../contracts';

import { type ParsedRequirement, sameTitle } from './openspec-parse';
import {
  CAPABILITY_PATTERN,
  MAX_DELTAS_PER_CHANGE,
  MAX_TASKS_PER_CHANGE,
} from './openspec.constants';

/** One capability's delta, as it arrives from the agent and reaches validation. */
export interface DeltaInput {
  capability: string;
  /** The delta file's markdown, verbatim. */
  markdown: string;
  requirements: ParsedRequirement[];
  /** Requirement titles the capability's spec already holds. */
  existingTitles: string[];
  /** False when the capability has no spec yet — every `MODIFIED` is then wrong. */
  specExists: boolean;
}

/** What {@link validateChange} is given: a proposal, before anything is written. */
export interface ChangeInput {
  proposal: string;
  tasks: CodeSpecTask[];
  deltas: DeltaInput[];
}

/**
 * Checks a change against the rules `openspec validate --strict` enforces
 * upstream, plus the two this product can check that the CLI cannot (a delta
 * against a capability that does not exist, a checklist nobody could work
 * through).
 *
 * The result travels in both directions from one call: `error` findings refuse
 * the proposal and are handed back to the agent as the text of a failed tool
 * call, so it revises instead of putting a broken change to the user; `warning`
 * findings are shown in the panel and let the change through. That is the whole
 * reason severity exists here — a rule nobody can act on is noise in a review.
 */
export function validateChange(change: ChangeInput): CodeSpecIssue[] {
  const issues: CodeSpecIssue[] = [];

  if (!change.proposal.trim()) {
    issues.push({
      severity: 'error',
      message: 'The proposal is empty — describe what changes and why.',
    });
  }

  if (change.tasks.length === 0) {
    issues.push({
      severity: 'error',
      message: '`tasks.md` holds no items — there would be nothing to implement.',
    });
  } else if (change.tasks.length > MAX_TASKS_PER_CHANGE) {
    issues.push({
      severity: 'error',
      message: `\`tasks.md\` holds ${change.tasks.length} items — more than ${MAX_TASKS_PER_CHANGE} will not fit in one change. Split it up.`,
    });
  }

  if (change.deltas.length === 0) {
    issues.push({
      severity: 'error',
      message:
        'There is no spec delta at all. Describe the requirements of at least one capability.',
    });
  } else if (change.deltas.length > MAX_DELTAS_PER_CHANGE) {
    issues.push({
      severity: 'error',
      message: `There are ${change.deltas.length} deltas — more than ${MAX_DELTAS_PER_CHANGE} in one change is never meaningful.`,
    });
  }

  const seen = new Set<string>();
  for (const delta of change.deltas) {
    issues.push(...validateDelta(delta, seen));
  }

  return issues;
}

/** Findings about one capability's delta. */
function validateDelta(delta: DeltaInput, seen: Set<string>): CodeSpecIssue[] {
  const issues: CodeSpecIssue[] = [];
  const path = `specs/${delta.capability}/spec.md`;

  if (!CAPABILITY_PATTERN.test(delta.capability)) {
    issues.push({
      severity: 'error',
      message: `«${delta.capability}» is not a capability name. kebab-case is expected: \`auth\`, \`order-history\`.`,
      path,
    });
    // Everything below reads the capability's spec by that name; there is
    // nothing further worth saying about a name that cannot be a folder.
    return issues;
  }

  if (seen.has(delta.capability)) {
    issues.push({
      severity: 'error',
      message: `Capability «${delta.capability}» is described twice — merge the deltas into one.`,
      path,
    });
  }
  seen.add(delta.capability);

  if (delta.requirements.length === 0) {
    issues.push({
      severity: 'error',
      message: `Delta «${delta.capability}» holds no requirements. It needs a heading like \`## ADDED Requirements\` and at least one \`### Requirement:\`.`,
      path,
    });
  }

  for (const requirement of delta.requirements) {
    issues.push(...validateRequirement(requirement, delta, path));
  }

  return issues;
}

/** Findings about one requirement inside a delta. */
function validateRequirement(
  requirement: ParsedRequirement,
  delta: DeltaInput,
  path: string,
): CodeSpecIssue[] {
  const issues: CodeSpecIssue[] = [];
  const named = `«${requirement.title}»`;

  // A requirement without a scenario is a wish: nothing about it can be
  // checked, before the change or after it. This is the rule the whole format
  // exists for, so it is an error rather than a warning.
  if (requirement.kind !== 'removed' && requirement.scenarios.length === 0) {
    issues.push({
      severity: 'error',
      message: `Requirement ${named} has no \`#### Scenario:\` — without a scenario it cannot be checked.`,
      path,
    });
  }

  for (const scenario of requirement.scenarios) {
    if (!/\bWHEN\b/i.test(scenario) || !/\bTHEN\b/i.test(scenario)) {
      issues.push({
        severity: 'warning',
        message: `A scenario of requirement ${named} has no \`- **WHEN**\` / \`- **THEN**\` — what is checked, and under what conditions, is unclear.`,
        path,
      });
    }
  }

  const exists = delta.existingTitles.some((title) => sameTitle(title, requirement.title));

  if (requirement.kind === 'added' && exists) {
    issues.push({
      severity: 'warning',
      message: `Requirement ${named} already exists in the «${delta.capability}» spec — this is probably \`MODIFIED\` rather than \`ADDED\`.`,
      path,
    });
  }

  if (requirement.kind !== 'added' && !exists) {
    const kind = requirement.kind === 'modified' ? 'MODIFIED' : 'REMOVED';
    issues.push({
      severity: 'error',
      message: delta.specExists
        ? `${kind} ${named}: the «${delta.capability}» spec holds no such requirement. Check the wording of the heading.`
        : `${kind} ${named}: capability «${delta.capability}» has no spec yet — there is nothing to change, start with \`ADDED\`.`,
      path,
    });
  }

  return issues;
}

/** True when any finding blocks the change. */
export function hasErrors(issues: CodeSpecIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'error');
}

/** The findings as a numbered list the agent can act on. */
export function formatIssues(issues: CodeSpecIssue[]): string {
  return issues
    .map((issue, index) => {
      const where = issue.path ? ` (${issue.path})` : '';
      return `${index + 1}. [${issue.severity === 'error' ? 'error' : 'warning'}] ${issue.message}${where}`;
    })
    .join('\n');
}
