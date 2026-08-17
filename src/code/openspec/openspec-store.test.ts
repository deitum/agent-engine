import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { OPENSPEC_DIR, OPENSPEC_STATE_FILE } from '../../contracts';

import { parseRequirements } from './openspec-parse';
import {
  activateChange,
  approveChange,
  archiveChange,
  type ChangeDraft,
  createChange,
  deriveStage,
  discardChange,
  exportToRepo,
  initOpenspec,
  isInitialized,
  readChange,
  readSpecState,
  readState,
  toggleTask,
  writeArtifact,
} from './openspec-store';

/** An empty checkout with the OpenSpec tree already created. */
async function checkout(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'engine-openspec-'));
  await initOpenspec(dir);
  return dir;
}

const DELTA = [
  '## ADDED Requirements',
  '',
  '### Requirement: SSO sign-in',
  '',
  '#### Scenario: Successful sign-in',
  '- **WHEN** the user opens /login',
  '- **THEN** they are redirected to the provider',
].join('\n');

/** A valid draft; each test breaks exactly the part it is about. */
function draft(overrides: Partial<ChangeDraft> = {}): ChangeDraft {
  return {
    id: 'add-sso-login',
    proposal: '# SSO sign-in\n\n## Why\nPasswords leak.',
    tasks: '## Implementation\n\n- [ ] Configure the provider\n- [ ] The /login endpoint\n',
    deltas: [{ capability: 'auth', spec: DELTA }],
    ...overrides,
  };
}

/** A capability's spec as it is on disk. */
function specOf(dir: string, capability: string): string {
  const path = join(dir, OPENSPEC_DIR, 'specs', capability, 'spec.md');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

describe('initOpenspec', () => {
  test('creates the tree and is safe to run again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'engine-openspec-'));
    assert.equal(isInitialized(dir), false);

    await initOpenspec(dir);
    assert.equal(isInitialized(dir), true);
    writeFileSync(join(dir, OPENSPEC_DIR, 'project.md'), 'our context', 'utf8');

    // Re-running must not overwrite what someone wrote into project.md.
    await initOpenspec(dir);
    assert.equal(readFileSync(join(dir, OPENSPEC_DIR, 'project.md'), 'utf8'), 'our context');
  });

  test('an uninitialised checkout reads as an empty state rather than failing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'engine-openspec-'));
    const state = await readSpecState(dir);

    assert.equal(state.initialized, false);
    assert.equal(state.stage, 'idle');
    assert.deepEqual(state.changes, []);
  });
});

describe('createChange', () => {
  test('writes the artefacts, parses them back and becomes the active change', async () => {
    const dir = await checkout();
    const { change, issues } = await createChange(dir, draft());

    assert.deepEqual(issues, []);
    assert.equal(change.id, 'add-sso-login');
    assert.equal(change.title, 'SSO sign-in');
    assert.equal(change.tasksTotal, 2);
    assert.equal(change.tasksDone, 0);
    assert.equal(change.deltas[0].capability, 'auth');
    assert.equal(change.deltas[0].requirements[0].title, 'SSO sign-in');

    assert.equal((await readState(dir)).activeChangeId, 'add-sso-login');
    assert.equal((await readSpecState(dir)).stage, 'review');
  });

  test('writes nothing at all when validation refuses the draft', async () => {
    const dir = await checkout();
    const { issues } = await createChange(dir, {
      ...draft(),
      deltas: [
        { capability: 'auth', spec: '## ADDED Requirements\n\n### Requirement: No scenario' },
      ],
    });

    assert.ok(issues.some((issue) => issue.severity === 'error'));
    // The half-written change is what the next turn would have tripped over.
    assert.equal(existsSync(join(dir, OPENSPEC_DIR, 'changes', 'add-sso-login')), false);
    assert.equal((await readSpecState(dir)).stage, 'idle');
  });

  test('a re-proposal replaces the previous draft instead of merging into it', async () => {
    const dir = await checkout();
    await createChange(dir, draft());
    await createChange(dir, {
      ...draft(),
      deltas: [{ capability: 'billing', spec: DELTA }],
    });

    const change = await readChange(dir, 'add-sso-login');
    assert.deepEqual(
      change?.deltas.map((delta) => delta.capability),
      ['billing'],
    );
  });

  test('refuses an id or a capability that could escape its folder', async () => {
    const dir = await checkout();

    await assert.rejects(() => createChange(dir, draft({ id: '../../etc' })), /will not do/);
    await assert.rejects(
      () => createChange(dir, draft({ deltas: [{ capability: '../x', spec: DELTA }] })),
      /will not do/,
    );
  });

  test('a draft with no checklist still gets one, so implementation has a step', async () => {
    const dir = await checkout();
    const { change } = await createChange(dir, draft({ tasks: '  ' }));

    assert.ok(change.tasksTotal > 0);
  });
});

