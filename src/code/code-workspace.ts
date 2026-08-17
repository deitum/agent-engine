import { existsSync } from 'node:fs';
import {
  appendFile,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveRepoCredentials } from '../config/engine-config';
import { ConnectorError } from '../connector';
import {
  type CodeCloneRequest,
  type CodeCommandFailure,
  type CodeCredentials,
  type CodeDiff,
  type CodeDiffFile,
  type CodeDiffMode,
  type CodeEnvVar,
  type CodeImageSource,
  type CodeLspConfig,
  type CodeLspLanguage,
  type CodeLspStatus,
  type CodeRepoRef,
  type CodeSandboxLimits,
  type CodeSetupInfo,
  type CodeToolchain,
  type CodeWorkspaceStatus,
  type CodeWorkspaceSummary,
  LOCAL_DIR,
  LOCAL_SKILLS_DIR,
  repoProvider,
} from '../contracts';
import { engineHome, checkoutConfigArgs, checkoutGitConfig, toDockerMountPath } from '../platform';
import { DIR_SIZE_MAX_ENTRIES, RM_RETRY } from '../platform.constants';
import { cloneUrl, gitAuthArgs, parseCloneUrl } from '../vcs/vcs';

import { addFailure, clearFailures } from './code-memory';
import { type DockerExecOptions, dockerExec, type ExecuteResponse } from './docker-backend';
import { dnsSearchArgs, hostSearchDomains } from './docker-dns';
import {
  isSafeBranchName,
  isSafeEnvKey,
  isSafeRelPath,
  type NumstatEntry,
  parseNumstatZ,
  parseStatusZ,
  redactUrls,
} from './git-parse';
import { LspSession } from './lsp/lsp-session';
import {
  defaultRunner,
  PROCESS_TIMEOUTS,
  ProcessTimeoutError,
  type ProcessRunner,
} from './process';
import {
  detectToolchain,
  FALLBACK_IMAGE,
  INSTALL_ARTIFACTS,
  TOOLCHAIN_LSP_LANGUAGE,
  type ToolchainCommands,
  type ToolchainDetection,
} from './toolchain';

/** Root for per-session Code workspaces on the user's machine. */
const WORKSPACE_ROOT = join(engineHome(), 'code');
/**
 * Package-manager caches, **shared by every session** and mounted at `/cache`.
 *
 * A host directory rather than a Docker volume on purpose: on Linux the
 * container runs as the host uid/gid (see `ensureContainer`), and a named volume
 * is created root-owned — the install would fail to write into it without a
 * separate `chown` pass. A host directory the connector creates itself has the
 * right owner from the start.
 */
const CACHE_ROOT = join(engineHome(), 'cache');
/** Prefix for the per-session Docker containers. */
const CONTAINER_PREFIX = 'agent-engine-code-';
/**
 * Prefixes {@link CONTAINER_PREFIX} has had. A session's container is removed by
 * the name derived from its id, so a session created by an earlier build would
 * otherwise never be reaped: its metadata survives on disk, the new name misses,
 * and the old container stays until someone finds it in `docker ps`. Droppable
 * once no workspace on disk predates the rename.
 */
const LEGACY_CONTAINER_PREFIXES = ['aft-code-'];
/** Docker label carrying the session id, so orphaned containers are findable. */
const SESSION_LABEL = 'com.deitum.agent-engine.code';
/** Metadata file that lets a workspace survive a connector restart. */
const META_FILE = 'workspace.json';
/** Shape version of `workspace.json`, written on every save. */
const META_VERSION = 1;
/**
 * Shape of the `docker run` arguments a container was created with. Bumped
 * whenever those arguments change (mounts, environment, DNS): a session created
 * by an older connector would otherwise keep a container without the `/cache`
 * mount — or without the host's search domains — for as long as its image and
 * limits stayed the same.
 */
const CONTAINER_SHAPE_VERSION = 3;
/** The materialised-skills dir kept out of git (see `runCodeStream`). */
const SKILLS_EXCLUDE_ENTRY = `${LOCAL_SKILLS_DIR}/`;
/** The session-local dir holding generated project memory, also kept out of git. */
export const LOCAL_DIR_ENTRY = `${LOCAL_DIR}/`;
/**
 * Where deepagents' filesystem middleware offloads an oversized tool result.
 * Unlike the summarizer's history directory (`historyPathPrefix`, see
 * `code-agent.ts`) this path is hard-coded in the library, so it cannot be moved
 * under {@link LOCAL_DIR} — it is kept out of the diff by exclusion instead.
 */
const TOOL_EVICT_EXCLUDE_ENTRY = 'large_tool_results/';
/** Container is stopped (not destroyed) after this long without use. */
const IDLE_TTL_MS = 30 * 60_000;
const SWEEP_INTERVAL_MS = 5 * 60_000;
/** Defaults for the container's resource limits. */
const DEFAULT_LIMITS: Required<Omit<CodeSandboxLimits, 'network'>> & {
  network: 'bridge' | 'none';
} = {
  memory: '4g',
  cpus: '2',
  pidsLimit: 512,
  network: 'bridge',
};
/** Guard rails for the diff payload streamed to the browser. */
const MAX_DIFF_FILES = 200;
const MAX_PATCH_CHARS = 400_000;

/**
 * Points every package manager at the shared `/cache` mount, so a dependency is
 * downloaded once per machine instead of once per session. Set on the container
 * itself, so they apply to every `docker exec` — the agent's builds included,
 * not just the bootstrap install.
 */
const CACHE_ENV: Record<string, string> = {
  NPM_CONFIG_CACHE: '/cache/npm',
  // pnpm reads npm-style config from the environment; this is its store path.
  npm_config_store_dir: '/cache/pnpm',
  YARN_CACHE_FOLDER: '/cache/yarn',
  BUN_INSTALL_CACHE_DIR: '/cache/bun',
  GRADLE_USER_HOME: '/cache/gradle',
  MAVEN_OPTS: '-Dmaven.repo.local=/cache/maven',
  PIP_CACHE_DIR: '/cache/pip',
  UV_CACHE_DIR: '/cache/uv',
  POETRY_CACHE_DIR: '/cache/poetry',
  GOMODCACHE: '/cache/go/mod',
  GOCACHE: '/cache/go/build',
};

/** Persisted description of a session's workspace (`workspace.json`). */
interface WorkspaceMeta {
  /** {@link META_VERSION} this file was written by. */
  version: number;
  sessionId: string;
  repo: CodeRepoRef;
  /** The branch the work branch was created from; never re-derived after clone. */
  baseBranch: string;
  workBranch: string;
  toolchain: CodeToolchain;
  detected: ToolchainDetection;
  /** The image the container was created with. */
  image: string;
  imageSource: CodeImageSource;
  limits: CodeSandboxLimits;
  /** {@link CONTAINER_SHAPE_VERSION} the container was created with. */
  shapeVersion?: number;
  env: CodeEnvVar[];
  /**
   * Dependency install + project memory state. Carried across a re-`prepare`
   * (applying an image, restoring a session) as long as the checkout survives,
   * and reset when the repository is cloned afresh.
   */
  setup?: CodeSetupInfo;
  /**
   * Commands that failed in this workspace, newest last. Injected into the notes
   * file before every turn so the agent does not retry a command it already
   * broke a turn ago — the transcript that would have told it is gone by then.
   * Absent on metadata written by an older connector.
   */
  failures?: CodeCommandFailure[];
  /** Commit author, remembered so committing works without a global git identity. */
  authorName?: string;
  updatedAt: number;
}

