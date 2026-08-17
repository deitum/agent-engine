import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type CodeLspLanguage, type CodeToolchain, type CodeToolchainInfo } from '../contracts';

/**
 * Toolchain detection for a Code workspace: what stack the checkout uses, which
 * Docker image fits it, and which commands build / test it. Replaces the old
 * image override the client may send — otherwise the image is derived from the
 * repository itself and only overridden from the browser (session settings or the
 * app-wide default).
 *
 * Every mapping deliberately targets an official image tag; when a derived tag
 * turns out not to exist the workspace falls back to {@link FALLBACK_IMAGE}
 * (see `CodeWorkspaces.ensureContainer`), so guessing a version is never fatal.
 */

/** Image used when nothing is detected, or when a derived tag cannot be pulled. */
export const FALLBACK_IMAGE = 'node:22-bookworm';

/** LTS Node majors we are willing to name in an image tag. */
const NODE_MAJORS = [18, 20, 22, 24];
/** JDK majors with official `gradle:` / `maven:` tags. */
const JAVA_MAJORS = [8, 11, 17, 21, 25];
/** Gradle line used with a detected JDK when the wrapper does not name one. */
const DEFAULT_GRADLE = '8.10';
/** Python minors with official `python:` tags we target. */
const PYTHON_MINORS = [9, 10, 11, 12, 13];

/** The build / test commands to run for a detected stack. */
export interface ToolchainCommands {
  /** Dependency install, when the stack needs an explicit one. */
  install?: string;
  test?: string;
  build?: string;
}

/**
 * Files whose contents decide whether an install is still up to date. Hashed
 * together into the fingerprint the bootstrap step compares against
 * (see {@link installFingerprint}); a checkout is re-installed only when one of
 * them changed, so re-opening a session costs nothing.
 */
const LOCK_FILES = [
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'requirements.txt',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'go.sum',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'gradle/wrapper/gradle-wrapper.properties',
] as const;

/**
 * A digest of the checkout's dependency manifests, or `''` when it has none.
 *
 * Deliberately content-based rather than mtime-based: a re-clone rewrites every
 * timestamp, and the whole point is that a session re-opened tomorrow does not
 * spend ten minutes re-downloading the same dependencies.
 */
export function installFingerprint(dir: string): string {
  const hash = createHash('sha256');
  let found = false;
  for (const file of LOCK_FILES) {
    const content = read(dir, ...file.split('/'));
    if (content !== null) {
      found = true;
      hash.update(file);
      hash.update(content);
    }
  }
  return found ? hash.digest('hex') : '';
}

/** Detection result plus the commands `/test` and `/build` should run. */
export interface ToolchainDetection extends CodeToolchainInfo {
  commands: ToolchainCommands;
}

/** Reads a file from the checkout, or `null` when it is absent / unreadable. */
function read(dir: string, ...segments: string[]): string | null {
  try {
    return readFileSync(join(dir, ...segments), 'utf8');
  } catch {
    return null;
  }
}

function has(dir: string, ...segments: string[]): boolean {
  return existsSync(join(dir, ...segments));
}

/** Picks the closest supported major that is >= `wanted` (else the highest). */
export function nearestMajor(wanted: number, supported: number[]): number {
  const atLeast = supported.filter((major) => major >= wanted);
  return atLeast.length > 0 ? Math.min(...atLeast) : Math.max(...supported);
}

/**
 * Extracts a major version from a version-ish string: `20`, `v20.11.1`, `>=20`,
 * `^20.1`, `20.x`, `lts/iron` → `null`. Returns `null` when there is no number.
 */
export function parseMajor(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const match = /(\d+)/.exec(value);
  if (!match) {
    return null;
  }
  const major = Number(match[1]);
  return Number.isFinite(major) && major > 0 ? major : null;
}

/**
 * The Node major a repository asks for: `.nvmrc` / `.node-version` win over
 * `engines.node` in `package.json`. Returns the raw source too, for the reason
 * shown in the UI.
 */
export function detectNodeVersion(dir: string): { major: number | null; source: string } {
  const nvmrc = read(dir, '.nvmrc') ?? read(dir, '.node-version');
  const fromFile = parseMajor(nvmrc);
  if (fromFile !== null) {
    return { major: fromFile, source: has(dir, '.nvmrc') ? '.nvmrc' : '.node-version' };
  }

  const engines = parseMajor(readPackageJson(dir)?.engines?.node);
  if (engines !== null) {
    return { major: engines, source: 'engines.node' };
  }
  return { major: null, source: 'package.json' };
}

