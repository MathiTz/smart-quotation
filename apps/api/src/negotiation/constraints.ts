import { DEFAULT_WEIGHTS, type NegotiationConstraints, type ScoringWeights } from "@sq/shared";

type Dimension = keyof ScoringWeights;

const DIMENSION_WORDS: Record<Dimension, RegExp> = {
  cost: /\b(cost|price|cheap|budget|spend|savings?|margin)\b/i,
  quality: /\b(quality|defects?|returns?|craftsmanship|reliability)\b/i,
  leadTime: /\b(lead ?time|speed|fast|quick|deadline|delivery|urgent|rush|on ?time)\b/i,
  paymentTerms: /\b(payment|terms|cash ?flow|upfront|deposit|working capital)\b/i,
};

/** "prioritise X over Y" is the phrasing the brief itself uses, so it is handled literally. */
const OVER = /\b(?:prioriti[sz]e|favou?r|weight|prefer)\s+(.{3,40}?)\s+over\s+(.{3,40}?)(?:[.,;]|$)/gi;

const EMPHASIS = /\b(?:prioriti[sz]e|focus on|maximi[sz]e|minimi[sz]e|care about|important)\b/i;

function dimensionIn(text: string): Dimension | null {
  for (const [dimension, pattern] of Object.entries(DIMENSION_WORDS) as Array<[Dimension, RegExp]>) {
    if (pattern.test(text)) return dimension;
  }
  return null;
}

function normalise(weights: ScoringWeights): ScoringWeights {
  const total = weights.cost + weights.quality + weights.leadTime + weights.paymentTerms;
  if (total <= 0) return { ...DEFAULT_WEIGHTS };
  return {
    cost: weights.cost / total,
    quality: weights.quality / total,
    leadTime: weights.leadTime / total,
    paymentTerms: weights.paymentTerms / total,
  };
}

/**
 * Reads the brand's free-text note into the two things the system can act on:
 * what to weight, and what is non-negotiable.
 *
 * Deterministic on purpose. The note steers how the brand's money is spent, so
 * the same sentence has to produce the same weights every time, and the user has
 * to be able to see what was understood — which is why the result is echoed back
 * in the UI rather than kept in a prompt.
 */
// #region note-parse
export function parseBrandNote(note: string): NegotiationConstraints {
  const weights: ScoringWeights = { ...DEFAULT_WEIGHTS };
  let maxLeadTimeDays: number | null = null;
  let minQualityRating: number | null = null;
  let maxTotalBudget: number | null = null;
  let singleSupplierOnly = false;

  const text = note.trim();

  for (const match of text.matchAll(OVER)) {
    const winner = dimensionIn(match[1]!);
    const loser = dimensionIn(match[2]!);
    if (winner) weights[winner] *= 2.5;
    if (loser) weights[loser] *= 0.5;
  }

  // A bare mention is a nudge; a mention next to "prioritise" is a shove.
  if (EMPHASIS.test(text)) {
    for (const [dimension, pattern] of Object.entries(DIMENSION_WORDS) as Array<[Dimension, RegExp]>) {
      if (pattern.test(text)) weights[dimension] *= 1.5;
    }
  }

  const deadline =
    /\b(\d{1,3})\s*[- ]?(?:day|days)\b[^.]{0,20}?\b(?:deadline|max|maximum|limit|or less|latest)\b/i.exec(text) ??
    /\b(?:within|under|no more than|less than|max(?:imum)?(?: of)?)\s*(\d{1,3})\s*(?:day|days)\b/i.exec(text) ??
    /\b(?:deadline|lead ?time)\b[^.]{0,20}?(\d{1,3})\s*(?:day|days)\b/i.exec(text);
  if (deadline) {
    const days = Number(deadline[1]);
    if (days > 0 && days <= 720) maxLeadTimeDays = days;
  }

  const quality = /\b(?:quality|rating)\b[^.]{0,25}?\b(?:at least|minimum|min|above|over|no less than)\s*([0-5](?:\.\d)?)/i.exec(text)
    ?? /\b(?:at least|minimum|min)\s*([0-5](?:\.\d)?)\s*(?:star|rating|quality)/i.exec(text);
  if (quality) {
    const rating = Number(quality[1]);
    if (rating > 0 && rating <= 5) minQualityRating = rating;
  }

  const budget = /(?:budget|cap|under|below|no more than|max(?:imum)?)\D{0,12}\$?\s*([\d,]+(?:\.\d+)?)\s*(k|m)?/i.exec(text);
  if (budget) {
    const magnitude = budget[2]?.toLowerCase();
    const value = Number(budget[1]!.replace(/,/g, "")) * (magnitude === "k" ? 1_000 : magnitude === "m" ? 1_000_000 : 1);
    // Ignore small numbers, which are far more often a day count than a budget.
    if (Number.isFinite(value) && value >= 1000) maxTotalBudget = value;
  }

  if (/\b(?:single|one|sole)\s+(?:supplier|vendor|source)\b|\bno\s+(?:split|splits|splitting)\b|\bdo not split\b/i.test(text)) {
    singleSupplierOnly = true;
  }

  return {
    maxLeadTimeDays,
    minQualityRating,
    maxTotalBudget,
    singleSupplierOnly,
    weights: normalise(weights),
    notes: text,
  };
}
// #endregion note-parse

/** What the UI echoes back so the user can see how their sentence was read. */
export function describeConstraints(constraints: NegotiationConstraints): string[] {
  const out: string[] = [];
  const w = constraints.weights;
  const ranked = (Object.entries(w) as Array<[Dimension, number]>).sort((a, b) => b[1] - a[1]);
  const label: Record<Dimension, string> = {
    cost: "cost",
    quality: "quality",
    leadTime: "lead time",
    paymentTerms: "payment terms",
  };

  out.push(`Weighting ${ranked.map(([d, v]) => `${label[d]} ${Math.round(v * 100)}%`).join(", ")}`);
  if (constraints.maxLeadTimeDays !== null) out.push(`Hard deadline: ${constraints.maxLeadTimeDays} days`);
  if (constraints.minQualityRating !== null) out.push(`Minimum quality: ${constraints.minQualityRating}`);
  if (constraints.maxTotalBudget !== null) {
    out.push(`Budget ceiling: $${constraints.maxTotalBudget.toLocaleString("en-US")}`);
  }
  if (constraints.singleSupplierOnly) out.push("Split awards are not allowed");
  return out;
}
