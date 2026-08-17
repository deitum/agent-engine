import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { type CodeToolchain, EXIT_PLAN_MODE_TOOL, OPENSPEC_TOOLS } from '../contracts';

import { buildCodingPrompt } from './code-agent';
import { type ToolchainCommands, TOOLCHAIN_NOTES } from './toolchain';

/** The per-session facts the prompt is assembled from. */
function facts(
  overrides: {
    branch?: string;
    baseBranch?: string;
    toolchain?: CodeToolchain;
    commands?: ToolchainCommands;
    envKeys?: string[];
  } = {},
) {
  return {
    branch: 'agent/session',
    baseBranch: 'main',
    toolchain: 'node' as CodeToolchain,
    commands: {},
    envKeys: [],
    ...overrides,
  };
}

describe('buildCodingPrompt', () => {
  test('states which branch the agent is on and what it forked from', () => {
    const prompt = buildCodingPrompt(facts({ branch: 'feat/api', baseBranch: 'develop' }), false);

    assert.match(prompt, /Current branch: \*\*feat\/api\*\* \(base: \*\*develop\*\*\)/);
    assert.match(prompt, /\*\*isolated Docker sandbox\*\*/);
  });

  test('carries the notes for the detected stack', () => {
    for (const toolchain of ['node', 'gradle', 'maven', 'python', 'go', 'unknown'] as const) {
      const prompt = buildCodingPrompt(facts({ toolchain }), false);
      assert.ok(
        prompt.includes(TOOLCHAIN_NOTES[toolchain]),
        `the ${toolchain} notes belong in the prompt`,
      );
    }
  });

  test('names the detected commands, and only the ones that were detected', () => {
    const full = buildCodingPrompt(
      facts({ commands: { test: 'npm test', build: 'npm run build', install: 'npm ci' } }),
      false,
    );
    assert.match(full, /Project tests: `npm test`/);
    assert.match(full, /Project build: `npm run build`/);
    assert.match(full, /Dependency install: `npm ci`/);

    const partial = buildCodingPrompt(facts({ commands: { test: 'go test ./...' } }), false);
    assert.match(partial, /Project tests: `go test \.\/\.\.\.`/);
    assert.ok(!partial.includes('Project build'));
    assert.ok(!partial.includes('Dependency install'));
  });

  /**
   * The container's variables are usually tokens. The agent has to know they are
   * there — otherwise it invents its own — and has to be told not to echo them,
   * because whatever it prints ends up in a transcript the browser persists.
   */
  test('lists the container’s env vars with the warning not to print their values', () => {
    const prompt = buildCodingPrompt(facts({ envKeys: ['NPM_TOKEN', 'SONAR_TOKEN'] }), false);

    assert.match(prompt, /environment defines: NPM_TOKEN, SONAR_TOKEN/);
    assert.match(prompt, /never print their values/);
  });

  test('says nothing about the environment when it is empty', () => {
    assert.ok(!buildCodingPrompt(facts(), false).includes('environment defines'));
  });

  /** Commits, branches and PRs are the user's own commands — the agent must not race them. */
  test('leaves git history to the user’s explicit commands', () => {
    const prompt = buildCodingPrompt(facts(), false);

    assert.match(prompt, /do not commit or push yourself/);
    assert.match(prompt, /before anything irreversible .* ask for confirmation/);
  });

  describe('plan mode', () => {
    test('says the workspace is read-only, and that a refusal is the rule', () => {
      const prompt = buildCodingPrompt(facts(), true);

      assert.match(prompt, /PLAN MODE/);
      assert.match(prompt, /read-only/);
      // The enforcement is real (see plan-mode.ts), so the prompt has to name it
      // as a rule — a model told only «please do not» reads a refusal as a bug.
      assert.match(prompt, /not a broken tool/);
    });

    test('routes approval through the tool that actually lifts the guard', () => {
      const prompt = buildCodingPrompt(facts(), true);

      assert.ok(
        prompt.includes(EXIT_PLAN_MODE_TOOL),
        'the agent has to be told which tool ends plan mode',
      );
      // Approval releases the guard mid-turn; if the agent thinks it must stop
      // and wait, the user has to send a second message to get any work done.
      assert.match(prompt, /within this very turn/);
    });

    test('is absent otherwise, and adds nothing else to the prompt', () => {
      const planning = buildCodingPrompt(facts(), true);
      const ordinary = buildCodingPrompt(facts(), false);

      assert.ok(!ordinary.includes('PLAN MODE'));
      assert.ok(planning.startsWith(ordinary), 'plan mode only appends');
    });
  });

  describe('OpenSpec mode', () => {
    test('the research stage reads as read-only and ends in a proposal', () => {
      const prompt = buildCodingPrompt({ ...facts(), spec: { stage: 'idle' } }, true);

      assert.match(prompt, /Stage: PROPOSAL/);
      assert.match(prompt, /read-only/);
      assert.ok(prompt.includes(OPENSPEC_TOOLS.propose));
      // The format is the point of the mode, so the prompt spells it out rather
      // than leaving it to the tool schema.
      assert.match(prompt, /#### Scenario:/);
      assert.match(prompt, /\*\*WHEN\*\*/);
    });

    test('a change awaiting review is the same instruction — nothing is approved yet', () => {
      const review = buildCodingPrompt({ ...facts(), spec: { stage: 'review' } }, true);

      assert.match(review, /Stage: PROPOSAL/);
    });

    test('the implementation stage names the change and its progress', () => {
      const prompt = buildCodingPrompt(
        {
          ...facts(),
          spec: { stage: 'implement', changeId: 'add-sso-login', tasksTotal: 5, tasksDone: 2 },
        },
        false,
      );

      assert.match(prompt, /Stage: IMPLEMENTATION/);
      assert.match(prompt, /add-sso-login/);
      assert.match(prompt, /2 of 5 items done/);
      assert.ok(prompt.includes(OPENSPEC_TOOLS.task));
      // Widening the approved scope silently is the failure mode this mode exists
      // to prevent, so it is said in words.
      assert.match(prompt, /is a new change/);
    });

    test('the archive stage asks for the checks before closing the change out', () => {
      const prompt = buildCodingPrompt(
        { ...facts(), spec: { stage: 'archive', changeId: 'add-sso-login' } },
        false,
      );

      assert.match(prompt, /Stage: ARCHIVE/);
      assert.ok(prompt.includes(OPENSPEC_TOOLS.archive));
    });

    test('replaces plan mode rather than stacking on it', () => {
      const prompt = buildCodingPrompt({ ...facts(), spec: { stage: 'idle' } }, true);

      // Two sets of instructions for the same read-only turn would disagree about
      // what ends it: `exit_plan_mode` is not even registered in this mode.
      assert.ok(!prompt.includes('PLAN MODE'));
      assert.ok(!prompt.includes(EXIT_PLAN_MODE_TOOL));
    });

    test('lists the capabilities that already exist, so names are reused', () => {
      const prompt = buildCodingPrompt(
        { ...facts(), spec: { stage: 'idle', capabilities: ['auth', 'billing'] } },
        true,
      );

      assert.match(prompt, /Capabilities already described: auth, billing/);
      assert.match(
        buildCodingPrompt({ ...facts(), spec: { stage: 'idle', capabilities: [] } }, true),
        /The specs are empty so far/,
      );
    });
  });
});
