import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  Award,
  DetectedLayout,
  MatchCandidate,
  NegotiationConstraints,
  QuotationMetadata,
  SupplierCoverage,
  SupplierOffer,
  TermsSnapshot,
} from "@sq/shared";

/**
 * Money is `numeric` and read back through `Number`. Postgres numeric avoids the
 * float drift that would make a PO total disagree with the sum of its lines;
 * JavaScript then does the arithmetic in float anyway, which is fine at these
 * magnitudes and is why totals are rounded to cents before they are stored.
 */
const money = (name: string) => numeric(name, { precision: 14, scale: 4 });

export const products = pgTable(
  "products",
  {
    sku: text("sku").primaryKey(),
    brand: text("brand").notNull(),
    name: text("name").notNull(),
    color: text("color").notNull(),
    /** Uppercased, punctuation-stripped, homoglyph-folded. The matcher's index key. */
    normalizedSku: text("normalized_sku").notNull(),
    /** Leading letters only ("OB" from "OB007-BAS-L"), used to bucket fuzzy candidates. */
    skuPrefix: text("sku_prefix").notNull(),
  },
  (t) => [
    index("products_normalized_sku_idx").on(t.normalizedSku),
    index("products_prefix_idx").on(t.skuPrefix),
  ],
);

export const suppliers = pgTable("suppliers", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  country: text("country").notNull(),
  qualityRating: real("quality_rating").notNull(),
  leadTimeDays: integer("lead_time_days").notNull(),
  paymentTerms: text("payment_terms").notNull(),
  /** Applied to the parsed baseline to derive this supplier's opening price. */
  openingMultiplier: real("opening_multiplier").notNull(),
  /** Never shown to the agent; enforced by the workflow when clamping an offer. */
  floorRatio: real("floor_ratio").notNull(),
  minLeadTimeDays: integer("min_lead_time_days").notNull(),
  bestPaymentTerms: text("best_payment_terms").notNull(),
  maxRebatePct: real("max_rebate_pct").notNull(),
  maxFreightAllowancePerUnit: real("max_freight_allowance_per_unit").notNull(),
  /** Minimum order quantity per line. The reason a split award needs a repair pass. */
  moqPerLine: integer("moq_per_line").notNull(),
  isIncumbent: boolean("is_incumbent").notNull().default(false),
});

export const quotations = pgTable("quotations", {
  id: uuid("id").primaryKey().defaultRandom(),
  filename: text("filename").notNull(),
  supplierCode: text("supplier_code")
    .notNull()
    .references(() => suppliers.code),
  metadata: jsonb("metadata").$type<QuotationMetadata>().notNull(),
  layout: jsonb("layout").$type<DetectedLayout>().notNull(),
  tiers: jsonb("tiers").$type<number[]>().notNull(),
  /** The tier the parser thinks the brand is buying; the UI can override it. */
  suggestedTier: integer("suggested_tier").notNull().default(0),
  warnings: jsonb("warnings").$type<string[]>().notNull().default([]),
  /** The free-text note from the upload form, before it is parsed into constraints. */
  brandNote: text("brand_note").notNull().default(""),
  constraints: jsonb("constraints").$type<NegotiationConstraints>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const quotationLines = pgTable(
  "quotation_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    quotationId: uuid("quotation_id")
      .notNull()
      .references(() => quotations.id, { onDelete: "cascade" }),
    rawSku: text("raw_sku").notNull(),
    rawDescription: text("raw_description"),
    quantity: integer("quantity").notNull(),
    tierQuantity: integer("tier_quantity").notNull(),
    unitPrice: money("unit_price").notNull(),
    listUnitPrice: money("list_unit_price").notNull(),
    discountPct: real("discount_pct").notNull().default(0),
    lineTotal: money("line_total").notNull(),
    sheetName: text("sheet_name").notNull(),
    rowNumber: integer("row_number").notNull(),
    totalMismatch: boolean("total_mismatch").notNull().default(false),

    matchedSku: text("matched_sku").references(() => products.sku),
    matchedName: text("matched_name"),
    matchedBrand: text("matched_brand"),
    matchConfidence: real("match_confidence").notNull().default(0),
    matchMethod: text("match_method").notNull(),
    candidates: jsonb("candidates").$type<MatchCandidate[]>().notNull().default([]),
    /** Flipped by the review screen when a human picks from `candidates`. */
    confirmedByUser: boolean("confirmed_by_user").notNull().default(false),
  },
  (t) => [index("quotation_lines_quotation_idx").on(t.quotationId)],
);

export const negotiations = pgTable(
  "negotiations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    quotationId: uuid("quotation_id")
      .notNull()
      .references(() => quotations.id, { onDelete: "cascade" }),
    /** Mastra's run id. How a suspended workflow is found again to resume it. */
    workflowRunId: text("workflow_run_id"),
    status: text("status").notNull().default("pending"),
    /** Which quantity tier the brand is actually buying. */
    tierQuantity: integer("tier_quantity").notNull(),
    constraints: jsonb("constraints").$type<NegotiationConstraints>().notNull(),
    coverage: jsonb("coverage").$type<SupplierCoverage[]>().notNull().default([]),
    /**
     * Capacity ceiling per supplier, 1 meaning "the whole order". The curveball
     * writes 0.6 here and nothing else about the negotiation changes, which is
     * what lets it be absorbed rather than restarted.
     */
    capacity: jsonb("capacity").$type<Record<string, number>>().notNull().default({}),
    award: jsonb("award").$type<Award | null>(),
    curveballApplied: boolean("curveball_applied").notNull().default(false),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("negotiations_quotation_idx").on(t.quotationId)],
);

