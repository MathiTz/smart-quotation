import type { NegotiationStatus } from "@sq/shared";

export type StatusTone = "neutral" | "accent" | "good" | "warn" | "bad";

/**
 * Shared by the negotiation page and the list, so a status cannot be called two
 * different things depending on where you are looking at it from.
 */
const COPY: Record<NegotiationStatus, { label: string; tone: StatusTone }> = {
  pending: { label: "Getting ready", tone: "neutral" },
  negotiating: { label: "Negotiating", tone: "accent" },
  suspended: { label: "Paused for input", tone: "warn" },
  scoring: { label: "Scoring the options", tone: "accent" },
  awaiting_conversion: { label: "Recommendation ready", tone: "good" },
  converted: { label: "Converted to a PO", tone: "good" },
  failed: { label: "Failed", tone: "bad" },
};

/**
 * Looked up through a function rather than indexed directly.
 *
 * The type says the key is always one of the seven, but the value crossed the
 * network as JSON and TypeScript did not check it there. A server that gains an
 * eighth status before the client is redeployed would otherwise return
 * `undefined` here, and reading `.tone` off it white-screens the whole page —
 * turning a cosmetic mismatch into an outage. Showing the raw status is worse
 * than a nice label and much better than nothing.
 */
export function statusCopy(status: NegotiationStatus): { label: string; tone: StatusTone } {
  return COPY[status] ?? { label: String(status).replace(/_/g, " "), tone: "neutral" };
}


/** The statuses where the workflow is still doing something on its own. */
export const RUNNING: NegotiationStatus[] = ["pending", "negotiating", "scoring"];

export const isRunning = (status: NegotiationStatus) => RUNNING.includes(status);

/**
 * Lifecycle order, used for sorting. Alphabetical would put "Converted to a PO"
 * next to "Getting ready", which tells you nothing; this way sorting by status
 * groups the negotiations that still need something from you at one end.
 *
 * `failed` sits at the end rather than where it occurred, because a failure is
 * not a stage of progress.
 */
const STATUS_ORDER: NegotiationStatus[] = [
  "pending",
  "negotiating",
  "suspended",
  "scoring",
  "awaiting_conversion",
  "converted",
  "failed",
];

export const statusRank = (status: NegotiationStatus) => STATUS_ORDER.indexOf(status);