/** A workspace as held in memory. Busy-ness lives in {@link CodeWorkspaces.locks}. */
interface Workspace {
  meta: WorkspaceMeta;
  dir: string;
  containerName: string;
  lastUsed: number;
}

/** What the coding agent needs to build its backend for a session. */
export interface WorkspaceBackendInfo {
  dir: string;
  containerName: string;
  toolchain: CodeToolchain;
  detected: ToolchainDetection;
  env: CodeEnvVar[];
  baseBranch: string;
}

/** Sanitises a session id into a safe single-segment name for dirs / containers. */
function safeName(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 64);
  return safe.length > 0 ? safe : 'default';
}

/** Validates a branch name before it reaches a git command line. */
function assertBranchName(name: string): string {
  const branch = name.trim();
  if (!isSafeBranchName(branch)) {
    throw new ConnectorError(400, `Invalid branch name: «${name}».`);
  }
  return branch;
}

/**
 * The commit identity a session uses where the environment has none of its own:
 * the account the repository credentials belong to, or a neutral stand-in.
 *
 * Shared by the host-side fallback ({@link CodeWorkspaces.identityArgs}) and the
 * container's global git config, so a commit the agent makes in the sandbox and
 * one `/commit` makes on the host carry the same author.
 */
function commitIdentity(authorName?: string): Record<string, string> {
  const name = authorName?.trim() || 'Agent Engine';
  // The name is a repository login and may hold anything one does — spaces, a
  // full name in Cyrillic — while the address built from it still has to parse.
  const local = name.replace(/[^A-Za-z0-9._-]+/g, '.').replace(/^\.+|\.+$/g, '') || 'agent';
  return { 'user.name': name, 'user.email': `${local}@agent-engine.local` };
}

