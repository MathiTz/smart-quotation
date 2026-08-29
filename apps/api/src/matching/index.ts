import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { MatchedLine, ParsedLine } from "@sq/shared";
import { env } from "../env.js";
import { parseCsvObjects } from "../lib/csv.js";
import { db, schema } from "../db/client.js";
import { CatalogIndex, type CatalogRow } from "./catalog.js";

export { CatalogIndex } from "./catalog.js";
export type { CatalogRow, MatchOutcome } from "./catalog.js";

let cached: CatalogIndex | null = null;

/**
 * The catalog is 10,053 immutable rows read on every upload, so it is built once
 * and kept. Restarting the process is the invalidation strategy, which is
 * honest for a catalog that only changes when someone reseeds it.
 */
export async function loadCatalog(): Promise<CatalogIndex> {
  if (cached) return cached;
  const rows = await db
    .select({
      sku: schema.products.sku,
      brand: schema.products.brand,
      name: schema.products.name,
      color: schema.products.color,
    })
    .from(schema.products);
  cached = new CatalogIndex(rows);
  return cached;
}

/** Used by tests and by the seed, so neither needs a database connection. */
export function loadCatalogFromCsv(path = resolve(env.repoRoot, "fixtures/products.csv")): CatalogIndex {
  const rows = parseCsvObjects(readFileSync(path, "utf8")).map(
    (r): CatalogRow => ({ sku: r.sku ?? "", brand: r.brand ?? "", name: r.name ?? "", color: r.color ?? "" }),
  );
  return new CatalogIndex(rows.filter((r) => r.sku));
}

export function matchLines(lines: ParsedLine[], catalog: CatalogIndex): MatchedLine[] {
  // The same SKU appears once per tier, so matching is memoised per file rather
  // than per line. On `quotation_2.xlsx` that halves the work.
  const memo = new Map<string, ReturnType<CatalogIndex["match"]>>();

  return lines.map((line) => {
    let outcome = memo.get(line.rawSku);
    if (!outcome) {
      outcome = catalog.match(line.rawSku);
      memo.set(line.rawSku, outcome);
    }

    return {
      ...line,
      matchedSku: outcome.sku,
      matchedName: outcome.name,
      matchedBrand: outcome.brand,
      matchConfidence: outcome.confidence,
      matchMethod: outcome.method,
      candidates: outcome.candidates,
    };
  });
}

export type MatchSummary = {
  total: number;
  matched: number;
  needsReview: number;
  unmatched: number;
  byMethod: Record<string, number>;
};

/** Counted over distinct SKUs, not rows: one bad SKU quoted at two tiers is one problem. */
export function summariseMatches(lines: MatchedLine[]): MatchSummary {
  const bySku = new Map<string, MatchedLine>();
  for (const line of lines) if (!bySku.has(line.rawSku)) bySku.set(line.rawSku, line);

  const distinct = [...bySku.values()];
  const byMethod: Record<string, number> = {};
  for (const line of distinct) byMethod[line.matchMethod] = (byMethod[line.matchMethod] ?? 0) + 1;

  return {
    total: distinct.length,
    matched: distinct.filter((l) => l.matchedSku !== null).length,
    needsReview: distinct.filter((l) => l.matchMethod === "ambiguous" || (l.matchedSku !== null && l.matchConfidence < 0.9)).length,
    unmatched: distinct.filter((l) => l.matchMethod === "unmatched").length,
    byMethod,
  };
}
