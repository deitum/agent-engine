import { type CodeLspConfig, type CodeLspLanguage } from '../../contracts';
import { type ExecuteResponse } from '../docker-backend';

import { INSTALL_TIMEOUT_SEC, LSP_CACHE_DIR, PROBE_TIMEOUT_SEC } from './lsp.constants';
import { installMarkerName, type LspServerVariant, specFor } from './servers';

/**
 * Materialising a language server into the shared `/cache/lsp` mount.
 *
 * `/cache` is a host directory bind-mounted into every session container, so a
 * server is downloaded once per machine rather than once per session — the same
 * bargain the dependency caches already make. Nothing is ever installed into the
 * checkout: it would show up in the diff panel and, eventually, in a pull request.
 */

/** Runs a command inside the session's container. */
export type ContainerExec = (command: string, timeoutSec: number) => Promise<ExecuteResponse>;

/** What an install attempt settled on. */
export interface InstallOutcome {
  /** The variant that is now on disk, when one is. */
  variant?: LspServerVariant;
  /** Why the language is unavailable, in the user's language. */
  reason?: string;
}

/**
 * In-flight installs, keyed by language.
 *
 * Two sessions opening the same stack at once would otherwise run `npm install
 * -g --prefix /cache/lsp/node` against the same directory concurrently, which npm
 * does not survive. The connector is a single process, so an in-process map is
 * the whole of the lock — and it is deliberately not a result cache: a failure
 * caused by a proxy being down must be retried later, and the marker file on disk
 * is what records real success.
 */
const inFlight = new Map<CodeLspLanguage, Promise<InstallOutcome>>();

/**
 * Makes sure the server for `language` is installed in the container, returning
 * the variant to launch or the reason it cannot be.
 *
 * Never throws: an unavailable language server is a degraded session, not a
 * failed one, and every caller's correct response is to carry on without it.
 */
export async function ensureServerInstalled(
  language: CodeLspLanguage,
  config: CodeLspConfig,
  exec: ContainerExec,
): Promise<InstallOutcome> {
  const running = inFlight.get(language);
  if (running) {
    return running;
  }
  const attempt = install(language, config, exec).finally(() => inFlight.delete(language));
  inFlight.set(language, attempt);
  return attempt;
}

async function install(
  language: CodeLspLanguage,
  config: CodeLspConfig,
  exec: ContainerExec,
): Promise<InstallOutcome> {
  const spec = specFor(language);

  // The runtime is probed rather than assumed: a `gradle:` image has no Node and
  // a `python:` image has no JDK, and «the server is not installed» is a much worse
  // thing to tell the user than «the image has no Node.js».
  let probe: ExecuteResponse;
  try {
    probe = await exec(spec.probe.command, PROBE_TIMEOUT_SEC);
  } catch (error) {
    return { reason: `could not probe the environment: ${describe(error)}` };
  }
  const missing = spec.probe.check(probe.output, probe.exitCode);
  if (missing) {
    return { reason: missing };
  }

  const failures: string[] = [];
  for (const variant of spec.variants) {
    const marker = installMarkerName(language, variant, config);
    try {
      const present = await exec(`test -f ${marker}`, PROBE_TIMEOUT_SEC);
      if (present.exitCode === 0) {
        return { variant };
      }
    } catch {
      // A failed probe is treated as «not installed»; the install below settles it.
    }

    let result: ExecuteResponse;
    try {
      result = await exec(variant.install(config), INSTALL_TIMEOUT_SEC);
    } catch (error) {
      failures.push(`${variant.id}: ${describe(error)}`);
      continue;
    }
    if (result.exitCode === 0) {
      // The marker is written only after a clean exit, so an install killed
      // half-way is retried rather than trusted.
      await exec(`mkdir -p ${LSP_CACHE_DIR} && touch ${marker}`, PROBE_TIMEOUT_SEC).catch(
        () => undefined,
      );
      return { variant };
    }
    failures.push(`${variant.id}: ${firstMeaningfulLine(result.output)}`);
  }

  return { reason: `could not install the server (${failures.join('; ')})` };
}

/**
 * The first line worth quoting from a failed install. Package managers open with
 * banners and progress bars; the line that says what went wrong is further down.
 */
export function firstMeaningfulLine(output: string): string {
  const lines = output
    .split('\n')
    .map((line) => line.replace(/\r/g, '').trim())
    .filter((line) => line.length > 0);

  const notable = lines.find((line) => /error|not found|denied|refused|fatal/i.test(line));
  const chosen = notable ?? lines[lines.length - 1] ?? 'no output';
  return chosen.slice(0, 200);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
