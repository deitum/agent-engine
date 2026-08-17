import { homedir, platform } from 'node:os';
import { posix as pathPosix, win32 as pathWin32 } from 'node:path';

import {
  CHECKOUT_GIT_CONFIG,
  ENGINE_HOME_DIR,
  SANDBOX_ENV_KEYS,
  WINDOWS_CHECKOUT_GIT_CONFIG,
} from './platform.constants';

/**
 * The handful of decisions that depend on the host operating system.
 *
 * Every function here takes the platform (and, where it matters, the
 * environment) as an argument instead of reading `process.platform` inline. That
 * is the whole point of the module: the Windows branches are the ones nobody on
 * this team can run, so they have to be reachable from a test on macOS.
 */

/** What `os.platform()` returns; narrowed to what this daemon distinguishes. */
export type PlatformName = NodeJS.Platform;

/**
 * Root for everything the daemon keeps on the user's machine — code checkouts,
 * deep-agent workspaces, the shared package caches, the SearXNG config, and the
 * client database when it is kept here.
 *
 * Overridable with `AGENT_ENGINE_HOME` because the default sits under the home
 * directory, and on a corporate Windows box that is routinely
 * `C:\Users\Ivanov` in Cyrillic — a non-ASCII path that Docker's file sharing has a history
 * of mishandling. Moving the root is then a one-variable fix rather than a
 * re-installed Windows profile.
 *
 * `home` and `platformName` default to this process's own and are passed
 * explicitly by exactly one caller: `integration-targets.ts`, which resolves
 * paths for a *described* host so that its Windows branches are reachable from
 * a test on macOS. Everything else runs on the host it is describing.
 */
export function engineHome(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platformName: PlatformName = platform(),
): string {
  const override = env.AGENT_ENGINE_HOME?.trim();
  const path = platformName === 'win32' ? pathWin32 : pathPosix;
  return override ? override : path.join(home, ENGINE_HOME_DIR);
}

/**
 * A host path as it should be written in a `docker run -v <src>:<dst>` argument.
 *
 * Docker Desktop accepts a native `C:\Users\…` source, but this is the one place
 * a Windows path is embedded in a colon-delimited argument, and getting it wrong
 * surfaces as an opaque daemon error about an invalid mount. Normalising the
 * separators keeps the two halves of that argument unambiguous.
 */
export function toDockerMountPath(path: string, platformName: PlatformName = platform()): string {
  return platformName === 'win32' ? path.replace(/\\/g, '/') : path;
}

/**
 * The environment a locally-spawned agent shell inherits: the allow-list for
 * this platform, filtered down to what is actually set.
 *
 * See {@link SANDBOX_ENV_KEYS} for why it is an allow-list and not the daemon's
 * whole environment.
 */
export function sandboxEnv(
  source: NodeJS.ProcessEnv = process.env,
  platformName: PlatformName = platform(),
): Record<string, string> {
  const keys = platformName === 'win32' ? SANDBOX_ENV_KEYS.win32 : SANDBOX_ENV_KEYS.posix;
  const env: Record<string, string> = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

/** The git settings a Code checkout is created and kept with, for a platform. */
export function checkoutGitConfig(platformName: PlatformName = platform()): Record<string, string> {
  return platformName === 'win32'
    ? { ...CHECKOUT_GIT_CONFIG, ...WINDOWS_CHECKOUT_GIT_CONFIG }
    : { ...CHECKOUT_GIT_CONFIG };
}

/** Those same settings as `-c key=value` arguments, in the style of `envArgs`. */
export function checkoutConfigArgs(platformName: PlatformName = platform()): string[] {
  return Object.entries(checkoutGitConfig(platformName)).flatMap(([key, value]) => [
    '-c',
    `${key}=${value}`,
  ]);
}

/**
 * The system-prompt addendum warning the agent that its shell is `cmd.exe`.
 *
 * deepagents' `LocalShellBackend` hard-codes `spawn(command, { shell: true })`,
 * which on Windows is `cmd.exe` and cannot be swapped for a POSIX shell. A model
 * left to assume otherwise spends the turn on `ls -la` and `grep`, reads the
 * resulting errors as a broken workspace, and starts «fixing» it. Telling it up
 * front costs one line. Returns `''` everywhere else, so nothing about the
 * prompt changes on macOS or Linux.
 */
export function hostShellPromptSection(platformName: PlatformName = platform()): string {
  if (platformName !== 'win32') {
    return '';
  }
  return [
    '## Shell',
    'Your `execute` tool runs commands through **cmd.exe on Windows**, not a POSIX shell.',
    'POSIX utilities (`ls`, `grep`, `sed`, `cat`) and POSIX quoting are unavailable:',
    'use `dir`, `findstr`, `type`, and Windows path separators. Prefer the dedicated',
    'file tools (`read_file`, `write_file`, `glob`, `grep`) over shell equivalents.',
  ].join('\n');
}
