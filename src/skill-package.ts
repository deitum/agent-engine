import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { stringify } from 'yaml';

import { ConnectorError } from './connector';
import {
  type Manifest,
  type McpRequirement,
  type Skill,
  type SkillFile,
  type SkillSource,
} from './contracts';
import { parseFrontmatter, splitFrontmatter } from './frontmatter';
import { RM_RETRY, WINDOWS_RESERVED_NAMES } from './platform.constants';

/** The instruction file that marks a directory as a skill package. */
export const SKILL_FILE = 'SKILL.md';

/**
 * Expands a leading `~` to the user's home directory and resolves the result to
 * an absolute path. Paths come from the browser, where typing `~/.claude/skills`
 * is the natural thing to do.
 */
export function expandHome(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    throw new ConnectorError(400, 'No folder path was given');
  }
  if (trimmed === '~') {
    return homedir();
  }
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return join(homedir(), trimmed.slice(2));
  }
  return resolve(trimmed);
}

/**
 * Reduces a caller-supplied package name to one safe path segment — the guard
 * that keeps a write inside the folder the user configured. Returns `''` when
 * nothing usable is left (the caller then tries the display name).
 *
 * A name Windows reserves for a device (`nul`, `con`, `com1`, …) is rejected the
 * same way: writing `…\nul\SKILL.md` there neither fails cleanly nor produces a
 * file, and a package that silently evaporates is worse than one that is refused.
 */
export function packageName(id: string): string {
  const segment = id
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  // Windows applies the rule to the stem, so `nul.md` is reserved too.
  return WINDOWS_RESERVED_NAMES.has(segment.split('.')[0]) ? '' : segment;
}

/**
 * Characters Windows refuses in a path segment (`:` is the alternate-stream
 * marker). The control range is the point here rather than the typo the rule
 * below normally catches.
 */
// eslint-disable-next-line no-control-regex
const WINDOWS_ILLEGAL_CHARS = /[<>:"|?*\u0000-\u001f]/g;

/**
 * Reduces one path segment to something every platform will actually create:
 * replaces the characters Windows forbids, drops the trailing dots and spaces it
 * silently strips, and renames a reserved device name out of the way. Returns
 * `''` when nothing usable is left, so the caller can drop the segment.
 *
 * Unlike {@link packageName} case and spaces survive — this runs over names a
 * human chose for a document (a project file, a skill's bundled reference), and
 * the model reads those paths back. A package slug is a different question.
 */
export function safeSegment(segment: string): string {
  const cleaned = segment.replace(WINDOWS_ILLEGAL_CHARS, '-').replace(/[. ]+$/, '');
  if (!cleaned) {
    return '';
  }
  // Prefixed rather than suffixed: `aux.md` has to stay a `.md` file.
  return WINDOWS_RESERVED_NAMES.has(cleaned.split('.')[0].toLowerCase()) ? `_${cleaned}` : cleaned;
}

/**
 * Resolves the package directory a caller's `id` names inside `root`, and is the
 * single place that guarantees the result stays inside it — every write and the
 * delete go through here. {@link packageName} already strips separators, so the
 * `relative` check is belt-and-braces against a future slug rule that doesn't.
 */
export function resolvePackageDir(root: string, id: string): string {
  const segment = packageName(id);
  if (!segment) {
    throw new ConnectorError(400, 'The skill name does not yield a folder name');
  }
  const base = join(root, segment);
  const rel = relative(root, base);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.includes(sep)) {
    throw new ConnectorError(400, `Invalid package name: ${id}`);
  }
  return base;
}

/** Same slug rules as the API/web `slugify`, for manifest requirement ids. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Parses a `requiredMcp` / `recommendedMcp` list (string or object items). */
function parseRequirements(value: unknown): McpRequirement[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const requirements: McpRequirement[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) {
      requirements.push({ id: slugify(item), name: item.trim() });
      continue;
    }
    if (item && typeof item === 'object') {
      const raw = item as Record<string, unknown>;
      const name = typeof raw.name === 'string' ? raw.name.trim() : '';
      const id =
        typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : name ? slugify(name) : '';
      if (!id && !name) {
        continue;
      }
      requirements.push({
        id: id || slugify(name),
        name: name || id,
        ...(typeof raw.note === 'string' && raw.note.trim() ? { note: raw.note.trim() } : {}),
      });
    }
  }
  return requirements;
}

/**
 * Parses an optional `manifest:` frontmatter block into a {@link Manifest},
 * mirroring the API's `manifest.loader.ts`. Defensive: a malformed block yields
 * an empty manifest rather than throwing.
 */
