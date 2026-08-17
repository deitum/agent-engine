import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  isSafeBranchName,
  isSafeEnvKey,
  isSafeRelPath,
  isSafeRepoSegment,
  parseNumstatZ,
  parseStatusZ,
  redactUrls,
} from './git-parse';

test('parseStatusZ reads the branch header with ahead/behind', () => {
  const raw = '## feature/x...origin/feature/x [ahead 2, behind 1]\0';
  const parsed = parseStatusZ(raw);
  assert.equal(parsed.branch, 'feature/x');
  assert.equal(parsed.upstream, 'origin/feature/x');
  assert.equal(parsed.ahead, 2);
  assert.equal(parsed.behind, 1);
  assert.deepEqual(parsed.files, []);
});

test('parseStatusZ handles a branch without an upstream', () => {
  const parsed = parseStatusZ('## agent/session-1\0');
  assert.equal(parsed.branch, 'agent/session-1');
  assert.equal(parsed.upstream, null);
  assert.equal(parsed.ahead, 0);
});

test('parseStatusZ keeps paths with spaces and non-ASCII characters intact', () => {
  const raw = '## main\0 M src/tëst file.ts\0?? nouveau fichier.md\0';
  const parsed = parseStatusZ(raw);
  assert.deepEqual(parsed.files, [
    { status: 'M', path: 'src/tëst file.ts' },
    { status: '??', path: 'nouveau fichier.md' },
  ]);
});

test('parseStatusZ pairs a rename with its original path', () => {
  const raw = '## main\0R  new/name.ts\0old/name.ts\0 M other.ts\0';
  const parsed = parseStatusZ(raw);
  assert.deepEqual(parsed.files, [
    { status: 'R', path: 'new/name.ts', from: 'old/name.ts' },
    { status: 'M', path: 'other.ts' },
  ]);
});

test('parseNumstatZ reads counters and inline paths', () => {
  const parsed = parseNumstatZ('12\t3\tsrc/app.ts\0' + '0\t0\tempty.txt\0');
  assert.deepEqual(parsed, [
    { path: 'src/app.ts', added: 12, removed: 3 },
    { path: 'empty.txt', added: 0, removed: 0 },
  ]);
});

test('parseNumstatZ marks a binary file with null counters', () => {
  const parsed = parseNumstatZ('-\t-\tlogo.png\0');
  assert.deepEqual(parsed, [{ path: 'logo.png', added: null, removed: null }]);
});

test('parseNumstatZ resolves a rename spread over three records', () => {
  const parsed = parseNumstatZ('4\t2\t\0old/path.ts\0new/path.ts\0');
  assert.deepEqual(parsed, [{ path: 'new/path.ts', added: 4, removed: 2, from: 'old/path.ts' }]);
});

test('redactUrls strips credentials from any scheme', () => {
  assert.equal(
    redactUrls('fatal: https://user:tok@git.example/scm/p/r.git not found'),
    'fatal: https://git.example/scm/p/r.git not found',
  );
});

test('isSafeBranchName rejects option-looking and traversing names', () => {
  assert.ok(isSafeBranchName('feature/ACME-1_fix'));
  assert.ok(!isSafeBranchName('--upload-pack=touch'));
  assert.ok(!isSafeBranchName('-x'));
  assert.ok(!isSafeBranchName('a..b'));
  assert.ok(!isSafeBranchName('has space'));
  assert.ok(!isSafeBranchName(''));
});

test('isSafeRepoSegment allows a personal project key but not a path', () => {
  assert.ok(isSafeRepoSegment('PAYMENTS'));
  assert.ok(isSafeRepoSegment('~user.name'));
  assert.ok(!isSafeRepoSegment('a/b'));
  assert.ok(!isSafeRepoSegment('../etc'));
});

test('isSafeRelPath rejects escapes and options', () => {
  assert.ok(isSafeRelPath('src/app.ts'));
  assert.ok(!isSafeRelPath('/etc/passwd'));
  assert.ok(!isSafeRelPath('../secrets'));
  assert.ok(!isSafeRelPath('--force'));
});

test('isSafeEnvKey follows POSIX naming', () => {
  assert.ok(isSafeEnvKey('MY_TOKEN_2'));
  assert.ok(!isSafeEnvKey('2MY'));
  assert.ok(!isSafeEnvKey('MY-TOKEN'));
});
