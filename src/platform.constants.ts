/**
 * Constants for the places where this daemon has to care which OS it runs on.
 *
 * The daemon is the one part of the product that executes on the user's own
 * machine, so «works on the developer's Mac» is not the bar — it has to work on
 * a corporate Windows box too. Every value here is paired with a pure function
 * in `platform.ts` that takes the platform as an argument, so the Windows
 * branches are testable from macOS instead of being discovered in production.
 */

/** Directory under the user's home where the daemon keeps everything it writes. */
export const ENGINE_HOME_DIR = '.agent-engine';

/**
 * Environment variables a locally-spawned shell inherits regardless of OS:
 * where to find programs, how to reach the network, and which CA to trust —
 * including the two that say «trust anything», which a shell whose daemon has
 * stopped verifying certificates would otherwise fail without (see `config/tls.ts`).
 */
const SHARED_ENV_KEYS = [
  'PATH',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'GIT_SSL_NO_VERIFY',
];

/**
 * The POSIX half of the sandbox environment.
 *
 * deepagents runs shell commands with an **empty** environment unless told
 * otherwise, which leaves the agent without the user's `PATH` (so nvm / homebrew
 * / pyenv toolchains are invisible and only the shell's fallback `/usr/bin:/bin`
 * resolves) and without `HOME` (so git finds no config or credentials). Copying
 * the whole environment would instead hand every secret the daemon was started
 * with to the model, so this allow-list is the middle ground: what tools need to
 * run, nothing that identifies or authenticates the user elsewhere.
 */
const POSIX_SANDBOX_ENV_KEYS = [
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
];

/**
 * The Windows half, and it is not optional.
 *
 * `LocalShellBackend` spawns with `shell: true`, which on Windows means
 * `cmd.exe /d /s /c`. An allow-list that only names `HOME` / `SHELL` / `TMPDIR`
 * — none of which exist there — starts that shell without `SystemRoot` or
 * `PATHEXT`, and a process without `SystemRoot` fails at winsock initialisation
 * before it runs a line of its own code. Modelled on the MCP SDK's
 * `DEFAULT_INHERITED_ENV_VARS`, which solves the same problem for stdio servers.
 */
const WINDOWS_SANDBOX_ENV_KEYS = [
  'PATHEXT',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'COMSPEC',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'PROGRAMDATA',
  'USERNAME',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
];

/** The sandbox environment allow-list for a platform. */
export const SANDBOX_ENV_KEYS = {
  win32: [...SHARED_ENV_KEYS, ...WINDOWS_SANDBOX_ENV_KEYS],
  posix: [...SHARED_ENV_KEYS, ...POSIX_SANDBOX_ENV_KEYS],
} as const;

/**
 * Options for every recursive delete in this daemon.
 *
 * `fs.rm` does **not** retry by default (`maxRetries` is 0), and on Windows a
 * file held open by an antivirus scanner, the search indexer or Docker itself
 * answers `EBUSY` / `EPERM` for a moment and then lets go. Without retries that
 * moment is the difference between a workspace that is removed and one that
 * reports a failure the user cannot act on. Harmless on POSIX, where the first
 * attempt succeeds and nothing is retried.
 */
export const RM_RETRY = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 100,
} as const;

/**
 * Git settings applied to every Code checkout, as `key=value` pairs.
 *
 * The Code tab splits the workspace: `git` runs on the **host**, builds run in a
 * Linux container over the same bind mount. Git for Windows installs with
 * `core.autocrlf=true` by default, so the host would check out CRLF and every
 * shebang script in the container — `./gradlew`, `./mvnw`, anything with
 * `#!/bin/sh` — would die with `bad interpreter: /bin/sh^M`. Forcing LF is what
 * makes the two halves agree.
 *
 * `core.symlinks` is deliberately absent: forcing it on breaks the whole
 * checkout on a Windows box without Developer Mode, so git's own probe decides.
 */
export const CHECKOUT_GIT_CONFIG: Record<string, string> = {
  'core.autocrlf': 'false',
  'core.eol': 'lf',
};

/**
 * Same, but only meaningful on Windows. `MAX_PATH` is 260 characters and
 * `C:\Users\<name>\.agent-engine\code\<sessionId>\repo\node_modules\…` clears it
 * without trying; git refuses the checkout rather than truncating.
 */
export const WINDOWS_CHECKOUT_GIT_CONFIG: Record<string, string> = {
  'core.longpaths': 'true',
};

/**
 * Directory names Windows reserves for devices. Creating `…\nul\SKILL.md`
 * neither fails cleanly nor produces a file, so a package id that slugifies to
 * one of these is refused outright (see `packageName`).
 */
export const WINDOWS_RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

/**
 * Entries `dirSize` walks before giving up on Windows. A checkout with
 * `node_modules` can hold hundreds of thousands of files, and the settings
 * screen asking for a number is not worth a multi-second stat storm.
 */
export const DIR_SIZE_MAX_ENTRIES = 200_000;

/** PowerShell arguments that print the host's DNS suffixes, one per line. */
export const WINDOWS_DNS_ARGS = [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  '(Get-DnsClientGlobalSetting).SuffixSearchList; (Get-DnsClient).ConnectionSpecificSuffix',
];
