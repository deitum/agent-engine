/**
 * Reading the daemon's SSE streams.
 *
 * Deliberately hand-rolled rather than `EventSource`: that API cannot send a
 * bearer token, cannot `POST`, and reconnects on its own — all three of which
 * are wrong here. Every stream this engine opens is an authenticated POST whose
 * end is meaningful, and a silent reconnect would start a second agent turn.
 *
 * Written against the web streams API alone, so this file is safe in a browser
 * bundle as well as in Node.
 */

/** The sentinel every one of the daemon's streams ends with. */
const DONE = '[DONE]';

/**
 * Yields one parsed event per `data:` frame, and returns when the stream ends —
 * whether by the sentinel, by the body closing, or by the caller aborting.
 *
 * Frames are decoded incrementally: a `data:` line can arrive split across two
 * chunks, and treating each chunk as a whole message drops events under exactly
 * the load that makes them worth streaming.
 */
export async function* streamEvents<TEvent>(response: Response): AsyncGenerator<TEvent> {
  const body = response.body;
  if (!body) {
    return;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      // Frames are separated by a blank line. Anything after the last separator
      // is a partial frame and stays in the buffer.
      let separator = buffer.indexOf('\n\n');
      while (separator !== -1) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);

        const data = dataOf(frame);
        if (data === DONE) {
          return;
        }
        if (data !== null) {
          const event = parse<TEvent>(data);
          if (event !== null) {
            yield event;
          }
        }

        separator = buffer.indexOf('\n\n');
      }
    }
  } finally {
    // Releasing matters on the abort path: the generator is closed by a `break`
    // in the caller's `for await`, and the socket would otherwise stay open.
    await reader.cancel().catch(() => undefined);
  }
}

/** The `data:` payload of one frame, or `null` when it carries none. */
function dataOf(frame: string): string | null {
  const lines = frame.split('\n');
  const data = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trimStart());
  return data.length > 0 ? data.join('\n') : null;
}

/**
 * Parses one frame's payload, dropping anything that is not JSON.
 *
 * Dropped rather than thrown: a malformed frame in the middle of a turn should
 * cost that frame, not the fifty good ones after it.
 */
function parse<TEvent>(data: string): TEvent | null {
  try {
    return JSON.parse(data) as TEvent;
  } catch {
    return null;
  }
}
