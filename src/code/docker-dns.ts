import { readFile } from 'node:fs/promises';
import { platform } from 'node:os';

import { type PlatformName } from '../platform';
import { WINDOWS_DNS_ARGS } from '../platform.constants';

import { PROCESS_TIMEOUTS, type ProcessRunner } from './process';

/**
 * The DNS **search domains** a session's container is created with.
 *
 * `docker run` does not inherit them from the host, so a container's
 * `/etc/resolv.conf` has a nameserver and no `search` line at all. The corporate
 * resolver still answers — but only for a fully qualified name, which makes an
 * internal short host like `http://binary/artifactory/` (the form repositories
 * actually declare in `.npmrc`, `settings.xml`, `gradle.properties`) fail to
 * resolve inside the sandbox while working everywhere else on the machine.
 *
 * The visible damage is not the failed download: the agent reads the failure as a
 * broken repository and «fixes» it by rewriting the host to a public-looking
 * equivalent, so the session ends with edits nobody asked for. Handing the
 * container the host's own search list removes the reason for that entirely.
 */

/** Env override: a comma/space separated list, or an empty value to disable. */
const OVERRIDE_VAR = 'AGENT_ENGINE_DNS_SEARCH';
/** `resolv.conf` honours at most six search domains… */
const MAX_DOMAINS = 6;
/** …and 256 characters of them in total. */
const MAX_TOTAL_CHARS = 256;

/** One hostname label, and the dotted name they form. */
const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

/**
 * True for a value safe to hand to `docker run --dns-search`. Same spirit as
 * `isSafeBranchName` / `isSafeEnvKey` in `git-parse.ts`: whatever we read from
 * the host's resolver configuration ends up on a command line, so it is matched
 * against the shape it is supposed to have rather than escaped.
 */
export function isSafeSearchDomain(value: string): boolean {
  return value.length > 0 && value.length <= 253 && DOMAIN_PATTERN.test(value);
}

/** Drops unsafe / duplicate entries and applies the `resolv.conf` limits. */
function normalize(domains: string[]): string[] {
  const result: string[] = [];
  let total = 0;
  for (const raw of domains) {
    const domain = raw.trim().replace(/\.$/, '').toLowerCase();
    if (!isSafeSearchDomain(domain) || result.includes(domain)) {
      continue;
    }
    // +1 for the space that separates them in the generated `search` line.
    const next = total + domain.length + (result.length > 0 ? 1 : 0);
    if (result.length >= MAX_DOMAINS || next > MAX_TOTAL_CHARS) {
      break;
    }
    result.push(domain);
    total = next;
  }
  return result;
}

/**
 * Search domains from `scutil --dns` (macOS), in the order it lists them.
 *
 * The output repeats the same domains once per resolver, which is why the
 * de-duplication in {@link normalize} is not optional.
 */
export function parseScutilSearchDomains(stdout: string): string[] {
  const domains: string[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*search domain\[\d+]\s*:\s*(\S+)\s*$/.exec(line);
    if (match) {
      domains.push(match[1]);
    }
  }
  return normalize(domains);
}

/** Search domains from a `resolv.conf` (Linux): `search a b c`, or `domain x`. */
export function parseResolvConfSearchDomains(text: string): string[] {
  const domains: string[] = [];
  for (const line of text.split('\n')) {
    const clean = line.split('#')[0].split(';')[0].trim();
    const match = /^(search|domain)\s+(.*)$/i.exec(clean);
    if (match) {
      domains.push(...match[2].split(/\s+/));
    }
  }
  return normalize(domains);
}

/**
 * Search domains from PowerShell (Windows): the machine-wide suffix search list
 * followed by each adapter's connection-specific suffix, one per line.
 *
 * Read through cmdlets rather than `ipconfig /all` because that output is
 * localised — a Russian Windows answers «DNS-суффикс подключения», and a parser
 * keyed on the English wording would silently find nothing on exactly the
 * corporate machines this exists for.
 */
export function parseWindowsSearchDomains(stdout: string): string[] {
  return normalize(stdout.split(/[\s,]+/));
}

/** Parses the {@link OVERRIDE_VAR} value; an empty one means «no search domains». */
export function parseOverride(value: string): string[] {
  return normalize(value.split(/[,\s]+/));
}

/** Cached for the life of the daemon — a machine's search domains do not move. */
let cached: Promise<string[]> | null = null;

/**
 * The search domains to give a session's container: the {@link OVERRIDE_VAR}
 * override if set (an empty value switches the whole thing off), otherwise the
 * host's own.
 *
 * Never throws: a missing `scutil`, an unreadable `resolv.conf` or a timeout all
 * mean «no search domains», which is exactly the behaviour containers had before.
 */
export function hostSearchDomains(
  runner: ProcessRunner,
  platformName: PlatformName = platform(),
): Promise<string[]> {
  cached ??= detect(runner, platformName).catch((error: unknown) => {
    // A warning, not an error: a machine with no search domains configured is a
    // perfectly ordinary machine, and containers behave as they always did.
    console.warn(`[code] could not read the host's DNS search domains: ${asMessage(error)}`);
    return [];
  });
  return cached;
}

/** Forgets the cached detection. For tests. */
export function resetSearchDomainCache(): void {
  cached = null;
}

async function detect(runner: ProcessRunner, platformName: PlatformName): Promise<string[]> {
  const override = process.env[OVERRIDE_VAR];
  if (override !== undefined) {
    return parseOverride(override);
  }
  if (platformName === 'darwin') {
    const { stdout } = await runner.run('scutil', ['--dns'], {
      timeoutMs: PROCESS_TIMEOUTS.probe,
    });
    return parseScutilSearchDomains(stdout);
  }
  if (platformName === 'win32') {
    const { stdout } = await runner.run('powershell', WINDOWS_DNS_ARGS, {
      timeoutMs: PROCESS_TIMEOUTS.probe,
    });
    return parseWindowsSearchDomains(stdout);
  }
  return parseResolvConfSearchDomains(await readFile('/etc/resolv.conf', 'utf8'));
}

/** `--dns-search DOMAIN` arguments for `docker run`, in the style of `envArgs`. */
export function dnsSearchArgs(domains: string[]): string[] {
  return domains.flatMap((domain) => ['--dns-search', domain]);
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
