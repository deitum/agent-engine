import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';

import { type CodeCommandFailure, SESSION_MEMORY_PATH } from '../contracts';

import {
  addFailure,
  appendNote,
  applyFailuresBlock,
  clearFailures,
  ensureNotesFile,
  entriesOf,
  memoryManifest,
  memorySources,
  normalizeEntry,
  parseNotes,
  renderFreshNotes,
  renderNotes,
  syncFailuresBlock,
  toFailure,
  withDescription,
  writableChars,
} from './code-memory';
import {
  MAX_FAILURE_ENTRIES,
  MEMORY_ENTRY_MAX_CHARS,
  MEMORY_NOTES_MAX_CHARS,
  MEMORY_SECTION_MAX_CHARS,
} from './code-memory.constants';

/** A checkout on disk with the given files. */
function checkout(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'engine-memory-'));
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
  return dir;
}

/** The notes file as it is on disk. */
function notesOf(dir: string): string {
  return readFileSync(join(dir, SESSION_MEMORY_PATH), 'utf8');
}

const failure = (command: string, detail = 'boom'): CodeCommandFailure => ({
  command,
  exitCode: 1,
  detail,
  at: 1,
});

describe('parseNotes / renderNotes', () => {
  test('a hand-edited file survives a round-trip', () => {
    const original = [
      '# Project memory',
      '',
      'A note written by a person.',
      '',
      '## Commands',
      '',
      '- npm ci',
      '',
      '## My own section',
      '',
      'Something of its own.',
      '',
      '## Pitfalls',
      '',
      '- do not run build without install',
    ].join('\n');

    const rendered = renderNotes(parseNotes(original));

    for (const fragment of [
      'A note written by a person.',
      '- npm ci',
      '## My own section',
      'Something of its own.',
      '- do not run build without install',
    ]) {
      assert.ok(rendered.includes(fragment), `«${fragment}» must survive`);
    }
    // Re-rendering is stable, so a second write does not keep reshuffling the file.
    assert.equal(renderNotes(parseNotes(rendered)), rendered);
  });

  test('an unknown heading keeps its body and its place after the known ones', () => {
    const parsed = parseNotes(
      ['## My own section', '', 'body', '', '## Commands', '', '- a'].join('\n'),
    );
    assert.deepEqual(parsed.extra, [{ heading: 'My own section', body: '\nbody\n' }]);
    assert.match(renderNotes(parsed), /## Code map[\s\S]*## My own section/);
  });

  test('a section repeated later in the file is joined rather than dropped', () => {
    const parsed = parseNotes(
      ['## Commands', '', '- a', '', '## Pitfalls', '', '- x', '', '## Commands', '', '- b'].join(
        '\n',
      ),
    );
    assert.deepEqual(entriesOf(parsed.sections.commands), ['a', 'b']);
  });
});

describe('normalizeEntry', () => {
  test('flattens a note to one line without its bullet', () => {
    assert.equal(normalizeEntry('  - tests:\n   npm test  '), 'tests: npm test');
  });

  test('caps a note that is really documentation', () => {
    const entry = normalizeEntry('é'.repeat(MEMORY_ENTRY_MAX_CHARS + 50));
    assert.equal(entry.length, MEMORY_ENTRY_MAX_CHARS + 1, 'capped, plus the ellipsis');
    assert.ok(entry.endsWith('…'));
  });
});

describe('appendNote', () => {
  test('writes into the named section', () => {
    const result = appendNote(
      renderFreshNotes(),
      'pitfalls',
      'gradle test fails without --no-daemon',
    );
    assert.equal(result.status, 'ok');
    assert.match(result.text, /## Pitfalls\n\n- gradle test fails without --no-daemon/);
  });

  test('refuses a repeat, however it is written', () => {
    const first = appendNote(renderFreshNotes(), 'commands', 'npm ci installs the dependencies');
    const again = appendNote(first.text, 'commands', '  NPM CI installs   the dependencies.  ');
    assert.equal(again.status, 'duplicate');
    assert.equal(again.text, first.text, 'and changes nothing');
  });

  test('refuses a repeat recorded in another section', () => {
    const first = appendNote(renderFreshNotes(), 'commands', 'npm ci');
    const again = appendNote(first.text, 'map', 'npm ci');
    assert.equal(again.status, 'duplicate');
  });

  test('refuses to overflow one section', () => {
    let text = renderFreshNotes();
    let filled = 0;
    for (let index = 0; index < 500; index += 1) {
      const result = appendNote(
        text,
        'map',
        `catalogue-${index} is responsible for something useful`,
      );
      if (result.status === 'over-budget') {
        break;
      }
      text = result.text;
      filled += 1;
    }
    assert.ok(filled > 0, 'some entries fit');
    assert.equal(appendNote(text, 'map', 'one more catalogue').status, 'over-budget');
    assert.ok(writableChars(text) <= MEMORY_NOTES_MAX_CHARS);
    assert.ok(
      entriesOf(parseNotes(text).sections.map).join('\n').length <= MEMORY_SECTION_MAX_CHARS,
    );
  });

  test('the generated blocks do not eat the write budget', () => {
    const fresh = renderFreshNotes('### About the project\n\na long description '.repeat(50));
    const withFailures = applyFailuresBlock(
      fresh,
      Array.from({ length: 5 }, (_, index) => failure(`command-${index}`)),
    );
    assert.ok(
      writableChars(withFailures) < 500,
      'a description and a failure list are not the agent’s notes',
    );
    assert.equal(appendNote(withFailures, 'pitfalls', 'something important').status, 'ok');
  });

  test('an append keeps the failures block', () => {
    const withFailures = applyFailuresBlock(renderFreshNotes(), [failure('npm test')]);
    const result = appendNote(withFailures, 'pitfalls', 'npm test needs a build first');
    assert.equal(result.status, 'ok');
    assert.match(result.text, /agent-engine:failures/);
  });
});

describe('failures block', () => {
  test('is rewritten in place rather than accumulating', () => {
    const once = applyFailuresBlock(renderFreshNotes(), [failure('npm test')]);
    const twice = applyFailuresBlock(once, [failure('gradle build')]);
    assert.equal(twice.match(/<!-- agent-engine:failures -->/gu)?.length, 1);
    assert.match(twice, /gradle build/);
    assert.ok(!twice.includes('npm test'));
  });

  test('an empty journal removes the block entirely', () => {
    const once = applyFailuresBlock(renderFreshNotes(), [failure('npm test')]);
    const cleared = applyFailuresBlock(once, []);
    assert.ok(!cleared.includes('agent-engine:failures'));
    assert.match(cleared, /## Pitfalls/, 'the file itself is untouched');
  });

  test('it lands above the sections, where it will be read', () => {
    const text = applyFailuresBlock(renderFreshNotes(), [failure('npm test')]);
    assert.ok(text.indexOf('agent-engine:failures') < text.indexOf('## Commands'));
  });

  /**
   * A notes file lives in the user's repository and is commonly committed, so a
   * marker rename cannot simply take effect: without this, the block written by
   * an older build stops matching, survives every regeneration, and ends up
   * sitting next to the new one forever.
   */
  test('a block left under a marker this build no longer writes is cleaned up', () => {
    const legacy = renderFreshNotes().replace(
      '## Commands',
      [
        '<!-- aft:failures -->',
        '- `npm test` — exit 1: stale',
        '<!-- /aft:failures -->',
        '',
        '## Commands',
      ].join('\n'),
    );

    const rewritten = applyFailuresBlock(legacy, [failure('gradle build')]);

    assert.ok(!rewritten.includes('aft:failures'), 'the old markers are gone');
    assert.ok(!rewritten.includes('exit 1: stale'), 'and so is what they held');
    assert.equal(rewritten.match(/<!-- agent-engine:failures -->/gu)?.length, 1);
    assert.match(rewritten, /gradle build/);
  });

  test('re-failing the same command refreshes its entry instead of adding one', () => {
    const journal = addFailure(addFailure([], failure('npm test', 'first')), {
      ...failure('npm test', 'second'),
      at: 2,
    });
    assert.deepEqual(journal, [{ command: 'npm test', exitCode: 1, detail: 'second', at: 2 }]);
  });

  test('the journal is capped, so a stuck agent cannot fill the prompt', () => {
    let journal: CodeCommandFailure[] = [];
    for (let index = 0; index < MAX_FAILURE_ENTRIES + 5; index += 1) {
      journal = addFailure(journal, failure(`command-${index}`));
    }
    assert.equal(journal.length, MAX_FAILURE_ENTRIES);
    assert.equal(journal.at(-1)?.command, `command-${MAX_FAILURE_ENTRIES + 4}`);
  });

  test('a lesson naming the command clears it', () => {
    const journal = [failure('gradle test'), failure('npm run lint')];
    assert.deepEqual(
      clearFailures(journal, 'gradle test fails without --no-daemon').map((entry) => entry.command),
      ['npm run lint'],
    );
  });

  test('a failure keeps only its first meaningful line', () => {
    const recorded = toFailure('npm test', 1, '\n\n  FAIL src/app.test.ts  \nmore\nlines\n');
    assert.equal(recorded.detail, 'FAIL src/app.test.ts');
  });
});

describe('withDescription', () => {
  test('replaces the description and keeps the notes', () => {
    const withEntry = appendNote(
      renderFreshNotes('### About the project\n\nold'),
      'pitfalls',
      'lesson',
    );
    const updated = withDescription(withEntry.text, '### About the project\n\nnew');
    assert.match(updated, /new/);
    assert.ok(!updated.includes('old'));
    assert.match(updated, /- lesson/);
  });

  test('keeps prose written above the sections', () => {
    const updated = withDescription('# mine\n\n## Pitfalls\n\n- lesson\n', 'a description');
    assert.match(updated, /# mine/);
    assert.match(updated, /a description/);
    assert.match(updated, /- lesson/);
  });
});

describe('on disk', () => {
  test('the notes file is created even when the repository documents itself', async () => {
    const dir = checkout({ 'AGENTS.md': '# rules\n' });
    await ensureNotesFile(dir);
    assert.match(notesOf(dir), /## Pitfalls/);
  });

  test('an existing notes file is never re-skeletoned', async () => {
    const dir = checkout({ [SESSION_MEMORY_PATH]: '# mine\n' });
    await ensureNotesFile(dir);
    assert.equal(notesOf(dir), '# mine\n');
  });

  test('memory sources follow the checkout', async () => {
    const bare = checkout();
    await ensureNotesFile(bare);
    assert.deepEqual(memorySources(bare), [`/${SESSION_MEMORY_PATH}`]);

    const documented = checkout({ 'CLAUDE.md': '# rules\n' });
    await ensureNotesFile(documented);
    assert.deepEqual(memorySources(documented), ['/CLAUDE.md', `/${SESSION_MEMORY_PATH}`]);
  });

  test('syncing failures rewrites the file only when it changes', async () => {
    const dir = checkout();
    await ensureNotesFile(dir);
    await syncFailuresBlock(dir, [failure('npm test')]);
    assert.match(notesOf(dir), /npm test/);

    await syncFailuresBlock(dir, []);
    assert.ok(!notesOf(dir).includes('agent-engine:failures'));
  });

  test('the manifest reports both files and the per-section counts', async () => {
    const dir = checkout({ 'AGENTS.md': '# rules\n' });
    await ensureNotesFile(dir);
    const appended = appendNote(notesOf(dir), 'pitfalls', 'lesson');
    writeFileSync(join(dir, SESSION_MEMORY_PATH), appended.text, 'utf8');

    const manifest = memoryManifest(dir, [failure('npm test')]);
    assert.deepEqual(
      manifest.files.map((file) => file.kind),
      ['repo', 'notes'],
    );
    assert.equal(manifest.overBudget, false);
    assert.equal(manifest.failures.length, 1);
    const notes = manifest.files.find((file) => file.kind === 'notes');
    assert.equal(notes?.sections?.find((entry) => entry.section === 'pitfalls')?.entries, 1);
    assert.ok(manifest.totalTokens > 0);
  });
});
