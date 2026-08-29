import { eq } from "drizzle-orm";
import { db, pool, schema } from "../db/client.js";
import { parseQuotation } from "../parser/index.js";
import { loadCatalog, matchLines } from "../matching/index.js";
import { parseBrandNote } from "../negotiation/constraints.js";
import { transcript } from "../negotiation/engine.js";
import { resumeNegotiation, startNegotiation } from "../workflows/runner.js";
import { env } from "../env.js";
import { resolve } from "node:path";

/**
 * Drives one negotiation end to end from the command line. Useful for seeing the
 * whole transcript at once without the UI, and for checking that the workflow
 * really does suspend and resume rather than replaying.
 */
async function main() {
  const file = process.argv[2] ?? resolve(env.repoRoot, "fixtures/quotation_2.xlsx");
  const note = process.argv[3] ?? "prioritize lead time over cost, 30 day deadline";

  const parsed = await parseQuotation(file);
  const catalog = await loadCatalog();
  const matched = matchLines(parsed.lines, catalog);

  const [quotation] = await db
    .insert(schema.quotations)
    .values({
      filename: file.split("/").pop()!,
      supplierCode: "supplier_1",
      metadata: parsed.metadata,
      layout: parsed.layout,
      tiers: parsed.tiers,
      warnings: parsed.warnings,
      brandNote: note,
      constraints: parseBrandNote(note),
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

  const [negotiation] = await db
    .insert(schema.negotiations)
    .values({
      quotationId: quotation!.id,
      tierQuantity: parsed.suggestedTier,
      constraints: parseBrandNote(note),
    })
    .returning();

  const id = negotiation!.id;
  console.log(`negotiation ${id}\n`);

  await startNegotiation(id);
  await waitFor(id, "suspended");
  console.log(">>> suspended, injecting the curveball\n");

  await resumeNegotiation(id, { supplierCode: "supplier_2", fulfillmentRatio: 0.6 });
  await waitFor(id, "awaiting_conversion", "failed");

  for (const row of await transcript(id)) {
    const who = row.actor === "supplier" ? row.supplierCode : row.actor;
    console.log(`[r${row.round} ${who}] ${row.message}\n`);
  }

  const final = await db.query.negotiations.findFirst({ where: eq(schema.negotiations.id, id) });
  console.log("status:", final?.status);
  console.log("award:", final?.award?.label);
  for (const allocation of final?.award?.plan.allocations ?? []) {
    console.log(
      `  ${allocation.supplierCode}: ${allocation.lines.length} lines, $${allocation.subtotal.toFixed(0)}, ${allocation.leadTimeDays}d, ${allocation.paymentTerms}`,
    );
  }
}

async function waitFor(id: string, ...statuses: string[]): Promise<void> {
  for (let i = 0; i < 240; i++) {
    const row = await db.query.negotiations.findFirst({ where: eq(schema.negotiations.id, id) });
    if (row && statuses.includes(row.status)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${statuses.join(" or ")}`);
}

main()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error(error);
    await pool.end();
    process.exit(1);
  });
