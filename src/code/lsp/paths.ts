import { isAbsolute, join, normalize, sep } from 'node:path';

import { CONTAINER_WORKSPACE, CONTAINER_WORKSPACE_URI } from './lsp.constants';

/**
 * The one place a file path is translated between the three forms it takes in a
 * Code session.
 *
 * | Form            | Looks like                        | Who uses it            |
 * | --------------- | --------------------------------- | ---------------------- |
 * | agent / virtual | `/src/OrderService.java`          | deepagents' file tools |
 * | host            | `~/.agent-engine/code/<id>/repo/…`  | reading the file       |
 * | container URI   | `file:///workspace/src/…`         | the language server    |
 *
 * They differ because the backend deliberately splits the workspace: file
 * operations run on the host side of the bind mount, while execution — and
 * therefore the language server — runs inside the container. Getting a
 * translation wrong here shows up as a server that reports diagnostics for a
 * file nobody asked about, so it is worth its own module and its own tests.
 */

/**
 * Reduces whatever the model passed to a path relative to the checkout root, or
 * `null` when it points outside it.
 *
 * Accepts all three spellings the model produces in practice: the virtual
 * `/src/a.ts` deepagents documents, a bare `src/a.ts`, and the container-absolute
 * `/workspace/src/a.ts` it sometimes copies out of a shell command.
 */
export function toRelativePath(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  let candidate = trimmed.replace(/\\/g, '/');
  if (candidate === CONTAINER_WORKSPACE) {
    return null;
  }
  if (candidate.startsWith(`${CONTAINER_WORKSPACE}/`)) {
    candidate = candidate.slice(CONTAINER_WORKSPACE.length + 1);
  }
  candidate = candidate.replace(/^\/+/, '');

  // `normalize` collapses `.` and `..`; anything that still climbs is an escape
  // attempt (or a confused model) and must not reach the filesystem.
  const normalized = normalize(candidate).split(sep).join('/');
  if (normalized === '..' || normalized.startsWith('../') || isAbsolute(normalized)) {
    return null;
  }
  return normalized.replace(/^\.\//, '');
}

/** The absolute host path of a checkout-relative path. */
export function toHostPath(dir: string, relative: string): string {
  return join(dir, relative);
}

/**
 * The URI the language server knows a file by.
 *
 * Percent-encoding is applied per segment so a path with a space or a Cyrillic
 * name survives; `encodeURIComponent` leaves the characters servers also leave
 * alone, which matters because a URI we spell differently from the server is a
 * URI whose diagnostics we will never match.
 */
export function toContainerUri(relative: string): string {
  const encoded = relative
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${CONTAINER_WORKSPACE_URI}/${encoded}`;
}

/**
 * The checkout-relative path a server's URI refers to, or `null` when it points
 * somewhere else entirely — a JDK class file (`jdt://…`), a stdlib stub under
 * `/usr/lib/python3`, a dependency inside `node_modules` of another root. Those
 * are real answers to a «go to definition» and deliberately not ours to rewrite:
 * the caller shows them as-is rather than pretending they are project files.
 */
export function fromContainerUri(uri: string): string | null {
  if (!uri.startsWith(`${CONTAINER_WORKSPACE_URI}/`)) {
    return null;
  }
  const encoded = uri.slice(CONTAINER_WORKSPACE_URI.length + 1);
  try {
    return encoded
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/');
  } catch {
    // A URI we cannot decode is one we cannot map; treat it as external.
    return null;
  }
}

/**
 * How a location is labelled for the model: the project-relative path when the
 * URI is inside the checkout, and something honest but short when it is not.
 */
export function describeUri(uri: string): string {
  const relative = fromContainerUri(uri);
  if (relative) {
    return relative;
  }
  // `file:///usr/lib/python3.12/typing.py` → `<outside the project> /usr/lib/…/typing.py`
  const withoutScheme = uri.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  try {
    return decodeURIComponent(withoutScheme);
  } catch {
    return withoutScheme;
  }
}
