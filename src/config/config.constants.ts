/**
 * What a request gets back before the browser has handed this daemon its
 * configuration (`POST /config`) — after a restart, or in the race between the
 * app's first request and its first probe. `428` rather than `500` because it is
 * the client's to fix and the fix is mechanical: hand the configuration over and
 * try again, which is exactly what the web transport does with this status.
 */
export const CONFIG_MISSING_STATUS = 428;