describe('the process, end to end', () => {
  test('review → implement → archive folds the deltas into the specs', async () => {
    const dir = await checkout();
    await createChange(dir, draft());
    assert.equal((await readSpecState(dir)).stage, 'review');

    await approveChange(dir, 'add-sso-login');
    assert.equal((await readSpecState(dir)).stage, 'implement');

    assert.equal(await toggleTask(dir, 'add-sso-login', 1, true), true);
    assert.equal((await readSpecState(dir)).active?.tasksDone, 1);
    // Still implementing: one task is left.
    assert.equal((await readSpecState(dir)).stage, 'implement');

    await toggleTask(dir, 'add-sso-login', 2, true);
    assert.equal((await readSpecState(dir)).stage, 'archive');

    const { archivedAs } = await archiveChange(dir, 'add-sso-login');
    assert.match(archivedAs, /^\d{4}-\d{2}-\d{2}-add-sso-login$/);

    // The requirement is now part of the capability's own spec…
    assert.equal(parseRequirements(specOf(dir, 'auth'))[0].title, 'SSO sign-in');
    // …the change has left `changes/`, and the session is idle again.
    const state = await readSpecState(dir);
    assert.equal(state.stage, 'idle');
    assert.equal(state.active, undefined);
    assert.deepEqual(
      state.archived.map((entry) => entry.id),
      ['add-sso-login'],
    );
    assert.deepEqual(state.capabilities, [{ capability: 'auth', requirements: 1 }]);
  });

  test('archiving a change that is already archived is a no-op, not an error', async () => {
    const dir = await checkout();
    await createChange(dir, draft());
    await approveChange(dir, 'add-sso-login');
    await archiveChange(dir, 'add-sso-login');

    // Both the panel's button and the agent's tool can reach this.
    const { archivedAs } = await archiveChange(dir, 'add-sso-login');
    assert.equal(archivedAs, 'add-sso-login');
  });

  test('archiving a change nobody ever created is an error', async () => {
    const dir = await checkout();
    await assert.rejects(() => archiveChange(dir, 'never-existed'), /was not found/);
  });

  test('a MODIFIED requirement replaces what the archived spec already said', async () => {
    const dir = await checkout();
    await createChange(dir, draft());
    await approveChange(dir, 'add-sso-login');
    await archiveChange(dir, 'add-sso-login');

    await createChange(dir, {
      ...draft({ id: 'sso-with-2fa' }),
      deltas: [
        {
          capability: 'auth',
          spec: '## MODIFIED Requirements\n\n### Requirement: SSO sign-in\nNow with 2FA.\n\n#### Scenario: X\n- **WHEN** a\n- **THEN** b',
        },
      ],
    });
    await approveChange(dir, 'sso-with-2fa');
    await archiveChange(dir, 'sso-with-2fa');

    const spec = specOf(dir, 'auth');
    assert.match(spec, /Now with 2FA\./);
    assert.equal(parseRequirements(spec).length, 1);
  });
});