export function parseManifest(value: unknown): Manifest {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const manifest: Manifest = {
    requiredMcp: parseRequirements(raw.requiredMcp),
    recommendedMcp: parseRequirements(raw.recommendedMcp),
  };
  if (typeof raw.recommendedModel === 'string' && raw.recommendedModel.trim()) {
    manifest.recommendedModel = raw.recommendedModel.trim();
  }
  if (typeof raw.notes === 'string' && raw.notes.trim()) {
    manifest.notes = raw.notes.trim();
  }
  return manifest;
}

/** True when a manifest carries nothing worth writing to frontmatter. */
function isManifestEmpty(manifest: Manifest | undefined): boolean {
  return (
    !manifest ||
    (manifest.requiredMcp.length === 0 &&
      manifest.recommendedMcp.length === 0 &&
      !manifest.recommendedModel &&
      !manifest.notes)
  );
}

/** Serializes a manifest back into a plain frontmatter object, or `undefined`. */
export function manifestToFrontmatter(
  manifest: Manifest | undefined,
): Record<string, unknown> | undefined {
  if (!manifest || isManifestEmpty(manifest)) {
    return undefined;
  }
  const toEntries = (list: McpRequirement[]) =>
    list.map((item) => ({
      id: item.id,
      name: item.name,
      ...(item.note ? { note: item.note } : {}),
    }));
  return {
    ...(manifest.requiredMcp.length > 0 ? { requiredMcp: toEntries(manifest.requiredMcp) } : {}),
    ...(manifest.recommendedMcp.length > 0
      ? { recommendedMcp: toEntries(manifest.recommendedMcp) }
      : {}),
    ...(manifest.recommendedModel ? { recommendedModel: manifest.recommendedModel } : {}),
    ...(manifest.notes ? { notes: manifest.notes } : {}),
  };
}

/**
 * Parses an optional `source:` frontmatter block — where the package was
 * imported from. Every field is required for the reference to mean anything (a
 * comparison needs the repository *and* the commit), so a partial block is
 * dropped rather than half-honoured.
 */
export function parseSource(value: unknown): SkillSource | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const text = (key: string): string => (typeof raw[key] === 'string' ? raw[key].trim() : '');

  const source: SkillSource = {
    kind: 'bitbucket',
    baseUrl: text('baseUrl'),
    project: text('project'),
    repo: text('repo'),
    path: text('path'),
    ref: text('ref'),
    commit: text('commit'),
    fetchedAt: text('fetchedAt'),
  };
  return source.baseUrl && source.project && source.repo && source.commit ? source : undefined;
}

/** Serializes a source reference back into a plain frontmatter object. */
export function sourceToFrontmatter(
  source: SkillSource | undefined,
): Record<string, unknown> | undefined {
  if (!source) {
    return undefined;
  }
  return {
    kind: source.kind,
    baseUrl: source.baseUrl,
    project: source.project,
    repo: source.repo,
    path: source.path,
    ref: source.ref,
    commit: source.commit,
    fetchedAt: source.fetchedAt,
  };
}

/**
 * Recursively lists every file under a skill dir except `SKILL.md` itself, as
 * relative slash-separated paths — the package's resource paths, exactly as
 * {@link SkillFile.path} spells them.
 */
export function listPackageFiles(skillDir: string): string[] {
  const paths: string[] = [];

  const walk = (current: string): void => {
    for (const entry of readdirSync(current).sort()) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      const rel = relative(skillDir, full);
      if (rel === SKILL_FILE) {
        continue;
      }
      paths.push(rel.split(sep).join('/'));
    }
  };

  walk(skillDir);
  return paths;
}

/** Reads every resource file of a package, keyed by its relative path. */
function collectFiles(skillDir: string): SkillFile[] {
  return listPackageFiles(skillDir).map((path) => ({
    path,
    content: readFileSync(join(skillDir, ...path.split('/')), 'utf8'),
  }));
}

/**
 * Builds a {@link Skill} from a package directory and its `SKILL.md`. The
 * directory name is the id: it round-trips through {@link writeSkillPackage}, so
 * re-syncing a skill overwrites its own package instead of forking one.
 */
export function readSkillPackage(entry: string, skillDir: string, raw: string): Skill {
  const { frontmatter, body } = splitFrontmatter(raw);
  const meta = parseFrontmatter(frontmatter);
  const stats = statSync(skillDir);

  const source = parseSource(meta.source);

  return {
    id: entry,
    name: typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : entry,
    description: typeof meta.description === 'string' ? meta.description.trim() : '',
    instructions: body.trim(),
    files: collectFiles(skillDir),
    manifest: parseManifest(meta.manifest),
    ...(source ? { source } : {}),
    createdAt: stats.birthtime.toISOString(),
    updatedAt: stats.mtime.toISOString(),
  };
}

/**
 * Reads every skill package (a directory holding a `SKILL.md`) under a root.
 * An unreadable root is a 404 — the path came from the user, so they should be
 * told it isn't there rather than shown an empty catalogue.
 */
