import { randomUUID } from 'node:crypto';

import { CODE_PLAN_APPROVE, type CodeSpecChange, OPENSPEC_TOOLS } from '../../contracts';
import { type loadDeps, type PendingAnswers } from '../../deep-agent';
// `CodeEventSink` is imported type-only for the same reason `plan-mode.ts` does
// it: `code-agent` imports from here, so a value import would close a runtime
// cycle. `import type` cannot.
import type { CodeEventSink } from '../code-agent';
import { type PlanGuard } from '../plan-mode';

import {
  approveChange,
  archiveChange,
  createChange,
  type DeltaDraft,
  readChange,
  readSpecState,
  toggleTask,
} from './openspec-store';
import { formatIssues, hasErrors } from './openspec-validate';
import { ARTIFACT_MAX_CHARS } from './openspec.constants';

/** What every OpenSpec tool needs to reach the session it belongs to. */
export interface OpenspecToolContext {
  /** The checkout root — the OpenSpec tree lives under it. */
  dir: string;
  onEvent: CodeEventSink;
  /** The active change; the tools that act on one refuse without it. */
  changeId?: string;
}

/** Announces the session's new stage, with the change the panel should render. */
async function emitStage(context: OpenspecToolContext): Promise<void> {
  const state = await readSpecState(context.dir);
  context.onEvent({
    type: 'spec_stage',
    stage: state.stage,
    ...(state.active ? { change: state.active } : {}),
  });
}

/** Trims and caps one artefact; an over-long one is a refusal, not a truncation. */
function readArtifact(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length > ARTIFACT_MAX_CHARS) {
    throw new Error(
      `\`${field}\` is longer than ${ARTIFACT_MAX_CHARS} characters. This is a document for a person — shorten it.`,
    );
  }
  return text;
}

/** Reads the `deltas` argument, which the model gets wrong in exactly two ways. */
function readDeltas(value: unknown): DeltaDraft[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const delta = entry as { capability?: unknown; spec?: unknown };
    const capability = typeof delta.capability === 'string' ? delta.capability.trim() : '';
    const spec = typeof delta.spec === 'string' ? delta.spec : '';
    return capability && spec.trim() ? [{ capability, spec }] : [];
  });
}

const PROPOSE_DESCRIPTION = [
  'Put a finished OpenSpec change to the user for review and leave the research stage.',
  'Call this once — and only once — you have read the repository and know exactly what should change.',
  'You write four things: why the change matters (`proposal`), how it will be built (`design`, optional),',
  'the implementation checklist (`tasks`), and the spec deltas (`deltas`) that say what the system must do afterwards.',
  'The deltas are the point: every requirement needs at least one `#### Scenario:` with `- **WHEN**` / `- **THEN**`,',
  'or the change is refused and handed back to you.',
  'This blocks until the user answers. Approval lifts the read-only guard and you implement the change in this same turn;',
  'a rejection returns their comments and the workspace stays read-only.',
].join(' ');

const PROPOSE_SCHEMA = {
  type: 'object',
  properties: {
    id: {
      type: 'string',
      description:
        'Short kebab-case id of the change, used as its folder name: add-sso-login, drop-basic-auth.',
    },
    proposal: {
      type: 'string',
      description:
        'Markdown with `## Why` and `## What changes`. Written for the person who approves it, not as your own notes.',
    },
    design: {
      type: 'string',
      description:
        'Optional. Technical approach and the decisions behind it — only when the change has a real choice in it.',
    },
    tasks: {
      type: 'string',
      description:
        'Markdown checklist (`- [ ] …`), in implementation order, grouped under `##` headings. This is what you will work through after approval.',
    },
    deltas: {
      type: 'array',
      description: 'One entry per capability whose requirements the change touches.',
      items: {
        type: 'object',
        properties: {
          capability: {
            type: 'string',
            description: 'kebab-case capability name: auth, order-history, billing.',
          },
          spec: {
            type: 'string',
            description:
              'The delta file: `## ADDED Requirements` / `## MODIFIED Requirements` / `## REMOVED Requirements`, then `### Requirement: <name>` blocks, each with `#### Scenario:` blocks.',
          },
        },
        required: ['capability', 'spec'],
      },
    },
  },
  required: ['id', 'proposal', 'tasks', 'deltas'],
} as const;

/**
 * Builds the tool that drafts a change and blocks for the user's review.
 *
 * Structurally `exit_plan_mode` (`plan-mode.ts`), and deliberately so: it emits
 * its event and waits on the shared `pending` map, so the verdict arrives
 * through the existing `POST /code/answer` and no new endpoint is needed. What
 * it adds is the change itself — validated and written to disk **before** the
 * user is asked, so what they approve is what will be implemented, and refused
 * before anything is written when it is not well formed.
 */