describe('toggleTask', () => {
  test('reports an id the checklist does not have, instead of pretending', async () => {
    const dir = await checkout();
    await createChange(dir, draft());

    assert.equal(await toggleTask(dir, 'add-sso-login', 99, true), false);
  });
});

describe('writeArtifact', () => {
  test('replaces one artefact and leaves the others alone', async () => {
    const dir = await checkout();
    await createChange(dir, draft());

    await writeArtifact(
      dir,
      'add-sso-login',
      'proposal',
      '# A different heading\n\nand some text.',
    );
    const change = await readChange(dir, 'add-sso-login');

    assert.equal(change?.title, 'A different heading');
    assert.equal(change?.tasksTotal, 2);
  });

  test('refuses to write into a change that does not exist', async () => {
    const dir = await checkout();
    await assert.rejects(() => writeArtifact(dir, 'nope', 'proposal', 'x'), /was not found/);
  });
});

describe('activateChange / discardChange', () => {
  test('activate switches which change the next turn works on', async () => {
    const dir = await checkout();
    await createChange(dir, draft());
    await createChange(dir, draft({ id: 'second-change' }));

    await activateChange(dir, 'add-sso-login');
    const state = await readSpecState(dir);

    assert.equal(state.active?.id, 'add-sso-login');
    // The list shows what is *not* active, so the panel never renders it twice.
    assert.deepEqual(
      state.changes.map((entry) => entry.id),
      ['second-change'],
    );
  });

  test('discard removes the folder and clears the active pointer', async () => {
    const dir = await checkout();
    await createChange(dir, draft());
    await discardChange(dir, 'add-sso-login');

    const state = await readSpecState(dir);
    assert.equal(state.stage, 'idle');
    assert.deepEqual(state.changes, []);
    assert.equal(existsSync(join(dir, OPENSPEC_DIR, 'changes', 'add-sso-login')), false);
  });
});

describe('readState', () => {
  test('unparseable JSON reads as an empty state — the tree is the real record', async () => {
    const dir = await checkout();
    await createChange(dir, draft());
    writeFileSync(join(dir, OPENSPEC_DIR, OPENSPEC_STATE_FILE), '{ truncated', 'utf8');

    assert.deepEqual(await readState(dir), {});
    // The change is still on disk and still listed; only «which is active» is lost.
    const state = await readSpecState(dir);
    assert.equal(state.stage, 'idle');
    assert.deepEqual(
      state.changes.map((entry) => entry.id),
      ['add-sso-login'],
    );
  });
});

describe('exportToRepo', () => {
  test('copies the tree to the checkout root without the local bookkeeping', async () => {
    const dir = await checkout();
    await createChange(dir, draft());

    assert.equal((await readSpecState(dir)).exported, false);
    assert.equal(await exportToRepo(dir), 'openspec');

    assert.ok(existsSync(join(dir, 'openspec', 'changes', 'add-sso-login', 'proposal.md')));
    // One machine's «active change» has no business in everyone's repository.
    assert.equal(existsSync(join(dir, 'openspec', OPENSPEC_STATE_FILE)), false);
    assert.equal((await readSpecState(dir)).exported, true);
  });

  test('refuses when there is nothing to export', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'engine-openspec-'));
    await assert.rejects(() => exportToRepo(dir), /has no openspec yet/);
  });
});

describe('deriveStage', () => {
  test('is read off the change, never off the state file', () => {
    assert.equal(deriveStage(null), 'idle');
    assert.equal(deriveStage({ tasksTotal: 2, tasksDone: 0 } as never), 'review');
    assert.equal(deriveStage({ approvedAt: 1, tasksTotal: 2, tasksDone: 1 } as never), 'implement');
    assert.equal(deriveStage({ approvedAt: 1, tasksTotal: 2, tasksDone: 2 } as never), 'archive');
    // An approved change with no checklist at all stays implementable rather
    // than jumping to «archive» on a division by zero.
    assert.equal(deriveStage({ approvedAt: 1, tasksTotal: 0, tasksDone: 0 } as never), 'implement');
  });
});
