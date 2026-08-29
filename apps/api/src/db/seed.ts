import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { SUPPLIER_PROFILES } from "@sq/shared";
import { env } from "../env.js";
import { parseCsvObjects } from "../lib/csv.js";
import { normalizeSku, skuPrefix } from "../matching/normalize.js";
import { db, pool, schema } from "./client.js";

const CATALOG_PATH = resolve(env.repoRoot, "fixtures/products.csv");

export async function seed(): Promise<{ products: number; suppliers: number }> {
  const rows = parseCsvObjects(readFileSync(CATALOG_PATH, "utf8"));

  const seen = new Set<string>();
  const catalog = rows
    .map((row) => ({
      sku: row.sku ?? "",
      brand: row.brand ?? "",
      // 130 catalog rows ship with an empty name. Kept, because the SKU is what
      // a quotation is matched on and dropping them would silently make real
      // products unbuyable. The UI shows the SKU when the name is blank.
      name: row.name ?? "",
      color: row.color ?? "",
    }))
    .filter((p) => {
      if (!p.sku || seen.has(p.sku)) return false;
      seen.add(p.sku);
      return true;
    })
    .map((p) => ({
      ...p,
      normalizedSku: normalizeSku(p.sku),
      skuPrefix: skuPrefix(p.sku),
    }));

  await db.transaction(async (tx) => {
    // Upserted rather than truncated: `quotation_lines.matched_sku` references
    // this table, so a `truncate ... cascade` would take every parsed line with
    // it and leave the quotations above them pointing at nothing. Re-running the
    // seed is something the README tells people to do, so it has to be safe.
    for (let i = 0; i < catalog.length; i += 1000) {
      await tx
        .insert(schema.products)
        .values(catalog.slice(i, i + 1000))
        .onConflictDoUpdate({
          target: schema.products.sku,
          set: {
            brand: sql`excluded.brand`,
            name: sql`excluded.name`,
            color: sql`excluded.color`,
            normalizedSku: sql`excluded.normalized_sku`,
            skuPrefix: sql`excluded.sku_prefix`,
          },
        });
    }

    for (const profile of SUPPLIER_PROFILES) {
      const row = {
        code: profile.code,
        name: profile.name,
        country: profile.country,
        qualityRating: profile.qualityRating,
        leadTimeDays: profile.leadTimeDays,
        paymentTerms: profile.paymentTerms,
        openingMultiplier: profile.openingMultiplier,
        floorRatio: profile.floorRatio,
        minLeadTimeDays: profile.minLeadTimeDays,
        bestPaymentTerms: profile.bestPaymentTerms,
        maxRebatePct: profile.maxRebatePct,
        maxFreightAllowancePerUnit: profile.maxFreightAllowancePerUnit,
        moqPerLine: profile.moqPerLine,
        isIncumbent: profile.code === "supplier_1",
      };
      await tx
        .insert(schema.suppliers)
        .values(row)
        .onConflictDoUpdate({ target: schema.suppliers.code, set: row });
    }

    await tx
      .insert(schema.counters)
      .values({ name: "po_number", value: 0 })
      .onConflictDoNothing();
  });

  return { products: catalog.length, suppliers: SUPPLIER_PROFILES.length };
}

const isEntrypoint = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!);
if (isEntrypoint) {
  seed()
    .then((counts) => {
      console.log(`seeded ${counts.products} products and ${counts.suppliers} suppliers`);
      return pool.end();
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
