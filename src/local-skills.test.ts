import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { type LocalSkillWriteRequest } from './contracts';
import { deleteLocalSkill, expandHome, listLocalSkills, writeLocalSkill } from './local-skills';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'engine-skills-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Writes one skill package by hand, the way a user's own folder would look. */
function writePackage(name: string, skillMd: string, files: Record<string, string> = {}): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), skillMd, 'utf8');
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, ...path.split('/'));
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  return dir;
}

/** A write request with the boilerplate filled in. */
function writeRequest(skill: Partial<LocalSkillWriteRequest['skill']>): LocalSkillWriteRequest {
  return {
    dir: root,
    skill: {
      id: 'code-review',
      name: 'Code review',
      description: 'How to review code',
      instructions: '# Review\n\nWatch the module boundaries.',
      files: [],
      ...skill,
    },
  };
}

describe('expandHome', () => {
  test('expands a bare tilde and a tilde path, either separator', () => {
    assert.equal(expandHome('~'), homedir());
    assert.equal(expandHome('~/.claude/skills'), join(homedir(), '.claude/skills'));
    assert.equal(expandHome('~\\.claude'), join(homedir(), '.claude'));
  });

  test('resolves a relative path to an absolute one', () => {
    assert.equal(expandHome('./skills'), resolve('./skills'));
  });

  test('refuses an empty path with a message the UI can show', () => {
    assert.throws(
      () => expandHome('   '),
      (error: unknown) => (error as { status?: number }).status === 400,
    );
  });
});

describe('listLocalSkills', () => {
  test('reads a package into a skill, resources and all', () => {
    writePackage(
      'code-review',
      '---\nname: Code review\ndescription: How to review code\n---\n\n# Review\n\nWatch the boundaries.\n',
      { 'refs/style.md': 'style', 'refs/nested/deep.md': 'deeper', 'checklist.md': 'checklist' },
    );

    const { dir, skills } = listLocalSkills(root);

    assert.equal(dir, root);
    assert.equal(skills.length, 1);
    const [skill] = skills;
    // The directory name is the id, so re-syncing overwrites its own package.
    assert.equal(skill.id, 'code-review');
    assert.equal(skill.name, 'Code review');
    assert.equal(skill.description, 'How to review code');
    assert.equal(skill.instructions, '# Review\n\nWatch the boundaries.');
    assert.deepEqual(
      skill.files.map((file) => file.path),
      ['checklist.md', 'refs/nested/deep.md', 'refs/style.md'],
      'files are sorted and always use forward slashes, whatever the platform',
    );
    assert.equal(skill.files[2].content, 'style');
    assert.ok(
      !skill.files.some((file) => file.path === 'SKILL.md'),
      'the instruction file is the skill, not one of its resources',
    );
  });

  test('falls back to the directory name when the frontmatter names nothing', () => {
    writePackage('bare', 'just instructions with no heading\n');

    const [skill] = listLocalSkills(root).skills;
    assert.equal(skill.name, 'bare');
    assert.equal(skill.description, '');
    assert.equal(skill.instructions, 'just instructions with no heading');
  });

  test('a BOM and CRLF line endings do not hide the frontmatter', () => {
    writePackage('windows', '﻿---\r\nname: From Windows\r\n---\r\n\r\nBody\r\n');

    const [skill] = listLocalSkills(root).skills;
    assert.equal(skill.name, 'From Windows');
    assert.equal(skill.instructions, 'Body');
  });

  test('skips whatever else lives in the folder instead of failing on it', () => {
    writePackage('real-skill', '---\nname: Real one\n---\n\nbody\n');
    mkdirSync(join(root, 'not-a-skill'), { recursive: true });
    writeFileSync(join(root, 'README.md'), 'notes', 'utf8');

    assert.deepEqual(
      listLocalSkills(root).skills.map((skill) => skill.id),
      ['real-skill'],
    );
  });

  test('a missing folder is a 404 — the user typed the path, so say it is not there', () => {
    assert.throws(
      () => listLocalSkills(join(root, 'nope')),
      (error: unknown) => {
        assert.equal((error as { status?: number }).status, 404);
        assert.match((error as Error).message, /Folder not found/);
        return true;
      },
    );
  });

  test('reads frontmatter that YAML rejects, the way Claude Code does', () => {
    // An unquoted `: ` inside a description is a nested mapping to YAML, and
    // routine in real Agent Skills packages — refusing them would make a
    // perfectly usable folder look broken.
    writePackage(
      'router',
      '---\nname: Router\ndescription: The entry router: it routes to a skill.\n---\n\nbody\n',
    );

    const [skill] = listLocalSkills(root).skills;
    assert.equal(skill.name, 'Router');
    assert.equal(skill.description, 'The entry router: it routes to a skill.');
    assert.equal(skill.instructions, 'body');
  });

  describe('manifest', () => {
    test('accepts both the string and the object form of a requirement', () => {
      writePackage(
        'with-manifest',
        [
          '---',
          'name: With a manifest',
          'manifest:',
          '  requiredMcp:',
          '    - Jira Cloud',
          '    - id: bitbucket',
          '      name: Bitbucket',
          '      note: to read pull requests',
          '  recommendedMcp:',
          '    - name: Confluence',
          '  recommendedModel: claude-opus-5',
          '  notes: needs a token',
          '---',
          '',
          'body',
          '',
        ].join('\n'),
      );

      const [skill] = listLocalSkills(root).skills;
      assert.deepEqual(skill.manifest, {
        requiredMcp: [
          { id: 'jira-cloud', name: 'Jira Cloud' },
          { id: 'bitbucket', name: 'Bitbucket', note: 'to read pull requests' },
        ],
        recommendedMcp: [{ id: 'confluence', name: 'Confluence' }],
        recommendedModel: 'claude-opus-5',
        notes: 'needs a token',
      });
    });

    /** A hand-edited manifest must degrade to "no manifest", not break the whole folder. */
    test('a malformed block yields an empty manifest rather than an error', () => {
      writePackage('junk-manifest', '---\nname: Junk\nmanifest: "just a string"\n---\n\nbody\n');

      const [skill] = listLocalSkills(root).skills;
      assert.deepEqual(skill.manifest, { requiredMcp: [], recommendedMcp: [] });
    });
  });
});