/** The `package.json` of a checkout, in the shape we read from it. */
interface PackageJson {
  engines?: { node?: string };
  packageManager?: string;
  scripts?: Record<string, string>;
}

function readPackageJson(dir: string): PackageJson | null {
  const raw = read(dir, 'package.json');
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as PackageJson;
  } catch {
    return null;
  }
}

/** The package manager a Node repository uses, from its lock file / `packageManager`. */
export function detectPackageManager(dir: string): 'npm' | 'pnpm' | 'yarn' | 'bun' {
  if (has(dir, 'pnpm-lock.yaml')) {
    return 'pnpm';
  }
  if (has(dir, 'yarn.lock')) {
    return 'yarn';
  }
  if (has(dir, 'bun.lockb') || has(dir, 'bun.lock')) {
    return 'bun';
  }
  if (has(dir, 'package-lock.json')) {
    return 'npm';
  }
  const declared = readPackageJson(dir)?.packageManager ?? '';
  if (declared.startsWith('pnpm')) {
    return 'pnpm';
  }
  if (declared.startsWith('yarn')) {
    return 'yarn';
  }
  if (declared.startsWith('bun')) {
    return 'bun';
  }
  return 'npm';
}

/**
 * The JDK major a Gradle build targets, read from the usual declarations:
 * `jvmToolchain(21)`, `JavaLanguageVersion.of(21)`, `sourceCompatibility` (as a
 * bare number, a quoted `'17'`, or `JavaVersion.VERSION_17`), or `.java-version`.
 */
