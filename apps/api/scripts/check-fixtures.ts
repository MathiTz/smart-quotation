/**
 * Parses every fixture and prints what came out, so a change to the parser can be
 * judged against all ten files at once rather than the one that was in hand.
 */
import { resolve } from "node:path";
import { parseQuotation } from "../src/parser/index.js";
import { loadCatalogFromCsv, matchLines } from "../src/matching/index.js";

const ROOT = resolve(import.meta.dirname, "../../../fixtures");
const catalog = loadCatalogFromCsv();

const only = process.argv[2];
const files = only ? [only] : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `quotation_${n}.xlsx`);

for (const file of files) {
  try {
    const parsed = await parseQuotation(resolve(ROOT, file));
    const matched = matchLines(parsed.lines, catalog);
    const byMethod = matched.reduce<Record<string, number>>((acc, m) => {
      acc[m.matchMethod] = (acc[m.matchMethod] ?? 0) + 1;
      return acc;
    }, {});

    console.log(`\n${file}`);
    console.log(`  lines          ${parsed.lines.length}`);
    console.log(`  tiers          ${parsed.tiers.join(", ") || "none"}`);
    console.log(`  lead time      ${parsed.metadata.leadTimeDays ?? "—"}`);
    console.log(`  payment terms  ${parsed.metadata.paymentTerms ?? "—"}`);
    console.log(
      `  matching       ${Object.entries(byMethod)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")}`,
    );
    if (parsed.warnings.length) console.log(`  warnings       ${parsed.warnings.join(" | ")}`);

    const sample = parsed.lines
      .slice(0, 3)
      .map((l) => `${l.rawSku} ${l.quantity}x@${l.unitPrice}`)
      .join("; ");
    console.log(`  sample         ${sample}`);

    const bad = matched.filter((m) => m.matchMethod === "unmatched").map((m) => m.rawSku);
    if (bad.length) console.log(`  unmatched      ${bad.join(", ")}`);
    const mismatched = parsed.lines.filter((l) => l.totalMismatch).length;
    if (mismatched) console.log(`  arithmetic     ${mismatched} rows disagreed with their total`);
  } catch (error) {
    console.log(`\n${file}`);
    console.log(`  FAILED  ${error instanceof Error ? error.message : error}`);
  }
}
