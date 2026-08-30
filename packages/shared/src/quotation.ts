import { z } from "zod";
import { paymentTermsSchema } from "./domain.js";

/**
 * What a spreadsheet column turns out to hold. Detected by an LLM and then
 * verified against the data, because `quotation_4.xlsx` labels its quantity
 * column "单价" (unit price) and its price column "数量" (quantity). The label
 * is not evidence; the values are.
 */
export const columnRoleSchema = z.enum([
  "sku",
  "description",
  "quantity",
  "unit_price",
  "line_total",
  "discount_pct",
  "row_number",
  "ignore",
]);
export type ColumnRole = z.infer<typeof columnRoleSchema>;

export const columnMappingSchema = z.object({
  /** Zero-based column index within the sheet grid. */
  index: z.number().int().nonnegative(),
  role: columnRoleSchema,
  header: z.string(),
  /**
   * Quantity this column's prices apply to, when tiers are expressed as
   * parallel columns ("Unit FOB Price - Qty 5000"). Null for every other layout.
   */
  tierQuantity: z.number().int().positive().nullable().default(null),
});
export type ColumnMapping = z.infer<typeof columnMappingSchema>;

/** How the file expresses more than one quantity tier. All three occur in the fixtures. */
export const tierLayoutSchema = z.enum([
  "single", // one tier only
  "row_blocks", // quotation_1: the same SKUs repeat lower down at a different qty
  "columns", // quotation_2: two price columns whose headers carry the quantities
  "sheets", // quotation_3: one sheet per tier
]);
export type TierLayout = z.infer<typeof tierLayoutSchema>;

export const sheetLayoutSchema = z.object({
  sheetName: z.string(),
  headerRow: z.number().int().nonnegative(),
  firstDataRow: z.number().int().nonnegative(),
  lastDataRow: z.number().int().nonnegative(),
  columns: z.array(columnMappingSchema),
  /** Set when the data contradicted the header text and the data won. */
  overrides: z.array(z.string()).default([]),
  source: z.enum(["llm", "heuristic", "llm+heuristic"]),
});
export type SheetLayout = z.infer<typeof sheetLayoutSchema>;

export const detectedLayoutSchema = z.object({
  tierLayout: tierLayoutSchema,
  sheets: z.array(sheetLayoutSchema),
});
export type DetectedLayout = z.infer<typeof detectedLayoutSchema>;

export const quotationMetadataSchema = z.object({
  supplierName: z.string().nullable().default(null),
  currency: z.string().default("USD"),
  quotationDate: z.string().nullable().default(null),
  leadTimeDays: z.number().int().positive().nullable().default(null),
  paymentTerms: paymentTermsSchema.nullable().default(null),
});
export type QuotationMetadata = z.infer<typeof quotationMetadataSchema>;

/**
 * Sentinel tier meaning "buy each line at the quantity it was quoted at".
 *
 * Lives here rather than in the parser because both sides have to agree on it:
 * the API builds a basket from it, and the client has to render it as a real
 * choice instead of a tier that matches no rows.
 */
export const AS_QUOTED = 0;

/** One priced row, exactly as the sheet had it, before any catalog matching. */
export const parsedLineSchema = z.object({
  rawSku: z.string(),
  rawDescription: z.string().nullable().default(null),
  quantity: z.number().int().positive(),
  /** Effective unit price: discount already applied when the sheet had a discount column. */
  unitPrice: z.number().nonnegative(),
  listUnitPrice: z.number().nonnegative(),
  discountPct: z.number().min(0).max(100).default(0),
  lineTotal: z.number().nonnegative(),
  /** The quantity tier this row belongs to. Equals `quantity` in most layouts. */
  tierQuantity: z.number().int().positive(),
  sheetName: z.string(),
  rowNumber: z.number().int().nonnegative(),
  /** Set when qty * unitPrice disagreed with the sheet's own total. */
  totalMismatch: z.boolean().default(false),
});
export type ParsedLine = z.infer<typeof parsedLineSchema>;

export const parsedQuotationSchema = z.object({
  metadata: quotationMetadataSchema,
  layout: detectedLayoutSchema,
  lines: z.array(parsedLineSchema),
  /** Tier quantities present in the file, ascending. */
  tiers: z.array(z.number().int().positive()),
  warnings: z.array(z.string()).default([]),
});
export type ParsedQuotation = z.infer<typeof parsedQuotationSchema>;

// --- Catalog matching -------------------------------------------------------

export const matchMethodSchema = z.enum([
  "exact",
  "normalized", // case, whitespace, homoglyph folding
  "padded", // EKA03 -> EKA003
  "fuzzy", // edit distance within a prefix bucket
  "ambiguous", // several candidates above threshold; a human must pick
  "unmatched",
]);
export type MatchMethod = z.infer<typeof matchMethodSchema>;

export const matchCandidateSchema = z.object({
  sku: z.string(),
  brand: z.string(),
  name: z.string(),
  color: z.string(),
  confidence: z.number().min(0).max(1),
});
export type MatchCandidate = z.infer<typeof matchCandidateSchema>;

export const matchedLineSchema = parsedLineSchema.extend({
  matchedSku: z.string().nullable(),
  matchedName: z.string().nullable(),
  matchedBrand: z.string().nullable(),
  matchConfidence: z.number().min(0).max(1),
  matchMethod: matchMethodSchema,
  candidates: z.array(matchCandidateSchema).default([]),
});
export type MatchedLine = z.infer<typeof matchedLineSchema>;

/**
 * Amber's own convention, reused so the review table reads the way their
 * product does: green at or above 0.80, yellow to 0.50, grey below.
 */
export function confidenceBand(confidence: number): "high" | "medium" | "low" {
  if (confidence >= 0.8) return "high";
  if (confidence >= 0.5) return "medium";
  return "low";
}

/** A line is only safe to buy when we know which catalog SKU it is. */
export function isBuyable(line: MatchedLine): boolean {
  return line.matchedSku !== null && line.matchMethod !== "ambiguous";
}
