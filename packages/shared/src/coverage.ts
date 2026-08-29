import { z } from "zod";

/**
 * A supplier can fail to cover the order through four different doors, and they
 * are all the same fact. Modelling them as one reason code is what lets the
 * Supplier 2 curveball reuse the logic that already ran in round one, instead of
 * getting its own special case.
 */
export const coverageReasonSchema = z.enum([
  "quoted", // fully covered
  "no_price_at_tier", // the sheet priced this SKU at 1000 but not at 5000
  "capacity_limited", // announced mid-negotiation ("we can only do 60%")
  "unmatched_sku", // never matched the catalog, so we cannot responsibly buy it
  "declined", // the supplier refused this line during negotiation
]);
export type CoverageReason = z.infer<typeof coverageReasonSchema>;

export const lineCoverageSchema = z.object({
  sku: z.string(),
  requestedQty: z.number().int().nonnegative(),
  /** 0 means no coverage at all. */
  offeredQty: z.number().int().nonnegative(),
  /** Null exactly when offeredQty is 0. Never 0, which would read as "free". */
  unitPrice: z.number().nonnegative().nullable(),
  reason: coverageReasonSchema,
});
export type LineCoverage = z.infer<typeof lineCoverageSchema>;

export const basketLineSchema = z.object({
  /** The catalog SKU, or the spreadsheet's spelling when it never matched. */
  sku: z.string(),
  rawSku: z.string(),
  productName: z.string().nullable(),
  quantity: z.number().int().positive(),
  /** Supplier 1's price from the uploaded file: the baseline everyone negotiates against. */
  baselineUnitPrice: z.number().nonnegative(),
  /**
   * Unmatched lines stay in the basket rather than being dropped at the door, so
   * the shortfall they cause is reported by the same coverage vector that
   * reports a capacity limit. One mechanism, four reasons.
   */
  matched: z.boolean().default(true),
  /**
   * True when the incumbent never priced this line at the chosen volume and the
   * baseline was projected from the tier they did quote. The rival suppliers are
   * being asked fresh, so they can still bid it — which is precisely why the gap
   * is leverage rather than a dead line.
   */
  baselineExtrapolated: z.boolean().default(false),
});
export type BasketLine = z.infer<typeof basketLineSchema>;

export const basketSchema = z.object({
  lines: z.array(basketLineSchema),
  tierQuantity: z.number().int().positive(),
  currency: z.string().default("USD"),
});
export type Basket = z.infer<typeof basketSchema>;

export const supplierCoverageSchema = z.object({
  supplierCode: z.string(),
  lines: z.array(lineCoverageSchema),
});
export type SupplierCoverage = z.infer<typeof supplierCoverageSchema>;

/** One supplier's committed share of the basket. Each allocation becomes exactly one PO. */
export const allocationSchema = z.object({
  supplierCode: z.string(),
  /**
   * Identifies the commit intent. Today it is just the supplier code; adding a
   * split dimension later (delivery window, season) only changes how this is
   * composed, which is what keeps N POs per supplier reachable without a migration.
   */
  allocationKey: z.string(),
  lines: z.array(
    z.object({
      sku: z.string(),
      productName: z.string().nullable(),
      quantity: z.number().int().positive(),
      unitPrice: z.number().nonnegative(),
      lineTotal: z.number().nonnegative(),
    }),
  ),
  subtotal: z.number().nonnegative(),
  leadTimeDays: z.number().int().positive(),
  paymentTerms: z.string(),
  qualityRating: z.number().min(0).max(5),
});
export type Allocation = z.infer<typeof allocationSchema>;

/** Why a line could not be split. Recorded and shown, never thrown. */
export const allocationNoteSchema = z.object({
  sku: z.string(),
  kind: z.enum(["moq_repair", "split_infeasible", "uncovered", "single_supplier"]),
  message: z.string(),
});
export type AllocationNote = z.infer<typeof allocationNoteSchema>;

export const allocationPlanSchema = z.object({
  allocations: z.array(allocationSchema),
  notes: z.array(allocationNoteSchema).default([]),
  /** Lines nobody could supply. Excluded from every PO. */
  uncovered: z.array(lineCoverageSchema).default([]),
});
export type AllocationPlan = z.infer<typeof allocationPlanSchema>;

export function basketTotal(basket: Basket): number {
  return basket.lines.reduce((sum, l) => sum + l.quantity * l.baselineUnitPrice, 0);
}

export function coveredQty(coverage: SupplierCoverage): number {
  return coverage.lines.reduce((sum, l) => sum + l.offeredQty, 0);
}

export function requestedQty(coverage: SupplierCoverage): number {
  return coverage.lines.reduce((sum, l) => sum + l.requestedQty, 0);
}

/** 1.0 when the supplier can ship everything. Used for display and for ranking. */
export function coverageRatio(coverage: SupplierCoverage): number {
  const requested = requestedQty(coverage);
  return requested === 0 ? 0 : coveredQty(coverage) / requested;
}
