import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CODE_PLAN_APPROVE, EXIT_PLAN_MODE_TOOL } from '../contracts';

import { createPlanGuard, isReadOnlyCommand, planRefusal } from './plan-mode';

describe('createPlanGuard', () => {
  test('starts active and stays released once the plan is approved', () => {
    const guard = createPlanGuard(true);
    assert.equal(guard.active, true);

    guard.release();
    assert.equal(guard.active, false);

    // Idempotent: a second approval must not re-arm the guard.
    guard.release();
    assert.equal(guard.active, false);
  });

  test('can be built already released, for an ordinary turn', () => {
    assert.equal(createPlanGuard(false).active, false);
  });
});

describe('planRefusal', () => {
  test('names the mode, the attempt, and the way out', () => {
    const message = planRefusal('an attempt to write «src/app.ts»');

    assert.match(message, /plan mode/);
    assert.match(message, /src\/app\.ts/);
    assert.ok(message.includes(EXIT_PLAN_MODE_TOOL), 'the way out has to be the tool name');
    // Said explicitly, or the model spends its turn repairing the sandbox.
    assert.match(message, /not a broken tool/);
  });
});

describe('isReadOnlyCommand', () => {
  /** Asserts the whole table in one test, so a failure names the command. */
  function expectAll(commands: string[], expected: boolean): void {
    for (const command of commands) {
      assert.equal(
        isReadOnlyCommand(command),
        expected,
        `${JSON.stringify(command)} should be ${expected ? 'allowed' : 'refused'}`,
      );
    }
  }

  test('allows the everyday ways of reading a checkout', () => {
    expectAll(
      [
        'ls -la src',
        'cat package.json',
        'head -50 README.md',
        'wc -l src/index.ts',
        'grep -rn "TODO" src',
        'rg --files-with-matches useState',
        'find src -name "*.ts"',
        'tree -L 2',
        'jq .scripts package.json',
        'diff a.txt b.txt',
        'sed -n 10,20p src/index.ts',
      ],
      true,
    );
  });

  test('allows git sub-commands that only read', () => {
    expectAll(
      [
        'git status',
        'git status --porcelain',
        'git diff HEAD~1',
        'git log --oneline -20',
        'git show HEAD:package.json',
        'git ls-files src',
        'git blame src/index.ts',
        'git rev-parse --abbrev-ref HEAD',
        'git -C /workspace status',
        'git --no-pager log -1',
        'git branch -a',
        'git tag --list',
        'git remote -v',
        'git config --get user.email',
        'git stash list',
        'git worktree list',
        'git submodule status',
      ],
      true,
    );
  });

  test('refuses the git sub-commands that change refs or the tree', () => {
    expectAll(
      [
        'git checkout .',
        'git commit -m "wip"',
        'git push origin HEAD',
        'git reset --hard',
        'git clean -fd',
        'git apply patch.diff',
        // A positional argument turns a listing into a ref that gets created.
        'git branch feat/x',
        'git branch -d feat/x',
        'git tag v1.0.0',
        'git config user.email me@example.com',
        'git stash pop',
      ],
      false,
    );
  });

  test('allows toolchain probes but not the commands that install or build', () => {
    expectAll(
      ['node -v', 'npm --version', 'npm ls --depth=0', 'npm outdated', 'go list ./...'],
      true,
    );
    expectAll(
      ['npm install', 'npm ci', 'npm run build', 'npx tsc', 'go build ./...', 'mvn package'],
      false,
    );
  });

  test('refuses anything it does not recognise', () => {
    expectAll(['rm -rf build', 'mv a b', 'cp a b', 'mkdir out', 'touch f', 'chmod +x f'], false);
  });

  test('refuses in-place edits that hide behind a reading tool', () => {
    expectAll(['sed -i "s/a/b/" f', 'sed -i.bak "s/a/b/" f', 'sed --in-place "s/a/b/" f'], false);
    expectAll(['find . -name "*.log" -delete', 'find . -name "*.ts" -exec rm {} ;'], false);
  });

  test('refuses a line whose write hides in a later segment', () => {
    expectAll(
      ['cat a && rm b', 'ls; rm -rf build', 'git status || npm install', 'cat a | tee out.txt'],
      false,
    );
  });

  test('every segment of a multi-command line still has to read', () => {
    expectAll(
      ['git status && git diff', 'ls src; cat package.json', 'cat a | grep b | wc -l'],
      true,
    );
  });

  test('refuses redirection, command substitution and privilege escalation', () => {
    expectAll(
      [
        'echo hi > f',
        'cat a >> b',
        'echo $(rm -rf /)',
        'echo `rm -rf /`',
        'sudo apt-get install curl',
        'FOO=bar rm x',
      ],
      false,
    );
  });

  test('still allows the /dev/null and 2>&1 idioms, which write nothing', () => {
    expectAll(
      ['grep -r foo src 2>/dev/null', 'git status 2>&1', 'ls missing >/dev/null 2>&1'],
      true,
    );
  });

  test('treats an empty command as harmless', () => {
    expectAll(['', '   '], true);
  });
});

describe('the approval token', () => {
  test('is a bare word the browser sends verbatim', () => {
    // The tool compares the answer against this exact string; a change on either
    // side that is not made on both silently turns every approval into «revise».
    assert.equal(CODE_PLAN_APPROVE, 'approve');
  });
});