export function parseGradleJava(text: string): number | null {
  const patterns = [
    /jvmToolchain\s*\(\s*(?:JavaLanguageVersion\.of\s*\(\s*)?(\d+)/,
    /JavaLanguageVersion\.of\s*\(\s*(\d+)/,
    /(?:source|target)Compatibility\s*(?:=|\s)\s*JavaVersion\.VERSION_(\d+)/,
    /(?:source|target)Compatibility\s*(?:=|\s)\s*['"]?(\d+(?:\.\d+)?)['"]?/,
    /release\s*(?:=|\.set\()\s*['"]?(\d+)/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      // `1.8` style compatibility means Java 8.
      const raw = match[1].startsWith('1.') ? match[1].slice(2) : match[1];
      const major = parseMajor(raw);
      if (major !== null) {
        return major;
      }
    }
  }
  return null;
}

/** The Gradle version a wrapper pins, from `distributionUrl` in its properties. */
export function parseGradleWrapperVersion(properties: string): string | null {
  const match = /gradle-(\d+(?:\.\d+)*)-(?:bin|all)\.zip/.exec(properties);
  return match ? match[1] : null;
}

/** The JDK major a Maven build targets, from the usual `pom.xml` properties. */
export function parseMavenJava(pom: string): number | null {
  const patterns = [
    /<maven\.compiler\.release>\s*(\d+)/,
    /<java\.version>\s*(\d+(?:\.\d+)?)/,
    /<maven\.compiler\.source>\s*(\d+(?:\.\d+)?)/,
    /<release>\s*(\d+)/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(pom);
    if (match) {
      const raw = match[1].startsWith('1.') ? match[1].slice(2) : match[1];
      const major = parseMajor(raw);
      if (major !== null) {
        return major;
      }
    }
  }
  return null;
}

/** The Python minor a repository asks for (`3.12` → `12`). */
export function parsePythonMinor(value: string): number | null {
  const match = /3\.(\d+)/.exec(value);
  return match ? Number(match[1]) : null;
}

/** The Go version a `go.mod` declares (`go 1.23.4` → `1.23`). */
export function parseGoVersion(goMod: string): string | null {
  const match = /^go\s+(\d+\.\d+)/m.exec(goMod);
  return match ? match[1] : null;
}

/**
 * Detects the stack of a cloned repository and the image to run it in. JVM
 * markers win over `package.json` (a Spring service with a bundled frontend
 * still needs a JDK to build), and the reason is phrased for the UI chip.
 */
export function detectToolchain(dir: string): ToolchainDetection {
  const gradle = detectGradle(dir);
  if (gradle) {
    return gradle;
  }
  const maven = detectMaven(dir);
  if (maven) {
    return maven;
  }
  const node = detectNode(dir);
  if (node) {
    return node;
  }
  const python = detectPython(dir);
  if (python) {
    return python;
  }
  const go = detectGo(dir);
  if (go) {
    return go;
  }
  return {
    toolchain: 'unknown',
    image: FALLBACK_IMAGE,
    reason: 'the stack was not detected — a general-purpose image is used',
    commands: {},
  };
}

function detectGradle(dir: string): ToolchainDetection | null {
  const buildFiles = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'];
  const present = buildFiles.filter((file) => has(dir, file));
  if (present.length === 0) {
    return null;
  }

  const sources = present.map((file) => read(dir, file) ?? '').join('\n');
  const javaVersion = read(dir, '.java-version');
  const detectedJava = parseGradleJava(sources) ?? parseMajor(javaVersion);
  const java = nearestMajor(detectedJava ?? 21, JAVA_MAJORS);

  const wrapper = read(dir, 'gradle', 'wrapper', 'gradle-wrapper.properties');
  const hasWrapper = has(dir, 'gradlew');
  const gradleVersion = (wrapper ? parseGradleWrapperVersion(wrapper) : null) ?? DEFAULT_GRADLE;

  const reason = [
    `${present[0]} → Gradle`,
    detectedJava !== null ? `JDK ${java}` : `JDK ${java} (default)`,
    wrapper ? `wrapper ${gradleVersion}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  const runner = hasWrapper ? './gradlew' : 'gradle';
  return {
    toolchain: 'gradle',
    image: `gradle:${gradleVersion}-jdk${java}`,
    packageManager: 'gradle',
    reason,
    commands: {
      // `dependencies` is a built-in help task present in *every* project, so
      // this cannot fail with «task not found» the way `classes` does on an
      // aggregator root — and it still downloads the wrapper distribution, the
      // plugins and the root project's configurations, which is the slow part.
      install: `${runner} --no-daemon dependencies`,
      test: `${runner} test`,
      build: `${runner} build`,
    },
  };
}

function detectMaven(dir: string): ToolchainDetection | null {
  const pom = read(dir, 'pom.xml');
  if (pom === null) {
    return null;
  }
  const detectedJava = parseMavenJava(pom);
  const java = nearestMajor(detectedJava ?? 21, JAVA_MAJORS);
  const runner = has(dir, 'mvnw') ? './mvnw' : 'mvn';
  return {
    toolchain: 'maven',
    image: `maven:3.9-eclipse-temurin-${java}`,
    packageManager: 'maven',
    reason: `pom.xml → Maven, JDK ${java}${detectedJava === null ? ' (default)' : ''}`,
    commands: {
      install: `${runner} -B -q dependency:go-offline`,
      test: `${runner} -B test`,
      build: `${runner} -B -DskipTests package`,
    },
  };
}

/**
 * The install command for a Node checkout. The lockfile-strict form (`npm ci`,
 * `--frozen-lockfile`) is only used when the lock file it needs is actually
 * there: {@link detectPackageManager} falls back to npm for a repository that
 * has no lock file at all, and `npm ci` refuses to run in one.
 */
export function nodeInstall(dir: string, manager: ReturnType<typeof detectPackageManager>): string {
  switch (manager) {
    case 'npm':
      return has(dir, 'package-lock.json') ? 'npm ci' : 'npm install';
    case 'pnpm':
      return has(dir, 'pnpm-lock.yaml') ? 'pnpm install --frozen-lockfile' : 'pnpm install';
    case 'yarn':
      return has(dir, 'yarn.lock') ? 'yarn install --frozen-lockfile' : 'yarn install';
    case 'bun':
      return has(dir, 'bun.lockb') || has(dir, 'bun.lock')
        ? 'bun install --frozen-lockfile'
        : 'bun install';
  }
}

function detectNode(dir: string): ToolchainDetection | null {
  if (!has(dir, 'package.json')) {
    return null;
  }
  const { major, source } = detectNodeVersion(dir);
  const node = nearestMajor(major ?? 22, NODE_MAJORS);
  const manager = detectPackageManager(dir);
  const scripts = readPackageJson(dir)?.scripts ?? {};

  const install = nodeInstall(dir, manager);
  const run = manager === 'npm' ? 'npm run' : `${manager} run`;

  return {
    toolchain: 'node',
    image: `node:${node}-bookworm`,
    packageManager: manager,
    reason: `${source} → Node ${node}${major === null ? ' (default)' : ''}, ${manager}`,
    commands: {
      install,
      ...(scripts.test ? { test: manager === 'npm' ? 'npm test' : `${manager} test` } : {}),
      ...(scripts.build ? { build: `${run} build` } : {}),
    },
  };
}

function detectPython(dir: string): ToolchainDetection | null {
  const pyproject = read(dir, 'pyproject.toml');
  const hasRequirements = has(dir, 'requirements.txt');
  if (pyproject === null && !hasRequirements && !has(dir, 'setup.py')) {
    return null;
  }
  const pinned = read(dir, '.python-version') ?? '';
  const requires = pyproject ? (/requires-python\s*=\s*"([^"]+)"/.exec(pyproject)?.[1] ?? '') : '';
  const detected = parsePythonMinor(pinned) ?? parsePythonMinor(requires);
  const minor = nearestMajor(detected ?? 12, PYTHON_MINORS);
  // The lock file names the manager: `uv sync` / `poetry install` install the
  // whole project, a bare `requirements.txt` is plain pip.
  const install = has(dir, 'uv.lock')
    ? 'uv sync'
    : has(dir, 'poetry.lock')
      ? 'poetry install'
      : hasRequirements
        ? 'pip install -r requirements.txt'
        : undefined;
  return {
    toolchain: 'python',
    image: `python:3.${minor}-bookworm`,
    packageManager: pyproject ? 'pyproject' : 'pip',
    reason: `${pyproject ? 'pyproject.toml' : 'requirements.txt'} → Python 3.${minor}${
      detected === null ? ' (default)' : ''
    }`,
    commands: {
      ...(install ? { install } : {}),
      test: 'python -m pytest',
    },
  };
}

function detectGo(dir: string): ToolchainDetection | null {
  const goMod = read(dir, 'go.mod');
  if (goMod === null) {
    return null;
  }
  const version = parseGoVersion(goMod);
  return {
    toolchain: 'go',
    image: `golang:${version ?? '1.23'}-bookworm`,
    packageManager: 'go',
    reason: `go.mod → Go ${version ?? '1.23 (default)'}`,
    commands: { install: 'go mod download', test: 'go test ./...', build: 'go build ./...' },
  };
}

/**
 * Directories a stack's install writes **into the checkout**. They are added to
 * the workspace's local `.git/info/exclude` so a `npm ci` does not turn the diff
 * panel into thousands of untracked files in repositories whose `.gitignore`
 * does not cover them.
 *
 * Safe by construction: `.git/info/exclude` only ever affects **untracked**
 * paths, so no entry here can hide a change to a file the repository tracks.
 */
export const INSTALL_ARTIFACTS: Record<CodeToolchain, string[]> = {
  node: ['node_modules/'],
  gradle: ['.gradle/'],
  maven: ['target/'],
  python: ['.venv/', 'venv/', '__pycache__/', '*.egg-info/'],
  go: [],
  unknown: [],
};

/**
 * The language server that fits a detected stack, when one of ours does.
 *
 * Used to warm a server during the bootstrap and to answer a project-wide symbol
 * search before any file has been opened. Only a *primary* language: a Spring
 * service with a bundled frontend still gets the TypeScript server the moment the
 * agent touches a `.ts` file, because servers start by file extension — this is
 * about which one is worth paying for up front.
 */
export const TOOLCHAIN_LSP_LANGUAGE: Record<CodeToolchain, CodeLspLanguage | null> = {
  node: 'typescript',
  gradle: 'java',
  maven: 'java',
  python: 'python',
  go: null,
  unknown: null,
};

/** Toolchain-specific build/test guidance injected into the coding prompt. */
export const TOOLCHAIN_NOTES: Record<CodeToolchain, string> = {
  node: [
    'Stack: **Node.js / JavaScript / TypeScript**.',
    '- Work out the package manager from the lock file: `package-lock.json` → npm, `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn.',
    '- Tests and builds are easiest through `/test` and `/build` — they already know the right script.',
  ].join('\n'),
  gradle: [
    'Stack: **Java / Gradle** (often Spring Boot).',
    '- Always use the wrapper: `./gradlew` (not a global gradle).',
    '- Quick compile check: `./gradlew compileJava`; the full tests are the `/test` command.',
    '- Follow Spring conventions (controller/service/repository layers, configuration through application.yml).',
  ].join('\n'),
  maven: [
    'Stack: **Java / Maven**.',
    '- Use the `./mvnw` wrapper when there is one, otherwise `mvn -B`.',
    '- Quick check: `./mvnw -B -q compile`; the full tests are the `/test` command.',
  ].join('\n'),
  python: [
    'Stack: **Python**.',
    '- Dependencies: `pip install -r requirements.txt`, or the manager named in `pyproject.toml` (poetry/uv).',
    '- Tests: `python -m pytest`. Follow the project’s existing style and typing.',
  ].join('\n'),
  go: [
    'Stack: **Go**.',
    '- Build: `go build ./...`, tests: `go test ./...`, formatting: `gofmt -w`.',
  ].join('\n'),
  unknown: [
    'The stack could not be detected — study the repository files (`ls`, `read_file`) and choose the right build and test commands.',
  ].join('\n'),
};