/** Validates the env pairs a request carries and drops empty keys. */
export function normalizeEnv(env: CodeEnvVar[] | undefined): CodeEnvVar[] {
  if (!env || env.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const result: CodeEnvVar[] = [];
  for (const item of env) {
    const key = item.key.trim();
    if (!key || seen.has(key)) {
      continue;
    }
    if (!isSafeEnvKey(key)) {
      throw new ConnectorError(400, `Invalid environment variable name: «${item.key}».`);
    }
    seen.add(key);
    result.push({ key, value: item.value, ...(item.secret ? { secret: true } : {}) });
  }
  return result;
}

/**
 * Adds entries to a checkout's local `.git/info/exclude` (idempotent) so the
 * things the connector itself writes into the workspace — materialised skills,
 * generated project memory, the artefacts of a dependency install — never show
 * up in the git status / diff the Code UI renders. `.git/info/exclude` is
 * local-only, so it never leaks into a commit or PR, and it only affects
 * **untracked** paths, so no entry here can hide a real change.
 */
export async function excludeLocalEntries(dir: string, entries: string[]): Promise<void> {
  if (entries.length === 0) {
    return;
  }
  const excludePath = join(dir, '.git', 'info', 'exclude');
  try {
    const current = existsSync(excludePath) ? await readFile(excludePath, 'utf8') : '';
    const present = new Set(current.split('\n').map((line) => line.trim()));
    const missing = entries.filter((entry) => !present.has(entry));
    if (missing.length === 0) {
      return;
    }
    const prefix = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
    await appendFile(excludePath, `${prefix}${missing.join('\n')}\n`);
  } catch {
    // Non-fatal: worst case those paths show up as untracked in the diff.
  }
}

/**
 * Manages per-session Code workspaces: a host directory holding the git checkout
 * (bind-mounted into a Docker container where builds/tests run). One instance is
 * shared across all `/code/*` requests, mirroring the MCP `Connector` pool.
 *
 * Every workspace is also described on disk (`workspace.json`), so a session
 * survives a connector restart and the idle sweep: {@link CodeWorkspaces.get}
 * rehydrates it from that file and restarts its container on demand. Git commands
 * run on the **host** against the checkout; the agent's shell runs in the
 * container (see {@link makeDockerBackend}).
 */
export class CodeWorkspaces {
  private readonly workspaces = new Map<string, Workspace>();
  /**
   * Sessions with a turn or command in flight. Keyed by session id rather than
   * held on {@link Workspace}, because `prepare` has to take the lock for a
   * session that has no workspace yet — which is exactly the race it prevents
   * (a re-clone checking out a different branch under a running agent).
   */
  private readonly locks = new Set<string>();
  /**
   * Language servers, one set per session.
   *
   * Owned here rather than built per turn because a server is expensive to start
   * — jdtls spends minutes importing a Gradle project — and worthless if it is
   * thrown away before the next request. Their lifetime is the container's: they
   * are stopped wherever it is stopped, and started again lazily on the next use.
   */
  private readonly lspSessions = new Map<string, LspSession>();
  /** Serialised LSP config each live session was built with, to spot a change. */
  private readonly lspConfigs = new Map<string, string>();
  private readonly sweeper: NodeJS.Timeout;
  private readonly runner: ProcessRunner;
  /** Where the per-session workspaces live; overridable so tests stay off `$HOME`. */
  private readonly root: string;
  /** Shared package-manager caches mounted at `/cache`; overridable for tests. */
  private readonly cacheRoot: string;
  /**
   * DNS search domains handed to a new container (see `docker-dns.ts`). Injected
   * so a test does not depend on the machine's own resolver configuration.
   */
  private readonly dnsSearch: () => Promise<string[]>;

  constructor(
    options: {
      runner?: ProcessRunner;
      root?: string;
      cacheRoot?: string;
      dnsSearch?: () => Promise<string[]>;
    } = {},
  ) {
    this.runner = options.runner ?? defaultRunner;
    this.root = options.root ?? WORKSPACE_ROOT;
    this.cacheRoot = options.cacheRoot ?? CACHE_ROOT;
    this.dnsSearch = options.dnsSearch ?? (() => hostSearchDomains(this.runner));
    this.sweeper = setInterval(() => void this.sweepIdle(), SWEEP_INTERVAL_MS);
    this.sweeper.unref?.();
  }

  /**
   * Prepares a session's workspace: verifies Docker, clones the repo (once),
   * creates the work branch, detects the toolchain, resolves the image and starts
   * the container. Idempotent — re-preparing an existing session refreshes its
   * container, env and image without touching the checkout's current branch.
   *
   * Holds the session lock: without it a re-clone (the settings screen's
   * applying an image, or the restore button) would run `checkout -B`
   * while an agent was editing the same checkout.
   */
  async prepare(req: CodeCloneRequest): Promise<CodeWorkspaceStatus> {
    await this.withLock(req.sessionId, () => this.prepareLocked(req));
    // Read the status *after* releasing, or it would report the session as busy
    // on account of the very call that is returning it.
    return this.status(req.sessionId);
  }

  private async prepareLocked(req: CodeCloneRequest): Promise<void> {
    await this.assertDocker();

    const name = safeName(req.sessionId);
    const root = join(this.root, name);
    const dir = join(root, 'repo');
    const containerName = `${CONTAINER_PREFIX}${name}`;
    const url = cloneUrl(req.repo);
    const env = normalizeEnv(req.env);
    // From the configuration the client handed over when it connected, not from
    // this request: they are the user's credentials, the same for every session,
    // and they are what `gitAuthArgs` puts on the clone.
    const credentials = resolveRepoCredentials(repoProvider(req.repo), req.repo.baseUrl);
    const existing = await this.readMeta(req.sessionId);

    let baseBranch = existing?.baseBranch ?? '';
    // A checkout produced by this call already used the right settings, so it
    // never needs the repair pass — see `applyCheckoutConfig`.
    let freshClone = false;
    // A checkout that survives keeps its bootstrap state and its failure
    // journal; one cloned from scratch has no dependencies, no memory and no
    // history of broken commands, whatever the old file said.
    let setup = existing?.setup;
    let failures = existing?.failures;

    if (!existsSync(join(dir, '.git'))) {
      await mkdir(root, { recursive: true });
      await rm(dir, RM_RETRY);
      const args = [
        ...gitAuthArgs(credentials),
        // Before the subcommand, like `authArgs`: these decide how the working
        // tree is written, so they have to be in force during the clone itself.
        ...checkoutConfigArgs(),
        'clone',
        '--depth',
        '50',
        '--no-single-branch',
      ];
      if (req.baseBranch) {
        args.push('--branch', assertBranchName(req.baseBranch));
      }
      args.push('--', url, dir);
      await this.git(root, args, 'Could not clone the repository', undefined, {
        timeoutMs: PROCESS_TIMEOUTS.gitNetwork,
      });
      // The freshly cloned HEAD *is* the base branch — capture it before any
      // work branch is checked out, and never derive it again (deriving it later
      // yields the work branch, which would make `/pr` target itself).
      baseBranch = (await this.git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      setup = undefined;
      failures = undefined;
      freshClone = true;
    } else if (!baseBranch) {
      // A checkout from an older connector version: recover the remote's default.
      baseBranch = await this.remoteDefaultBranch(dir, req.baseBranch);
    }

    // Before any host-side `checkout`, which would otherwise re-write the working
    // tree with whatever the machine's global git config says about line endings.
    await this.applyCheckoutConfig(dir, { repair: !freshClone });

    const current = (await this.git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    let workBranch = existing?.workBranch ?? current;
    if (req.workBranch) {
      workBranch = assertBranchName(req.workBranch);
    } else if (!existing && current === baseBranch) {
      workBranch = assertBranchName(`agent/${name}`.slice(0, 60));
    }
    if (current !== workBranch) {
      await this.git(dir, ['checkout', '-B', workBranch], 'Could not create the work branch');
    }

    const detected = detectToolchain(dir);

    // Keep everything the engine itself writes into the checkout out of git:
    // materialised skills (`.agent-engine-skills/`), the generated project memory
    // and the OpenSpec tree (`.agent-engine/`), the offloaded oversized tool
    // results (`large_tool_results/`), and the artefacts of the dependency
    // install — so none of them ever appear in the status/diff the UI shows, or
    // in a commit.
    await excludeLocalEntries(dir, [
      SKILLS_EXCLUDE_ENTRY,
      LOCAL_DIR_ENTRY,
      TOOL_EVICT_EXCLUDE_ENTRY,
      ...INSTALL_ARTIFACTS[detected.toolchain],
    ]);

    const requestedImage = req.image?.trim();
    const limits = { ...DEFAULT_LIMITS, ...req.limits };
    const meta: WorkspaceMeta = {
      version: META_VERSION,
      sessionId: req.sessionId,
      repo: req.repo,
      baseBranch,
      workBranch,
      toolchain: detected.toolchain,
      detected,
      image: requestedImage || detected.image,
      imageSource: requestedImage ? 'override' : 'auto',
      limits,
      shapeVersion: CONTAINER_SHAPE_VERSION,
      env,
      ...(setup ? { setup } : {}),
      ...(failures && failures.length > 0 ? { failures } : {}),
      ...(credentials.username ? { authorName: credentials.username } : {}),
      updatedAt: Date.now(),
    };

    const applied = await this.ensureContainer(containerName, dir, meta.image, limits, {
      recreate: existing !== null && !sameContainerShape(existing, meta),
      authorName: meta.authorName,
    });
    if (applied !== meta.image) {
      meta.image = applied;
      meta.imageSource = 'fallback';
    }

    const workspace: Workspace = { meta, dir, containerName, lastUsed: Date.now() };
    this.workspaces.set(req.sessionId, workspace);
    await this.writeMeta(workspace);
  }

  /**
   * A prepared session's workspace. Rehydrates it from `workspace.json` when the
   * in-memory entry is gone (connector restarted, or the idle sweep dropped it),
   * so an existing session keeps working without re-cloning.
   *
   * A checkout whose metadata is missing or unreadable is **rebuilt** from the
   * checkout itself ({@link recoverMeta}) rather than reported as missing: the
   * repository is still there and still knows its own remote, so declaring the
   * session dead would throw away the user's uncommitted work over a lost
   * bookkeeping file. Only a vanished checkout is a genuine 404.
   */
  private async get(sessionId: string): Promise<Workspace> {
    const cached = this.workspaces.get(sessionId);
    if (cached) {
      cached.lastUsed = Date.now();
      return cached;
    }

    const dir = join(this.root, safeName(sessionId), 'repo');
    if (!existsSync(join(dir, '.git'))) {
      throw new ConnectorError(
        404,
        'The workspace is not ready — reconnect the repository for this session.',
      );
    }

    const meta = (await this.readMeta(sessionId)) ?? (await this.recoverMeta(sessionId, dir));
    if (!meta) {
      throw new ConnectorError(
        404,
        'The workspace is damaged — reconnect the repository for this session.',
      );
    }

    const workspace: Workspace = {
      meta,
      dir,
      containerName: `${CONTAINER_PREFIX}${safeName(sessionId)}`,
      lastUsed: Date.now(),
    };
    this.workspaces.set(sessionId, workspace);
    // Persist the recovered snapshot so the next request takes the fast path.
    await this.writeMeta(workspace);
    return workspace;
  }

  /**
   * Rebuilds a workspace's metadata from the checkout on disk when
   * `workspace.json` is gone or unparseable. Everything it holds is either
   * recorded by git itself (the remote, the current branch) or re-derivable
   * ({@link detectToolchain}); what cannot be recovered is the session's env and
   * any image override, and both are re-sent by the browser on the next run.
   */
  private async recoverMeta(sessionId: string, dir: string): Promise<WorkspaceMeta | null> {
    let origin: string;
    try {
      origin = (await this.git(dir, ['remote', 'get-url', 'origin'])).trim();
    } catch {
      return null;
    }
    const repo = parseCloneUrl(origin);
    if (!repo) {
      return null;
    }

    const detected = detectToolchain(dir);
    const workBranch = (await this.git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    console.warn(`[code] rebuilt workspace metadata for session ${sessionId} from its checkout`);

    return {
      version: META_VERSION,
      sessionId,
      repo,
      baseBranch: await this.remoteDefaultBranch(dir, undefined),
      workBranch,
      toolchain: detected.toolchain,
      detected,
      image: detected.image,
      imageSource: 'auto',
      limits: { ...DEFAULT_LIMITS },
      shapeVersion: CONTAINER_SHAPE_VERSION,
      env: [],
      updatedAt: Date.now(),
    };
  }

  /** Backend wiring for a prepared session (rehydrating it if needed). */
  async backendInfo(sessionId: string): Promise<WorkspaceBackendInfo> {
    const ws = await this.get(sessionId);
    await this.ensureRunning(ws);
    return {
      dir: ws.dir,
      containerName: ws.containerName,
      toolchain: ws.meta.toolchain,
      detected: ws.meta.detected,
      env: ws.meta.env,
      baseBranch: ws.meta.baseBranch,
    };
  }

  /** The `/test` and `/build` commands for the session's detected stack. */
  async commands(sessionId: string): Promise<ToolchainCommands> {
    const ws = await this.get(sessionId);
    return ws.meta.detected.commands;
  }

  /** The repo coordinates a session was cloned from. */
  async repo(sessionId: string): Promise<CodeRepoRef> {
    return (await this.get(sessionId)).meta.repo;
  }

  async baseBranch(sessionId: string): Promise<string> {
    return (await this.get(sessionId)).meta.baseBranch;
  }

  /**
   * Replaces the env applied to the session's commands, persisting it so a
   * rehydrated workspace keeps it. Called at the start of every run / command so
   * the browser stays the source of truth.
   */
  async setEnv(sessionId: string, env: CodeEnvVar[] | undefined): Promise<void> {
    if (env === undefined) {
      return;
    }
    const ws = await this.get(sessionId);
    const next = normalizeEnv(env);
    if (JSON.stringify(next) === JSON.stringify(ws.meta.env)) {
      return;
    }
    ws.meta.env = next;
    await this.writeMeta(ws);
  }

  /**
   * Marks a session busy for the duration of a run / command. Prevents two
   * agents (or an agent and a command, or a re-clone) from racing on the same
   * checkout.
   *
   * Deliberately does **not** resolve the workspace first: `prepare` takes this
   * same lock for a session that has no workspace yet, and the whole point is
   * that the two cannot run concurrently. Callers that need the workspace get
   * their 404 from the operation itself.
   */
  async acquire(sessionId: string): Promise<void> {
    if (this.locks.has(sessionId)) {
      throw new ConnectorError(
        409,
        'This session already has work running — wait for it to finish.',
      );
    }
    this.locks.add(sessionId);
    return Promise.resolve();
  }

  release(sessionId: string): void {
    this.locks.delete(sessionId);
    const ws = this.workspaces.get(sessionId);
    if (ws) {
      ws.lastUsed = Date.now();
    }
  }

  /** True while a turn, command or re-clone holds the session. */
  isBusy(sessionId: string): boolean {
    return this.locks.has(sessionId);
  }

  /**
   * Runs `fn` holding the session lock. Used by the operations that own their
   * whole lifetime (`prepare`, `remove`); the streaming paths call
   * {@link acquire} / {@link release} directly because the lock has to outlive
   * the function that opens the stream.
   */
  private async withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    await this.acquire(sessionId);
    try {
      return await fn();
    } finally {
      this.release(sessionId);
    }
  }

  /** The git + toolchain state of a session's workspace. */
  async status(sessionId: string): Promise<CodeWorkspaceStatus> {
    const ws = await this.get(sessionId);
    const raw = await this.git(ws.dir, [
      '-c',
      'core.quotepath=false',
      'status',
      '--porcelain=v1',
      '-b',
      '-z',
    ]);
    const parsed = parseStatusZ(raw);
    const branch = parsed.branch ?? ws.meta.workBranch;

    // Without an upstream (before the first push) compare against the base
    // branch instead, so the counters mean something from the start.
    let { ahead, behind } = parsed;
    if (!parsed.upstream) {
      ({ ahead, behind } = await this.countAgainstBase(ws));
    }

    return {
      cloned: true,
      branch,
      baseBranch: ws.meta.baseBranch,
      toolchain: ws.meta.toolchain,
      ahead,
      behind,
      files: parsed.files,
      image: ws.meta.image,
      imageSource: ws.meta.imageSource,
      detected: ws.meta.detected,
      envKeys: ws.meta.env.map((item) => item.key),
      containerRunning: await this.isRunning(ws.containerName),
      busy: this.isBusy(sessionId),
      setup: setupOf(ws.meta),
      lsp: this.lspStatus(sessionId),
    };
  }

  /**
   * The session's diff, one patch per file. `worktree` shows uncommitted changes
   * (including files git does not track yet); `branch` shows everything the work
   * branch adds on top of its base, uncommitted changes included.
   */
  async diff(sessionId: string, mode: CodeDiffMode = 'worktree'): Promise<CodeDiff> {
    const ws = await this.get(sessionId);
    const ref = mode === 'branch' ? await this.baseRef(ws) : 'HEAD';
    return this.diffAgainst(ws, ref, mode);
  }

  /** Creates and checks out a new work branch (`git checkout -b <name>`). */
  async createBranch(sessionId: string, name: string): Promise<string> {
    const ws = await this.get(sessionId);
    const branch = assertBranchName(name);
    await this.git(ws.dir, ['checkout', '-b', branch], 'Could not create the branch');
    ws.meta.workBranch = branch;
    await this.writeMeta(ws);
    return branch;
  }

  /** Switches to an existing branch, keeping uncommitted changes. */
  async checkout(sessionId: string, name: string): Promise<string> {
    const ws = await this.get(sessionId);
    const branch = assertBranchName(name);
    await this.git(ws.dir, ['checkout', branch], 'Could not switch branch');
    ws.meta.workBranch = branch;
    await this.writeMeta(ws);
    return branch;
  }

  /**
   * Stages everything and commits with `message` (a generic default when empty).
   * Returns a human-readable summary; a clean tree is reported, not thrown.
   */
  async commit(sessionId: string, message: string): Promise<string> {
    const ws = await this.get(sessionId);
    await this.git(ws.dir, ['add', '-A'], 'Could not stage the changes');

    const staged = (await this.git(ws.dir, ['status', '--porcelain=v1', '-z'])).trim();
    if (!staged) {
      return 'Nothing to commit — the working tree is clean.';
    }

    const text = message.trim() || 'Changes (agent-engine)';
    const identity = await this.identityArgs(ws);
    return (await this.git(ws.dir, [...identity, 'commit', '-m', text], 'Could not commit')).trim();
  }

  /** Pushes the current branch to `origin`, setting upstream. Returns the branch. */
  async push(sessionId: string, credentials: CodeCredentials): Promise<string> {
    const ws = await this.get(sessionId);
    const branch = (await this.git(ws.dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    await this.git(
      ws.dir,
      [...gitAuthArgs(credentials), 'push', '-u', 'origin', `HEAD:refs/heads/${branch}`],
      'Could not push the branch',
      undefined,
      { timeoutMs: PROCESS_TIMEOUTS.gitNetwork },
    );
    return branch;
  }

  /**
   * Fetches from `origin`, updating the remote-tracking refs. Returns git's own
   * report (empty when there was nothing new).
   *
   * `--no-tags` because the checkout is shallow and a tag fetch on one pulls
   * history nobody asked for; deepening is left to git, which walks back only as
   * far as the fetched branches need.
   */
  async fetch(sessionId: string, credentials: CodeCredentials, branch?: string): Promise<string> {
    const ws = await this.get(sessionId);
    const args = [...gitAuthArgs(credentials), 'fetch', '--no-tags', 'origin'];
    if (branch) {
      args.push(assertBranchName(branch));
    }
    return (
      await this.git(ws.dir, args, 'Could not fetch from origin', undefined, {
        timeoutMs: PROCESS_TIMEOUTS.gitNetwork,
      })
    ).trim();
  }

  /** Discards a path's changes: restores a tracked file, deletes an untracked one. */
  async revert(sessionId: string, path: string): Promise<string> {
    const ws = await this.get(sessionId);
    const relative = path.trim();
    if (!isSafeRelPath(relative)) {
      throw new ConnectorError(400, `Invalid path: «${path}».`);
    }
    try {
      await this.git(ws.dir, ['checkout', 'HEAD', '--', relative]);
      return `«${relative}» was restored from HEAD.`;
    } catch {
      await this.git(ws.dir, ['clean', '-fd', '--', relative], 'Could not delete the file');
      return `«${relative}» was deleted (git was not tracking it).`;
    }
  }

  /**
   * Runs a shell command inside the session's container. `options` carries the
   * abort signal, a longer budget than the default (a cold dependency install
   * outlives it) and an `onOutput` sink for the callers that stream a live log.
   */
  async exec(
    sessionId: string,
    command: string,
    options: Omit<DockerExecOptions, 'env'> = {},
  ): Promise<ExecuteResponse> {
    const ws = await this.get(sessionId);
    await this.ensureRunning(ws);
    return dockerExec(ws.containerName, command, { ...options, env: ws.meta.env });
  }

  /** The session's bootstrap state, defaulted for a workspace that never ran it. */
  async setup(sessionId: string): Promise<CodeSetupInfo> {
    const ws = await this.get(sessionId);
    return setupOf(ws.meta);
  }

  /** Records the outcome of a bootstrap run so the next open can skip it. */
  async setSetup(sessionId: string, setup: CodeSetupInfo): Promise<void> {
    const ws = await this.get(sessionId);
    ws.meta.setup = setup;
    await this.writeMeta(ws);
  }

  /** The session's failure journal (empty for a workspace that never failed one). */
  async failures(sessionId: string): Promise<CodeCommandFailure[]> {
    return (await this.get(sessionId)).meta.failures ?? [];
  }

  /**
   * Records a failed command, de-duplicated by the command itself and capped —
   * see {@link addFailure}. Best-effort on purpose: a workspace that has gone
   * away must not turn a failing build into a second, louder failure.
   */
  async recordFailure(sessionId: string, failure: CodeCommandFailure): Promise<void> {
    try {
      const ws = await this.get(sessionId);
      ws.meta.failures = addFailure(ws.meta.failures ?? [], failure);
      await this.writeMeta(ws);
    } catch {
      // The journal is a convenience; losing an entry is not worth an error.
    }
  }

  /** Drops the journal entries a written lesson covers. */
  async clearFailures(sessionId: string, lesson: string): Promise<void> {
    try {
      const ws = await this.get(sessionId);
      const next = clearFailures(ws.meta.failures ?? [], lesson);
      if (next.length !== (ws.meta.failures ?? []).length) {
        ws.meta.failures = next;
        await this.writeMeta(ws);
      }
    } catch {
      // Same reasoning as recordFailure.
    }
  }

  /** The sandbox limits in force, so the bootstrap can tell a network-less session. */
  async limits(sessionId: string): Promise<CodeSandboxLimits> {
    return (await this.get(sessionId)).meta.limits;
  }

  /**
   * The repository's files as git sees them — tracked plus untracked-but-not-
   * ignored, NUL-delimited so Cyrillic and spaces survive. Used to build the
   * project-memory digest: going through git means `node_modules`, build output
   * and anything else the repository ignores never reaches it.
   */
  async listFiles(sessionId: string): Promise<string[]> {
    const ws = await this.get(sessionId);
    const raw = await this.git(ws.dir, [
      '-c',
      'core.quotepath=false',
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
    ]);
    return raw.split('\0').filter((path) => path.length > 0);
  }

  /** Every workspace the connector holds on disk (for the settings screen). */
  async list(): Promise<CodeWorkspaceSummary[]> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch {
      return [];
    }

    const summaries: CodeWorkspaceSummary[] = [];
    for (const name of names) {
      const meta = await this.readMetaAt(join(this.root, name, META_FILE));
      if (!meta) {
        continue;
      }
      summaries.push({
        sessionId: meta.sessionId,
        repo: meta.repo,
        branch: meta.workBranch,
        image: meta.image,
        sizeBytes: await this.dirSize(join(this.root, name)),
        containerRunning: await this.isRunning(`${CONTAINER_PREFIX}${name}`),
        updatedAt: meta.updatedAt,
      });
    }
    return summaries.sort((left, right) => right.updatedAt - left.updatedAt);
  }

  /**
   * Removes a session's container and (unless asked otherwise) its checkout.
   * Holds the session lock so the files cannot disappear from under a running
   * build.
   */
  async remove(sessionId: string, keepFiles = false): Promise<void> {
    await this.withLock(sessionId, async () => {
      const name = safeName(sessionId);
      this.stopLsp(sessionId);
      this.workspaces.delete(sessionId);
      for (const prefix of [CONTAINER_PREFIX, ...LEGACY_CONTAINER_PREFIXES]) {
        await this.dockerAllowFail(['rm', '-f', `${prefix}${name}`]);
      }
      if (!keepFiles) {
        await rm(join(this.root, name), RM_RETRY);
      }
    });
  }

  /** Stops every session container (called on daemon shutdown). */
  async shutdown(): Promise<void> {
    clearInterval(this.sweeper);
    this.stopLsp();
    await Promise.all(
      [...this.workspaces.values()].map((ws) =>
        this.dockerAllowFail(['stop', '-t', '1', ws.containerName]),
      ),
    );
    this.workspaces.clear();
  }

  // ─── language servers ───────────────────────────────────────────────────────

  /**
   * The session's language servers, created on first use.
   *
   * `config` arrives with every run and setup request (it is org policy read from
   * the deployment and forwarded by the client), so the first call
   * of a session decides what the servers may do. A later call with a different
   * config replaces the set — that is how applying the settings takes
   * effect without restarting the session.
   */
  async lsp(sessionId: string, config: CodeLspConfig): Promise<LspSession> {
    const existing = this.lspSessions.get(sessionId);
    const signature = JSON.stringify(config ?? {});
    if (existing && this.lspConfigs.get(sessionId) === signature) {
      return existing;
    }
    existing?.dispose();

    const info = await this.backendInfo(sessionId);
    const primary: CodeLspLanguage | null = TOOLCHAIN_LSP_LANGUAGE[info.toolchain];
    const session = new LspSession({
      sessionId,
      dir: info.dir,
      containerName: info.containerName,
      env: info.env,
      config,
      ...(primary ? { primaryLanguage: primary } : {}),
      exec: (command, timeoutSec) => this.exec(sessionId, command, { timeoutSec }),
    });
    this.lspSessions.set(sessionId, session);
    this.lspConfigs.set(sessionId, signature);
    return session;
  }

  /** What the session's language servers are doing, for the workspace status. */
  lspStatus(sessionId: string): CodeLspStatus[] {
    return this.lspSessions.get(sessionId)?.status() ?? [];
  }

  /**
   * Stops the servers of whichever session owns a container. Used by the
   * container lifecycle, which knows the container name and not the session id.
   */
  private stopLspFor(containerName: string): void {
    const prefix = `${CONTAINER_PREFIX}`;
    if (!containerName.startsWith(prefix)) {
      return;
    }
    const name = containerName.slice(prefix.length);
    for (const sessionId of this.lspSessions.keys()) {
      if (safeName(sessionId) === name) {
        this.stopLsp(sessionId);
      }
    }
  }

  /**
   * Stops the language servers of one session, or of all of them.
   *
   * Called wherever the container goes away: the idle sweep, a removal, a
   * recreation for a new image. A server left behind would be talking down a
   * `docker exec` whose container no longer exists.
   */
  stopLsp(sessionId?: string): void {
    for (const [key, session] of this.lspSessions) {
      if (sessionId && key !== sessionId) {
        continue;
      }
      session.dispose();
      this.lspSessions.delete(key);
      this.lspConfigs.delete(key);
    }
  }

  // ─── git ────────────────────────────────────────────────────────────────────

  /** Ahead/behind of `HEAD` relative to the base branch, for a fresh work branch. */
  private async countAgainstBase(ws: Workspace): Promise<{ ahead: number; behind: number }> {
    try {
      const ref = await this.baseRef(ws);
      const raw = await this.git(ws.dir, ['rev-list', '--left-right', '--count', `${ref}...HEAD`]);
      const [behind, ahead] = raw.trim().split(/\s+/).map(Number);
      return { ahead: ahead || 0, behind: behind || 0 };
    } catch {
      return { ahead: 0, behind: 0 };
    }
  }

  /** The ref the base branch resolves to, preferring the remote-tracking one. */
  private async baseRef(ws: Workspace): Promise<string> {
    const remote = `origin/${ws.meta.baseBranch}`;
    try {
      await this.git(ws.dir, ['rev-parse', '--verify', '--quiet', remote]);
      return remote;
    } catch {
      return ws.meta.baseBranch;
    }
  }

  /** The remote's default branch, for checkouts made before metadata existed. */
  private async remoteDefaultBranch(dir: string, fallback: string | undefined): Promise<string> {
    try {
      const raw = await this.git(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
      const branch = raw.trim().replace(/^origin\//, '');
      if (branch) {
        return branch;
      }
    } catch {
      // no origin/HEAD (shallow clone) — fall through
    }
    return fallback?.trim() || 'master';
  }

  /**
   * Builds the diff against `ref`, including files git does not track yet. The
   * intent-to-add entries needed for that are written into a **throw-away copy**
   * of the index (`GIT_INDEX_FILE`), so the user's own staging area is untouched.
   */
  private async diffAgainst(ws: Workspace, ref: string, mode: CodeDiffMode): Promise<CodeDiff> {
    const indexPath = join(ws.dir, '.git', 'index');
    const scratchIndex = join(
      tmpdir(),
      `${CONTAINER_PREFIX}index-${safeName(ws.meta.sessionId)}-${Date.now()}`,
    );
    let env: NodeJS.ProcessEnv | undefined;
    try {
      if (existsSync(indexPath)) {
        await copyFile(indexPath, scratchIndex);
        env = { GIT_INDEX_FILE: scratchIndex };
        await this.git(ws.dir, ['add', '-A', '-N'], undefined, env);
      }

      const untracked = new Set(
        (await this.git(ws.dir, ['ls-files', '--others', '--exclude-standard', '-z']))
          .split('\0')
          .filter((path) => path.length > 0),
      );

      const numstat = parseNumstatZ(
        await this.git(
          ws.dir,
          ['-c', 'core.quotepath=false', 'diff', '--numstat', '-z', ref],
          undefined,
          env,
        ),
      );

      const files: CodeDiffFile[] = [];
      for (const entry of numstat.slice(0, MAX_DIFF_FILES)) {
        files.push({
          path: entry.path,
          patch: await this.filePatch(ws, ref, entry, env),
          added: entry.added,
          removed: entry.removed,
          ...(untracked.has(entry.path) ? { untracked: true } : {}),
        });
      }
      return { files, mode };
    } finally {
      await rm(scratchIndex, { force: true }).catch(() => undefined);
    }
  }

  /** One file's unified patch, capped so a huge file cannot flood the stream. */
  private async filePatch(
    ws: Workspace,
    ref: string,
    entry: NumstatEntry,
    env: NodeJS.ProcessEnv | undefined,
  ): Promise<string> {
    if (entry.added === null && entry.removed === null) {
      return `Binary file ${entry.path} changed.`;
    }
    try {
      const raw = await this.git(
        ws.dir,
        [
          '-c',
          'core.quotepath=false',
          '--no-pager',
          'diff',
          ref,
          '--',
          ...(entry.from ? [entry.from, entry.path] : [entry.path]),
        ],
        undefined,
        env,
      );
      return raw.length > MAX_PATCH_CHARS
        ? `${raw.slice(0, MAX_PATCH_CHARS)}\n… patch truncated`
        : raw;
    } catch {
      return '';
    }
  }

  /**
   * Pins the checkout's line-ending policy in its **local** config.
   *
   * The `-c` args on `clone` only cover the clone; every later host-side git
   * command (`checkout -B`, `revert`, `commit`) reads the machine's global
   * config again, and on Windows that means `core.autocrlf=true` re-writing the
   * working tree with CRLF the next time a branch is switched. Writing the
   * values into `.git/config` is what makes them stick.
   *
   * When this changes the policy of a checkout that already existed, the tree on
   * disk still holds whatever the old one produced, so it is re-materialised —
   * but **only** if the tree is clean. A checkout with uncommitted work is left
   * exactly as it is: losing the user's changes to fix their line endings is not
   * a trade we get to make for them.
   *
   * `repair` is false right after a clone, which was already performed under
   * these settings: re-materialising it would be a full second checkout for no
   * change, and `git rm --cached` is not a step worth taking for nothing.
   */
  private async applyCheckoutConfig(dir: string, { repair }: { repair: boolean }): Promise<void> {
    let changed = false;
    for (const [key, value] of Object.entries(checkoutGitConfig())) {
      let current = '';
      try {
        current = (await this.git(dir, ['config', '--local', '--get', key])).trim();
      } catch {
        // Not set locally — `git config --get` exits non-zero, which is a value
        // of its own and not a failure.
      }
      if (current === value) {
        continue;
      }
      await this.git(dir, ['config', '--local', key, value]);
      changed = true;
    }

    if (!changed || !repair) {
      return;
    }
    await this.renormalize(dir);
  }

  /**
   * Re-materialises the working tree under the current line-ending policy, so a
   * checkout cloned by an older connector (or on a machine with
   * `core.autocrlf=true`) stops handing CRLF scripts to the Linux container.
   * A no-op unless the tree is clean — see {@link applyCheckoutConfig}.
   */
  private async renormalize(dir: string): Promise<void> {
    try {
      const dirty = (await this.git(dir, ['status', '--porcelain=v1', '-z'])).trim();
      if (dirty) {
        console.warn(
          `[code] ${dir}: line-ending policy changed, but the tree has uncommitted changes — skipping renormalisation`,
        );
        return;
      }
      // Dropping the index forces every path to be re-checked-out through the
      // new filters; `reset --hard` then rebuilds both the index and the tree.
      await this.git(dir, ['rm', '--cached', '-r', '-q', '--', '.']);
      await this.git(dir, ['reset', '--hard']);
    } catch (error) {
      // Cosmetic next to losing the session: the checkout still works, its
      // scripts may just carry the old line endings.
      console.warn(`[code] could not renormalise ${dir}: ${String(error)}`);
    }
  }

  /**
   * `-c user.*` args when the machine has no git identity configured — otherwise
   * the first `/commit` in a fresh environment fails with «Please tell me who
   * you are».
   */
  private async identityArgs(ws: Workspace): Promise<string[]> {
    try {
      const email = (await this.git(ws.dir, ['config', '--get', 'user.email'])).trim();
      if (email) {
        return [];
      }
    } catch {
      // not configured — fall through
    }
    return Object.entries(commitIdentity(ws.meta.authorName)).flatMap(([key, value]) => [
      '-c',
      `${key}=${value}`,
    ]);
  }

  private async git(
    cwd: string,
    args: string[],
    failMessage?: string,
    extraEnv?: NodeJS.ProcessEnv,
    options: { timeoutMs?: number } = {},
  ): Promise<string> {
    try {
      const { stdout } = await this.runner.run('git', ['-C', cwd, ...args], {
        timeoutMs: options.timeoutMs ?? PROCESS_TIMEOUTS.git,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
      });
      return stdout;
    } catch (error) {
      const message = failMessage ?? 'git error';
      // A hang and a rejection need different words: «git error: » with an empty
      // stderr is what a timeout used to look like.
      if (error instanceof ProcessTimeoutError) {
        throw new ConnectorError(504, `${message}: ${error.message}`);
      }
      // Never surface credentials (a token-bearing URL or an auth header).
      const raw = error instanceof Error ? error.message : String(error);
      const detail = redactUrls(raw).replace(/Basic [A-Za-z0-9+/=]+/g, 'Basic ***');
      throw new ConnectorError(500, `${message}: ${detail}`.trim());
    }
  }

  /** One `docker` invocation, with a mandatory budget. */
  private async docker(args: string[], timeoutMs: number): Promise<string> {
    const { stdout } = await this.runner.run('docker', args, { timeoutMs });
    return stdout;
  }

  // ─── docker ─────────────────────────────────────────────────────────────────

  private async assertDocker(): Promise<void> {
    try {
      await this.docker(['version', '--format', '{{.Server.Version}}'], PROCESS_TIMEOUTS.probe);
    } catch {
      throw new ConnectorError(
        400,
        'Docker is unavailable. Install and start Docker Desktop, then try again.',
      );
    }
  }

  /**
   * Ensures a container bound to `dir` runs the requested image. Returns the
   * image actually used: when a detected tag cannot be pulled (a guessed JDK or
   * Node version that has no such tag) it falls back to {@link FALLBACK_IMAGE}
   * rather than failing the whole session.
   */
  private async ensureContainer(
    containerName: string,
    dir: string,
    image: string,
    limits: CodeSandboxLimits,
    options: { recreate: boolean; authorName?: string },
  ): Promise<string> {
    const state = await this.containerState(containerName);
    if (state && (options.recreate || state.image !== image)) {
      // The language servers run inside the container being replaced; leaving
      // them behind would keep a `docker exec` attached to a dead container.
      this.stopLspFor(containerName);
      await this.dockerAllowFail(['rm', '-f', containerName]);
    } else if (state) {
      if (!state.running) {
        await this.dockerAllowFail(['start', containerName]);
      }
      await this.configureContainerGit(containerName, options.authorName);
      return state.image;
    }

    const applied = (await this.pullImage(image)) ? image : FALLBACK_IMAGE;
    if (applied !== image && !(await this.pullImage(applied))) {
      throw new ConnectorError(500, `Could not pull the Docker image «${image}».`);
    }

    const args = [
      'run',
      '-d',
      '--name',
      containerName,
      '--label',
      `${SESSION_LABEL}=${containerName}`,
    ];
    args.push('-v', `${toDockerMountPath(dir)}:/workspace`, '-w', '/workspace');
    // Shared dependency caches, so a Gradle or npm install downloads the world
    // once per machine rather than once per session.
    await mkdir(this.cacheRoot, { recursive: true }).catch(() => undefined);
    args.push('-v', `${toDockerMountPath(this.cacheRoot)}:/cache`);
    for (const [key, value] of Object.entries(CACHE_ENV)) {
      args.push('-e', `${key}=${value}`);
    }
    if (limits.memory) {
      args.push('--memory', limits.memory);
    }
    if (limits.cpus) {
      args.push('--cpus', limits.cpus);
    }
    if (limits.pidsLimit) {
      args.push('--pids-limit', String(limits.pidsLimit));
    }
    if (limits.network === 'none') {
      args.push('--network', 'none');
    } else {
      // Without them a short internal host (`http://binary/artifactory/`) does
      // not resolve in the container even though its FQDN does — see
      // `docker-dns.ts` for why that matters more than a failed download.
      args.push(...dnsSearchArgs(await this.dnsSearch()));
    }
    // On Linux the bind mount keeps host ownership, so a root container would
    // write root-owned files the connector's own git then cannot touch.
    if (platform() === 'linux' && typeof process.getuid === 'function') {
      args.push('--user', `${process.getuid()}:${process.getgid?.() ?? process.getuid()}`);
    }
    args.push(applied, 'sleep', 'infinity');

    try {
      await this.docker(args, PROCESS_TIMEOUTS.dockerLifecycle);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ConnectorError(500, `Could not start the container: ${detail.trim()}`);
    }
    await this.configureContainerGit(containerName, options.authorName);
    return applied;
  }

  /** Restarts (or recreates) a rehydrated session's container before using it. */
  private async ensureRunning(ws: Workspace): Promise<void> {
    const state = await this.containerState(ws.containerName);
    if (state?.running) {
      return;
    }
    const applied = await this.ensureContainer(
      ws.containerName,
      ws.dir,
      ws.meta.image,
      ws.meta.limits,
      { recreate: false, authorName: ws.meta.authorName },
    );
    if (applied !== ws.meta.image) {
      ws.meta.image = applied;
      ws.meta.imageSource = 'fallback';
      await this.writeMeta(ws);
    }
  }

  /**
   * The two things container git needs before the agent's first `git` command.
   *
   * `safe.directory` because the bind-mounted checkout is owned by the host
   * user, and an identity because a fresh image has none — without it the first
   * `git commit` inside the sandbox fails with «Please tell me who you are», and
   * what the agent does next is invent an author out of the repository's log.
   * The same identity the host-side `/commit` falls back to ({@link
   * identityArgs}), so a session's commits read the same whoever made them.
   *
   * Global rather than in the checkout's own config: `.git/config` is the user's
   * file, and a session should not leave an identity behind in it.
   */
  private async configureContainerGit(containerName: string, authorName?: string): Promise<void> {
    await this.dockerAllowFail([
      'exec',
      containerName,
      'git',
      'config',
      '--global',
      '--add',
      'safe.directory',
      '/workspace',
    ]);
    const identity = commitIdentity(authorName);
    for (const [key, value] of Object.entries(identity)) {
      await this.dockerAllowFail(['exec', containerName, 'git', 'config', '--global', key, value]);
    }
  }

  private async containerState(
    containerName: string,
  ): Promise<{ image: string; running: boolean } | null> {
    try {
      const stdout = await this.docker(
        ['inspect', '--format', '{{.Config.Image}}\t{{.State.Running}}', containerName],
        PROCESS_TIMEOUTS.probe,
      );
      const [image, running] = stdout.trim().split('\t');
      return { image, running: running === 'true' };
    } catch {
      return null;
    }
  }

  private async isRunning(containerName: string): Promise<boolean> {
    return (await this.containerState(containerName))?.running ?? false;
  }

  /** True when the image is available locally or could be pulled. */
  private async pullImage(image: string): Promise<boolean> {
    try {
      await this.docker(['image', 'inspect', image], PROCESS_TIMEOUTS.probe);
      return true;
    } catch {
      try {
        await this.docker(['pull', image], PROCESS_TIMEOUTS.dockerPull);
        return true;
      } catch {
        return false;
      }
    }
  }

  private async dockerAllowFail(
    args: string[],
    timeoutMs: number = PROCESS_TIMEOUTS.dockerLifecycle,
  ): Promise<void> {
    try {
      await this.docker(args, timeoutMs);
    } catch {
      // best-effort (start/stop/rm/config may legitimately no-op)
    }
  }

  // ─── metadata ───────────────────────────────────────────────────────────────

  private metaPath(sessionId: string): string {
    return join(this.root, safeName(sessionId), META_FILE);
  }

  /**
   * Persists a workspace's metadata **atomically** — written to a sibling temp
   * file and `rename`d over the target, which is atomic within a filesystem.
   * A plain write that was interrupted (a crash, a full disk) left behind
   * truncated JSON, and a `workspace.json` that will not parse used to mean the
   * session was reported as missing for good.
   */
  private async writeMeta(ws: Workspace): Promise<void> {
    ws.meta.version = META_VERSION;
    ws.meta.updatedAt = Date.now();
    const target = this.metaPath(ws.meta.sessionId);
    const temp = `${target}.tmp`;
    try {
      await mkdir(join(this.root, safeName(ws.meta.sessionId)), { recursive: true });
      await writeFile(temp, JSON.stringify(ws.meta, null, 2), 'utf8');
      await rename(temp, target);
    } catch {
      // Non-fatal: the session still works, it just won't survive a restart —
      // and `recoverMeta` can rebuild it from the checkout anyway.
      await rm(temp, { force: true }).catch(() => undefined);
    }
  }

  private async readMeta(sessionId: string): Promise<WorkspaceMeta | null> {
    return this.readMetaAt(this.metaPath(sessionId));
  }

  /**
   * Reads a `workspace.json`. A file without a `version` is a pre-versioning
   * (v0) snapshot: every field it holds still means the same thing, so it is
   * accepted as-is and re-stamped on the next write.
   */
  private async readMetaAt(path: string): Promise<WorkspaceMeta | null> {
    try {
      const meta = JSON.parse(await readFile(path, 'utf8')) as WorkspaceMeta;
      return meta.sessionId && meta.repo && meta.baseBranch ? meta : null;
    } catch {
      return null;
    }
  }

  /**
   * Disk usage of a workspace. `du` on POSIX because it is one process and
   * orders of magnitude faster than anything we can write; a walk on Windows,
   * where there is no `du` at all and the settings screen would otherwise always
   * read «—».
   */
  private async dirSize(dir: string): Promise<number | null> {
    if (platform() === 'win32') {
      return walkSize(dir);
    }
    try {
      const { stdout } = await this.runner.run('du', ['-sk', dir], {
        timeoutMs: PROCESS_TIMEOUTS.diskUsage,
        maxBuffer: 1024 * 1024,
      });
      const kb = Number(stdout.trim().split(/\s+/)[0]);
      return Number.isFinite(kb) ? kb * 1024 : null;
    } catch {
      return null;
    }
  }

  /**
   * Stops containers that have been idle for a while but **keeps** the workspace
   * registered and its metadata on disk, so the next request just restarts it.
   */
  private async sweepIdle(): Promise<void> {
    const cutoff = Date.now() - IDLE_TTL_MS;
    for (const [sessionId, ws] of this.workspaces) {
      if (!this.isBusy(sessionId) && ws.lastUsed < cutoff) {
        // Before the container, not after: the servers live inside it, and a
        // `docker exec` outliving its container is just a stuck pipe.
        this.stopLsp(sessionId);
        await this.dockerAllowFail(['stop', '-t', '1', ws.containerName]);
      }
    }
  }
}

/**
 * Total size of a directory tree, walked in-process.
 *
 * The `du` stand-in for Windows. Gives up past {@link DIR_SIZE_MAX_ENTRIES} and
 * returns `null` — a checkout with `node_modules` can hold hundreds of thousands
 * of files, and the settings screen wanting a number is not worth stalling on
 * all of them. Symlinks are counted by their own entry, never followed, so a
 * link back up the tree cannot turn this into an infinite walk.
 */
async function walkSize(dir: string): Promise<number | null> {
  let total = 0;
  let seen = 0;

  const visit = async (current: string): Promise<boolean> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return true; // Unreadable subtree — count it as nothing and carry on.
    }
    for (const entry of entries) {
      if (++seen > DIR_SIZE_MAX_ENTRIES) {
        return false;
      }
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!(await visit(full))) {
          return false;
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      try {
        total += (await stat(full)).size;
      } catch {
        // Vanished or locked between the readdir and the stat — skip it.
      }
    }
    return true;
  };

  return (await visit(dir)) ? total : null;
}

/** True when two metadata snapshots describe the same container shape. */
/**
 * A workspace's bootstrap state, defaulted for one that has never run it: the
 * install is `pending` when the detected stack has a command to run and
 * `skipped` when it has none, and there is no project memory yet. `ranAt` stays
 * absent, which is what tells the browser to start the step.
 */
function setupOf(meta: WorkspaceMeta): CodeSetupInfo {
  if (meta.setup) {
    return meta.setup;
  }
  const install = meta.detected.commands.install;
  return {
    install: install ? 'pending' : 'skipped',
    ...(install ? { installCommand: install } : {}),
    memory: 'none',
  };
}

function sameContainerShape(left: WorkspaceMeta, right: WorkspaceMeta): boolean {
  return (
    left.image === right.image &&
    JSON.stringify(left.limits) === JSON.stringify(right.limits) &&
    (left.shapeVersion ?? 0) === (right.shapeVersion ?? 0)
  );
}
