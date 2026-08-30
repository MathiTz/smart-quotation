/**
 * Display helpers.
 *
 * Every numeric formatter here guards against a non-finite input. Not because
 * one is expected — the API computes these — but because the failure mode is
 * uniquely bad: `$NaN` on a purchase-order total looks like a broken app, and
 * `NaN` next to a supplier name looks like a real number the reader cannot
 * interpret. An em dash reads as "not available", which is what it is.
 */
import { AS_QUOTED } from "@sq/shared";

const NOT_AVAILABLE = "—";

const isNumber = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

export const money = (n: number, decimals = 0) =>
  isNumber(n)
    ? `$${n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`
    : NOT_AVAILABLE;

/** Unit prices are cents-scale; whole dollars would round the difference away. */
export const unitMoney = (n: number) =>
  isNumber(n) ? `$${n.toFixed(4).replace(/0+$/, "").replace(/\.$/, ".00")}` : NOT_AVAILABLE;

export const qty = (n: number) => (isNumber(n) ? n.toLocaleString("en-US") : NOT_AVAILABLE);

export const pct = (n: number) => (isNumber(n) ? `${Math.round(n * 100)}%` : NOT_AVAILABLE);

/**
 * A negotiation's tier, for anywhere outside the review screen that has the
 * number but not the tier picker. `AS_QUOTED` is a sentinel rather than a
 * quantity, so formatting it as one reads "0/line" on a basket that is really
 * every line at the volume its own row was quoted for.
 */
export const basketTier = (tierQuantity: number) =>
  tierQuantity === AS_QUOTED ? "As quoted" : `${qty(tierQuantity)}/line`;

export const days = (n: number) => (isNumber(n) ? `${n} day${n === 1 ? "" : "s"}` : NOT_AVAILABLE);

/**
 * `new Date("nonsense")` renders the literal string "Invalid Date", which is
 * worse than saying nothing: it appears mid-transcript as though it were content.
 */
function parseDate(iso: string): Date | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

export const dateTime = (iso: string) =>
  parseDate(iso)?.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }) ?? NOT_AVAILABLE;

export const dateOnly = (iso: string) =>
  parseDate(iso)?.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }) ?? NOT_AVAILABLE;

/** 33/33/33 reads better as prose the first time someone sees it. */
export function explainTerms(terms: string): string {
  const parts = terms
    .split("/")
    .map(Number)
    .filter((n) => Number.isFinite(n));
  // An unreadable term is shown as written rather than as "% upfront", which is
  // what an empty split used to produce.
  if (parts.length === 0) return terms.trim() || NOT_AVAILABLE;
  if (parts.length === 1) return `${parts[0]}% upfront`;
  if (parts.length === 2) return `${parts[0]}% upfront, ${parts[1]}% on delivery`;
  return `${parts[0]}% upfront, ${parts[1]}% mid-production, ${parts[2]}% on delivery`;
}
