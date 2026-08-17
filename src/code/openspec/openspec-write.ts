import { type CodeSpecWriteRequest, type CodeSpecWriteResult } from '../../contracts';

import {
  activateChange,
  archiveChange,
  discardChange,
  exportToRepo,
  initOpenspec,
  isInitialized,
  readState,
  readSpecState,
  toggleTask,
  writeArtifact,
} from './openspec-store';

/**
 * Carries out one `POST /code/spec` and answers with the refreshed state.
 *
 * The panel's every action goes through here rather than through its own
 * endpoint, for the same reason `/code/memory` is one route with an `op`: they
 * all read and rewrite the same tree, and the caller always wants the whole
 * state back afterwards — a change that was archived also emptied `changes/`,
 * moved the stage and grew the capability list.
 *
 * A refusal comes back as `ok: false` with a sentence, not as an HTTP error: the
 * user asked for something the tree does not allow (archiving nothing, writing
 * into a change that is gone), which is an answer rather than a failure.
 */
export async function writeSpec(
  dir: string,
  request: CodeSpecWriteRequest,
): Promise<CodeSpecWriteResult> {
  try {
    const message = await apply(dir, request);
    return { ok: true, ...(message ? { message } : {}), state: await readSpecState(dir) };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      state: await readSpecState(dir),
    };
  }
}

/** Runs the operation, returning what to tell the user when it is worth saying. */
async function apply(dir: string, request: CodeSpecWriteRequest): Promise<string | undefined> {
  // Every operation but `init` needs the tree, and every one but `init` and
  // `activate` needs a change to act on.
  if (request.op !== 'init' && !isInitialized(dir)) {
    throw new Error(
      'This session has no openspec yet — create the process before working with it.',
    );
  }

  switch (request.op) {
    case 'init':
      await initOpenspec(dir);
      return 'The OpenSpec process was created.';

    case 'activate': {
      if (!request.changeId) {
        throw new Error('No change was given.');
      }
      await activateChange(dir, request.changeId);
      return undefined;
    }

    case 'write': {
      if (!request.artifact) {
        throw new Error('No artefact to write was named.');
      }
      await writeArtifact(
        dir,
        await resolveChangeId(dir, request.changeId),
        request.artifact,
        request.content ?? '',
      );
      return undefined;
    }

    case 'task': {
      if (typeof request.taskId !== 'number') {
        throw new Error('No checklist item was given.');
      }
      const changeId = await resolveChangeId(dir, request.changeId);
      if (!(await toggleTask(dir, changeId, request.taskId, request.done !== false))) {
        throw new Error(`The checklist has no item #${request.taskId}.`);
      }
      return undefined;
    }

    case 'archive': {
      const { archivedAs } = await archiveChange(dir, await resolveChangeId(dir, request.changeId));
      return `The change was archived as ${archivedAs}; its requirements were merged into the specs.`;
    }

    case 'discard': {
      await discardChange(dir, await resolveChangeId(dir, request.changeId));
      return 'The change was deleted.';
    }

    case 'export': {
      const target = await exportToRepo(dir);
      return `The process was exported to \`${target}/\` — it will now travel with a commit.`;
    }
  }
}

/** The change an operation acts on: the one named, or the active one. */
async function resolveChangeId(dir: string, changeId?: string): Promise<string> {
  const wanted = changeId ?? (await readState(dir)).activeChangeId;
  if (!wanted) {
    throw new Error('This session has no active change.');
  }
  return wanted;
}