export function buildProposeTool(
  tool: Awaited<ReturnType<typeof loadDeps>>['tool'],
  context: OpenspecToolContext,
  pending: PendingAnswers,
  signal: AbortSignal,
  guard: PlanGuard,
): unknown {
  return tool(
    async (args: Record<string, unknown>): Promise<string> => {
      let change: CodeSpecChange;
      try {
        const result = await createChange(context.dir, {
          id: typeof args.id === 'string' ? args.id : '',
          proposal: readArtifact(args.proposal, 'proposal'),
          design: readArtifact(args.design, 'design'),
          tasks: readArtifact(args.tasks, 'tasks'),
          deltas: readDeltas(args.deltas),
        });
        if (hasErrors(result.issues)) {
          // Nothing was written. The findings are the whole answer: they name
          // the file and the requirement, so the next attempt is a correction
          // rather than a guess.
          return [
            'The proposal was not accepted — fix it and call the tool again.',
            formatIssues(result.issues),
          ].join('\n');
        }
        change = result.change;
      } catch (error) {
        return `Could not write the change: ${error instanceof Error ? error.message : String(error)}`;
      }

      const id = randomUUID();
      context.onEvent({ type: 'spec_proposal', id, change });

      // Hoisted so it can be detached again: one signal lives for the whole turn,
      // and an agent that re-proposes would otherwise pile up listeners.
      let onAbort = (): void => {};
      let answer: string;
      try {
        answer = await new Promise<string>((resolve, reject) => {
          onAbort = () => reject(new Error('aborted'));
          if (signal.aborted) {
            onAbort();
            return;
          }
          pending.set(id, (result) => resolve(result.text));
          signal.addEventListener('abort', onAbort, { once: true });
        });
      } finally {
        signal.removeEventListener('abort', onAbort);
        pending.delete(id);
      }

      if (answer.trim() !== CODE_PLAN_APPROVE) {
        // The change stays on disk in `review`: the user's comments are about
        // *this* draft, and re-proposing under the same id replaces it.
        return [
          `The user did not approve change «${change.id}»: ${answer || '(no comment)'}.`,
          'The workspace is still read-only. Fix the proposal, the deltas or the tasks',
          `and call ${OPENSPEC_TOOLS.propose} again with the same id.`,
        ].join(' ');
      }

      await approveChange(context.dir, change.id);
      context.changeId = change.id;
      guard.release();
      await emitStage(context);

      const warnings = change.issues.length > 0 ? `\n${formatIssues(change.issues)}` : '';
      return [
        `Change «${change.id}» was approved. The workspace is writable again — implement it in this very turn.`,
        `Work down \`tasks.md\` from the top and call \`${OPENSPEC_TOOLS.task}\` after each finished item.`,
        `Stay inside what was approved: a new requirement is a new change.${warnings}`,
      ].join(' ');
    },
    { name: OPENSPEC_TOOLS.propose, description: PROPOSE_DESCRIPTION, schema: PROPOSE_SCHEMA },
  );
}

const TASK_DESCRIPTION = [
  "Tick one entry of the approved change's `tasks.md` off, right after you finished it — not in a batch at the end.",
  'The user watches this counter: it is how they know the change is progressing and how much is left.',
  'Ticking an entry you have not actually verified is worse than not ticking it.',
].join(' ');

const TASK_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'number', description: 'The entry number, counted from 1 down the file.' },
    done: {
      type: 'boolean',
      description: 'Omit or pass true to tick it; pass false to re-open one you had ticked.',
    },
  },
  required: ['id'],
} as const;

/** Builds the tool that moves the implementation checklist along. */
export function buildTaskTool(
  tool: Awaited<ReturnType<typeof loadDeps>>['tool'],
  context: OpenspecToolContext,
): unknown {
  return tool(
    async (args: Record<string, unknown>): Promise<string> => {
      const changeId = context.changeId;
      if (!changeId) {
        return 'This session has no active change — there is nothing to tick.';
      }
      const id = typeof args.id === 'number' ? args.id : Number(args.id);
      if (!Number.isInteger(id) || id < 1) {
        return 'Pass the item number from `tasks.md` — a whole number counting from 1.';
      }
      const done = args.done !== false;

      if (!(await toggleTask(context.dir, changeId, id, done))) {
        const change = await readChange(context.dir, changeId);
        return [
          `\`tasks.md\` has no item #${id} (there are ${change?.tasksTotal ?? 0}).`,
          'Re-read the file — the list may have changed.',
        ].join(' ');
      }

      await emitStage(context);
      const change = await readChange(context.dir, changeId);
      const left = (change?.tasksTotal ?? 0) - (change?.tasksDone ?? 0);
      if (left > 0) {
        return `Item #${id} is ticked. ${left} left.`;
      }
      return [
        `Item #${id} is ticked; there are no tasks left.`,
        `Run the project's checks and, if everything is green, call \`${OPENSPEC_TOOLS.archive}\`.`,
      ].join(' ');
    },
    { name: OPENSPEC_TOOLS.task, description: TASK_DESCRIPTION, schema: TASK_SCHEMA },
  );
}

const ARCHIVE_DESCRIPTION = [
  "Fold the approved change's deltas into the project's specs and file the change away.",
  'Call this only once every task is ticked and the project builds and tests clean —',
  'from here on the deltas are what the system is documented to do.',
].join(' ');

const ARCHIVE_SCHEMA = { type: 'object', properties: {} } as const;

/** Builds the tool that closes a change out. */
export function buildArchiveTool(
  tool: Awaited<ReturnType<typeof loadDeps>>['tool'],
  context: OpenspecToolContext,
): unknown {
  return tool(
    async (): Promise<string> => {
      const changeId = context.changeId;
      if (!changeId) {
        return 'This session has no active change — there is nothing to archive.';
      }
      const change = await readChange(context.dir, changeId);
      if (change && change.tasksDone < change.tasksTotal) {
        return `Not everything is done: ${change.tasksDone} of ${change.tasksTotal} items. It is too early to archive.`;
      }

      try {
        const { archivedAs } = await archiveChange(context.dir, changeId);
        context.changeId = undefined;
        await emitStage(context);
        return [
          `Change «${changeId}» was archived as ${archivedAs}; its requirements were merged into the project specs.`,
          'The next task starts a new change.',
        ].join(' ');
      } catch (error) {
        return `Could not archive: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    { name: OPENSPEC_TOOLS.archive, description: ARCHIVE_DESCRIPTION, schema: ARCHIVE_SCHEMA },
  );
}
