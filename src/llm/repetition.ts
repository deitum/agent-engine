/**
 * Degenerate-repetition detection for a streaming answer.
 *
 * A model answering at temperature 0 — the default here (`chat-model.ts`) —
 * can fall into a loop where it writes the same sentence over and over until
 * something stops it. It happens when the context has become self-similar: a
 * search that returned nothing a dozen times in a row, a plan restated at every
 * step. Nothing upstream of this module catches it. The step budget
 * (`AGENT_RECURSION_LIMIT`) counts graph super-steps, and the whole loop happens
 * inside **one** of them; `maxTokens` is unset unless an agent's config names it.
 * So the only thing that ever ended such a turn was the user pressing Stop.
 *
 * What follows is the cheap, text-only test for it: is the tail of what has been
 * written so far just one block repeated end to end? That catches both shapes
 * the failure takes — a paragraph repeated with newlines between the copies, and
 * a sentence repeated inline — without knowing anything about the model.
 */

import {
  REPETITION_MIN_COPIES,
  REPETITION_MIN_SPAN_CHARS,
  REPETITION_PROBE_CHARS,
  REPETITION_QUOTE_CHARS,
  REPETITION_WINDOW_CHARS,
} from './llm.constants';

/** A block that the end of a stream is made of, repeated back to back. */
export interface Repetition {
  /** Length of the repeated block, in characters. */
  period: number;
  /** How many times it repeats, consecutively, at the very end of the text. */
  copies: number;
  /** The block itself, for the line that explains the cut to the user. */
  unit: string;
}

/**
 * The repetition at the end of `text`, or `null` if it ends like ordinary prose.
 *
 * Finds the one candidate block worth checking instead of trying every possible
 * length: the last {@link REPETITION_PROBE_CHARS} characters must, in periodic
 * text, appear again exactly one period earlier — so the distance back to their
 * previous occurrence *is* the period, and one `lastIndexOf` finds it. The block
 * is then verified copy by copy, because a probe can also recur for innocent
 * reasons (a repeated phrase in a list, a table's column header).
 *
 * Both thresholds have to be met. {@link REPETITION_MIN_COPIES} alone would fire
 * on `"— — — —"`; {@link REPETITION_MIN_SPAN_CHARS} alone would fire on two
 * copies of a long paragraph, which a model quoting itself does legitimately.
 * Together they describe text that has stopped going anywhere.
 */
export function findRepetition(text: string): Repetition | null {
  if (text.length < REPETITION_MIN_SPAN_CHARS) {
    return null;
  }
  const probe = text.slice(-REPETITION_PROBE_CHARS);
  const previous = text.lastIndexOf(probe, text.length - REPETITION_PROBE_CHARS - 1);
  if (previous < 0) {
    return null;
  }
  const period = text.length - REPETITION_PROBE_CHARS - previous;
  const unit = text.slice(text.length - period);
  // `startsWith` with an offset compares in place — the alternative allocates a
  // copy of the tail on every token of every turn.
  let copies = 1;
  while (
    (copies + 1) * period <= text.length &&
    text.startsWith(unit, text.length - (copies + 1) * period)
  ) {
    copies += 1;
  }
  const span = copies * period;
  return copies >= REPETITION_MIN_COPIES && span >= REPETITION_MIN_SPAN_CHARS
    ? { period, copies, unit }
    : null;
}

/**
 * The cut as a sentence for the user, quoting what the model got stuck on.
 *
 * Says what happened and no more: the answer is kept, so this is a note beside a
 * turn rather than a failure — and the quote is the whole explanation, because a
 * loop is instantly recognisable once it is on screen.
 */
export function repetitionMessage({ copies, unit }: Repetition): string {
  const quote = unit.trim().replace(/\s+/g, ' ').slice(0, REPETITION_QUOTE_CHARS);
  return `The answer started repeating itself and was cut short after ${copies} copies of «${quote}». Everything written before that is kept.`;
}

/** Watches one model call's text as it is written. */
export interface RepetitionWatch {
  /** Adds the next token; returns the repetition it completes, if any. */
  push: (delta: string) => Repetition | null;
  /** Forgets everything — call it when a different model call starts. */
  reset: () => void;
}

/**
 * A watch over a sliding {@link REPETITION_WINDOW_CHARS}-character window.
 *
 * Bounded on purpose: a turn can write far more than this, and none of the
 * earlier text can tell us anything about whether the *end* is stuck. The window
 * is many times {@link REPETITION_MIN_SPAN_CHARS}, so a repetition long enough
 * to report always fits inside it.
 */
export function createRepetitionWatch(): RepetitionWatch {
  let tail = '';
  return {
    push: (delta) => {
      tail = (tail + delta).slice(-REPETITION_WINDOW_CHARS);
      return findRepetition(tail);
    },
    reset: () => {
      tail = '';
    },
  };
}
