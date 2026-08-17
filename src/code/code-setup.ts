import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  type CodeMemorySource,
  type CodeSetupEvent,
  type CodeSetupInfo,
  type CodeSetupPhase,
  type CodeSetupRequest,
} from '../contracts';
import { loadDeps } from '../deep-agent';
import { buildChatModel } from '../llm/chat-model';

import {
  ensureNotesFile,
  GENERATED_MEMORY_FILE,
  renderFreshNotes,
  REPO_MEMORY_FILES,
  withDescription,
  writeNotesFile,
} from './code-memory';
import { type CodeWorkspaces, type WorkspaceBackendInfo } from './code-workspace';
import { installFingerprint, TOOLCHAIN_LSP_LANGUAGE } from './toolchain';

/** Receives progress events as the workspace is bootstrapped. */
export type CodeSetupSink = (event: CodeSetupEvent) => void;

/**
 * A dependency install gets far longer than the ordinary command budget: a cold
 * Gradle or Maven build downloads hundreds of megabytes before it prints
 * anything useful, and dying at ten minutes would leave a half-populated cache.
 */
const INSTALL_TIMEOUT_SEC = 30 * 60;

/** Log frames are coalesced to at most one per this many ms. */
const LOG_FLUSH_MS = 250;
/** …or sooner, once this much output has piled up. */
const LOG_FLUSH_BYTES = 8_000;

/** Head of a file used in the digest handed to the model. */
const MAX_DIGEST_FILE_CHARS = 8_000;
/** How many directories the structure section lists. */
const MAX_TREE_ENTRIES = 40;

