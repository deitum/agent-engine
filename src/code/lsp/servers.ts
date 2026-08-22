import { createHash } from 'node:crypto';
import { extname } from 'node:path';

import { type CodeLspConfig, type CodeLspLanguage } from '../../contracts';

import { type ReadySignal } from './client';
import { JDTLS_DATA_DIR, LSP_CACHE_DIR } from './lsp.constants';

/**
 * Which language server the connector runs for each language, how it is
 * installed into the shared `/cache/lsp`, and how it is launched.
 *
 * Everything here is a **shell command string** run inside the session's
 * container, because that is where the toolchain and the project's resolved
 * dependencies live. Nothing in this file talks to Docker or to the protocol —
 * it is a table, so the parts that are easy to get wrong (a registry override
 * that never reaches the command line, a launcher jar matched by the wrong glob)
 * are readable and testable on their own.
 */

/** Default sources, overridable per deployment through {@link CodeLspConfig}. */
const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org';
const DEFAULT_PYPI_INDEX = 'https://pypi.org/simple';
const DEFAULT_JDTLS_URL =
  'https://download.eclipse.org/jdtls/milestones/1.40.0/jdt-language-server-1.40.0-202409261450.tar.gz';

/**
 * The compiler installed next to `typescript-language-server`, pinned to the
 * major it can drive.
 *
 * `typescript@7` — what `latest` resolves to now — is the native port: it ships a
 * platform binary and no `lib/tsserver.js`, and the language server refuses to
 * initialize against it («Could not find a valid TypeScript installation»).
 * Unpinned, the recipe therefore installs cleanly and then fails at every start,
 * which is the worst of the two failures to have. The pin lifts when the server
 * learns to speak to the new compiler.
 */
const TSSERVER_COMPILER = 'typescript@5';

/** The oldest JDK the current Eclipse JDT language server will run on. */
export const MIN_JDTLS_JDK = 17;

/** Context a launch command is built against. */
export interface LaunchContext {
  /** The session id, used for jdtls' per-project data directory. */
  sessionId: string;
  /**
   * Absolute container path of the checkout's own TypeScript, when it has one.
   * Diagnostics must match the compiler the project builds with, or the agent
   * spends its turn fixing errors that its own build would never report.
   */
  projectTypescriptPath?: string;
}

/** One concrete way to provide a language's server. */
export interface LspServerVariant {
  /** Stable id; part of the marker that records a successful install. */
  id: string;
  /** Installs the server into {@link LSP_CACHE_DIR}. */
  install: (config: CodeLspConfig) => string;
  /** Runs the server on stdio. */
  launch: (context: LaunchContext) => string;
  initializationOptions?: (context: LaunchContext) => unknown;
  /** Recognises the notification meaning «indexing finished». */
  readySignal?: ReadySignal;
}

/** What must exist in the container before a server can be installed at all. */
export interface RuntimeProbe {
  /** Shell command whose output {@link check} reads. */
  command: string;
  /**
   * Returns a human reason the runtime is unusable, or `null` when it is fine.
   * Takes the exit code too, because «not installed» and «too old» are different
   * things to tell the user.
   */
  check: (output: string, exitCode: number | null) => string | null;
}

/** Everything the connector knows about one language. */
export interface LspServerSpec {
  language: CodeLspLanguage;
  /** File extensions this server owns, lower case, with the dot. */
  extensions: readonly string[];
  /** LSP `languageId` for a given path. */
  languageId: (path: string) => string;
  probe: RuntimeProbe;
  /** Tried in order; the first that installs wins. */
  variants: readonly LspServerVariant[];
  /** Budget for the `initialize` round-trip. */
  initializeTimeoutMs: number;
  /** Budget for an ordinary request. */
  requestTimeoutMs: number;
  /** How long an edit waits for diagnostics before giving up silently. */
  diagnosticsTimeoutMs: number;
  /** How long the initial index is waited for before reporting «indexing». */
  indexTimeoutMs: number;
}

/** Quotes a value for safe interpolation into a `sh -lc` command line. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The major version of a `java -version` banner, or `null` if unreadable. */
export function parseJavaMajor(banner: string): number | null {
  const match = /version "(\d+)(?:\.(\d+))?/.exec(banner);
  if (!match) {
    return null;
  }
  const first = Number(match[1]);
  // `1.8.0_202` is Java 8; everything from 9 on names its major directly.
  const major = first === 1 ? Number(match[2] ?? NaN) : first;
  return Number.isFinite(major) ? major : null;
}

/**
 * The TypeScript server. Installed globally into the cache prefix rather than
 * into the checkout, so it is shared by every session on the machine and never
 * appears in the user's diff.
 */
