/**
 * Constants for the daemon's own log file.
 *
 * The daemon is started by a person who then leaves it alone in a terminal
 * window for the rest of the day — and that window is exactly where the answer
 * to «why did the model call fail three hours ago» has already scrolled away, or
 * was closed with the tab. A file beside everything else the daemon keeps costs
 * one append per line and makes the run reportable.
 */

/** Directory under the daemon's home that holds the log. */
export const LOG_DIR = 'logs';

/** File every run appends to. */
export const LOG_FILE = 'engine.log';

/**
 * Suffix of the one previous log kept around. A single generation on purpose:
 * the point is to survive a rotation mid-session, not to archive the machine's
 * history — anything older belongs to whatever collects logs on that host.
 */
export const LOG_ROTATED_SUFFIX = '.1';

/**
 * Size at which the current log is rotated. A daemon left running for weeks with
 * `AGENT_ENGINE_DEBUG_EVENTS` on writes a line per stream event, so «grows until
 * the disk is full» is a real outcome rather than a theoretical one.
 */
export const LOG_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Modes the directory and the file are created with — the same reasoning as
 * `STATE_DB_MODE`. The banner prints the bearer token, so the log holds it, and
 * a shared machine's other accounts have no business reading it.
 */
export const LOG_DIR_MODE = 0o700;
export const LOG_FILE_MODE = 0o600;
