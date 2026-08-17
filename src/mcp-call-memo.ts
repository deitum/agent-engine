/**
 * Per-turn memory of the MCP calls a run has already made.
 *
 * An agent that cannot find what it is looking for starts going in circles, and
 * the circles are literal: the same tool, the same arguments, several times in
 * one turn. Every lap costs a round-trip to the server, a step of the turn's
 * budget, and another copy of the same output in the context — which is exactly
 * the self-similar history a model then gets stuck repeating (`llm/repetition.ts`).
 *
 * So a repeat is answered from here, with a line saying so. The note matters as
 * much as the saving: a model reading its own earlier output back, unlabelled,
 * has no way to notice it is not making progress, and will happily ask a third
 * time.
 *
 * **Only successful calls are remembered.** A model repeating a call that failed
 * is usually retrying a timeout or a flaky server, and that has to actually run.
 * The memo lives for one run and is shared with its sub-agents, which delegate
 * from inside the same turn and search the same ground.
 */

/** How many calls one turn remembers. Beyond this the oldest are forgotten. */
const MEMO_MAX_ENTRIES = 64;

/**
 * The largest result kept. A memo entry is a second copy of an output the
 * history already holds; past this size the copy costs more than the round-trip
 * it would save.
 */
const MEMO_MAX_RESULT_CHARS = 20_000;

/** Prefix put on a result served from the memo instead of from the server. */
const REPEAT_NOTICE =
  'Note: this tool was already called with exactly these arguments in this turn. ' +
  'Its previous result is repeated below — the tool was not run again. ' +
  'Change the arguments, or use what is already here.';

export interface McpCallMemo {
  /** The previous result of this exact call, or `undefined` if it is new. */
  recall: (name: string, args: unknown) => string | undefined;
  /** Remembers a successful call's result. */
  remember: (name: string, args: unknown, result: string) => void;
}

/** A memo for one run. Not shared between turns: «already asked» is a fact about a turn. */
export function createMcpCallMemo(): McpCallMemo {
  const results = new Map<string, string>();

  return {
    recall: (name, args) => {
      const previous = results.get(memoKey(name, args));
      return previous === undefined ? undefined : `${REPEAT_NOTICE}\n\n${previous}`;
    },
    remember: (name, args, result) => {
      if (result.length > MEMO_MAX_RESULT_CHARS) {
        return;
      }
      const key = memoKey(name, args);
      // Re-inserted rather than updated, so the map's insertion order stays a
      // least-recently-called order and the eviction below is the right one.
      results.delete(key);
      results.set(key, result);
      if (results.size > MEMO_MAX_ENTRIES) {
        const oldest = results.keys().next();
        if (!oldest.done) {
          results.delete(oldest.value);
        }
      }
    },
  };
}

/**
 * The identity of one call: its tool and its arguments, with object keys sorted.
 *
 * Sorted because the model does not write them in a stable order — the same
 * search is `{workspace, repository}` one time and `{repository, workspace}` the
 * next — and two spellings of one call must not read as two calls.
 */
function memoKey(name: string, args: unknown): string {
  return `${name} ${stableJson(args)}`;
}

/** `JSON.stringify` with every object's keys in sorted order, at every depth. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
    return `{${entries.join(',')}}`;
  }
  // `undefined` has no JSON spelling and would come back as the string
  // "undefined"; it is a missing argument, which is what `null` says here.
  return JSON.stringify(value) ?? 'null';
}
