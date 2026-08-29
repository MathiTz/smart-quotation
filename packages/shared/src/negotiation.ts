import { z } from "zod";
import { paymentTermsSchema } from "./domain.js";
import { allocationPlanSchema } from "./coverage.js";
import { scoreBreakdownSchema } from "./scoring.js";

export const negotiationStatusSchema = z.enum([
  "pending",
  "negotiating",
  "suspended", // awaiting the curveball, or any other injected fact
  "scoring",
  "awaiting_conversion", // the award lives here
  "converted",
  "failed",
]);
export type NegotiationStatus = z.infer<typeof negotiationStatusSchema>;

/**
 * The levers a supplier may trade against price. The brief requires suppliers to
 * "find ways to win the deal" rather than accept or reject, and a price-only
 * agent has exactly two moves: capitulate or refuse. Every lever here is already
 * a dimension in the scoring function, so a concession moves the ranking through
 * the same arithmetic as a discount.
 */
export const concessionSchema = z.object({
  kind: z.enum([
    "price",
    "lead_time",
    "payment_terms",
    "volume_rebate",
    "freight_allowance",
    "capacity_guarantee",
  ]),
  description: z.string(),
});
export type Concession = z.infer<typeof concessionSchema>;

/** What a supplier agent is allowed to promise. Enforced in code, never by prompt. */
export const concessionBoundsSchema = z.object({
  floorRatio: z.number().min(0).max(1),
  minLeadTimeDays: z.number().int().positive(),
  bestPaymentTerms: paymentTermsSchema,
  maxRebatePct: z.number().min(0).max(50),
  maxFreightAllowancePerUnit: z.number().min(0),
});
export type ConcessionBounds = z.infer<typeof concessionBoundsSchema>;

export const supplierOfferSchema = z.object({
  supplierCode: z.string(),
  round: z.number().int().positive(),
  /** Multiplier on this supplier's own opening price. 0.92 means a cut of 8%. */
  priceFactor: z.number().positive(),
  leadTimeDays: z.number().int().positive(),
  paymentTerms: paymentTermsSchema,
  rebatePct: z.number().min(0).max(50).default(0),
  freightAllowancePerUnit: z.number().min(0).default(0),
  fulfillmentRatio: z.number().min(0).max(1).default(1),
  concessions: z.array(concessionSchema).default([]),
  /** The argument, in English. Required: a transcript of numbers is not a negotiation. */
  message: z.string().min(1),
  /** Set when a bound was hit and the offer was clamped back into legality. */
  clamped: z.array(z.string()).default([]),
});
export type SupplierOffer = z.infer<typeof supplierOfferSchema>;

export const roundActorSchema = z.enum(["brand", "supplier", "system"]);
export type RoundActor = z.infer<typeof roundActorSchema>;

export const negotiationRoundSchema = z.object({
  round: z.number().int().nonnegative(),
  actor: roundActorSchema,
  supplierCode: z.string().nullable(),
  message: z.string(),
  offer: supplierOfferSchema.nullable().default(null),
  offeredAt: z.string(),
});
export type NegotiationRound = z.infer<typeof negotiationRoundSchema>;

export const awardSchema = z.object({
  plan: allocationPlanSchema,
  winningOptionId: z.string(),
  label: z.string(),
  /**
   * Every plan that was considered, scored. Kept on the award so the comparison
   * the brand sees is the one the decision was actually made from, rather than a
   * second calculation done at render time that could disagree with it.
   */
  scores: z.array(scoreBreakdownSchema).default([]),
  /** Amber-style explainability tree, rendered as nested bullets in the UI. */
  reasoning: z.object({
    headline: z.string(),
    bullets: z.array(z.string()),
    runnerUp: z.string().nullable().default(null),
    rejected: z.array(z.string()).default([]),
  }),
});
export type Award = z.infer<typeof awardSchema>;

export const MAX_ROUNDS = 3;
export const CURVEBALL_AFTER_ROUND = 1;
export const SUPPLIER_2_CURVEBALL_RATIO = 0.6;