/** Reads a file from the checkout, or `null` when it is absent / unreadable. */
function read(dir: string, file: string): string | null {
  try {
    return readFileSync(join(dir, file), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Coalesces the raw chunks `docker exec` emits into readable log frames: one
 * every {@link LOG_FLUSH_MS}, or sooner when enough has piled up. Without it a
 * chatty install would emit a frame per write — hundreds of SSE messages a
 * second, each re-rendering the transcript.
 */
function makeLogger(onEvent: CodeSetupSink): { push: (chunk: string) => void; stop: () => void } {
  let buffer = '';
  let timer: NodeJS.Timeout | null = null;

  const flush = (): void => {
    timer = null;
    if (buffer.length > 0) {
      onEvent({ type: 'log', chunk: buffer });
      buffer = '';
    }
  };

  return {
    push: (chunk) => {
      buffer += chunk;
      if (buffer.length >= LOG_FLUSH_BYTES) {
        if (timer) {
          clearTimeout(timer);
        }
        flush();
        return;
      }
      if (!timer) {
        timer = setTimeout(flush, LOG_FLUSH_MS);
        timer.unref?.();
      }
    },
    stop: () => {
      if (timer) {
        clearTimeout(timer);
      }
      flush();
    },
  };
}

/**
 * Bootstraps a prepared workspace: installs the stack's dependencies inside the
 * container and makes sure the session has a project memory, streaming its
 * progress. Both phases are best-effort — a failed install or an unreachable
 * model leaves a usable session, with the failure visible in the transcript.
 *
 * The result is persisted in `workspace.json`, so re-opening the session skips
 * an install whose lock files have not moved.
 */
export async function runCodeSetup(
  workspaces: CodeWorkspaces,
  req: CodeSetupRequest,
  onEvent: CodeSetupSink,
  signal: AbortSignal,
): Promise<void> {
  const phases = new Set<CodeSetupPhase>(req.phases ?? ['install', 'memory', 'lsp']);
  await workspaces.setEnv(req.sessionId, req.env);
  // Also restarts a swept container, so the install has somewhere to run.
  const info = await workspaces.backendInfo(req.sessionId);
  const current = await workspaces.setup(req.sessionId);
  const next: CodeSetupInfo = { ...current };

  if (phases.has('install')) {
    Object.assign(next, await runInstall(workspaces, req, info, current, onEvent, signal));
  }

  if (phases.has('memory') && !signal.aborted) {
    next.memory = await runMemory(workspaces, req, info, current, onEvent);
  }

  if (phases.has('lsp') && !signal.aborted) {
    Object.assign(next, await runLsp(workspaces, req, info, onEvent));
  }

  next.ranAt = Date.now();
  await workspaces.setSetup(req.sessionId, next);
  onEvent({ type: 'done', setup: next, status: await workspaces.status(req.sessionId) });
}

/** The install phase; returns the fields it settles on {@link CodeSetupInfo}. */
async function runInstall(
  workspaces: CodeWorkspaces,
  req: CodeSetupRequest,
  info: WorkspaceBackendInfo,
  current: CodeSetupInfo,
  onEvent: CodeSetupSink,
  signal: AbortSignal,
): Promise<Partial<CodeSetupInfo>> {
  const command =
    req.installCommand?.trim() || current.installCommand || info.detected.commands.install;

  /**
   * A skipped phase reports what this run did; what it leaves in
   * {@link CodeSetupInfo} is a statement about the *checkout*. Only «this stack
   * has nothing to install» settles that — a session cut off from the network,
   * or one whose dependencies are already there, keeps whatever state it had.
   */
  const skip = (detail: string, settles = false): Partial<CodeSetupInfo> => {
    onEvent({ type: 'phase', phase: 'install', state: 'skipped', detail });
    return settles ? { install: 'skipped' } : {};
  };

  if (!command) {
    return skip('no install command is known for this stack', true);
  }

  const limits = await workspaces.limits(req.sessionId);
  if (limits.network === 'none') {
    return skip('the sandbox is running without network access');
  }

  const fingerprint = installFingerprint(info.dir);
  if (
    req.force !== true &&
    current.install === 'ok' &&
    fingerprint !== '' &&
    fingerprint === current.fingerprint
  ) {
    return skip('dependencies are already installed and the lock files have not changed');
  }

  onEvent({ type: 'phase', phase: 'install', state: 'running', detail: command });
  const logger = makeLogger(onEvent);
  let result;
  try {
    result = await workspaces.exec(req.sessionId, command, {
      signal,
      timeoutSec: INSTALL_TIMEOUT_SEC,
      onOutput: logger.push,
    });
  } finally {
    logger.stop();
  }

  if (result.exitCode === 0) {
    onEvent({ type: 'phase', phase: 'install', state: 'ok' });
    return {
      install: 'ok',
      installCommand: command,
      installExitCode: 0,
      ...(fingerprint ? { fingerprint } : {}),
    };
  }

  onEvent({
    type: 'phase',
    phase: 'install',
    state: 'failed',
    detail:
      result.exitCode === null
        ? 'the install was interrupted'
        : `«${command}» exited with code ${result.exitCode}`,
    exitCode: result.exitCode,
  });
  // Deliberately no fingerprint: a failed install must be retried next time.
  return { install: 'failed', installCommand: command, installExitCode: result.exitCode };
}

/**
 * The memory phase. A repository that documents itself for agents wins outright
 * — generating a *description* next to a hand-written `AGENTS.md` would only give
 * the agent two sources of truth about the same project.
 *
 * The agent's notes file is a different thing and is created either way: it is
 * where `remember` writes, and the prompt names it on every turn, so a
 * well-documented repository must not be the one case where that instruction
 * points at nothing.
 */
async function runMemory(
  workspaces: CodeWorkspaces,
  req: CodeSetupRequest,
  info: WorkspaceBackendInfo,
  current: CodeSetupInfo,
  onEvent: CodeSetupSink,
): Promise<CodeMemorySource> {
  const own = REPO_MEMORY_FILES.find((file) => existsSync(join(info.dir, file)));
  if (own) {
    await ensureNotesFile(info.dir);
    // Reported as done only the first time round: a session opened every day
    // does not need to be told again that the repository has an AGENTS.md.
    const first = current.memory !== 'repo';
    onEvent({
      type: 'phase',
      phase: 'memory',
      state: first ? 'ok' : 'skipped',
      detail: `project memory comes from the repository: ${own}`,
    });
    return 'repo';
  }

  const target = join(info.dir, GENERATED_MEMORY_FILE);
  if (req.force !== true && current.memory === 'generated' && existsSync(target)) {
    onEvent({
      type: 'phase',
      phase: 'memory',
      state: 'skipped',
      detail: `memory has already been created: ${GENERATED_MEMORY_FILE}`,
    });
    return 'generated';
  }

  onEvent({ type: 'phase', phase: 'memory', state: 'running', detail: GENERATED_MEMORY_FILE });

  let files: string[] = [];
  try {
    files = await workspaces.listFiles(req.sessionId);
  } catch {
    // A repository git cannot list still gets the facts we already hold.
  }

  const facts = buildProjectFacts(info, files);
  let summary = '';
  let failure: string | null = null;
  if (req.llm) {
    try {
      summary = await summarizeProject(req, info, files);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
  }

  const description = [facts, ...(summary ? ['### About the project', '', summary] : [])].join(
    '\n',
  );

  try {
    const existing = existsSync(target) ? await readFile(target, 'utf8') : null;
    await writeNotesFile(
      info.dir,
      existing === null ? renderFreshNotes(description) : withDescription(existing, description),
    );
  } catch (error) {
    onEvent({
      type: 'phase',
      phase: 'memory',
      state: 'failed',
      detail: error instanceof Error ? error.message : 'the memory file could not be written',
    });
    return 'none';
  }

  if (failure) {
    // The file exists with its deterministic half; only the prose is missing.
    onEvent({
      type: 'phase',
      phase: 'memory',
      state: 'failed',
      detail: `memory was created without a project description: ${failure}`,
    });
    return 'generated';
  }

  onEvent({
    type: 'phase',
    phase: 'memory',
    state: 'ok',
    detail: `project memory was created: ${GENERATED_MEMORY_FILE}`,
  });
  return 'generated';
}

/**
 * The language-server phase: start the server for the detected stack now, so its
 * project import happens while the user is reading the setup log instead of
 * during their first task. On a Spring repository that is the difference between
 * a first edit that reports errors and one that reports «the server is still indexing».
 *
 * Runs last because it depends on the other two: jdtls reads the classpath the
 * dependency install produced. Entirely best-effort — a session with no language
 * server works exactly as it did before the feature existed, so nothing here is
 * allowed to fail the bootstrap.
 */
async function runLsp(
  workspaces: CodeWorkspaces,
  req: CodeSetupRequest,
  info: WorkspaceBackendInfo,
  onEvent: CodeSetupSink,
): Promise<Partial<CodeSetupInfo>> {
  const language = TOOLCHAIN_LSP_LANGUAGE[info.toolchain];
  if (!language) {
    const detail = `there is no language server for the «${info.toolchain}» stack`;
    onEvent({ type: 'phase', phase: 'lsp', state: 'skipped', detail });
    return { lsp: 'skipped', lspDetail: detail };
  }

  let session;
  try {
    session = await workspaces.lsp(req.sessionId, req.lsp ?? {});
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    onEvent({ type: 'phase', phase: 'lsp', state: 'failed', detail });
    return { lsp: 'failed', lspDetail: detail };
  }

  if (session.off) {
    const detail = 'code analysis is turned off in the settings';
    onEvent({ type: 'phase', phase: 'lsp', state: 'skipped', detail });
    return { lsp: 'skipped', lspDetail: detail };
  }

  onEvent({
    type: 'phase',
    phase: 'lsp',
    state: 'running',
    detail: `language server: ${language}`,
  });
  const status = await session.warm(language).catch(() => null);

  if (!status || status.state === 'unavailable') {
    const detail = status?.detail ?? 'the server did not start';
    onEvent({ type: 'phase', phase: 'lsp', state: 'failed', detail });
    return { lsp: 'failed', lspDetail: detail };
  }

  // `indexing` is a success: the server is up and answering, it just has not
  // finished reading the project. Waiting for that here would hold the setup
  // stream open for the several minutes a cold Gradle import takes.
  const detail =
    status.state === 'indexing'
      ? `${language}: indexing the project in the background`
      : `${language}: ready`;
  onEvent({ type: 'phase', phase: 'lsp', state: 'ok', detail });
  return { lsp: 'ok', lspDetail: detail };
}

/**
 * The half of the memory that needs no model: where the repository is, what the
 * connector detected in it, how it is built and tested, and how it is laid out.
 * Cheap, always correct, and useful on its own when the model call fails.
 */
export function buildProjectFacts(info: WorkspaceBackendInfo, files: string[]): string {
  const { commands } = info.detected;
  const lines = [
    '### Stack and commands',
    '',
    `- Detected: ${info.detected.reason}`,
    `- Base branch: \`${info.baseBranch}\``,
    ...(commands.install ? [`- Dependency install: \`${commands.install}\``] : []),
    ...(commands.test ? [`- Tests: \`${commands.test}\` (the \`/test\` command)`] : []),
    ...(commands.build ? [`- Build: \`${commands.build}\` (the \`/build\` command)`] : []),
    '',
  ];

  const tree = topDirectories(files);
  if (tree.length > 0) {
    lines.push('### Layout', '', '```');
    for (const entry of tree) {
      lines.push(`${entry.path} — ${entry.count} file(s)`);
    }
    lines.push('```', '');
  }

  const key = KEY_FILES.filter((file) => existsSync(join(info.dir, file)));
  if (key.length > 0) {
    lines.push('### Key files', '', ...key.map((file) => `- \`${file}\``), '');
  }

  return lines.join('\n');
}

/** Files worth pointing the agent at when they exist. */
const KEY_FILES = [
  'README.md',
  'README.rst',
  'CONTRIBUTING.md',
  'docs/',
  'package.json',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'pyproject.toml',
  'requirements.txt',
  'go.mod',
  'Makefile',
  'docker-compose.yml',
];

/**
 * The repository's top two directory levels with file counts — the cheapest
 * useful map of a codebase. Deeper levels are noise at this size, and the whole
 * point is a section a human can read at a glance.
 */
export function topDirectories(files: string[]): { path: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const parts = file.split('/');
    if (parts.length === 1) {
      counts.set('./', (counts.get('./') ?? 0) + 1);
      continue;
    }
    const depth = Math.min(parts.length - 1, 2);
    const path = `${parts.slice(0, depth).join('/')}/`;
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([path, count]) => ({ path, count }))
    .sort((left, right) => right.count - left.count || left.path.localeCompare(right.path))
    .slice(0, MAX_TREE_ENTRIES);
}

/** The system prompt of the one-shot project summary. */
const SUMMARY_SYSTEM = [
  'You are studying an unfamiliar repository in order to leave a short briefing for another engineer.',
  'The input is a digest of the repository: its README, the root manifests, a directory listing.',
  'Answer with a Markdown fragment, no top-level heading, no longer than 2000 characters:',
  '- one or two sentences on what the project is;',
  '- a map of the modules: what each directory is responsible for;',
  '- the conventions visible in the code and the configuration;',
  '- where new code goes (a new endpoint, component, test);',
  '- non-obvious places and pitfalls, where they are visible.',
  'Write only what the input supports. Invent nothing, do not list the',
  'obvious, and do not repeat the build commands — they are recorded separately.',
].join('\n');

/** One non-agentic model call over a digest of the repository. */
async function summarizeProject(
  req: CodeSetupRequest,
  info: WorkspaceBackendInfo,
  files: string[],
): Promise<string> {
  const llm = req.llm;
  if (!llm) {
    return '';
  }
  const { ChatOpenAI } = await loadDeps();
  const model = buildChatModel(ChatOpenAI, llm);

  const response = await model.invoke([
    { role: 'system', content: SUMMARY_SYSTEM },
    { role: 'user', content: buildDigest(info, files) },
  ]);
  return textOf(response.content).trim();
}

/** What the summary model sees: the repository, compressed. */
export function buildDigest(info: WorkspaceBackendInfo, files: string[]): string {
  const readme = read(info.dir, 'README.md') ?? read(info.dir, 'README.rst') ?? '';
  const manifests = [
    'package.json',
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
    'pyproject.toml',
    'go.mod',
  ]
    .map((file) => ({ file, content: read(info.dir, file) }))
    .filter((entry): entry is { file: string; content: string } => entry.content !== null);

  const sections = [
    `Stack: ${info.detected.reason}`,
    '',
    '## Directories',
    ...topDirectories(files).map((entry) => `${entry.path} — ${entry.count}`),
  ];

  if (readme) {
    sections.push('', '## README', readme.slice(0, MAX_DIGEST_FILE_CHARS));
  }
  for (const { file, content } of manifests) {
    sections.push('', `## ${file}`, content.slice(0, MAX_DIGEST_FILE_CHARS));
  }
  return sections.join('\n');
}

/** Flattens a LangChain message `content` (string or block array) to text. */
function textOf(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
          ? (block as { text: string }).text
          : '',
      )
      .join('');
  }
  return '';
}
