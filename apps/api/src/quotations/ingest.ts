import { desc, eq } from "drizzle-orm";
import type { MatchedLine } from "@sq/shared";
import { db, schema } from "../db/client.js";
import { parseQuotation } from "../parser/index.js";
import { loadCatalog, matchLines, summariseMatches } from "../matching/index.js";
import { parseBrandNote, describeConstraints } from "../negotiation/constraints.js";

export type QuotationView = {
  id: string;
  filename: string;
  supplierCode: string;
  createdAt: string;
  metadata: typeof schema.quotations.$inferSelect["metadata"];
  layout: typeof schema.quotations.$inferSelect["layout"];
  tiers: number[];
  suggestedTier: number;
  warnings: string[];
  brandNote: string | null;
  constraints: typeof schema.quotations.$inferSelect["constraints"];
  constraintSummary: string[];
  lines: MatchedLine[];
  matchSummary: ReturnType<typeof summariseMatches>;
  negotiationId: string | null;
};

/**
 * Parse, match, persist. Kept out of the route handler so the demo script and
 * the tests exercise the same path the HTTP API does.
 */
export async function ingestQuotation(input: {
  source: Buffer | string;
  filename: string;
  brandNote?: string | null;
}): Promise<QuotationView> {
  const parsed = await parseQuotation(input.source);
  const catalog = await loadCatalog();
  const matched = matchLines(parsed.lines, catalog);
  const note = input.brandNote?.trim() || null;
  const constraints = parseBrandNote(note ?? "");

  const [quotation] = await db
    .insert(schema.quotations)
    .values({
      filename: input.filename,
      supplierCode: "supplier_1",
      metadata: parsed.metadata,
      layout: parsed.layout,
      tiers: parsed.tiers,
      suggestedTier: parsed.suggestedTier,
      warnings: parsed.warnings,
      brandNote: note ?? "",
      constraints,
    })
    .returning();

  await db.insert(schema.quotationLines).values(
    matched.map((line) => ({
      quotationId: quotation!.id,
      rawSku: line.rawSku,
      rawDescription: line.rawDescription,
      quantity: line.quantity,
      tierQuantity: line.tierQuantity,
      unitPrice: String(line.unitPrice),
      listUnitPrice: String(line.listUnitPrice),
      discountPct: line.discountPct,
      lineTotal: String(line.lineTotal),
      sheetName: line.sheetName,
      rowNumber: line.rowNumber,
      totalMismatch: line.totalMismatch,
      matchedSku: line.matchedSku,
      matchedName: line.matchedName,
      matchedBrand: line.matchedBrand,
      matchConfidence: line.matchConfidence,
      matchMethod: line.matchMethod,
      candidates: line.candidates,
    })),
  );

  return (await getQuotation(quotation!.id))!;
}

export async function getQuotation(id: string): Promise<QuotationView | null> {
  const row = await db.query.quotations.findFirst({ where: eq(schema.quotations.id, id) });
  if (!row) return null;

  const lineRows = await db
    .select()
    .from(schema.quotationLines)
    .where(eq(schema.quotationLines.quotationId, id))
    .orderBy(schema.quotationLines.rowNumber);

  const lines: MatchedLine[] = lineRows.map((l) => ({
    rawSku: l.rawSku,
    rawDescription: l.rawDescription,
    quantity: l.quantity,
    tierQuantity: l.tierQuantity,
    unitPrice: Number(l.unitPrice),
    listUnitPrice: Number(l.listUnitPrice),
    discountPct: l.discountPct,
    lineTotal: Number(l.lineTotal),
    sheetName: l.sheetName,
    rowNumber: l.rowNumber,
    totalMismatch: l.totalMismatch,
    matchedSku: l.matchedSku,
    matchedName: l.matchedName,
    matchedBrand: l.matchedBrand,
    matchConfidence: l.matchConfidence,
    matchMethod: l.matchMethod as MatchedLine["matchMethod"],
    candidates: l.candidates ?? [],
  }));

  const [negotiation] = await db
    .select({ id: schema.negotiations.id })
    .from(schema.negotiations)
    .where(eq(schema.negotiations.quotationId, id))
    .orderBy(desc(schema.negotiations.createdAt))
    .limit(1);

  return {
    id: row.id,
    filename: row.filename,
    supplierCode: row.supplierCode,
    createdAt: row.createdAt.toISOString(),
    metadata: row.metadata,
    layout: row.layout,
    tiers: row.tiers ?? [],
    suggestedTier: row.suggestedTier,
    warnings: row.warnings ?? [],
    brandNote: row.brandNote,
    constraints: row.constraints,
    constraintSummary: describeConstraints(row.constraints),
    lines,
    matchSummary: summariseMatches(lines),
    negotiationId: negotiation?.id ?? null,
  };
}
