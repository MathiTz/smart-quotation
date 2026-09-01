import { z } from "zod";
import { ANNUAL_DISCOUNT_RATE, type NegotiationConstraints, type ScoringWeights } from "./domain.js";
import type { Allocation, AllocationNote } from "./coverage.js";

/**
 * FOB is the price at the supplier's port; landed adds freight and duty. Amber's
 * quotation screen toggles between the two and so does ours, because comparing
 * a Vietnamese FOB price against a Chinese one is not comparing like with like.
 */
export const costBasisSchema = z.enum(["fob", "landed"]);
export type CostBasis = z.infer<typeof costBasisSchema>;

/**
 * Deliberately crude. Amber derives this from the bill of materials, origin,
 * destination and HTS code; `products.csv` carries none of that, so we estimate
 * per origin country. The scoring function takes landed cost as an input, so a
 * real calculator drops straight in here.
 */
export const COUNTRY_LANDED_COST: Record<string, { freightPerUnit: number; dutyRate: number }> = {
  TH: { freightPerUnit: 0.42, dutyRate: 0.082 },
  VN: { freightPerUnit: 0.38, dutyRate: 0.09 },
  CN: { freightPerUnit: 0.31, dutyRate: 0.135 },
  BD: { freightPerUnit: 0.3, dutyRate: 0.12 },
};

const DEFAULT_LANDED = { freightPerUnit: 0.4, dutyRate: 0.1 };

export function landedUnitCost(fobUnitPrice: number, country: string): number {
  const { freightPerUnit, dutyRate } = COUNTRY_LANDED_COST[country] ?? DEFAULT_LANDED;
  return fobUnitPrice * (1 + dutyRate) + freightPerUnit;
}

/**
 * Turns "40/60" into the cash schedule it implies. The first milestone is always
 * at order placement; the last lands on delivery; anything between is spread
 * across the production window. Lead time therefore changes what payment terms
 * are worth, which is why this is derived rather than stored.
 */
export function paymentMilestones(
  paymentTerms: string,
  leadTimeDays: number,
): Array<{ fraction: number; dayOffset: number }> {
  const parts = paymentTerms
    .split("/")
    .map((p) => Number(p.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  // Nothing parseable means nothing is known about the schedule. Treating that
  // as "100% upfront" is the conservative reading — it is the most expensive
  // schedule, so an unreadable term can never make an option look better than
  // one whose terms were actually stated.
  if (parts.length === 0) return [{ fraction: 1, dayOffset: 0 }];

  // A negative lead time would put milestones before the order was placed and
  // turn the cash-flow cost into a discount, which would rank paying early as an
  // advantage.
  const window = Number.isFinite(leadTimeDays) && leadTimeDays > 0 ? leadTimeDays : 0;

  const total = parts.reduce((a, b) => a + b, 0);
  return parts.map((part, i) => ({
    fraction: part / total,
    dayOffset: parts.length === 1 ? 0 : (i / (parts.length - 1)) * window,
  }));
}

/**
 * What it costs to pay before you receive the goods. Money handed over on day 0
 * for goods arriving on day L is capital tied up for L days. This is what makes
 * "100% upfront" genuinely worse than "40/60" rather than just less pleasant.
 */
// #region cash-flow
export function paymentCashFlowCost(
  amount: number,
  paymentTerms: string,
  leadTimeDays: number,
  annualRate: number = ANNUAL_DISCOUNT_RATE,
): number {
  // Both inputs are clamped to the range the formula is meaningful over, and
  // both failures are ones that would flip the sign of the result rather than
  // merely distort it. A negative lead time makes every milestone look late and
  // turns the cost into a discount — paying 100% upfront would then rank as an
  // advantage. A non-finite amount produces `Infinity * 0` on the milestone paid
  // at delivery, which is NaN, and a NaN here spreads to every option's score.
  const principal = Number.isFinite(amount) && amount > 0 ? amount : 0;
  const window = Number.isFinite(leadTimeDays) && leadTimeDays > 0 ? leadTimeDays : 0;
  if (principal === 0 || window === 0) return 0;

  return paymentMilestones(paymentTerms, window).reduce((cost, m) => {
    // Never negative: a milestone cannot fall after delivery, because the
    // offsets are spread across the window and capped by it.
    const daysEarly = Math.max(0, window - m.dayOffset);
    return cost + principal * m.fraction * annualRate * (daysEarly / 365);
  }, 0);
}
// #endregion cash-flow

/** A complete, already-priced way to buy the basket: one supplier or several. */
export const awardOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  allocations: z.array(z.custom<Allocation>()),
  notes: z.array(z.custom<AllocationNote>()).default([]),
  /** Units nobody could supply. Heavily penalised: an unfillable order is not a deal. */
  uncoveredQty: z.number().int().nonnegative().default(0),
  requestedQty: z.number().int().positive(),
});
export type AwardOption = z.infer<typeof awardOptionSchema>;

