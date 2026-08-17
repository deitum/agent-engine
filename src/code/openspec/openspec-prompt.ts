import { type CodeSpecStage, OPENSPEC_DIR, OPENSPEC_TOOLS } from '../../contracts';

/** What the prompt needs to know about where the session stands. */
export interface OpenspecPromptFacts {
  stage: CodeSpecStage;
  /** The active change, when there is one. */
  changeId?: string;
  tasksTotal?: number;
  tasksDone?: number;
  /** Capabilities the specs already describe, so the agent reuses their names. */
  capabilities?: string[];
}

/** The header every stage shares: where the process lives and what it is for. */
function preamble(facts: OpenspecPromptFacts): string[] {
  const capabilities = facts.capabilities?.length
    ? `Capabilities already described: ${facts.capabilities.join(', ')}. To change existing behaviour take a name from this list rather than inventing a synonym.`
    : 'The specs are empty so far — the first change creates the first capabilities.';
  return [
    '',
    'WORKING THROUGH THE OpenSpec PROCESS',
    `This session works from specs. The process lives in \`${OPENSPEC_DIR}/\` (outside git): \`specs/<capability>/spec.md\` is what the system does today, \`changes/<id>/\` is a proposed change.`,
    'The process files are not edited through `write_file`/`edit_file` — only with the tools below: they check the format, measure a delta against the current spec, and move the stage.',
    capabilities,
  ];
}

/** The research stage: read-only, and the exit is a proposal. */
function proposalBlock(facts: OpenspecPromptFacts): string[] {
  return [
    ...preamble(facts),
    '',
    'Stage: PROPOSAL. The workspace is read-only, and that is enforced: `write_file`, `edit_file`, deletion and any mutating shell command will be refused. The refusal is the rule of this stage, not a broken tool.',
    '',
    '1. Understand the task and the code by reading alone: `read_file`, `glob`, `grep`, `ls`, read-only git.',
    '2. If the requirements allow more than one reading, settle it with `ask_user` BEFORE writing the proposal.',
    `3. Assemble the change and call \`${OPENSPEC_TOOLS.propose}\`:`,
    '   - `proposal` — `## Why` and `## What changes`, for the person who will approve it;',
    '   - `design` — only when the change involves a genuine architectural choice;',
    '   - `tasks` — a `- [ ] …` checklist in the order of work; it is what you will follow afterwards;',
    '   - `deltas` — one entry per capability.',
    '',
    'The delta format (this is its substance, not decoration):',
    '```markdown',
    '## ADDED Requirements',
    '',
    '### Requirement: Sign in with SSO',
    'The system SHALL let a user in through corporate SSO.',
    '',
    '#### Scenario: A successful sign-in',
    '- **WHEN** the user opens /login',
    '- **THEN** they are redirected to the provider',
    '```',
    'Every requirement needs at least one `#### Scenario:` with `- **WHEN**` and `- **THEN**`; without a scenario a requirement cannot be checked and the change is refused. `MODIFIED` and `REMOVED` refer to a requirement the spec already holds — the heading has to match word for word.',
    '',
    'Approval lifts the lock within this very turn — start implementing at once. If it was not approved you will get the objections back: fix them and propose again.',
  ];
}

/** The implementation stage: the checklist is the plan, and it is not yours to widen. */
function implementBlock(facts: OpenspecPromptFacts): string[] {
  const total = facts.tasksTotal ?? 0;
  const done = facts.tasksDone ?? 0;
  return [
    ...preamble(facts),
    '',
    `Stage: IMPLEMENTATION. Active change: \`${facts.changeId ?? '—'}\`, ${done} of ${total} items done.`,
    `Read \`${OPENSPEC_DIR}/changes/${facts.changeId ?? '<id>'}/tasks.md\` and work down it from the top.`,
    `After each finished item call \`${OPENSPEC_TOOLS.task}\` with its number, right away rather than in a batch at the end: that counter is how the user sees progress.`,
    'Ticking an item you have not verified is worse than not ticking it.',
    '',
    'The bounds of what was approved: a new requirement is a new change.',
    '- if you find another requirement is needed, do not implement it silently; say so and propose a separate change;',
    '- if an item turns out to be impossible, do not drop it — explain through `ask_user` what to do;',
    `- when every item is closed, run the project's checks and call \`${OPENSPEC_TOOLS.archive}\` — it merges the deltas into the specs and closes the change.`,
  ];
}

/** Everything is done: the only thing left is to close it out. */
function archiveBlock(facts: OpenspecPromptFacts): string[] {
  return [
    ...preamble(facts),
    '',
    `Stage: ARCHIVE. Every item of change \`${facts.changeId ?? '—'}\` is closed.`,
    `Run the project's tests and build. If everything is green, \`${OPENSPEC_TOOLS.archive}\`; if not, fix it, and put an item that is not actually done back into work with \`${OPENSPEC_TOOLS.task}\` and \`done: false\`.`,
  ];
}

/**
 * The OpenSpec block appended to the coding prompt, written for the stage the
 * session is actually in.
 *
 * Stage-specific rather than one block describing the whole process: the agent
 * reads this on every turn, and instructions for a stage it is not in are both a
 * standing token cost and an invitation to do the wrong step next.
 */
export function openspecPromptBlock(facts: OpenspecPromptFacts): string {
  switch (facts.stage) {
    case 'implement':
      return implementBlock(facts).join('\n');
    case 'archive':
      return archiveBlock(facts).join('\n');
    // `idle` and `review` are the same instruction: nothing is approved, so the
    // work of this turn is to produce (or repair) a proposal.
    default:
      return proposalBlock(facts).join('\n');
  }
}
