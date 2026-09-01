import type { NegotiationConstraints, SupplierOffer, SupplierProfile } from "@sq/shared";
import { MAX_ROUNDS, formatPaymentTerms } from "@sq/shared";

/**
 * Everything both sides are allowed to know. The brand's leverage is real (it
 * came out of the uploaded file) and the supplier's limits are real (they came
 * out of its profile), which is what keeps the transcript honest even though
 * both parties are the same model.
 */
export type NegotiationBrief = {
  supplierName: string;
  lineCount: number;
  totalUnits: number;
  /**
   * The incumbent's total for this basket: the number everyone is bidding
   * against. It covers `baselineLineCount` lines, which is fewer than
   * `lineCount` whenever the incumbent declined to price something at this
   * volume — quoting it against the full line count would overstate the
   * leverage the brand actually holds.
   */
  baselineTotal: number;
  baselineLineCount: number;
  openingTotal: number;
  openingLeadTimeDays: number;
  openingPaymentTerms: string;
  incumbentLeadTimeDays: number;
  incumbentPaymentTerms: string;
  /** SKUs the incumbent would not price at this volume. Open business. */
  uncoveredByIncumbent: string[];
  priorities: string[];
  hardConstraints: string[];
  brandNote: string;
  capacityRatio: number;
  /** How the brand ranked everyone after the previous round. */
  standings: string[];
};

export function supplierSystemPrompt(supplier: SupplierProfile): string {
  return [
    `You are the sales lead for ${supplier.name}, a garment factory in ${supplier.country}.`,
    `You are negotiating one order with a brand's sourcing team. You want this order, but not at any price.`,
    "",
    "How you behave:",
    "- You never simply accept or refuse. You look for a shape of deal that wins the business.",
    "- Price is only one lever. You also have lead time, payment terms, volume rebates and freight allowances.",
    "- You have a real cost floor. When you reach it you say so plainly and hold, rather than inventing a discount.",
    `- Your quality rating is ${supplier.qualityRating.toFixed(1)} out of 5. ${
      supplier.qualityRating >= 4.5
        ? "You are the premium option and you argue on total cost of ownership, not headline price."
        : supplier.qualityRating < 4
          ? "You are the new entrant on this list. You are not the finest factory, and you do not pretend to be: you win by being the cheapest credible option and by being the most flexible on terms, because you need this volume to establish yourself. You move further and faster than the established factories, and you say so plainly."
          : "You compete on responsiveness and price rather than on being the finest factory on the list."
    }`,
    "",
    "Write like a person who does this for a living: direct, specific, a few sentences.",
    "No bullet points, no headings, no marketing language. Name the numbers you are moving.",
  ].join("\n");
}

export function supplierTurnPrompt(
  brief: NegotiationBrief,
  round: number,
  previous: SupplierOffer | null,
): string {
  const lines = [
    `Round ${round} of at most ${MAX_ROUNDS}.`,
    "",
    `The order: ${brief.lineCount} lines, ${brief.totalUnits.toLocaleString("en-US")} units.`,
    `The brand is holding a competing quotation worth $${brief.baselineTotal.toLocaleString("en-US", { maximumFractionDigits: 0 })} across ${brief.baselineLineCount} of those lines, at ${brief.incumbentLeadTimeDays} days on ${formatPaymentTerms(brief.incumbentPaymentTerms)}.`,
    `Your current offer stands at $${brief.openingTotal.toLocaleString("en-US", { maximumFractionDigits: 0 })}, ${brief.openingLeadTimeDays} days, ${formatPaymentTerms(brief.openingPaymentTerms)}.`,
  ];

  if (brief.brandNote) lines.push(`The brand said: "${brief.brandNote}"`);
  if (brief.priorities.length > 0) lines.push(`They care most about: ${brief.priorities.join(", then ")}.`);
  if (brief.hardConstraints.length > 0) lines.push(`Non-negotiable for them: ${brief.hardConstraints.join("; ")}.`);
  if (brief.standings.length > 0) lines.push(`Where you stand: ${brief.standings.join(" ")}`);

  if (brief.capacityRatio < 1) {
    lines.push(
      `You have just discovered you can only fulfil ${Math.round(brief.capacityRatio * 100)}% of this order. Lead with that honestly, then argue for why they should still give you that share.`,
    );
  }

  if (brief.uncoveredByIncumbent.length > 0) {
    lines.push(
      `The incumbent did not price these lines at this volume: ${brief.uncoveredByIncumbent.join(", ")}. That is open business you can take.`,
    );
  }

  if (previous) {
    lines.push(
      `Last round you offered ${((1 - previous.priceFactor) * 100).toFixed(1)}% off, ${previous.leadTimeDays} days, ${formatPaymentTerms(previous.paymentTerms)}. You cannot go backwards from that.`,
    );
  }

  lines.push(
    "",
    "priceFactor is a multiplier on your own opening prices: 0.92 means you have taken 8% off. 1.0 means no movement.",
    round === MAX_ROUNDS
      ? "This is the final round. Give your genuine best and say that it is final."
      : "Leave yourself somewhere to go in later rounds.",
    "",
    OUTPUT_CONTRACT,
  );

  return lines.join("\n");
}

