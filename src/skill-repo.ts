import { ConnectorError } from './connector';
import {
  type PackageSource,
  type RepoSkillSummary,
  type Skill,
  type SkillFile,
  type SkillRepoFetchRequest,
  type SkillRepoFetchResponse,
  type SkillRepoListRequest,
  type SkillRepoListResponse,
  type SkillRepoSkippedFile,
} from './contracts';
import { parseFrontmatter, splitFrontmatter } from './frontmatter';
import {
  baseOf,
  decodeFile,
  dirOf,
  joinPath,
  mapWithLimit,
  MAX_PACKAGE_FILES,
  normalizePath,
  READ_CONCURRENCY,
  repoClientFor,
  resolveRevision,
  sourceOf,
} from './repo-package';
import { parseManifest, SKILL_FILE } from './skill-package';
import { type RepoClient } from './vcs/repo-client';

/**
 * Finding Agent Skills packages in a Bitbucket repository and pulling them out
 * of it — the catalogue's the repository tab tab.
 *
 * A repository is not a skills folder: the packages sit wherever their author
 * put them, at any depth, sometimes inside a plugin. So the rule is the same one
 * `skill-package.ts` uses on disk, applied to the whole tree — **a directory
 * holding a `SKILL.md` is a package** — with one refinement: a package nested
 * inside another is its own skill and not a resource of the outer one, which is
 * what makes `<plugin>/skills/<name>/SKILL.md` show up as the skill it is.
 *
 * Everything that is true of any repository import — the walk, the decode, the
 * revision pinning, the recorded source — lives in `repo-package.ts`.
 */

/** A package as the tree describes it, before anything is downloaded. */
interface RepoPackage {
  /** Directory relative to the scanned root, `''` for a package at the root. */
  dir: string;
  /** Resource paths relative to that directory (`SKILL.md` excluded). */
  files: string[];
}

/**
 * Groups a flat listing into packages. Every `SKILL.md` opens one; every other
 * file belongs to the **deepest** package directory that contains it, so a
 * nested package keeps its own resources instead of donating them upwards.
 */
export function groupPackages(paths: string[]): RepoPackage[] {
  const dirs = paths
    .filter((path) => path === SKILL_FILE || path.endsWith(`/${SKILL_FILE}`))
    .map((path) => dirOf(path));
  const packages = new Map<string, string[]>(dirs.map((dir) => [dir, []]));

  for (const path of paths) {
    if (path === SKILL_FILE || path.endsWith(`/${SKILL_FILE}`)) {
      continue;
    }
    // Deepest first: `a/b` wins over `a` for a file under both.
    const owner = dirs
      .filter((dir) => dir === '' || path.startsWith(`${dir}/`))
      .sort((left, right) => right.length - left.length)[0];
    if (owner === undefined) {
      continue; // Not part of any package — some other file in the repository.
    }
    const relative = owner === '' ? path : path.slice(owner.length + 1);
    packages.get(owner)?.push(relative);
  }

  return [...packages.entries()]
    .map(([dir, files]) => ({ dir, files: files.sort() }))
    .sort((left, right) => left.dir.localeCompare(right.dir));
}

/** Reads the `name` / `description` / `manifest` a package's `SKILL.md` declares. */
function readSkillMarkdown(raw: string, fallbackName: string) {
  const { frontmatter, body } = splitFrontmatter(raw);
  const meta = parseFrontmatter(frontmatter);
  return {
    name: typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : fallbackName,
    description: typeof meta.description === 'string' ? meta.description.trim() : '',
    instructions: body.trim(),
    manifest: parseManifest(meta.manifest),
  };
}

/**
 * Walks a repository (or one sub-directory of it) and reports every skill
 * package in it, reading only each `SKILL.md` — enough for the catalogue to show
 * a name and a description, cheap enough for a repository holding dozens.
 */
