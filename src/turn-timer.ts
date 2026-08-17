/**
 * Where a turn's wall-clock time went, as one line per turn.
 *
 * A turn that feels slow is almost never slow in the place people guess: the
 * model call is visible and everything before it is not. This records the
 * phases that run before the first token — dependency loading, the workspace,
 * bridging MCP servers, the search backend, building the graph — so «the chat
 * is slow» can be answered with numbers instead of a hypothesis.
 *
 * Off unless `AGENT_ENGINE_DEBUG_TIMING=1`, like `AGENT_ENGINE_DEBUG_EVENTS`
 * before it: a daemon that prints a line per turn by default is a daemon whose
 * console nobody reads.
 */

/** Injection seams; production passes none of them. */
export interface TurnTimerOptions {
  now?: () => number;
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}

export interface TurnTimer {
  /**
   * Closes the phase that has just finished, recording how long it took. The
   * value is a **delta** — the time since the previous mark, or since the timer
   * was created for the first one.
   */
  mark: (phase: string) => void;
  /**
   * Records a value that is not a phase: a count, or a moment measured from the
   * start of the turn rather than from the previous mark ({@link since}). The
   * value is written verbatim, so a duration carries its own `ms`.
   */
  note: (key: string, value: string | number) => void;
  /** Milliseconds since the timer was created. */
  since: () => number;
  /** Writes the line. Does nothing when the flag is off, or when called twice. */
  done: () => void;
  /** Whether anything is being recorded at all, so callers can skip their own work. */
  readonly enabled: boolean;
}

/** A timer for one turn. `label` names what is being timed (`chat`, `task`, …). */
export function createTurnTimer(label: string, options: TurnTimerOptions = {}): TurnTimer {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.log(line));
  const env = options.env ?? process.env;
  const enabled = env.AGENT_ENGINE_DEBUG_TIMING === '1';

  if (!enabled) {
    return {
      mark: () => {},
      note: () => {},
      since: () => 0,
      done: () => {},
      enabled: false,
    };
  }

  const started = now();
  let previous = started;
  const parts: string[] = [];
  let written = false;

  return {
    enabled: true,

    mark: (phase) => {
      const at = now();
      parts.push(`${phase}=${at - previous}ms`);
      previous = at;
    },

    note: (key, value) => {
      parts.push(`${key}=${value}`);
    },

    since: () => now() - started,

    done: () => {
      if (written) {
        return;
      }
      written = true;
      log(`[timing] ${label} ${parts.join(' ')} total=${now() - started}ms`);
    },
  };
}
