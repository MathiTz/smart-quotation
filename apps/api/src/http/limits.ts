/**
 * Ceilings on the untrusted inputs, kept together so the API and its docs cannot
 * drift apart on what they are.
 *
 * Each of these bounds something that is otherwise unbounded by its type. A
 * `z.string()` accepts a megabyte and a `z.number().int().positive()` accepts a
 * quantity no factory could make; neither is rejected by anything downstream,
 * so the limit has to be stated here or not at all.
 */

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * The brand note is read by regexes with `matchAll`, stored on the row, and
 * echoed into every agent prompt each round. An unbounded one is a slow parse, a
 * large row and a large prompt at once. Well beyond the instruction it holds.
 */
export const MAX_NOTE_CHARS = 2000;

/**
 * A tier is a per-line order quantity. The basket multiplies it by the number of
 * distinct SKUs, so an absurd value produces totals that overflow the display
 * and a negotiation about an order nobody could place.
 */
export const MAX_TIER_QUANTITY = 1_000_000;
