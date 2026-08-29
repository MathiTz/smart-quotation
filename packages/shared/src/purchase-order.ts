import { z } from "zod";

/**
 * `draft` and `sent` differ only in whether the supplier has been told. Both have
 * frozen terms; a draft is not a scratchpad. The primary Convert action goes
 * straight to `sent` because the brief calls the list "POs the brand has issued".
 *
 * Those two are the only reachable values. `acknowledged` onwards are the states
 * this order will pass through elsewhere — the supplier replying, the factory
 * reporting — and are declared so the type matches the domain rather than the
 * subset of it we drive. Nothing in this codebase sets them.
 */
export const poStatusSchema = z.enum([
  "draft",
  "sent",
  "acknowledged",
  "in_production",
  "fulfilled",
  "cancelled",
]);
export type PoStatus = z.infer<typeof poStatusSchema>;

export const poLineSchema = z.object({
  sku: z.string(),
  productName: z.string().nullable(),
  quantity: z.number().int().positive(),
  unitCostFinal: z.number().nonnegative(),
  lineTotal: z.number().nonnegative(),
});
export type PoLine = z.infer<typeof poLineSchema>;

/**
 * What was agreed, frozen at commit time. A purchase order that reads its terms
 * back from a mutable negotiation is not a commitment.
 */
export const termsSnapshotSchema = z.object({
  supplierCode: z.string(),
  supplierName: z.string(),
  country: z.string(),
  qualityRating: z.number(),
  leadTimeDays: z.number().int().positive(),
  paymentTerms: z.string(),
  currency: z.string(),
  subtotal: z.number().nonnegative(),
  landedTotal: z.number().nonnegative(),
  lines: z.array(poLineSchema),
  agreedAt: z.string(),
  negotiationRounds: z.number().int().nonnegative(),
  concessions: z.array(z.string()).default([]),
  /**
   * Which plan was bought, and which one the system put forward. They differ when
   * a buyer overrules the recommendation, which is allowed — the ranking encodes
   * stated priorities, not the ones nobody wrote down — but an order that departs
   * from the advice has to say so on its face rather than in someone's memory.
   *
   * Optional because orders committed before the override existed have neither,
   * and a snapshot is frozen: back-filling it would be inventing a record.
   */
  chosenOptionId: z.string().optional(),
  recommendedOptionId: z.string().optional(),
});
export type TermsSnapshot = z.infer<typeof termsSnapshotSchema>;

/**
 * Fired on convert (all of them) or split across convert and confirm when the
 * PO is saved as a draft first. `internal` effects bind the brand; `supplier_facing`
 * ones leave the building.
 */
export const outboxStageSchema = z.enum(["internal", "supplier_facing"]);
export type OutboxStage = z.infer<typeof outboxStageSchema>;

export const outboxEventTypeSchema = z.enum([
  "reserve_capacity",
  "schedule_payment_tranches",
  "notify_internal_approvers",
  "notify_supplier",
  "sync_accounting",
]);
export type OutboxEventType = z.infer<typeof outboxEventTypeSchema>;

export const OUTBOX_STAGE_BY_EVENT: Record<OutboxEventType, OutboxStage> = {
  reserve_capacity: "internal",
  schedule_payment_tranches: "internal",
  notify_internal_approvers: "internal",
  notify_supplier: "supplier_facing",
  sync_accounting: "supplier_facing",
};

export const outboxStatusSchema = z.enum(["pending", "sent", "failed"]);
export type OutboxStatus = z.infer<typeof outboxStatusSchema>;

export const purchaseOrderSchema = z.object({
  id: z.string(),
  poNumber: z.string(),
  negotiationId: z.string(),
  supplierCode: z.string(),
  supplierName: z.string(),
  allocationKey: z.string(),
  status: poStatusSchema,
  currency: z.string(),
  subtotal: z.number().nonnegative(),
  total: z.number().nonnegative(),
  leadTimeQuotedDays: z.number().int().positive(),
  paymentTerms: z.string(),
  termsSnapshot: termsSnapshotSchema,
  createdAt: z.string(),
  lines: z.array(poLineSchema).default([]),
  effects: z
    .array(
      z.object({
        eventType: outboxEventTypeSchema,
        stage: outboxStageSchema,
        status: outboxStatusSchema,
        attempts: z.number().int().nonnegative(),
        detail: z.string().nullable().default(null),
      }),
    )
    .default([]),
});
export type PurchaseOrder = z.infer<typeof purchaseOrderSchema>;

export const convertRequestSchema = z.object({
  idempotencyKey: z.string().min(8),
  /** false issues immediately (the primary path); true stops at draft for internal approval. */
  saveAsDraft: z.boolean().default(false),
  /** Buy a plan other than the recommended one. Omitted means the recommendation. */
  optionId: z.string().optional(),
});
export type ConvertRequest = z.infer<typeof convertRequestSchema>;

/**
 * Keyed on the commit intent rather than the supplier, which is what allows a
 * split award to write several POs and would allow several POs per supplier
 * later without touching the schema.
 */
export function idempotencySeed(
  negotiationId: string,
  allocationKey: string,
  termsHash: string,
): string {
  return `${negotiationId}:${allocationKey}:${termsHash}`;
}