export type SupplierMeta = { country: string };

export const scoreBreakdownSchema = z.object({
  optionId: z.string(),
  label: z.string(),
  fobTotal: z.number(),
  landedTotal: z.number(),
  cashFlowCost: z.number(),
  /** What the brand actually gives up: landed cost plus the cost of paying early. */
  effectiveTotal: z.number(),
  leadTimeDays: z.number(),
  qualityRating: z.number(),
  supplierCount: z.number().int(),
  requestedQty: z.number().int(),
  coveredQty: z.number().int(),
  coverageRatio: z.number(),
  switchingPenalty: z.number(),
  disqualified: z.boolean(),
  disqualifiedReasons: z.array(z.string()).default([]),
  /** Each dimension normalised to 0..1 across the option set. Drives the UI's bars. */
  components: z.object({
    cost: z.number(),
    quality: z.number(),
    leadTime: z.number(),
    paymentTerms: z.number(),
  }),
  score: z.number(),
});
export type ScoreBreakdown = z.infer<typeof scoreBreakdownSchema>;

/** Charged per extra supplier: two counterparties is genuinely more work than one. */
export const SWITCHING_PENALTY_RATE = 0.015;

export function summariseOption(
  option: AwardOption,
  suppliers: Record<string, SupplierMeta>,
): Omit<ScoreBreakdown, "components" | "score" | "disqualified" | "disqualifiedReasons"> {
  let fobTotal = 0;
  let landedTotal = 0;
  let cashFlowCost = 0;
  let qualityWeighted = 0;
  let leadTimeDays = 0;

  for (const alloc of option.allocations) {
    const country = suppliers[alloc.supplierCode]?.country ?? "XX";
    let allocLanded = 0;
    for (const line of alloc.lines) {
      fobTotal += line.lineTotal;
      allocLanded += landedUnitCost(line.unitPrice, country) * line.quantity;
    }
    landedTotal += allocLanded;
    cashFlowCost += paymentCashFlowCost(allocLanded, alloc.paymentTerms, alloc.leadTimeDays);
    qualityWeighted += alloc.qualityRating * allocLanded;
    // You wait for the slowest supplier, not the average of them.
    leadTimeDays = Math.max(leadTimeDays, alloc.leadTimeDays);
  }

  const extraSuppliers = Math.max(0, option.allocations.length - 1);
  // Written as a conditional rather than `extraSuppliers * RATE * landedTotal`
  // because a single-supplier option multiplies by zero, and `0 * Infinity` is
  // NaN rather than 0. One corrupt price would then make every option's score
  // NaN, since the normalisation below spans the whole set.
  const switchingPenalty = extraSuppliers === 0 ? 0 : extraSuppliers * SWITCHING_PENALTY_RATE * landedTotal;

  // Clamped because a shortfall larger than the order would otherwise produce a
  // negative ratio, and the score is multiplied by it.
  const coveredQty = Math.max(0, Math.min(option.requestedQty, option.requestedQty - option.uncoveredQty));

  return {
    optionId: option.id,
    label: option.label,
    fobTotal,
    landedTotal,
    cashFlowCost,
    effectiveTotal: landedTotal + cashFlowCost + switchingPenalty,
    leadTimeDays,
    qualityRating: landedTotal > 0 ? qualityWeighted / landedTotal : 0,
    supplierCount: option.allocations.length,
    requestedQty: option.requestedQty,
    coveredQty,
    coverageRatio: option.requestedQty > 0 ? coveredQty / option.requestedQty : 0,
    switchingPenalty,
  };
}

/**
 * Best value maps to 1, worst to 0. A dimension with no spread scores neutral.
 *
 * Normalisation is the point in scoring where one bad number stops being one bad
 * option: `min` and `max` span the whole set, so a single NaN would make every
 * option's score NaN and the sort order arbitrary. Non-finite values are dropped
 * from the range, and a value that is itself non-finite scores neutral rather
 * than poisoning the comparison.
 */
// #region normalise
function normalise(values: number[], value: number, lowerIsBetter: boolean): number {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0 || !Number.isFinite(value)) return 0.5;

  const min = Math.min(...finite);
  const max = Math.max(...finite);
  if (max - min < 1e-9) return 0.5;

  // Clamped because `value` may sit outside the finite range when it was one of
  // the values excluded above.
  const t = Math.max(0, Math.min(1, (value - min) / (max - min)));
  return lowerIsBetter ? 1 - t : t;
}
// #endregion normalise

