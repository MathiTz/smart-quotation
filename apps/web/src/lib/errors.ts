import { ApiError } from "./api.js";

/**
 * Turns anything a rejected request can throw into a sentence worth showing.
 *
 * Three cases arrive here and they are not interchangeable. `ApiError` carries a
 * message the server wrote deliberately, so it is used as-is along with any
 * detail. A `TypeError` from `fetch` means the request never reached the server
 * at all — the browser reports that as "Failed to fetch", which tells a user
 * nothing, so it is replaced with the thing they can actually act on. Anything
 * else is a bug in our own code, and `String(e)` at least names it.
 */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    return [e.message, e.detail].filter(Boolean).join(" — ");
  }
  if (e instanceof TypeError) {
    return "Could not reach the server. Check that the API is running on port 8787.";
  }
  return e instanceof Error ? e.message : String(e);
}
