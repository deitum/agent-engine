/**
 * A refusal from the daemon, carrying the status it answered with.
 *
 * The status is the part callers branch on and the reason this is a class rather
 * than a plain `Error`: `428` means "hand me a configuration and try again",
 * `401` means the token is wrong, and `501` means this build cannot do what was
 * asked. Losing that distinction turns every one of them into "something went
 * wrong".
 */
export class EngineError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

/**
 * The daemon could not be reached at all — nothing answered on the port.
 *
 * Deliberately distinct from {@link EngineError}: an app shows "is the daemon
 * running?" for this and the daemon's own words for that, and it cannot tell
 * them apart from a status code that never arrived.
 */
export class EngineUnreachableError extends Error {
  constructor(
    readonly baseUrl: string,
    override readonly cause?: unknown,
  ) {
    super(`The agent engine at ${baseUrl} is not responding`);
    this.name = 'EngineUnreachableError';
  }
}

/** The status the daemon answers with while it holds no configuration. */
export const CONFIG_MISSING_STATUS = 428;

/**
 * The message out of an error response body, or a readable fallback.
 *
 * Never throws: this runs on the failure path, and a body that is not the JSON
 * the daemon promised must not replace the status with a parse error.
 */
export async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === 'string' && body.message) {
      return body.message;
    }
  } catch {
    // Falls through to the status line below.
  }
  return `The agent engine answered ${response.status}`;
}