const TYPESCRIPT: LspServerSpec = {
  language: 'typescript',
  extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
  languageId: (path) => {
    switch (extname(path).toLowerCase()) {
      case '.tsx':
        return 'typescriptreact';
      case '.jsx':
        return 'javascriptreact';
      case '.js':
      case '.mjs':
      case '.cjs':
        return 'javascript';
      default:
        return 'typescript';
    }
  },
  probe: {
    command: 'command -v node && node --version',
    check: (_output, exitCode) =>
      exitCode === 0
        ? null
        : 'the container image has no Node.js — the TypeScript server cannot start',
  },
  variants: [
    {
      id: 'typescript-language-server',
      install: (config) =>
        [
          `npm install -g --prefix ${LSP_CACHE_DIR}/node`,
          `--registry ${shellQuote(config.npmRegistry ?? DEFAULT_NPM_REGISTRY)}`,
          '--no-fund --no-audit --loglevel error',
          `typescript-language-server ${TSSERVER_COMPILER}`,
        ].join(' '),
      launch: () => `${LSP_CACHE_DIR}/node/bin/typescript-language-server --stdio`,
      // Prefer the checkout's own compiler when it has one. Passed through
      // `initializationOptions` rather than `--tsserver-path`, which the server
      // has deprecated.
      initializationOptions: (context) =>
        context.projectTypescriptPath
          ? { tsserver: { path: context.projectTypescriptPath, logVerbosity: 'off' } }
          : { tsserver: { logVerbosity: 'off' } },
    },
  ],
  initializeTimeoutMs: 60_000,
  requestTimeoutMs: 20_000,
  diagnosticsTimeoutMs: 2_000,
  indexTimeoutMs: 30_000,
};

/**
 * The Python server. `basedpyright` is preferred because it is a real type
 * checker and ships its own Node runtime as a wheel, so it needs nothing in the
 * image but `pip`. `jedi-language-server` is the fallback for an index that does
 * not carry it: weaker diagnostics, but navigation still works, which is more
 * than half of what the agent asks for.
 */
const PYTHON: LspServerSpec = {
  language: 'python',
  extensions: ['.py', '.pyi'],
  languageId: () => 'python',
  probe: {
    // pip is probed too, not just the interpreter: a `gradle:` or `node:` image
    // carries python3 without it, and both variants install through `python3 -m
    // pip`. Without this the honest «the image has no pip» would reach the user
    // as «could not install the server».
    command: 'command -v python3 && python3 -m pip --version',
    check: (output, exitCode) => {
      if (exitCode === 0) {
        return null;
      }
      return /no module named pip/i.test(output)
        ? 'the container image has python3 but no pip — the Python server cannot be installed'
        : 'the container image has no python3 — the Python server cannot start';
    },
  },
  variants: [
    {
      id: 'basedpyright',
      install: (config) =>
        [
          `python3 -m pip install --disable-pip-version-check --no-warn-script-location`,
          `--target ${LSP_CACHE_DIR}/py`,
          `--index-url ${shellQuote(config.pypiIndexUrl ?? DEFAULT_PYPI_INDEX)}`,
          'basedpyright',
        ].join(' '),
      launch: () =>
        `PYTHONPATH=${LSP_CACHE_DIR}/py ${LSP_CACHE_DIR}/py/bin/basedpyright-langserver --stdio`,
      initializationOptions: () => ({
        // The agent reads diagnostics, not a style guide: reporting every
        // missing annotation in an untyped codebase would bury the real errors.
        python: { analysis: { typeCheckingMode: 'standard', diagnosticMode: 'openFilesOnly' } },
      }),
    },
    {
      id: 'jedi-language-server',
      install: (config) =>
        [
          `python3 -m pip install --disable-pip-version-check --no-warn-script-location`,
          `--target ${LSP_CACHE_DIR}/py-jedi`,
          `--index-url ${shellQuote(config.pypiIndexUrl ?? DEFAULT_PYPI_INDEX)}`,
          'jedi-language-server',
        ].join(' '),
      launch: () =>
        `PYTHONPATH=${LSP_CACHE_DIR}/py-jedi ${LSP_CACHE_DIR}/py-jedi/bin/jedi-language-server`,
    },
  ],
  initializeTimeoutMs: 60_000,
  requestTimeoutMs: 20_000,
  diagnosticsTimeoutMs: 3_000,
  indexTimeoutMs: 60_000,
};

/**
 * The Java server. The heavyweight of the three: a ~100 MB download, a JDK 17+
 * requirement, and minutes of project import before its answers are complete —
 * which is why it is warmed during the bootstrap rather than on first edit.
 *
 * Launched through the Equinox jar directly rather than the `bin/jdtls` wrapper
 * the tarball ships, because that wrapper is a Python script and a `gradle:` or
 * `maven:` image has no Python.
 */
