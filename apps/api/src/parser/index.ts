import type { ParsedQuotation } from "@sq/shared";
import { readWorkbook } from "./read-workbook.js";
import { analyseWorkbook } from "./detect-layout.js";
import { extractLines, suggestTier, tiersFrom } from "./extract.js";
import { extractMetadata } from "./metadata.js";

export { AS_QUOTED, suggestTier, tiersFrom } from "./extract.js";
export { readWorkbook } from "./read-workbook.js";

export type ParseResult = ParsedQuotation & { suggestedTier: number };

/**
 * Read the file, work out its shape, pull the lines out, then read whatever
 * metadata is lying around outside the table. Nothing here knows the names of
 * the fixture files; every decision comes from the data in front of it.
 */
export async function parseQuotation(source: Buffer | string): Promise<ParseResult> {
  const workbook = await readWorkbook(source);
  if (workbook.sheets.length === 0) throw new Error("the workbook has no readable sheets");

  const { analyses, layout } = await analyseWorkbook(workbook);
  if (analyses.length === 0) {
    throw new Error("no line-item table could be found in this workbook");
  }

  const { lines, warnings } = extractLines(analyses);
  if (lines.length === 0) {
    throw new Error("a table was found but no priced line items could be read from it");
  }

  const metadata = extractMetadata(
    analyses.map((a) => ({ grid: a.grid, region: a.region })),
  );

  // Every sheet of a multi-sheet workbook reports the same layout override, so
  // the user sees the finding once rather than once per tier.
  const overrides = [...new Set(analyses.flatMap((a) => a.layout.overrides))];

  return {
    metadata,
    layout,
    lines,
    tiers: tiersFrom(lines),
    warnings: [...overrides, ...warnings],
    suggestedTier: suggestTier(lines),
  };
}
