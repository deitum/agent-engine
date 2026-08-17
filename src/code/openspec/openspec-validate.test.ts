import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { type CodeSpecIssue } from '../../contracts';

import { parseRequirements, parseTasks } from './openspec-parse';
import {
  type ChangeInput,
  type DeltaInput,
  formatIssues,
  hasErrors,
  validateChange,
} from './openspec-validate';

/** A delta of one capability, with what its spec already says. */
function delta(
  capability: string,
  markdown: string,
  existingTitles: string[] = [],
  specExists = existingTitles.length > 0,
): DeltaInput {
  return {
    capability,
    markdown,
    requirements: parseRequirements(markdown),
    existingTitles,
    specExists,
  };
}

const GOOD_DELTA = [
  '## ADDED Requirements',
  '',
  '### Requirement: SSO sign-in',
  '',
  '#### Scenario: Successful sign-in',
  '- **WHEN** the user opens /login',
  '- **THEN** they are redirected to the provider',
].join('\n');

/** A change that passes everything, so each test can break exactly one thing. */
function change(overrides: Partial<ChangeInput> = {}): ChangeInput {
  return {
    proposal: '# SSO sign-in\n\n## Why\nPasswords leak.',
    tasks: parseTasks('- [ ] Configure the provider'),
    deltas: [delta('auth', GOOD_DELTA)],
    ...overrides,
  };
}

/** The messages of the findings at a given severity, for readable assertions. */
function messages(issues: CodeSpecIssue[], severity: CodeSpecIssue['severity']): string[] {
  return issues.filter((issue) => issue.severity === severity).map((issue) => issue.message);
}

describe('validateChange', () => {
  test('a well-formed change has nothing to say about it', () => {
    assert.deepEqual(validateChange(change()), []);
  });

  test('refuses a requirement without a scenario — the rule the format exists for', () => {
    const issues = validateChange(
      change({ deltas: [delta('auth', '## ADDED Requirements\n\n### Requirement: SSO sign-in')] }),
    );

    assert.ok(hasErrors(issues));
    assert.match(messages(issues, 'error').join('\n'), /Scenario/);
  });

  test('a REMOVED requirement needs no scenario — it is being taken away', () => {
    const issues = validateChange({
      ...change(),
      deltas: [
        delta('auth', '## REMOVED Requirements\n\n### Requirement: Basic auth', ['Basic auth']),
      ],
    });

    assert.deepEqual(issues, []);
  });

  test('refuses MODIFIED of a requirement the spec does not have', () => {
    const issues = validateChange(
      change({
        deltas: [
          delta(
            'auth',
            '## MODIFIED Requirements\n\n### Requirement: SSO sign-in\n\n#### Scenario: X\n- **WHEN** a\n- **THEN** b',
            ['Password sign-in'],
          ),
        ],
      }),
    );

    assert.ok(hasErrors(issues));
    assert.match(messages(issues, 'error').join('\n'), /holds no such requirement/);
  });

  test('says so plainly when the capability has no spec at all', () => {
    const issues = validateChange(
      change({
        deltas: [
          delta(
            'auth',
            '## MODIFIED Requirements\n\n### Requirement: SSO sign-in\n\n#### Scenario: X\n- **WHEN** a\n- **THEN** b',
            [],
            false,
          ),
        ],
      }),
    );

    assert.match(messages(issues, 'error').join('\n'), /has no spec yet/);
  });

  test('an ADDED requirement that already exists is a warning, not a refusal', () => {
    const issues = validateChange(change({ deltas: [delta('auth', GOOD_DELTA, ['SSO sign-in'])] }));

    assert.ok(!hasErrors(issues));
    assert.match(messages(issues, 'warning').join('\n'), /probably `MODIFIED`/);
  });

  test('a scenario without WHEN/THEN is a warning — it is still readable', () => {
    const issues = validateChange(
      change({
        deltas: [
          delta(
            'auth',
            '## ADDED Requirements\n\n### Requirement: SSO sign-in\n\n#### Scenario: Somehow\nit works',
          ),
        ],
      }),
    );

    assert.ok(!hasErrors(issues));
    assert.match(messages(issues, 'warning').join('\n'), /WHEN/);
  });

  test('refuses a capability name that could not be a folder', () => {
    const issues = validateChange(change({ deltas: [delta('../etc', GOOD_DELTA)] }));

    assert.ok(hasErrors(issues));
    assert.match(messages(issues, 'error').join('\n'), /kebab-case/);
    // Nothing further is claimed about a name that cannot be resolved to a spec.
    assert.equal(messages(issues, 'error').length, 1);
  });

  test('refuses the same capability described twice', () => {
    const issues = validateChange(
      change({ deltas: [delta('auth', GOOD_DELTA), delta('auth', GOOD_DELTA)] }),
    );

    assert.match(messages(issues, 'error').join('\n'), /is described twice/);
  });

  test('refuses an empty proposal, an empty checklist and an empty delta set', () => {
    assert.match(
      messages(validateChange(change({ proposal: '  ' })), 'error').join('\n'),
      /is empty/,
    );
    assert.match(messages(validateChange(change({ tasks: [] })), 'error').join('\n'), /tasks\.md/);
    assert.match(
      messages(validateChange(change({ deltas: [] })), 'error').join('\n'),
      /no spec delta at all/,
    );
  });

  test('refuses a delta file with no requirements in it', () => {
    const issues = validateChange(change({ deltas: [delta('auth', '## ADDED Requirements')] }));

    assert.match(messages(issues, 'error').join('\n'), /holds no requirements/);
  });
});

describe('formatIssues', () => {
  test('numbers the findings and names the file each one is about', () => {
    const text = formatIssues([
      { severity: 'error', message: 'No scenario', path: 'specs/auth/spec.md' },
      { severity: 'warning', message: 'Looks like MODIFIED' },
    ]);

    assert.equal(
      text,
      '1. [error] No scenario (specs/auth/spec.md)\n2. [warning] Looks like MODIFIED',
    );
  });
});
