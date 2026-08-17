import { ConnectorError } from './connector';
import {
  type PackageSource,
  type Plugin,
  type PluginAgent,
  type PluginCommand,
  type PluginRepoFetchRequest,
  type PluginRepoFetchResponse,
  type PluginRepoListRequest,
  type PluginRepoListResponse,
  type PluginRepoSkippedFile,
  type RepoPluginSummary,
  type Skill,
  type SkillFile,
} from './contracts';
import { parseFrontmatter, splitFrontmatter } from './frontmatter';
import {
  AGENTS_DIR,
  COMMANDS_DIR,
  LEGACY_AGENTS_DIR,
  LEGACY_COMMANDS_DIR,
  LEGACY_PLUGIN_MANIFEST,
  LEGACY_PLUGIN_MCP_FILE,
  parseAgentMarkdown,
  parseCommandMarkdown,
  parseMcpJson,
  parsePluginManifest,
  PLUGIN_MANIFEST,
  PLUGIN_MCP_FILE,
  SKILLS_DIR,
} from './plugin-package';
import {
  baseOf,
  decodeFile,
  joinPath,
  mapWithLimit,
  MAX_PLUGIN_FILES,
  normalizePath,
  READ_CONCURRENCY,
  repoClientFor,
  resolveRevision,
  sourceOf,
  under,
} from './repo-package';
import { parseManifest, SKILL_FILE } from './skill-package';
import { type RepoClient } from './vcs/repo-client';

/**
 * Finding plugin packages in a repository and pulling them out of it — the
 * plugins catalogue's repository tab, and the sibling of `skill-repo.ts`.
 *
 * A repository is not a plugins folder: a package sits wherever its author put
 * it — at the root of a single-plugin repository, under `plugins/<name>/` in a
 * monorepo, under `.claude/plugins/` in a product repository. So the rule from
 * `plugin-package.ts` is applied to the whole tree: **a directory holding a
 * `plugin.json` (or a legacy `.claude-plugin/plugin.json`) is a package**.
 *
 * Unlike a skill, a plugin does **not** nest: a `plugin.json` found inside
 * another package is part of that package's payload, not a second plugin. The
 * shallowest match wins, and everything under it belongs to it.
 */

/** Reads the `<dir>/plugin.json`s a flat listing implies, shallowest first. */
export function findPluginDirs(paths: string[]): string[] {
  const dirs = paths
    .filter((path) => path === PLUGIN_MANIFEST || path.endsWith(`/${PLUGIN_MANIFEST}`))
    .map((path) => path.slice(0, Math.max(0, path.length - PLUGIN_MANIFEST.length - 1)))
    .concat(
      paths
        .filter(
          (path) => path === LEGACY_PLUGIN_MANIFEST || path.endsWith(`/${LEGACY_PLUGIN_MANIFEST}`),
        )
        .map((path) => path.slice(0, Math.max(0, path.length - LEGACY_PLUGIN_MANIFEST.length - 1))),
    );

  // Shallowest first, so a manifest that a package merely *contains* — a
  // vendored example, a fixture — is recognised as payload and dropped.
  const sorted = [...new Set(dirs)].sort(
    (left, right) => left.length - right.length || left.localeCompare(right),
  );
  const roots: string[] = [];
  for (const dir of sorted) {
    if (!roots.some((root) => dir === root || dir.startsWith(`${root}/`))) {
      roots.push(dir);
    }
  }
  return roots.sort((left, right) => left.localeCompare(right));
}

/**
 * Which of two spellings a package uses for a directory — a **choice, not a
 * merge**, the same rule the on-disk reader follows.
 */
function pickDir(files: string[], candidates: string[]): string {
  return (
    candidates.find((candidate) => files.some((path) => path.startsWith(`${candidate}/`))) ?? ''
  );
}

/** Which of two spellings a package uses for a file. */
function pickFile(files: string[], candidates: string[]): string {
  return candidates.find((candidate) => files.includes(candidate)) ?? '';
}

/** `<dir>/a/b.md` → the `a:b` name a command / sub-agent gets from its path. */
function entryName(relative: string): string {
  return relative.replace(/\.md$/, '').split('/').join(':');
}

/**
 * Walks a repository (or one sub-directory of it) and reports every plugin
 * package in it, reading only each manifest — enough for the catalogue to show a
 * name, a description and what the bundle holds.
 */
