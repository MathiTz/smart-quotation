import type { Concession, SupplierProfile } from "@sq/shared";
import { MAX_ROUNDS, formatPaymentTerms } from "@sq/shared";
import type { RawProposal } from "./bounds.js";
import type { NegotiationBrief } from "./prompts.js";

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/**
 * How much of its remaining room a supplier gives up by round `round`. Concave,
 * so the first round moves a lot and the last barely moves at all, which is how
 * a real counterparty behaves: the early discount is cheap to give and the last
 * one is the one they actually care about.
 */
function concessionCurve(round: number): number {
  const remaining = Math.max(0, 1 - round / MAX_ROUNDS);
  return remaining ** 1.5;
}

/**
 * The negotiation without a language model. Every number is derived from the
 * supplier's real bounds and the brand's real leverage, and the wording is
 * generated from those numbers, so the offline transcript says the same things
 * the Gemini one does. This is the default path on a clean clone, so it has to
 * be good enough to demo, not just good enough to pass a test.
 */
export function offlineSupplierProposal(
  supplier: SupplierProfile,
  brief: NegotiationBrief,
  round: number,
): RawProposal {
  const room = concessionCurve(round);

  const priceFactor = supplier.floorRatio + (1 - supplier.floorRatio) * room;
  const leadTimeDays = Math.round(
    supplier.minLeadTimeDays + (brief.openingLeadTimeDays - supplier.minLeadTimeDays) * room,
  );
  const rebatePct = Number((supplier.maxRebatePct * (1 - room)).toFixed(1));
  const freight = Number((supplier.maxFreightAllowancePerUnit * (1 - room)).toFixed(3));

  // Terms move on the second pass, once the supplier has seen it is not alone.
  const paymentTerms = round >= 2 ? supplier.bestPaymentTerms : brief.openingPaymentTerms;

  const concessions: Concession[] = [];
  if (priceFactor < 1) {
    concessions.push({
      kind: "price",
      description: `${pct(1 - priceFactor)} off our opening prices across the basket`,
    });
  }
  if (leadTimeDays < brief.openingLeadTimeDays) {
    concessions.push({
      kind: "lead_time",
      description: `delivery pulled in to ${leadTimeDays} days`,
    });
  }
  if (paymentTerms !== brief.openingPaymentTerms) {
    concessions.push({
      kind: "payment_terms",
      description: `payment restructured to ${formatPaymentTerms(paymentTerms)}`,
    });
  }
  if (rebatePct > 0) {
    concessions.push({ kind: "volume_rebate", description: `${rebatePct}% rebate at this volume` });
  }
  if (freight > 0) {
    concessions.push({
      kind: "freight_allowance",
      description: `${money(freight)} per unit toward freight`,
    });
  }
  if (brief.capacityRatio < 1) {
    concessions.push({
      kind: "capacity_guarantee",
      description: `firm commitment on the ${Math.round(brief.capacityRatio * 100)}% we can run`,
    });
  }

  return {
    priceFactor,
    leadTimeDays,
    paymentTerms,
    rebatePct,
    freightAllowancePerUnit: freight,
    concessions,
    message: supplierMessage(supplier, brief, round, {
      priceFactor,
      leadTimeDays,
      paymentTerms,
      rebatePct,
      freight,
    }),
  };
}

type OfferNumbers = {
  priceFactor: number;
  leadTimeDays: number;
  paymentTerms: string;
  rebatePct: number;
  freight: number;
};

