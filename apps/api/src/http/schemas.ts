/**
 * Response schemas for the OpenAPI document.
 *
 * These exist because every route used to answer `z.any()`, which meant the spec
 * described no response body anywhere — `/docs` showed two components, one of
 * which was `z.any()` with a name attached. A spec that documents nothing is
 * worse than no spec, because the README promised it "cannot describe a response
 * the code does not return".
 *
 * Each one is `satisfies Describes<T>` against the type the handler actually
 * returns, so the compiler fails when a view model gains a field the schema does
 * not have. That is the drift that matters: documentation quietly falling behind
 * the code it claims to describe.
 *
 * Response schemas are not used to *validate* outgoing payloads — the handlers
 * return typed view models and re-parsing them on every request would buy
 * nothing. They are here to describe.
 */
import { z } from "@hono/zod-openapi";
import {
  allocationSchema,
  awardSchema,
  detectedLayoutSchema,
  matchedLineSchema,
  negotiationConstraintsSchema,
  negotiationStatusSchema,
  purchaseOrderSchema,
  quotationMetadataSchema,
  roundActorSchema,
  supplierOfferSchema,
} from "@sq/shared";
import type { QuotationView } from "../quotations/ingest.js";
import type {
  NegotiationSummary,
  NegotiationView,
  PlanView,
  TranscriptEntry,
} from "../negotiation/view.js";

/**
 * Pins a schema's *output* to the type a handler returns, leaving its input free.
 * The two differ wherever a shared schema uses `.default()` — the field is
 * optional going in and present coming out — and it is the outgoing shape that
 * the documentation is describing.
 */
type Describes<T> = z.ZodType<T, z.ZodTypeDef, unknown>;

const matchSummary = z
  .object({
    total: z.number().int().nonnegative(),
    matched: z.number().int().nonnegative(),
    needsReview: z.number().int().nonnegative(),
    unmatched: z.number().int().nonnegative(),
    /** Count per `MatchMethod`, so the review screen can show where confidence came from. */
    byMethod: z.record(z.string(), z.number().int().nonnegative()),
  })
  .openapi("MatchSummary");

export const quotationViewSchema = z
  .object({
    id: z.string().uuid(),
    filename: z.string(),
    supplierCode: z.string(),
    createdAt: z.string().datetime(),
    metadata: quotationMetadataSchema,
    layout: detectedLayoutSchema,
    /** Quantity tiers the file prices for enough of its SKUs to be worth offering. */
    tiers: z.array(z.number().int().nonnegative()),
    /** `AS_QUOTED` (0) when no single tier covers the sheet. */
    suggestedTier: z.number().int().nonnegative(),
    warnings: z.array(z.string()),
    brandNote: z.string().nullable(),
    constraints: negotiationConstraintsSchema,
    constraintSummary: z.array(z.string()),
    lines: z.array(matchedLineSchema),
    matchSummary,
    negotiationId: z.string().uuid().nullable(),
  })
  .openapi("Quotation") satisfies Describes<QuotationView>;

export const transcriptEntrySchema = z
  .object({
    /** Monotonic within a negotiation. The SSE stream replays in this order. */
    sequence: z.number().int().nonnegative(),
    round: z.number().int().nonnegative(),
    actor: roundActorSchema,
    supplierCode: z.string().nullable(),
    supplierName: z.string().nullable(),
    message: z.string(),
    offer: supplierOfferSchema.nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi("TranscriptEntry") satisfies Describes<TranscriptEntry>;

export const planViewSchema = z
  .object({
    optionId: z.string(),
    label: z.string(),
    allocations: z.array(allocationSchema),
  })
  .openapi("Plan") satisfies Describes<PlanView>;

export const negotiationViewSchema = z
  .object({
    id: z.string().uuid(),
    quotationId: z.string().uuid(),
    status: negotiationStatusSchema,
    tierQuantity: z.number().int().nonnegative(),
    constraints: negotiationConstraintsSchema,
    constraintSummary: z.array(z.string()),
    /** Supplier code to the fraction of the order it can still fulfil. */
    capacity: z.record(z.string(), z.number()),
    curveballApplied: z.boolean(),
    award: awardSchema.nullable(),
    plans: z.array(planViewSchema),
    error: z.string().nullable(),
    createdAt: z.string().datetime(),
    transcript: z.array(transcriptEntrySchema),
    purchaseOrderIds: z.array(z.string().uuid()),
  })
  .openapi("Negotiation") satisfies Describes<NegotiationView>;

export const negotiationSummarySchema = z
  .object({
    id: z.string().uuid(),
    status: negotiationStatusSchema,
    tierQuantity: z.number().int().nonnegative(),
    filename: z.string(),
    createdAt: z.string().datetime(),
    winner: z.string().nullable(),
    total: z.number().nullable(),
    purchaseOrderCount: z.number().int().nonnegative(),
  })
  .openapi("NegotiationSummary") satisfies Describes<NegotiationSummary>;

export const purchaseOrderResponseSchema = purchaseOrderSchema.openapi("PurchaseOrder");

/** A split award writes one order per supplier, so conversion returns a list. */
export const purchaseOrdersSchema = z.array(purchaseOrderResponseSchema);