export function readSkillPackages(root: string): Skill[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    throw new ConnectorError(404, `Folder not found: ${root}`);
  }

  const skills: Skill[] = [];
  for (const entry of entries.sort()) {
    const skillDir = join(root, entry);
    try {
      if (!statSync(skillDir).isDirectory()) {
        continue;
      }
    } catch {
      // Unreadable or already gone — one inaccessible entry (a Windows junction,
      // a permissions-denied folder) must not fail the whole catalogue.
      continue;
    }
    let raw: string;
    try {
      raw = readFileSync(join(skillDir, SKILL_FILE), 'utf8');
    } catch {
      continue; // Not a skill package — just another directory.
    }
    try {
      skills.push(readSkillPackage(entry, skillDir, raw));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ConnectorError(422, `Malformed skill ${entry}: ${message}`);
    }
  }
  return skills;
}

/** Rejects resource paths that would escape the package directory. */
export function safeRelativePath(path: string): string {
  const trimmed = path.trim().replace(/\\/g, '/');
  if (!trimmed) {
    throw new ConnectorError(400, 'Empty file path inside the package');
  }
  if (isAbsolute(trimmed) || trimmed.startsWith('/')) {
    throw new ConnectorError(400, `An absolute file path is not allowed: ${path}`);
  }
  if (trimmed.split('/').some((segment) => segment === '..')) {
    throw new ConnectorError(400, `The file path escapes the package: ${path}`);
  }
  return trimmed;
}

/** Writes a file, creating any missing parent directories first. */
export function writeFileEnsured(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

/** The fields of a skill that are written out as a package. */
export type WritableSkill = Pick<
  Skill,
  'name' | 'description' | 'instructions' | 'files' | 'manifest' | 'source'
>;

/**
 * Renders a `SKILL.md`: `name` / `description` / `manifest` / `source`
 * frontmatter + body. `source` travels with the package so a folder imported
 * from a repository still knows where it came from after the browser that
 * imported it has forgotten.
 */
export function skillMarkdown(skill: WritableSkill): string {
  const manifest = manifestToFrontmatter(skill.manifest);
  const source = sourceToFrontmatter(skill.source);
  const frontmatter = stringify({
    name: skill.name.trim(),
    description: skill.description.trim(),
    ...(manifest ? { manifest } : {}),
    ...(source ? { source } : {}),
  }).trimEnd();
  return `---\n${frontmatter}\n---\n\n${skill.instructions.trim()}\n`;
}

/**
 * Deletes every file in the package that `keep` doesn't name (`SKILL.md` is
 * never touched), then removes the directories that emptying them left behind.
 * Returns what it removed. Called only when a write asks to `prune`.
 */
function prunePackageFiles(base: string, keep: string[]): string[] {
  const wanted = new Set(keep);
  const removed = listPackageFiles(base).filter((path) => !wanted.has(path));

  for (const path of removed) {
    rmSync(join(base, ...path.split('/')), { ...RM_RETRY, recursive: false });
  }

  // Deepest-first, so a directory emptied by removing its only subdirectory goes
  // too. `rmdir` fails on a non-empty directory, which is exactly the guard we
  // want — anything still holding a kept file survives.
  const directories = [...new Set(removed.map((path) => dirname(path)))]
    .filter((dir) => dir !== '.')
    .flatMap((dir) => {
      const segments = dir.split('/');
      return segments.map((_, index) => segments.slice(0, index + 1).join('/'));
    })
    .sort((a, b) => b.length - a.length);
  for (const dir of new Set(directories)) {
    try {
      rmdirSync(join(base, ...dir.split('/')));
    } catch {
      // Still holds something the skill carries — leave it.
    }
  }

  return removed;
}

/**
 * Writes one skill package into `base`: its `SKILL.md` plus every bundled file
 * at its relative path. Existing files are overwritten in place; files already
 * there that the skill no longer carries are left alone unless `prune` asks for
 * them to go (the editor's in-place save does). Returns the pruned paths.
 */
export function writeSkillPackage(
  base: string,
  skill: WritableSkill,
  { prune = false }: { prune?: boolean } = {},
): string[] {
  // Validate every path before writing anything, so a bad file can't leave a
  // half-written package on disk.
  const files = skill.files
    .filter((file) => file.path.trim())
    .map((file) => ({ path: safeRelativePath(file.path), content: file.content }));

  writeFileEnsured(join(base, SKILL_FILE), skillMarkdown(skill));
  for (const file of files) {
    writeFileEnsured(join(base, ...file.path.split('/')), file.content);
  }

  return prune
    ? prunePackageFiles(
        base,
        files.map((file) => file.path),
      )
    : [];
}
