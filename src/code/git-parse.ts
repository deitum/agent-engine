import { type CodeFileStatus } from '../contracts';

/**
 * Parsers for the NUL-delimited git output the Code workspace reads. They are
 * pure so they can be unit-tested without a repository — and NUL-delimited
 * because the porcelain text format mangles paths containing spaces, quotes or
 * non-ASCII characters (which the previous `line.slice(3)` parsing did).
 */

/** The branch header plus changed files of `git status --porcelain=v1 -b -z`. */
export interface ParsedStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: CodeFileStatus[];
}

/** Status letters that carry a second (original) path record. */
const PAIRED_STATUS = /^[RC]/;

/**
 * Parses `git status --porcelain=v1 -b -z`. Records are NUL-terminated; the
 * first one is the `## branch...upstream [ahead N, behind M]` header, and a
 * rename / copy entry is followed by one extra record holding the original path.
 */
export function parseStatusZ(raw: string): ParsedStatus {
  const records = raw.split('\0').filter((record) => record.length > 0);
  const result: ParsedStatus = {
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    files: [],
  };

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];

    if (record.startsWith('## ')) {
      const header = record.slice(3);
      const [branch, upstream] = header.split('...');
      result.branch = branch.split(' ')[0] || null;
      result.upstream = upstream ? upstream.split(' ')[0] || null : null;
      result.ahead = Number(/ahead (\d+)/.exec(header)?.[1] ?? 0);
      result.behind = Number(/behind (\d+)/.exec(header)?.[1] ?? 0);
      continue;
    }

    // `XY path`, where XY are the index / worktree status letters.
    const status = record.slice(0, 2);
    const path = record.slice(3);
    if (!path) {
      continue;
    }
    if (PAIRED_STATUS.test(status.trim())) {
      const from = records[index + 1];
      index += 1;
      result.files.push({ status: status.trim(), path, ...(from ? { from } : {}) });
    } else {
      result.files.push({ status: status.trim(), path });
    }
  }

  return result;
}

/** One entry of `git diff --numstat -z`. */
export interface NumstatEntry {
  path: string;
  /** `null` for a binary file (git prints `-`). */
  added: number | null;
  removed: number | null;
  /** Previous path, for a rename. */
  from?: string;
}

/**
 * Parses `git diff --numstat -z`. A normal entry is one NUL-terminated record
 * `added\tremoved\tpath`; a rename ends after the second tab and its old and new
 * paths follow as two separate records.
 */
export function parseNumstatZ(raw: string): NumstatEntry[] {
  const records = raw.split('\0');
  const entries: NumstatEntry[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) {
      continue;
    }
    const parts = record.split('\t');
    if (parts.length < 2) {
      continue;
    }
    const added = parts[0] === '-' ? null : Number(parts[0]);
    const removed = parts[1] === '-' ? null : Number(parts[1]);
    const inline = parts.slice(2).join('\t');

    if (inline) {
      entries.push({ path: inline, added, removed });
      continue;
    }
    // Rename / copy: the next two records are the old and new paths.
    const from = records[index + 1];
    const to = records[index + 2];
    if (from && to) {
      entries.push({ path: to, added, removed, from });
      index += 2;
    }
  }

  return entries;
}

/** Strips credentials out of any URL in `text` (never leak a token to the UI). */
export function redactUrls(text: string): string {
  return text.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^@\s/]+@/g, '$1');
}

/**
 * A git ref name safe to pass as a command argument: no leading dash (which git
 * would read as an option), no whitespace, no shell metacharacters.
 */
export function isSafeBranchName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 200 &&
    !name.startsWith('-') &&
    !name.startsWith('/') &&
    !name.endsWith('/') &&
    !name.includes('..') &&
    /^[A-Za-z0-9._/-]+$/.test(name)
  );
}

/** A Bitbucket project key or repository slug safe to interpolate into a URL. */
export function isSafeRepoSegment(value: string): boolean {
  return value.length > 0 && value.length <= 128 && /^~?[A-Za-z0-9._-]+$/.test(value);
}

/**
 * A repository-relative path safe to hand to git as an argument: no leading
 * dash, no absolute path, no `..` segment escaping the checkout.
 */
export function isSafeRelPath(path: string): boolean {
  if (path.length === 0 || path.length > 4096 || path.startsWith('-') || path.startsWith('/')) {
    return false;
  }
  return !path.split(/[\\/]/).includes('..');
}

/** A valid environment-variable name (`docker exec -e` key). */
export function isSafeEnvKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}
