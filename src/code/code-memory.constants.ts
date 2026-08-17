/**
 * Write budget for the notes file. It is injected into the system prompt on
 * *every* turn, so its size is a permanent tax rather than a one-off cost —
 * roughly 2k tokens is a page of hard-won facts, which is what memory is for.
 * Past this the `remember` tool refuses and asks for a tidy-up.
 */
export const MEMORY_NOTES_MAX_CHARS = 8_000;

/** Per-section share of the budget, so one section cannot crowd out the rest. */
export const MEMORY_SECTION_MAX_CHARS = 3_000;

/** Longest single entry. A note that needs more than this is documentation. */
export const MEMORY_ENTRY_MAX_CHARS = 400;

/**
 * How many failed commands the injected block carries. Enough to cover a round
 * of trial and error, short enough that the block stays scannable.
 */
export const MAX_FAILURE_ENTRIES = 10;

/** How much of a failed command's output is kept as its one-line detail. */
export const FAILURE_DETAIL_MAX_CHARS = 200;

/** Longest command string recorded in the failure journal. */
export const FAILURE_COMMAND_MAX_CHARS = 300;

/** Divisor turning characters into an estimated token count. */
export const CHARS_PER_TOKEN = 4;

/** Heading of the injected failures block, inside the marker pair. */
export const FAILURES_HEADING = 'Recent command failures';