export async function listRepoPlugins(
  request: PluginRepoListRequest,
): Promise<PluginRepoListResponse> {
  const client = repoClientFor(request.repo);
  const root = normalizePath(request.repo.path);
  const { ref, commit } = await resolveRevision(client, request.repo.ref);

  const paths = await client.listFiles(root, commit);
  const dirs = findPluginDirs(paths);

  const plugins = await mapWithLimit(
    dirs,
    READ_CONCURRENCY,
    async (dir): Promise<RepoPluginSummary> => {
      const path = joinPath(root, dir);
      const files = under(paths, dir);
      const manifestPath = pickFile(files, [PLUGIN_MANIFEST, LEGACY_PLUGIN_MANIFEST]);
      const raw = decodeFile(await client.readFile(joinPath(path, manifestPath), commit));
      const meta =
        'content' in raw
          ? parsePluginManifest(raw.content, baseOf(path) || request.repo.repo)
          : undefined;

      const commandsDir = pickDir(files, [COMMANDS_DIR, LEGACY_COMMANDS_DIR]);
      const agentsDir = pickDir(files, [AGENTS_DIR, LEGACY_AGENTS_DIR]);
      const mcpFile = pickFile(files, [PLUGIN_MCP_FILE, LEGACY_PLUGIN_MCP_FILE]);
      const mcpServers = mcpFile
        ? await readMcpServers(client, joinPath(path, mcpFile), commit)
        : {};

      return {
        path,
        id: meta?.name || baseOf(path) || request.repo.repo,
        name: meta?.name ?? baseOf(path),
        ...(meta?.displayName ? { displayName: meta.displayName } : {}),
        version: meta?.version ?? '',
        description: meta?.description ?? '',
        keywords: meta?.keywords ?? [],
        counts: {
          commands: countMarkdown(files, commandsDir),
          agents: countMarkdown(files, agentsDir),
          skills: files.filter(
            (file) =>
              file.startsWith(`${SKILLS_DIR}/`) &&
              file.endsWith(`/${SKILL_FILE}`) &&
              file.split('/').length === 3,
          ).length,
          mcpServers: Object.keys(mcpServers).length,
        },
      };
    },
  );

  return { ref, commit, plugins };
}

/** `.md` files directly or indirectly under one of the package's directories. */
function countMarkdown(files: string[], dir: string): number {
  return dir === ''
    ? 0
    : files.filter((file) => file.startsWith(`${dir}/`) && file.endsWith('.md')).length;
}

/** Reads and parses a package's `mcp.json`; unreadable means "no servers". */
async function readMcpServers(client: RepoClient, path: string, commit: string) {
  try {
    const decoded = decodeFile(await client.readFile(path, commit));
    return 'content' in decoded ? parseMcpJson(decoded.content) : {};
  } catch {
    return {};
  }
}

/**
 * Downloads whole packages — manifest, MCP configuration, slash commands,
 * sub-agents and bundled skills — ready to be stored as personal plugins or
 * written into a folder on disk. Each one comes back carrying its
 * {@link Plugin.source}, which is what later lets the copy be measured against
 * the repository it came from.
 */
export async function fetchRepoPlugins(
  request: PluginRepoFetchRequest,
): Promise<PluginRepoFetchResponse> {
  if (request.paths.length === 0) {
    throw new ConnectorError(400, 'No plugins were selected.');
  }

  const client = repoClientFor(request.repo);
  const { ref, commit } = await resolveRevision(client, request.repo.ref);
  const fetchedAt = new Date().toISOString();
  const skipped: PluginRepoSkippedFile[] = [];

  const plugins = await mapWithLimit(
    request.paths,
    READ_CONCURRENCY,
    async (rawPath): Promise<Plugin> => {
      const path = normalizePath(rawPath);
      // Listed again per package rather than trusted from the browser: the
      // request only names directories, and the contents are whatever the
      // repository holds under them at this commit.
      const files = await client.listFiles(path, commit);

      return readPluginPackage({
        client,
        path,
        files,
        commit,
        fetchedAt,
        source: sourceOf(request.repo, path, ref, commit, fetchedAt),
        fallbackId: request.repo.repo,
        onSkipped: (file) => skipped.push(file),
      });
    },
  );

  return { ref, commit, plugins, skipped };
}

/** One package, once its directory and its file listing are already known. */
export interface RepoPluginRead {
  client: RepoClient;
  /** Package directory relative to the repository root. */
  path: string;
  /** Every file under {@link path}, relative to it. */
  files: string[];
  commit: string;
  fetchedAt: string;
  /** Where the copy says it came from, or omitted for a catalogue read. */
  source?: PackageSource;
  /** Id to fall back on for a package sitting at the repository root. */
  fallbackId: string;
  onSkipped: (skipped: PluginRepoSkippedFile) => void;
}

/**
 * Downloads one package whole — manifest, `mcp.json`, commands, sub-agents and
 * bundled skills.
 *
 * Split out of {@link fetchRepoPlugins} because the catalogue walk
 * (`catalog-repo.ts`) has the whole tree in hand already and must not pay a
 * listing per package to read the same thing.
 */