export const negotiationRounds = pgTable(
  "negotiation_rounds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    negotiationId: uuid("negotiation_id")
      .notNull()
      .references(() => negotiations.id, { onDelete: "cascade" }),
    round: integer("round").notNull(),
    actor: text("actor").notNull(),
    supplierCode: text("supplier_code"),
    /** Not nullable: the brief requires agents to talk, so every row carries English. */
    message: text("message").notNull(),
    offer: jsonb("offer").$type<SupplierOffer | null>(),
    /** Monotonic within a negotiation. The SSE stream replays in this order. */
    sequence: integer("sequence").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("negotiation_rounds_negotiation_idx").on(t.negotiationId, t.sequence),
    uniqueIndex("negotiation_rounds_sequence_uq").on(t.negotiationId, t.sequence),
  ],
);

export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    poNumber: text("po_number").notNull().unique(),
    negotiationId: uuid("negotiation_id")
      .notNull()
      .references(() => negotiations.id),
    supplierCode: text("supplier_code")
      .notNull()
      .references(() => suppliers.code),
    supplierName: text("supplier_name").notNull(),
    /**
     * Identifies the commit intent within a negotiation. Deliberately not unique
     * with supplier_code: today a split award writes one PO per supplier, and
     * splitting further (by delivery window, say) only needs a richer key here,
     * not a migration.
     */
    allocationKey: text("allocation_key").notNull(),
    status: text("status").notNull().default("sent"),
    currency: text("currency").notNull().default("USD"),
    subtotal: money("subtotal").notNull(),
    total: money("total").notNull(),
    leadTimeQuotedDays: integer("lead_time_quoted_days").notNull(),
    paymentTerms: text("payment_terms").notNull(),
    /** Frozen at commit. A PO that re-reads a mutable negotiation is not a commitment. */
    termsSnapshot: jsonb("terms_snapshot").$type<TermsSnapshot>().notNull(),
    /** Makes a double-clicked Convert button return the same PO instead of two. */
    idempotencyKey: text("idempotency_key").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  },
  (t) => [
    index("purchase_orders_negotiation_idx").on(t.negotiationId),
    index("purchase_orders_supplier_idx").on(t.supplierCode),
  ],
);

export const purchaseOrderLines = pgTable(
  "purchase_order_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    purchaseOrderId: uuid("purchase_order_id")
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "cascade" }),
    sku: text("sku").notNull(),
    productName: text("product_name"),
    quantity: integer("quantity").notNull(),
    unitCostFinal: money("unit_cost_final").notNull(),
    lineTotal: money("line_total").notNull(),
  },
  (t) => [index("purchase_order_lines_po_idx").on(t.purchaseOrderId)],
);

/**
 * Downstream effects of committing. They live in the same transaction as the PO
 * so the commit is atomic, and are delivered afterwards by a worker so a slow
 * supplier API cannot roll back a purchase order the brand has already agreed to.
 */
export const outbox = pgTable(
  "outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    purchaseOrderId: uuid("purchase_order_id")
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    /** `internal` fires on draft; `supplier_facing` waits for the PO to be issued. */
    stage: text("stage").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    detail: text("detail"),
    /** Backoff marker: null means eligible now. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    index("outbox_status_idx").on(t.status),
    uniqueIndex("outbox_po_event_uq").on(t.purchaseOrderId, t.eventType),
  ],
);

/** Sequential PO numbers (PO-2026-0001) without a race between two commits. */
export const counters = pgTable(
  "counters",
  {
    name: text("name").notNull(),
    value: integer("value").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.name] })],
);
