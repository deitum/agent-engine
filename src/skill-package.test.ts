import assert from 'node:assert/strict';
import { test } from 'node:test';

import { packageName, safeSegment } from './skill-package';

test('safeSegment keeps a name Windows will actually create', () => {
  // Every character Windows refuses in a segment; `:` is the one an embedder
  // hits, because it namespaces a plugin's skill as `<plugin>:<skill>`.
  assert.equal(safeSegment('aft-sa:jira-task-onboarding'), 'aft-sa-jira-task-onboarding');
  assert.equal(safeSegment('a<b>c"d|e?f*g'), 'a-b-c-d-e-f-g');

  // Windows strips a trailing dot or space without saying so, which loses the
  // file — trim it here instead, where the caller can still see the name.
  assert.equal(safeSegment('draft.'), 'draft');
  assert.equal(safeSegment('draft '), 'draft');
  assert.equal(safeSegment('notes...'), 'notes');

  // Reserved device names are prefixed, not suffixed: `aux.md` stays `.md`.
  assert.equal(safeSegment('aux.md'), '_aux.md');
  assert.equal(safeSegment('NUL'), '_NUL');
  assert.equal(safeSegment('auxiliary.md'), 'auxiliary.md');

  // Unlike packageName, a human's own name survives intact.
  assert.equal(safeSegment('Design Notes.md'), 'Design Notes.md');
  assert.equal(safeSegment('спека.md'), 'спека.md');

  // Nothing usable left — the caller drops the segment.
  assert.equal(safeSegment(''), '');
  assert.equal(safeSegment('...'), '');
});

test('packageName slugs a namespaced id down to one safe segment', () => {
  assert.equal(packageName('aft-sa:jira-task-onboarding'), 'aft-sa-jira-task-onboarding');
  assert.equal(packageName('aft-sa__jira-task-onboarding'), 'aft-sa__jira-task-onboarding');
  assert.equal(packageName('..'), '');
  assert.equal(packageName('nul'), '');
});