describe('writeLocalSkill', () => {
  test('writes an Agent Skills package and reports where it landed', () => {
    const response = writeLocalSkill(
      writeRequest({ files: [{ path: 'refs/style.md', content: 'style' }] }),
    );

    assert.equal(response.path, join(root, 'code-review'));
    assert.equal(response.overwritten, false);

    const markdown = readFileSync(join(root, 'code-review', 'SKILL.md'), 'utf8');
    assert.match(markdown, /^---\n/);
    assert.match(markdown, /name: Code review/);
    assert.match(markdown, /description: How to review code/);
    assert.match(markdown, /# Review/);
    assert.equal(readFileSync(join(root, 'code-review', 'refs', 'style.md'), 'utf8'), 'style');
  });

  test('re-writing the same skill overwrites its own package', () => {
    writeLocalSkill(writeRequest({}));
    const again = writeLocalSkill(writeRequest({ instructions: 'second version' }));

    assert.equal(again.overwritten, true);
    assert.match(readFileSync(join(root, 'code-review', 'SKILL.md'), 'utf8'), /second version/);
  });

  test('a skill with nothing to declare gets no manifest block', () => {
    writeLocalSkill(writeRequest({ manifest: { requiredMcp: [], recommendedMcp: [] } }));

    assert.ok(!readFileSync(join(root, 'code-review', 'SKILL.md'), 'utf8').includes('manifest:'));
  });

  test('the manifest survives a round-trip through the folder', () => {
    writeLocalSkill(
      writeRequest({
        manifest: {
          requiredMcp: [{ id: 'jira', name: 'Jira', note: 'tasks' }],
          recommendedMcp: [],
          recommendedModel: 'claude-opus-5',
          notes: 'needs a token',
        },
        files: [{ path: 'refs/style.md', content: 'style' }],
      }),
    );

    const [skill] = listLocalSkills(root).skills;
    assert.equal(skill.id, 'code-review');
    assert.equal(skill.name, 'Code review');
    assert.equal(skill.description, 'How to review code');
    assert.equal(skill.instructions, '# Review\n\nWatch the module boundaries.');
    assert.deepEqual(skill.files, [{ path: 'refs/style.md', content: 'style' }]);
    assert.deepEqual(skill.manifest, {
      requiredMcp: [{ id: 'jira', name: 'Jira', note: 'tasks' }],
      recommendedMcp: [],
      recommendedModel: 'claude-opus-5',
      notes: 'needs a token',
    });
  });

  /**
   * A package imported from a repository has to remember where it came from
   * once the browser that imported it is gone — that reference is the whole
   * basis of «differs from the repository».
   */
  test('the source reference survives a round-trip through the folder', () => {
    writeLocalSkill(
      writeRequest({
        source: {
          kind: 'bitbucket',
          baseUrl: 'https://git.example.net',
          project: 'ACME',
          repo: 'skills',
          path: 'skills/code-review',
          ref: 'master',
          commit: 'c0ffee',
          fetchedAt: '2026-08-01T10:00:00.000Z',
        },
      }),
    );

    const [skill] = listLocalSkills(root).skills;
    assert.deepEqual(skill.source, {
      kind: 'bitbucket',
      baseUrl: 'https://git.example.net',
      project: 'ACME',
      repo: 'skills',
      path: 'skills/code-review',
      ref: 'master',
      commit: 'c0ffee',
      fetchedAt: '2026-08-01T10:00:00.000Z',
    });
  });

  test('a hand-written package has no source, and a partial block is not one', () => {
    writePackage('plain', '---\nname: Manual\ndescription: own\n---\n\nbody\n');
    writePackage(
      'half',
      '---\nname: Half\nsource:\n  baseUrl: https://git.example.net\n---\n\nbody\n',
    );

    const skills = listLocalSkills(root).skills;
    assert.equal(skills.find((skill) => skill.id === 'plain')?.source, undefined);
    assert.equal(skills.find((skill) => skill.id === 'half')?.source, undefined);
  });

  describe('naming', () => {
    test('reduces a caller-supplied id to one safe folder name', () => {
      const response = writeLocalSkill(writeRequest({ id: '  Code Review!! ' }));
      assert.equal(response.path, join(root, 'code-review'));
    });

    test('falls back to the display name when the id survives as nothing', () => {
      const response = writeLocalSkill(writeRequest({ id: '///', name: 'Review PR' }));
      assert.equal(response.path, join(root, 'review-pr'));
    });

    /** A name in a non-Latin script slugs away to nothing — better a 400 than a folder called «-». */
    test('refuses a skill neither of whose names yields a folder', () => {
      assert.throws(
        () => writeLocalSkill(writeRequest({ id: '///', name: '评审' })),
        (error: unknown) => {
          assert.equal((error as { status?: number }).status, 400);
          assert.match((error as Error).message, /does not yield a folder name/);
          return true;
        },
      );
    });

    test('refuses a skill with no name at all', () => {
      assert.throws(
        () => writeLocalSkill(writeRequest({ name: '  ' })),
        (error: unknown) => (error as { status?: number }).status === 400,
      );
    });
  });

  describe('path safety', () => {
    /**
     * The folder comes from the browser, so a resource path is caller-supplied
     * input: without the guard a crafted one writes anywhere on the user's disk.
     * Every path is validated before the first write, so a bad one cannot leave
     * half a package behind either.
     */
    for (const path of ['../escape.md', 'refs/../../escape.md', `${sep}etc${sep}passwd`]) {
      test(`refuses «${path}» and writes nothing at all`, () => {
        assert.throws(
          () => writeLocalSkill(writeRequest({ files: [{ path, content: 'not allowed' }] })),
          (error: unknown) => (error as { status?: number }).status === 400,
        );
        assert.ok(
          !existsSync(join(root, 'code-review')),
          'the package directory must not exist after a rejected write',
        );
      });
    }

    test('drops a blank path instead of refusing the whole skill', () => {
      writeLocalSkill(
        writeRequest({
          files: [
            { path: '  ', content: 'no name' },
            { path: 'kept.md', content: 'kept' },
          ],
        }),
      );

      assert.deepEqual(
        listLocalSkills(root).skills[0].files.map((file) => file.path),
        ['kept.md'],
      );
    });

    test('normalises a Windows-style separator into the package', () => {
      writeLocalSkill(writeRequest({ files: [{ path: 'refs\\style.md', content: 'style' }] }));

      assert.equal(readFileSync(join(root, 'code-review', 'refs', 'style.md'), 'utf8'), 'style');
    });
  });

  describe('prune', () => {
    /**
     * The default has to stay "add and overwrite": a Sync push
     * must not throw away whatever else the user keeps beside the package.
     */
    test('leaves files the skill no longer carries alone by default', () => {
      writeLocalSkill(writeRequest({ files: [{ path: 'refs/style.md', content: 'style' }] }));
      const response = writeLocalSkill(writeRequest({ files: [] }));

      assert.deepEqual(response.pruned, []);
      assert.ok(existsSync(join(root, 'code-review', 'refs', 'style.md')));
    });

    test('deletes them when asked, and reports what went', () => {
      writeLocalSkill(
        writeRequest({
          files: [
            { path: 'refs/style.md', content: 'style' },
            { path: 'refs/nested/deep.md', content: 'deeper' },
            { path: 'checklist.md', content: 'checklist' },
          ],
        }),
      );

      const response = writeLocalSkill({
        ...writeRequest({ files: [{ path: 'checklist.md', content: 'checklist v2' }] }),
        prune: true,
      });

      assert.deepEqual(response.pruned, ['refs/nested/deep.md', 'refs/style.md']);
      assert.deepEqual(
        listLocalSkills(root).skills[0].files,
        [{ path: 'checklist.md', content: 'checklist v2' }],
        'the kept file is still rewritten, the rest is gone',
      );
      assert.ok(
        !existsSync(join(root, 'code-review', 'refs')),
        'the directories emptied by the prune go too',
      );
    });

    test('never prunes the instruction file itself', () => {
      writeLocalSkill({ ...writeRequest({ files: [] }), prune: true });

      assert.ok(existsSync(join(root, 'code-review', 'SKILL.md')));
    });

    test('keeps a directory that still holds a file the skill carries', () => {
      writeLocalSkill(
        writeRequest({
          files: [
            { path: 'refs/style.md', content: 'style' },
            { path: 'refs/keep.md', content: 'keep' },
          ],
        }),
      );

      writeLocalSkill({
        ...writeRequest({ files: [{ path: 'refs/keep.md', content: 'keep' }] }),
        prune: true,
      });

      assert.ok(existsSync(join(root, 'code-review', 'refs', 'keep.md')));
      assert.ok(!existsSync(join(root, 'code-review', 'refs', 'style.md')));
    });
  });
});

describe('deleteLocalSkill', () => {
  test('removes the package directory and reports its path', () => {
    writePackage('code-review', '---\nname: Code review\n---\n\nbody\n', {
      'refs/style.md': 'style',
    });

    const response = deleteLocalSkill({ dir: root, id: 'code-review' });

    assert.equal(response.path, join(root, 'code-review'));
    assert.ok(!existsSync(join(root, 'code-review')));
  });

  /**
   * The id travels from the browser, so it is caller-supplied input. Refusing a
   * directory without a `SKILL.md` is what keeps a stray value from wiping a
   * folder that was never a skill package.
   */
  test('refuses a directory that holds no SKILL.md', () => {
    mkdirSync(join(root, 'not-a-skill'), { recursive: true });
    writeFileSync(join(root, 'not-a-skill', 'notes.md'), 'notes', 'utf8');

    assert.throws(
      () => deleteLocalSkill({ dir: root, id: 'not-a-skill' }),
      (error: unknown) => {
        assert.equal((error as { status?: number }).status, 404);
        return true;
      },
    );
    assert.ok(existsSync(join(root, 'not-a-skill', 'notes.md')));
  });

  test('refuses an id that slugs away to nothing rather than guessing', () => {
    for (const id of ['..', '///', '   ']) {
      assert.throws(
        () => deleteLocalSkill({ dir: root, id }),
        (error: unknown) => (error as { status?: number }).status === 400,
      );
    }
  });

  /**
   * The id travels from the browser, so a crafted one must not be able to reach
   * a sibling of the configured folder. `packageName` flattens the separators
   * instead of rejecting them, so the delete lands on a name *inside* the folder
   * and fails there for want of a `SKILL.md` — either way nothing outside moves.
   */
  test('a traversal id cannot reach outside the folder', () => {
    const outside = join(root, '..', 'skills-victim');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'SKILL.md'), '---\nname: Victim\n---\n\nbody\n', 'utf8');

    try {
      for (const id of ['../skills-victim', `..${sep}skills-victim`, `${sep}etc${sep}passwd`]) {
        assert.throws(() => deleteLocalSkill({ dir: root, id }));
      }
      assert.ok(existsSync(join(outside, 'SKILL.md')), 'the sibling package is untouched');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
