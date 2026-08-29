import type { Concession, SupplierOffer, SupplierProfile } from "@sq/shared";
import { paymentTermsSchema } from "@sq/shared";

/** What a supplier agent is asked to produce. The system decides what it means. */
export type RawProposal = {
  priceFactor: number;
  leadTimeDays: number;
  paymentTerms: string;
  rebatePct: number;
  freightAllowancePerUnit: number;
  concessions: Concession[];
  message: string;
};

/**
 * Concessions are rendered as chips beside the message, so they have to read as
 * labels rather than sentences. A live model will happily return a full clause
 * here, so the length is trimmed on the way in for the same reason the prices
 * are: the prompt asks, this guarantees.
 */
const CONCESSION_LABEL_MAX = 64;

function shortenConcession(concession: Concession): Concession {
  const description = concession.description.trim().replace(/\s+/g, " ");
  if (description.length <= CONCESSION_LABEL_MAX) return { ...concession, description };

  // Prefer the last clause boundary that fits, falling back to a word boundary,
  // so the chip still reads as a phrase rather than a word broken in half.
  const head = description.slice(0, CONCESSION_LABEL_MAX);
  const clause = head.search(/[,;:][^,;:]*$/);
  const cut = clause > 24 ? clause : head.lastIndexOf(" ");

  return {
    ...concession,
    description: `${(cut > 24 ? head.slice(0, cut) : head).trimEnd()}…`,
  };
}

/**
 * Forces a proposal back inside what this supplier is actually willing to do.
 *
 * The bounds live here rather than in the prompt because a prompt is a request,
 * not a constraint: a model that has been told "never go below 0.84" will go
 * below 0.84 eventually, and when it does, the brand gets a purchase order at a
 * price the factory never agreed to. Everything the model returns is treated as
 * a suggestion and every clamp is recorded, so the transcript shows where the
 * supplier hit its limit.
 */