function supplierMessage(
  supplier: SupplierProfile,
  brief: NegotiationBrief,
  round: number,
  offer: OfferNumbers,
): string {
  const parts: string[] = [];
  const discount = pct(1 - offer.priceFactor);

  if (brief.capacityRatio < 1) {
    parts.push(
      `I have to be straight with you before anything else: our finishing line is committed through the season and we can only hold ${Math.round(brief.capacityRatio * 100)}% of this order.`,
    );
  }

  if (round === 1) {
    parts.push(
      `Thanks for putting ${supplier.name} in front of this. I have seen the ${money(brief.baselineTotal)} number you are working from, and I am not going to pretend we can match it line for line at our quality level.`,
      `What I can do on this first pass is take ${discount} off our opening prices and commit to ${offer.leadTimeDays} days.`,
    );
  } else if (round < MAX_ROUNDS) {
    parts.push(
      `Understood — you are shopping this properly, so let me move rather than argue.`,
      `I am now at ${discount} below where we opened, ${offer.leadTimeDays} days, and I can restructure payment to ${formatPaymentTerms(offer.paymentTerms)}.`,
    );
  } else {
    parts.push(
      `This is where I run out of road.`,
      `${discount} off our opening, ${offer.leadTimeDays} days, ${formatPaymentTerms(offer.paymentTerms)}. Below this I am selling at cost and I would rather lose the order than do that.`,
    );
  }

  if (offer.rebatePct > 0) {
    parts.push(`There is a ${offer.rebatePct}% volume rebate on top once you confirm the full quantity.`);
  }
  if (offer.freight > 0) {
    parts.push(`I will also put ${money(offer.freight)} a unit toward your freight, which is real money at ${brief.totalUnits.toLocaleString("en-US")} units.`);
  }

  if (brief.uncoveredByIncumbent.length > 0 && supplier.code !== "supplier_1") {
    parts.push(
      `One more thing worth saying: ${brief.uncoveredByIncumbent.slice(0, 2).join(" and ")} are lines your current supplier would not price at this volume. We will quote them.`,
    );
  }

  if (supplier.qualityRating >= 4.5) {
    parts.push(
      `On quality, we are a ${supplier.qualityRating.toFixed(1)} and that is the reason we are not the cheapest name on your list.`,
    );
  }

  return parts.join(" ");
}

export function offlineBrandOpening(brief: NegotiationBrief): string {
  const lines = [
    `We are placing ${brief.totalUnits.toLocaleString("en-US")} units across ${brief.lineCount} lines.`,
    brief.baselineLineCount < brief.lineCount
      ? `I am holding a quotation worth ${money(brief.baselineTotal)} on ${brief.baselineLineCount} of them.`
      : `I am holding a quotation worth ${money(brief.baselineTotal)} on all of them.`,
    `I am running the same basket past all three of you at once, so treat this as your best pass rather than an opening position.`,
  ];

  if (brief.priorities.length > 0) {
    lines.push(`What matters to us on this order, in order: ${brief.priorities.join(", then ")}.`);
  }
  if (brief.hardConstraints.length > 0) {
    lines.push(`These are not preferences: ${brief.hardConstraints.join("; ")}.`);
  }
  if (brief.uncoveredByIncumbent.length > 0) {
    lines.push(
      `Note that ${brief.uncoveredByIncumbent.length} line${brief.uncoveredByIncumbent.length === 1 ? " was" : "s were"} never priced at this volume by the incumbent, so there is business here that is genuinely open.`,
    );
  }
  lines.push(`I will judge this on landed cost, quality rating, lead time and how much of my cash the payment schedule ties up. Not on headline price alone.`);

  return lines.join(" ");
}

export function offlineBrandPush(brief: NegotiationBrief, round: number, standings: string[]): string {
  const lines = [
    round === 1
      ? `Thanks — I have all three offers side by side now.`
      : `Second pass. Here is where you each stand.`,
  ];
  if (standings.length > 0) lines.push(standings.join(" "));
  lines.push(
    `I am going back to each of you once more. The gap I am trying to close is ${brief.priorities[0] ?? "cost"}, so move there if you want this.`,
  );
  return lines.join(" ");
}

export function offlineCurveballNote(supplierName: string, ratio: number): string {
  return (
    `${supplierName} has come back mid-negotiation: they can only fulfil ${Math.round(ratio * 100)}% of the order. ` +
    `I am not restarting this — their offer stands on the volume they can actually ship, and I am re-scoring every plan with the shortfall priced in, ` +
    `including splitting the remainder to whoever can absorb it.`
  );
}