export async function readPluginPackage({
  client,
  path,
  files: allFiles,
  commit,
  fetchedAt,
  source,
  fallbackId,
  onSkipped,
}: RepoPluginRead): Promise<Plugin> {
  const files = allFiles.slice(0, MAX_PLUGIN_FILES);

  /** Reads one file as text, recording it as skipped when it cannot travel. */
  const readText = async (filePath: string): Promise<string | undefined> => {
    const decoded = decodeFile(await client.readFile(filePath, commit));
    if ('content' in decoded) {
      return decoded.content;
    }
    onSkipped({ path: filePath, reason: decoded.reason });
    return undefined;
  };

  const manifestPath = pickFile(files, [PLUGIN_MANIFEST, LEGACY_PLUGIN_MANIFEST]);
  if (!manifestPath) {
    throw new ConnectorError(422, `${path} holds no ${PLUGIN_MANIFEST}.`);
  }
  const rawManifest = await readText(joinPath(path, manifestPath));
  if (rawManifest === undefined) {
    throw new ConnectorError(422, `${joinPath(path, manifestPath)} is not text.`);
  }
  const meta = parsePluginManifest(rawManifest, baseOf(path) || fallbackId);

  const mcpFile = pickFile(files, [PLUGIN_MCP_FILE, LEGACY_PLUGIN_MCP_FILE]);
  const rawMcp = mcpFile ? await readText(joinPath(path, mcpFile)) : undefined;
  const mcpServers = rawMcp === undefined ? {} : parseMcpJson(rawMcp);

  const commands: PluginCommand[] = [];
  const commandsDir = pickDir(files, [COMMANDS_DIR, LEGACY_COMMANDS_DIR]);
  for (const relative of markdownUnder(files, commandsDir)) {
    const content = await readText(joinPath(path, commandsDir, relative));
    if (content !== undefined) {
      commands.push(parseCommandMarkdown(entryName(relative), content));
    }
  }

  const agents: PluginAgent[] = [];
  const agentsDir = pickDir(files, [AGENTS_DIR, LEGACY_AGENTS_DIR]);
  for (const relative of markdownUnder(files, agentsDir)) {
    const content = await readText(joinPath(path, agentsDir, relative));
    if (content !== undefined) {
      agents.push(parseAgentMarkdown(entryName(relative), content));
    }
  }

  const skills = await readBundledSkills(path, files, fetchedAt, readText);

  return {
    id: meta.name || baseOf(path) || fallbackId,
    ...meta,
    commands,
    agents,
    skills,
    ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    ...(source ? { source } : {}),
    createdAt: fetchedAt,
    updatedAt: fetchedAt,
  };
}

/** Markdown paths under one of the package's entry directories, relative to it. */
function markdownUnder(files: string[], dir: string): string[] {
  return dir === ''
    ? []
    : files
        .filter((file) => file.startsWith(`${dir}/`) && file.endsWith('.md'))
        .map((file) => file.slice(dir.length + 1))
        .sort();
}

/**
 * The package's `skills/<name>/` packages, each with its own resources. The same
 * shape a standalone skill has, so a bundled skill written to disk is byte-wise
 * an ordinary Agent Skills package.
 */
async function readBundledSkills(
  path: string,
  files: string[],
  fetchedAt: string,
  readText: (path: string) => Promise<string | undefined>,
): Promise<Skill[]> {
  const dirs = files
    .filter(
      (file) =>
        file.startsWith(`${SKILLS_DIR}/`) &&
        file.endsWith(`/${SKILL_FILE}`) &&
        file.split('/').length === 3,
    )
    .map((file) => file.slice(0, file.length - SKILL_FILE.length - 1))
    .sort();

  const skills: Skill[] = [];
  for (const dir of dirs) {
    const raw = await readText(joinPath(path, dir, SKILL_FILE));
    if (raw === undefined) {
      continue;
    }
    const id = baseOf(dir);
    const { frontmatter, body } = splitFrontmatter(raw);
    const meta = parseFrontmatter(frontmatter);

    const resources: SkillFile[] = [];
    for (const relative of under(files, dir).filter((file) => file !== SKILL_FILE)) {
      const content = await readText(joinPath(path, dir, relative));
      if (content !== undefined) {
        resources.push({ path: relative, content });
      }
    }

    skills.push({
      id,
      name: typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : id,
      description: typeof meta.description === 'string' ? meta.description.trim() : '',
      instructions: body.trim(),
      files: resources,
      manifest: parseManifest(meta.manifest),
      createdAt: fetchedAt,
      updatedAt: fetchedAt,
    });
  }

  return skills;
}