/**
 * Ranks complete award options. Deliberately a pure function: the agent explains
 * the ranking, it never computes it, which is what makes the reasoning testable
 * and the purchasing decision defensible.
 */
// #region score
export function scoreOptions(
  options: AwardOption[],
  suppliers: Record<string, SupplierMeta>,
  constraints: NegotiationConstraints,
): ScoreBreakdown[] {
  if (options.length === 0) return [];

  const summaries = options.map((o) => summariseOption(o, suppliers));

  const costs = summaries.map((s) => s.effectiveTotal);
  const qualities = summaries.map((s) => s.qualityRating);
  const leads = summaries.map((s) => s.leadTimeDays);
  const cashFlows = summaries.map((s) => s.cashFlowCost);

  const weights = redistributeWeights(constraints.weights, {
    cost: hasSpread(costs),
    quality: hasSpread(qualities),
    leadTime: hasSpread(leads),
    paymentTerms: hasSpread(cashFlows),
  });

  return summaries
    .map((summary): ScoreBreakdown => {
      const disqualifiedReasons: string[] = [];
      if (constraints.maxLeadTimeDays !== null && summary.leadTimeDays > constraints.maxLeadTimeDays) {
        disqualifiedReasons.push(
          `lead time ${summary.leadTimeDays} days exceeds the ${constraints.maxLeadTimeDays} day deadline`,
        );
      }
      if (constraints.minQualityRating !== null && summary.qualityRating < constraints.minQualityRating) {
        disqualifiedReasons.push(
          `quality ${summary.qualityRating.toFixed(2)} is below the required ${constraints.minQualityRating}`,
        );
      }
      if (constraints.maxTotalBudget !== null && summary.effectiveTotal > constraints.maxTotalBudget) {
        disqualifiedReasons.push(
          `effective total ${summary.effectiveTotal.toFixed(0)} exceeds the ${constraints.maxTotalBudget} budget`,
        );
      }
      if (constraints.singleSupplierOnly && summary.supplierCount > 1) {
        disqualifiedReasons.push("split awards were ruled out by the brand note");
      }

      const components = {
        cost: normalise(costs, summary.effectiveTotal, true) * weights.cost,
        quality: normalise(qualities, summary.qualityRating, false) * weights.quality,
        leadTime: normalise(leads, summary.leadTimeDays, true) * weights.leadTime,
        paymentTerms: normalise(cashFlows, summary.cashFlowCost, true) * weights.paymentTerms,
      };

      const base =
        components.cost + components.quality + components.leadTime + components.paymentTerms;

      return {
        ...summary,
        components,
        // Shortfall is scaled rather than disqualifying: covering 60% of the
        // order is worth something, just not as much as covering all of it.
        score: base * summary.coverageRatio,
        disqualified: disqualifiedReasons.length > 0,
        disqualifiedReasons,
      };
    })
    .sort((a, b) => {
      if (a.disqualified !== b.disqualified) return a.disqualified ? 1 : -1;
      return b.score - a.score;
    });
}
// #endregion score

function hasSpread(values: number[]): boolean {
  const finite = values.filter((v) => Number.isFinite(v));
  // `Math.max()` of nothing is -Infinity, and the subtraction below would then
  // report a spread on a dimension that has no usable values at all.
  if (finite.length === 0) return false;
  return Math.max(...finite) - Math.min(...finite) > 1e-9;
}

/**
 * A dimension every option ties on carries no information, so its weight is
 * redistributed proportionally across the rest. Taken from the Smart RFQ spec,
 * which does the same for missing supplier-efficiency dimensions.
 */
export function redistributeWeights(
  weights: ScoringWeights,
  available: Record<keyof ScoringWeights, boolean>,
): ScoringWeights {
  const keys = Object.keys(weights) as Array<keyof ScoringWeights>;
  const liveTotal = keys.reduce((sum, k) => sum + (available[k] ? weights[k] : 0), 0);
  // `!isFinite` covers the case where a weight arrived as Infinity: the division
  // below would be Infinity/Infinity, so every weight would come back NaN and no
  // option would be rankable. An even split is a defensible answer; NaN is not.
  if (!Number.isFinite(liveTotal) || liveTotal <= 0) {
    const even = 1 / keys.length;
    return { cost: even, quality: even, leadTime: even, paymentTerms: even };
  }
  const out = {} as ScoringWeights;
  for (const k of keys) out[k] = available[k] ? weights[k] / liveTotal : 0;
  return out;
}
