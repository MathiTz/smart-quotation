import { z } from "zod";

/**
 * Payment terms are stored as the milestone split the industry writes them as
 * ("40/60", "33/33/33", "100") because that is what a buyer signs. The cash
 * timing each milestone implies is derived at scoring time by
 * `paymentMilestones`, since it depends on the lead time being negotiated.
 */
export const paymentTermsSchema = z
  .string()
  .regex(/^\d{1,3}(\/\d{1,3})*$/, 'payment terms must look like "40/60", "33/33/33" or "100"');

export const supplierProfileSchema = z.object({
  code: z.enum(["supplier_1", "supplier_2", "supplier_3"]),
  name: z.string(),
  country: z.string().length(2),
  qualityRating: z.number().min(0).max(5),
  leadTimeDays: z.number().int().positive(),
  paymentTerms: paymentTermsSchema,
  /** Multiplier applied to the parsed baseline to derive this supplier's opening price. */
  openingMultiplier: z.number().positive(),
  /** Fraction of its own opening price below which the agent may never go. */
  floorRatio: z.number().min(0).max(1),
  /**
   * The rest of the concession space. Suppliers who can only move on price have
   * two moves, accept or refuse, which is exactly the behaviour the brief rules
   * out. Every lever below is also a scoring dimension, so a concession changes
   * the ranking through the same arithmetic a discount would.
   */
  minLeadTimeDays: z.number().int().positive(),
  bestPaymentTerms: paymentTermsSchema,
  maxRebatePct: z.number().min(0).max(50),
  maxFreightAllowancePerUnit: z.number().min(0),
  /**
   * Minimum order quantity per line. Invented, because `products.csv` carries no
   * MOQ, but it is what makes a split award interesting: you cannot give a
   * supplier 200 units of a line they will not run below 500.
   */
  moqPerLine: z.number().int().nonnegative(),
});
export type SupplierProfile = z.infer<typeof supplierProfileSchema>;

export const lineItemSchema = z.object({
  sku: z.string(),
  productName: z.string().nullable(),
  quantity: z.number().int().nonnegative(),
  unitPrice: z.number().nonnegative(),
});
export type LineItem = z.infer<typeof lineItemSchema>;

export const offerSchema = z.object({
  supplierCode: z.string(),
  supplierName: z.string(),
  qualityRating: z.number().min(0).max(5),
  leadTimeDays: z.number().int().positive(),
  paymentTerms: paymentTermsSchema,
  lineItems: z.array(lineItemSchema),
  /** 1 = can ship the whole order. 0.6 = the Supplier 2 curveball. */
  fulfillmentRatio: z.number().min(0).max(1).default(1),
});
export type Offer = z.infer<typeof offerSchema>;

export const scoringWeightsSchema = z.object({
  cost: z.number().min(0),
  quality: z.number().min(0),
  leadTime: z.number().min(0),
  paymentTerms: z.number().min(0),
});
export type ScoringWeights = z.infer<typeof scoringWeightsSchema>;

export const DEFAULT_WEIGHTS: ScoringWeights = {
  cost: 0.4,
  quality: 0.25,
  leadTime: 0.2,
  paymentTerms: 0.15,
};

/**
 * Hard limits the brand user typed into the guidance note. A violated hard
 * constraint disqualifies an offer outright rather than just penalising it,
 * because "30 day deadline" is not a preference.
 */
export const negotiationConstraintsSchema = z.object({
  maxLeadTimeDays: z.number().int().positive().nullable().default(null),
  minQualityRating: z.number().min(0).max(5).nullable().default(null),
  maxTotalBudget: z.number().positive().nullable().default(null),
  /** Forbid split awards even when a supplier cannot fulfil the whole order. */
  singleSupplierOnly: z.boolean().default(false),
  weights: scoringWeightsSchema.default(DEFAULT_WEIGHTS),
  /** Free-text residue passed verbatim into the brand agent's prompt. */
  notes: z.string().default(""),
});
export type NegotiationConstraints = z.infer<typeof negotiationConstraintsSchema>;

export const DEFAULT_CONSTRAINTS: NegotiationConstraints = negotiationConstraintsSchema.parse({});

/** Annual discount rate used to price the cash-flow value of payment terms. */
export const ANNUAL_DISCOUNT_RATE = 0.12;

/**
 * Quality, lead time and payment terms come straight from the brief. The
 * multipliers encode its price ordering (Supplier 1 cheapest, Supplier 2 most
 * expensive, Supplier 3 in between) and the floors are how far each will
 * actually go, which is the number the agent is never told.
 */
// #region profiles
export const SUPPLIER_PROFILES: readonly SupplierProfile[] = [
  {
    code: "supplier_1",
    name: "Incumbent (uploaded quotation)",
    country: "TH",
    qualityRating: 4.0,
    leadTimeDays: 50,
    paymentTerms: "33/33/33",
    openingMultiplier: 1.0,
    // Already the cheapest, so it has the least room and defends on price alone.
    floorRatio: 0.93,
    minLeadTimeDays: 40,
    bestPaymentTerms: "30/40/30",
    maxRebatePct: 3,
    maxFreightAllowancePerUnit: 0.05,
    moqPerLine: 500,
  },
  // #endregion profiles
  {
    code: "supplier_2",
    name: "Meridian Apparel Group",
    country: "VN",
    qualityRating: 4.7,
    leadTimeDays: 25,
    paymentTerms: "40/60",
    openingMultiplier: 1.25,
    // Starts expensive, so it has the most room to give and the most to prove.
    floorRatio: 0.84,
    minLeadTimeDays: 21,
    bestPaymentTerms: "25/75",
    maxRebatePct: 6,
    maxFreightAllowancePerUnit: 0.18,
    moqPerLine: 750,
  },
  {
    code: "supplier_3",
    name: "Kunshan Rapid Manufacturing",
    country: "CN",
    qualityRating: 4.0,
    leadTimeDays: 15,
    paymentTerms: "100",
    openingMultiplier: 1.12,
    floorRatio: 0.88,
    minLeadTimeDays: 12,
    // Its weakest dimension, so it is where it concedes first.
    bestPaymentTerms: "50/50",
    maxRebatePct: 5,
    maxFreightAllowancePerUnit: 0.12,
    moqPerLine: 300,
  },
];

/** "100" on its own reads as a percentage sign short of meaning, so it gets words. */
export function formatPaymentTerms(terms: string): string {
  return terms.includes("/") ? terms : `${terms}% upfront`;
}

export function supplierProfile(code: string): SupplierProfile {
  const found = SUPPLIER_PROFILES.find((s) => s.code === code);
  if (!found) throw new Error(`unknown supplier code: ${code}`);
  return found;
}