/**
 * The response shape, spelled out in the prompt as well as in the schema.
 *
 * It is redundant against providers that enforce a JSON schema, and it is the
 * only thing that works against providers that do not. Ollama Cloud accepts
 * `response_format: json_schema` and its native `format` field, and honours
 * neither: asked for this object without being told the key names, it returns a
 * formatted business letter. The model can produce the right object — it just
 * has to be told what the keys are, in the one channel that always arrives.
 *
 * Costs a few dozen tokens per turn against providers that did not need it, and
 * buys a negotiation that is actually driven by a model rather than quietly
 * falling back to the offline stubs.
 */
const OUTPUT_CONTRACT = [
  "Reply with a single JSON object and nothing else. No prose before or after it, no markdown fence.",
  "It has exactly these keys:",
  '  "priceFactor": number between 0.5 and 1',
  '  "leadTimeDays": whole number of days between 1 and 365',
  '  "paymentTerms": string, a milestone split such as "30/70" or "33/33/33"',
  '  "rebatePct": number between 0 and 50',
  '  "freightAllowancePerUnit": number between 0 and 5',
  '  "concessions": array of at most 6 objects, each {"kind": one of price | lead_time | payment_terms | volume_rebate | freight_allowance | capacity_guarantee, "description": short chip label under 64 characters}',
  '  "message": your negotiating message to the brand, between 20 and 1200 characters',
  "",
  'Write "message" the way a sales lead writes to a customer. Never name a field from this',
  'contract in it: say "a 6% price reduction", not "priceFactor 0.94".',
].join("\n");

export const BRAND_SYSTEM_PROMPT = [
  "You are the sourcing lead for an apparel brand, running a competitive negotiation against three factories at once.",
  "",
  "You have a quotation from the incumbent supplier and you are using it as leverage.",
  "You know each supplier's quality rating and you factor it in: the cheapest unit price is not the cheapest order.",
  "",
  "You do not compute the ranking. It is given to you, already scored on landed cost, quality, lead time and the cash-flow cost of payment terms.",
  "Your job is to explain it in plain English and to push each supplier where they have room.",
  "",
  "Write like a buyer talking to their own team: direct, specific, no marketing language, no bullet points.",
].join("\n");

export function brandOpeningPrompt(brief: NegotiationBrief): string {
  return [
    `Open the negotiation. You are sending this to all three suppliers at once.`,
    "",
    `The order: ${brief.lineCount} lines, ${brief.totalUnits.toLocaleString("en-US")} units.`,
    `The incumbent's quotation totals $${brief.baselineTotal.toLocaleString("en-US", { maximumFractionDigits: 0 })} across ${brief.baselineLineCount} of those lines, at ${brief.incumbentLeadTimeDays} days on ${formatPaymentTerms(brief.incumbentPaymentTerms)}.`,
    brief.brandNote ? `Your own instruction for this order: "${brief.brandNote}"` : "",
    brief.priorities.length > 0 ? `Your priorities in order: ${brief.priorities.join(", then ")}.` : "",
    brief.hardConstraints.length > 0 ? `Hard limits: ${brief.hardConstraints.join("; ")}.` : "",
    brief.uncoveredByIncumbent.length > 0
      ? `These lines were never priced at this volume by the incumbent: ${brief.uncoveredByIncumbent.join(", ")}. Say so — it is leverage.`
      : "",
    "",
    "Three or four sentences. State the volume, the number you are working from, and what you will judge on.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function brandVerdictPrompt(
  brief: NegotiationBrief,
  winnerLabel: string,
  reasoningBullets: string[],
  rejected: string[],
): string {
  return [
    `The negotiation is over. The scoring picked: ${winnerLabel}.`,
    "",
    "Why it won, from the scoring:",
    ...reasoningBullets.map((b) => `- ${b}`),
    "",
    "What lost:",
    ...rejected.map((r) => `- ${r}`),
    brief.capacityRatio < 1
      ? "\nOne supplier capped their capacity part-way through and the plans were re-scored with that shortfall priced in."
      : "",
    "",
    "Explain this decision to your own team in four or five sentences.",
    "Use these exact figures. Do not introduce numbers that are not above.",
    "Say plainly what you gave up by not choosing the runner-up.",
  ]
    .filter(Boolean)
    .join("\n");
}