const JAVA: LspServerSpec = {
  language: 'java',
  extensions: ['.java'],
  languageId: () => 'java',
  probe: {
    command: 'java -version 2>&1 | head -1',
    check: (output, exitCode) => {
      if (exitCode !== 0) {
        return 'the container image has no JDK — the Java server cannot start';
      }
      const major = parseJavaMajor(output);
      if (major === null) {
        return `could not read the JDK version: «${output.trim().slice(0, 80)}»`;
      }
      return major >= MIN_JDTLS_JDK
        ? null
        : `jdtls needs JDK ${MIN_JDTLS_JDK} or newer; the image has JDK ${major}`;
    },
  },
  variants: [
    {
      id: 'jdtls',
      install: (config) => {
        const url = shellQuote(config.jdtlsUrl ?? DEFAULT_JDTLS_URL);
        // Either downloader, because neither is guaranteed: `gradle:` images
        // carry curl, some slim JDK images only wget.
        return [
          `mkdir -p ${LSP_CACHE_DIR}/jdtls &&`,
          `{ command -v curl >/dev/null 2>&1 && curl -fsSL ${url} || wget -qO- ${url}; }`,
          `| tar -xz -C ${LSP_CACHE_DIR}/jdtls`,
        ].join(' ');
      },
      launch: (context) => {
        const data = `${JDTLS_DATA_DIR}/${sanitizeSegment(context.sessionId)}`;
        // The launcher jar carries a build number in its name, and the shipped
        // configuration directory differs per architecture.
        return [
          `LAUNCHER=$(ls ${LSP_CACHE_DIR}/jdtls/plugins/org.eclipse.equinox.launcher_*.jar 2>/dev/null | head -1)`,
          `CONFIG=${LSP_CACHE_DIR}/jdtls/config_linux`,
          `[ "$(uname -m)" = aarch64 ] && [ -d ${LSP_CACHE_DIR}/jdtls/config_linux_arm ] && CONFIG=${LSP_CACHE_DIR}/jdtls/config_linux_arm`,
          `mkdir -p ${data}`,
          [
            'exec java',
            '-Declipse.application=org.eclipse.jdt.ls.core.id1',
            '-Dosgi.bundles.defaultStartLevel=4',
            '-Declipse.product=org.eclipse.jdt.ls.core.product',
            '-Dlog.level=ERROR',
            // Bounded on purpose: the container's memory limit is shared with the
            // build the agent is about to run, and an unbounded heap here turns a
            // `./gradlew test` into an OOM kill.
            '-Xms256m -Xmx1500m',
            '--add-modules=ALL-SYSTEM',
            '--add-opens java.base/java.util=ALL-UNNAMED',
            '--add-opens java.base/java.lang=ALL-UNNAMED',
            '-jar "$LAUNCHER"',
            '-configuration "$CONFIG"',
            `-data ${data}`,
          ].join(' '),
        ].join('; ');
      },
      initializationOptions: () => ({
        settings: {
          java: {
            // Point the import at the cache the bootstrap install already
            // warmed, so jdtls resolves the classpath from disk instead of
            // downloading the world a second time.
            import: {
              gradle: { enabled: true, user: { home: '/cache/gradle' } },
              maven: { enabled: true },
            },
            configuration: { updateBuildConfiguration: 'automatic' },
            autobuild: { enabled: true },
            maxConcurrentBuilds: 1,
          },
        },
        extendedClientCapabilities: {
          progressReportProvider: false,
          classFileContentsSupport: false,
        },
      }),
      readySignal: (method, params) => {
        if (method !== 'language/status') {
          return false;
        }
        const type = (params as { type?: unknown })?.type;
        return type === 'ServiceReady' || type === 'Started';
      },
    },
  ],
  initializeTimeoutMs: 120_000,
  requestTimeoutMs: 30_000,
  diagnosticsTimeoutMs: 8_000,
  indexTimeoutMs: 5 * 60_000,
};

const SPECS: readonly LspServerSpec[] = [JAVA, TYPESCRIPT, PYTHON];

/** Replaces anything that would be awkward in a path with a dash. */
function sanitizeSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 64);
  return safe.length > 0 ? safe : 'default';
}

/** The spec for a language. */
export function specFor(language: CodeLspLanguage): LspServerSpec {
  const spec = SPECS.find((entry) => entry.language === language);
  if (!spec) {
    throw new Error(`Unknown LSP language: ${language}`);
  }
  return spec;
}

/** Which language, if any, owns a file — the lookup that starts servers lazily. */
export function languageForPath(path: string): CodeLspLanguage | null {
  const extension = extname(path).toLowerCase();
  if (!extension) {
    return null;
  }
  return SPECS.find((spec) => spec.extensions.includes(extension))?.language ?? null;
}

/**
 * The languages a config allows, in registry order. An empty `servers` list is
 * read as «none», not as «all»: an operator who wrote it down meant it.
 */
export function enabledLanguages(config: CodeLspConfig | undefined): CodeLspLanguage[] {
  if (config?.enabled === false) {
    return [];
  }
  const allowed = config?.servers;
  return SPECS.map((spec) => spec.language).filter(
    (language) => allowed === undefined || allowed.includes(language),
  );
}

/**
 * A short digest of the command that installs a variant, used in the marker file
 * that records success. Deriving it from the command means a changed recipe —
 * a new jdtls URL, a different registry — reinstalls by itself, with no version
 * constant anyone has to remember to bump.
 */
export function installMarkerName(
  language: CodeLspLanguage,
  variant: LspServerVariant,
  config: CodeLspConfig,
): string {
  const digest = createHash('sha256').update(variant.install(config)).digest('hex').slice(0, 12);
  return `${LSP_CACHE_DIR}/.installed-${language}-${variant.id}-${digest}`;
}
