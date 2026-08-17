import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  mergeIntoSpec,
  parseRequirements,
  parseTasks,
  sameTitle,
  setTaskDone,
  titleOf,
} from './openspec-parse';

const DELTA = [
  '## ADDED Requirements',
  '',
  '### Requirement: SSO sign-in',
  'The system SHALL let a user in through corporate SSO.',
  '',
  '#### Scenario: Successful sign-in',
  '- **WHEN** the user opens /login',
  '- **THEN** they are redirected to the provider',
  '',
  '#### Scenario: Provider unreachable',
  '- **WHEN** the provider does not answer',
  '- **THEN** the password form is shown',
  '',
  '## MODIFIED Requirements',
  '',
  '### Requirement: Sign-out',
  '',
  '#### Scenario: Signing out ends the session',
  '- **WHEN** the user clicks «Sign out»',
  '- **THEN** the session ends',
  '',
  '## REMOVED Requirements',
  '',
  '### Requirement: Basic auth',
].join('\n');

describe('parseRequirements', () => {
  test('reads the kind from the heading each requirement sits under', () => {
    const requirements = parseRequirements(DELTA);

    assert.deepEqual(
      requirements.map((entry) => [entry.kind, entry.title]),
      [
        ['added', 'SSO sign-in'],
        ['modified', 'Sign-out'],
        ['removed', 'Basic auth'],
      ],
    );
  });

  test('collects every scenario block of a requirement, verbatim', () => {
    const [sso] = parseRequirements(DELTA);

    assert.equal(sso.scenarios.length, 2);
    assert.match(sso.scenarios[0], /^#### Scenario: Successful sign-in/);
    assert.match(sso.scenarios[0], /redirected to the provider/);
    // The second scenario must not swallow the first one's lines.
    assert.doesNotMatch(sso.scenarios[1], /Successful sign-in/);
  });

  test('keeps the prose between the heading and the scenarios in `raw`', () => {
    const [sso] = parseRequirements(DELTA);

    assert.match(sso.raw, /^### Requirement: SSO sign-in/);
    assert.match(sso.raw, /The system SHALL let a user/);
  });

  test('a requirement with no scenarios parses as one with none, not as absent', () => {
    const removed = parseRequirements(DELTA).at(-1);

    assert.equal(removed?.title, 'Basic auth');
    assert.deepEqual(removed?.scenarios, []);
  });

  test("a capability's own spec has no kind headings, so everything is current", () => {
    const spec = [
      '# auth',
      '',
      '## Requirements',
      '',
      '### Requirement: SSO sign-in',
      '',
      '#### Scenario: Successful sign-in',
      '- **WHEN** … - **THEN** …',
    ].join('\n');

    assert.deepEqual(
      parseRequirements(spec).map((entry) => entry.kind),
      ['added'],
    );
  });

  test('a document without requirements yields none rather than throwing', () => {
    assert.deepEqual(parseRequirements('# Just a heading\n\nand some text.'), []);
    assert.deepEqual(parseRequirements(''), []);
  });
});

describe('parseTasks', () => {
  const TASKS = [
    '## Preparation',
    '',
    '- [x] DB schema',
    '- [X] Migration',
    '',
    '## Implementation',
    '',
    '- [ ] The /login endpoint',
    '* [ ] Tests',
    '',
    'Just a line, not an item.',
  ].join('\n');

  test('numbers entries positionally and reads their section', () => {
    assert.deepEqual(parseTasks(TASKS), [
      { id: 1, text: 'DB schema', done: true, section: 'Preparation' },
      { id: 2, text: 'Migration', done: true, section: 'Preparation' },
      { id: 3, text: 'The /login endpoint', done: false, section: 'Implementation' },
      { id: 4, text: 'Tests', done: false, section: 'Implementation' },
    ]);
  });

  test('a checklist without headings still parses', () => {
    assert.deepEqual(parseTasks('- [ ] One thing'), [{ id: 1, text: 'One thing', done: false }]);
  });
});

describe('setTaskDone', () => {
  const TASKS = ['## Implementation', '', '- [ ] First', '- [ ] Second  <!-- note -->'].join('\n');

  test('flips exactly the entry asked for and leaves the rest byte-identical', () => {
    const next = setTaskDone(TASKS, 2, true);

    assert.equal(
      next,
      ['## Implementation', '', '- [ ] First', '- [x] Second  <!-- note -->'].join('\n'),
    );
  });

  test('un-ticking is the same operation the other way', () => {
    const ticked = setTaskDone(TASKS, 1, true) ?? '';
    assert.equal(setTaskDone(ticked, 1, false), TASKS);
  });

  test('an id the file does not have is reported, not silently ignored', () => {
    assert.equal(setTaskDone(TASKS, 9, true), null);
  });
});

describe('mergeIntoSpec', () => {
  const SPEC = [
    '# auth',
    '',
    'How the system lets a user in.',
    '',
    '## Requirements',
    '',
    '### Requirement: Password sign-in',
    '',
    '#### Scenario: Correct password',
    '- **WHEN** … - **THEN** …',
  ].join('\n');

  test('appends an ADDED requirement and keeps the header prose', () => {
    const merged = mergeIntoSpec(
      SPEC,
      'auth',
      parseRequirements(
        '## ADDED Requirements\n\n### Requirement: SSO sign-in\n\n#### Scenario: X\n- **WHEN** a - **THEN** b',
      ),
    );

    assert.match(merged, /How the system lets a user in\./);
    assert.match(merged, /### Requirement: Password sign-in/);
    assert.match(merged, /### Requirement: SSO sign-in/);
  });

  test('a MODIFIED requirement replaces the block of the same title', () => {
    const merged = mergeIntoSpec(
      SPEC,
      'auth',
      parseRequirements(
        '## MODIFIED Requirements\n\n### Requirement: Password sign-in\nNow with 2FA.\n\n#### Scenario: Y\n- **WHEN** a - **THEN** b',
      ),
    );

    assert.match(merged, /Now with 2FA\./);
    assert.doesNotMatch(merged, /Correct password/);
    // Replaced in place, not appended twice.
    assert.equal(parseRequirements(merged).length, 1);
  });

  test('a REMOVED requirement drops the block', () => {
    const merged = mergeIntoSpec(
      SPEC,
      'auth',
      parseRequirements('## REMOVED Requirements\n\n### Requirement: Password sign-in'),
    );

    assert.deepEqual(parseRequirements(merged), []);
    assert.match(merged, /# auth/);
  });

  test('merging into a capability that has no spec yet writes a skeleton', () => {
    const merged = mergeIntoSpec(
      '',
      'order-history',
      parseRequirements(
        '## ADDED Requirements\n\n### Requirement: Order list\n\n#### Scenario: X\n- **WHEN** a - **THEN** b',
      ),
    );

    assert.match(merged, /^# order-history/);
    assert.match(merged, /## Requirements/);
    assert.equal(parseRequirements(merged).length, 1);
  });

  test('is idempotent — archiving the same delta twice changes nothing', () => {
    const delta = parseRequirements(
      '## ADDED Requirements\n\n### Requirement: SSO sign-in\n\n#### Scenario: X\n- **WHEN** a - **THEN** b',
    );
    const once = mergeIntoSpec(SPEC, 'auth', delta);

    assert.equal(mergeIntoSpec(once, 'auth', delta), once);
  });
});

describe('titleOf', () => {
  test('takes the first level-1 heading, and falls back to nothing', () => {
    assert.equal(titleOf('## Wrong level\n\n# SSO sign-in\n'), 'SSO sign-in');
    assert.equal(titleOf('no heading'), '');
  });
});

describe('sameTitle', () => {
  test('ignores case and surrounding whitespace, since headings are hand-typed', () => {
    assert.ok(sameTitle('  SSO sign-in ', 'sso sign-in'));
    assert.ok(!sameTitle('SSO sign-in', 'Password sign-in'));
  });
});