export function clampOffer(
  raw: RawProposal,
  supplier: SupplierProfile,
  round: number,
  previous: SupplierOffer | null,
  openingLeadTimeDays: number,
  openingPaymentTerms: string,
): SupplierOffer {
  const clamped: string[] = [];

  // #region price-floor
  let priceFactor = Number.isFinite(raw.priceFactor) ? raw.priceFactor : 1;
  if (priceFactor < supplier.floorRatio) {
    clamped.push(`price held at its floor of ${(supplier.floorRatio * 100).toFixed(0)}% of the opening quote`);
    priceFactor = supplier.floorRatio;
  }
  if (priceFactor > 1) {
    clamped.push("price cannot be raised above the opening quote");
    priceFactor = 1;
  }
  // A supplier that re-raises a price it already conceded is not negotiating in
  // good faith, and it makes the transcript incoherent to read.
  if (previous && priceFactor > previous.priceFactor) {
    clamped.push("price held at the level already offered");
    priceFactor = previous.priceFactor;
  }
  // #endregion price-floor

  let leadTimeDays = Math.round(Number.isFinite(raw.leadTimeDays) ? raw.leadTimeDays : openingLeadTimeDays);
  if (leadTimeDays < supplier.minLeadTimeDays) {
    clamped.push(`lead time held at ${supplier.minLeadTimeDays} days, the fastest this factory runs`);
    leadTimeDays = supplier.minLeadTimeDays;
  }
  if (leadTimeDays > openingLeadTimeDays) leadTimeDays = openingLeadTimeDays;
  if (previous && leadTimeDays > previous.leadTimeDays) leadTimeDays = previous.leadTimeDays;

  // Payment terms are a milestone split, not a number, so they are picked from
  // the two schedules this supplier will actually sign rather than clamped.
  const allowed = new Set([openingPaymentTerms, supplier.bestPaymentTerms, previous?.paymentTerms].filter(Boolean) as string[]);
  let paymentTerms = raw.paymentTerms?.trim() ?? openingPaymentTerms;
  if (!paymentTermsSchema.safeParse(paymentTerms).success || !allowed.has(paymentTerms)) {
    if (paymentTerms !== openingPaymentTerms) {
      clamped.push(`payment terms held at ${previous?.paymentTerms ?? openingPaymentTerms}`);
    }
    paymentTerms = previous?.paymentTerms ?? openingPaymentTerms;
  }

  let rebatePct = Number.isFinite(raw.rebatePct) ? raw.rebatePct : 0;
  if (rebatePct > supplier.maxRebatePct) {
    clamped.push(`volume rebate capped at ${supplier.maxRebatePct}%`);
    rebatePct = supplier.maxRebatePct;
  }
  if (rebatePct < 0) rebatePct = 0;
  if (previous && rebatePct < previous.rebatePct) rebatePct = previous.rebatePct;

  let freightAllowancePerUnit = Number.isFinite(raw.freightAllowancePerUnit) ? raw.freightAllowancePerUnit : 0;
  if (freightAllowancePerUnit > supplier.maxFreightAllowancePerUnit) {
    clamped.push(`freight allowance capped at $${supplier.maxFreightAllowancePerUnit.toFixed(2)} per unit`);
    freightAllowancePerUnit = supplier.maxFreightAllowancePerUnit;
  }
  if (freightAllowancePerUnit < 0) freightAllowancePerUnit = 0;
  if (previous && freightAllowancePerUnit < previous.freightAllowancePerUnit) {
    freightAllowancePerUnit = previous.freightAllowancePerUnit;
  }

  return {
    supplierCode: supplier.code,
    round,
    priceFactor: Number(priceFactor.toFixed(4)),
    leadTimeDays,
    paymentTerms,
    rebatePct: Number(rebatePct.toFixed(2)),
    freightAllowancePerUnit: Number(freightAllowancePerUnit.toFixed(3)),
    fulfillmentRatio: previous?.fulfillmentRatio ?? 1,
    concessions: (raw.concessions ?? []).map(shortenConcession),
    message: humaniseFieldNames(raw.message?.trim() || "We have updated our offer."),
    clamped,
  };
}

/** Our field names, and what a person would have called them. */
const FIELD_WORDS: Record<string, string> = {
  priceFactor: "price factor",
  leadTimeDays: "lead time",
  paymentTerms: "payment terms",
  rebatePct: "rebate",
  freightAllowancePerUnit: "freight allowance",
};

/**
 * Keeps our schema's field names out of the message the brand reads.
 *
 * The model is handed a JSON contract naming `priceFactor`, so it will sometimes
 * write "a 6% price reduction (priceFactor 0.94)" — correct, and not how a sales
 * lead writes to a customer. The prompt asks it not to; this makes sure.
 *
 * `priceFactor` also gets its value turned into the percentage a reader expects,
 * because 0.94 means "94% of the opening price" and is very easy to read as a 94%
 * discount.
 */
export function humaniseFieldNames(message: string): string {
  let out = message.replace(
    /\bpriceFactor\b\s*(?:of|at|:|=)?\s*(0?\.\d+|1(?:\.0+)?)\b/g,
    (_match, value: string) => `price factor at ${Math.round(Number(value) * 100)}%`,
  );

  for (const [field, words] of Object.entries(FIELD_WORDS)) {
    out = out.replace(new RegExp(`\\b${field}\\b`, "g"), words);
  }

  // "(price factor at 94%)" reads fine; "( price factor at 94% )" does not.
  return out.replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").replace(/\s{2,}/g, " ").trim();
}

/** True when a supplier has nothing left to give on any dimension. */
export function isExhausted(offer: SupplierOffer, supplier: SupplierProfile): boolean {
  return (
    offer.priceFactor <= supplier.floorRatio + 1e-6 &&
    offer.leadTimeDays <= supplier.minLeadTimeDays &&
    offer.rebatePct >= supplier.maxRebatePct - 1e-6
  );
}