export async function listRepoSkills(
  request: SkillRepoListRequest,
): Promise<SkillRepoListResponse> {
  const client = repoClientFor(request.repo);
  const root = normalizePath(request.repo.path);
  const { ref, commit } = await resolveRevision(client, request.repo.ref);

  const packages = groupPackages(await client.listFiles(root, commit));

  const skills = await mapWithLimit(
    packages,
    READ_CONCURRENCY,
    async ({ dir, files }): Promise<RepoSkillSummary> => {
      const path = joinPath(root, dir);
      const raw = await client.readFile(joinPath(path, SKILL_FILE), commit);
      const decoded = decodeFile(raw);
      const markdown =
        'content' in decoded
          ? readSkillMarkdown(decoded.content, baseOf(path))
          : { name: baseOf(path), description: '' };
      return {
        path,
        id: baseOf(path) || request.repo.repo,
        name: markdown.name,
        description: markdown.description,
        files: files.slice(0, MAX_PACKAGE_FILES),
      };
    },
  );

  return { ref, commit, skills };
}

/**
 * Downloads whole packages — `SKILL.md` and every resource next to it — ready to
 * be stored as personal skills or written into a folder on disk. Each one comes
 * back carrying its {@link SkillSource}, which is what later lets the copy be
 * measured against the repository it came from.
 */
export async function fetchRepoSkills(
  request: SkillRepoFetchRequest,
): Promise<SkillRepoFetchResponse> {
  if (request.paths.length === 0) {
    throw new ConnectorError(400, 'No skills were selected.');
  }

  const client = repoClientFor(request.repo);
  const { ref, commit } = await resolveRevision(client, request.repo.ref);
  const fetchedAt = new Date().toISOString();
  const skipped: SkillRepoSkippedFile[] = [];

  const skills = await mapWithLimit(
    request.paths,
    READ_CONCURRENCY,
    async (rawPath): Promise<Skill> => {
      const path = normalizePath(rawPath);
      // Listed again per package rather than trusted from the browser: the
      // request only names directories, and the resources are whatever the
      // repository holds under them at this commit. Grouped by the same rule as
      // the listing, so a package nested inside this one keeps its own files.
      const own = groupPackages(await client.listFiles(path, commit)).find(
        (entry) => entry.dir === '',
      );

      return readSkillPackage({
        client,
        path,
        files: own?.files ?? [],
        commit,
        fetchedAt,
        source: sourceOf(request.repo, path, ref, commit, fetchedAt),
        fallbackId: request.repo.repo,
        onSkipped: (file) => skipped.push(file),
      });
    },
  );

  return { ref, commit, skills, skipped };
}

/** One package, once its directory and its resource paths are already known. */
export interface RepoSkillRead {
  client: RepoClient;
  /** Package directory relative to the repository root. */
  path: string;
  /** Resource paths relative to {@link path} (`SKILL.md` excluded). */
  files: string[];
  commit: string;
  fetchedAt: string;
  /** Where the copy says it came from, or omitted for a catalogue read. */
  source?: PackageSource;
  /** Id to fall back on for a package sitting at the repository root. */
  fallbackId: string;
  onSkipped: (skipped: SkillRepoSkippedFile) => void;
}

/**
 * Downloads one package's `SKILL.md` and its resources.
 *
 * Split out of {@link fetchRepoSkills} because the catalogue walk
 * (`catalog-repo.ts`) has the whole tree in hand already and must not pay a
 * listing per package to read the same thing.
 */
export async function readSkillPackage({
  client,
  path,
  files,
  commit,
  fetchedAt,
  source,
  fallbackId,
  onSkipped,
}: RepoSkillRead): Promise<Skill> {
  const markdownPath = joinPath(path, SKILL_FILE);
  const raw = decodeFile(await client.readFile(markdownPath, commit));
  if (!('content' in raw)) {
    throw new ConnectorError(422, `${markdownPath} is not text.`);
  }
  const markdown = readSkillMarkdown(raw.content, baseOf(path));

  const resources: SkillFile[] = [];
  for (const relative of files.slice(0, MAX_PACKAGE_FILES)) {
    const decoded = decodeFile(await client.readFile(joinPath(path, relative), commit));
    if ('content' in decoded) {
      resources.push({ path: relative, content: decoded.content });
    } else {
      onSkipped({ path: joinPath(path, relative), reason: decoded.reason });
    }
  }

  return {
    id: baseOf(path) || fallbackId,
    name: markdown.name,
    description: markdown.description,
    instructions: markdown.instructions,
    files: resources,
    manifest: markdown.manifest,
    ...(source ? { source } : {}),
    createdAt: fetchedAt,
    updatedAt: fetchedAt,
  };
}
