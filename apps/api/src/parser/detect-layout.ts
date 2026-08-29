import type { ColumnMapping, ColumnRole, DetectedLayout, SheetLayout, TierLayout } from "@sq/shared";
import { cellAt, type SheetGrid, type Workbook } from "./read-workbook.js";
import {
  columnStats,
  findArithmeticTriple,
  findDataRegion,
  headerRole,
  looksLikeSku,
  type ColumnStats,
  type DataRegion,
} from "./heuristics.js";
import { classifyColumnsWithLlm } from "./llm.js";

export type SheetAnalysis = {
  grid: SheetGrid;
  region: DataRegion;
  stats: ColumnStats[];
  layout: SheetLayout;
};

/**
 * Assigns a role to every column from the shape of its data, then uses the
 * header text only for the columns the data could not settle. The order matters:
 * headers are a hint, arithmetic is evidence.
 */
export function assignRoles(
  grid: SheetGrid,
  region: DataRegion,
  stats: ColumnStats[],
  llmRoles?: Map<number, ColumnRole>,
): { columns: ColumnMapping[]; overrides: string[] } {
  const roles = new Map<number, ColumnRole>();
  const overrides: string[] = [];
  const rowCount = region.lastDataRow - region.firstDataRow + 1;

  const triple = findArithmeticTriple(stats, rowCount);
  if (triple) {
    roles.set(triple.quantity, "quantity");
    roles.set(triple.unitPrice, "unit_price");
    roles.set(triple.lineTotal, "line_total");
    if (triple.discount !== null) roles.set(triple.discount, "discount_pct");
  }

  // The SKU column is whichever column actually contains SKUs.
  const skuCol = stats
    .filter((s) => s.skuLikeCount >= Math.max(2, rowCount * 0.5) && !roles.has(s.index))
    .sort((a, b) => b.skuLikeCount - a.skuLikeCount || a.index - b.index)[0];
  if (skuCol) roles.set(skuCol.index, "sku");

  const descCol = stats
    .filter(
      (s) =>
        !roles.has(s.index) &&
        s.descriptionLikeCount >= Math.max(2, rowCount * 0.5) &&
        s.numericCount < rowCount * 0.5,
    )
    .sort((a, b) => b.descriptionLikeCount - a.descriptionLikeCount || a.index - b.index)[0];
  if (descCol) roles.set(descCol.index, "description");

  for (const s of stats) {
    if (roles.has(s.index)) continue;
    if (s.isSequential && s.numericCount >= rowCount * 0.8) roles.set(s.index, "row_number");
  }

  // Tiers expressed as parallel price columns. The quantity lives in the header
  // and nowhere else, so this is the one case where header text is the data.
  for (const s of stats) {
    if (roles.has(s.index)) continue;
    if (s.tierQuantity !== null && s.numericCount >= Math.max(2, rowCount * 0.5)) {
      roles.set(s.index, "unit_price");
    }
  }

  for (const s of stats) {
    if (roles.has(s.index)) continue;
    if (s.nonEmpty === 0) {
      roles.set(s.index, "ignore");
      continue;
    }
    const fromLlm = llmRoles?.get(s.index);
    const fromHeader = headerRole(s.header);
    const role = fromHeader ?? fromLlm ?? "ignore";
    roles.set(s.index, role);
  }

  // Record every place the data contradicted a label, so the review screen can
  // show it rather than the parser quietly being clever.
  for (const s of stats) {
    const assigned = roles.get(s.index)!;
    const claimed = headerRole(s.header);
    if (claimed && claimed !== assigned && assigned !== "ignore") {
      overrides.push(
        `column ${s.index + 1} is labelled "${s.header}" (${claimed}) but its values are ${assigned}`,
      );
    }
    const llmSaid = llmRoles?.get(s.index);
    if (llmSaid && llmSaid !== assigned && assigned !== "ignore") {
      overrides.push(`model called column ${s.index + 1} ${llmSaid}; the data says ${assigned}`);
    }
  }

  const columns: ColumnMapping[] = stats.map((s) => ({
    index: s.index,
    role: roles.get(s.index) ?? "ignore",
    header: s.header,
    tierQuantity: roles.get(s.index) === "unit_price" ? s.tierQuantity : null,
  }));

  return { columns, overrides };
}

/**
 * How this file expresses more than one quantity tier. All four shapes appear in
 * the fixtures and all four have to be recognised without being told which.
 */
export function detectTierLayout(analyses: SheetAnalysis[]): TierLayout {
  const priceTierColumns = analyses.flatMap((a) =>
    a.layout.columns.filter((c) => c.role === "unit_price" && c.tierQuantity !== null),
  );
  if (priceTierColumns.length >= 2) return "columns";

  if (analyses.length > 1) {
    const skuSets = analyses.map((a) => new Set(skusIn(a)));
    const [first, ...rest] = skuSets;
    // Separate sheets are tiers only when they quote the same products.
    if (first && rest.some((s) => overlap(first, s) > 0.6)) return "sheets";
  }

  for (const analysis of analyses) {
    const seen = new Map<string, Set<number>>();
    const skuCol = analysis.layout.columns.find((c) => c.role === "sku");
    const qtyCol = analysis.layout.columns.find((c) => c.role === "quantity");
    if (!skuCol || !qtyCol) continue;
    for (let r = analysis.region.firstDataRow; r <= analysis.region.lastDataRow; r++) {
      const sku = cellAt(analysis.grid, r, skuCol.index).text;
      const qty = cellAt(analysis.grid, r, qtyCol.index).number;
      if (!sku || qty === null) continue;
      if (!seen.has(sku)) seen.set(sku, new Set());
      seen.get(sku)!.add(qty);
    }
    const repeated = [...seen.values()].filter((qtys) => qtys.size > 1).length;
    if (repeated >= Math.max(2, seen.size * 0.5)) return "row_blocks";
  }

  return "single";
}

function skusIn(analysis: SheetAnalysis): string[] {
  const skuCol = analysis.layout.columns.find((c) => c.role === "sku");
  if (!skuCol) return [];
  const out: string[] = [];
  for (let r = analysis.region.firstDataRow; r <= analysis.region.lastDataRow; r++) {
    const text = cellAt(analysis.grid, r, skuCol.index).text;
    if (looksLikeSku(text)) out.push(text);
  }
  return out;
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const v of a) if (b.has(v)) shared++;
  return shared / Math.min(a.size, b.size);
}

export async function analyseWorkbook(workbook: Workbook): Promise<{
  analyses: SheetAnalysis[];
  layout: DetectedLayout;
}> {
  const analyses: SheetAnalysis[] = [];

  for (const grid of workbook.sheets) {
    const region = findDataRegion(grid);
    if (!region) continue;

    const stats = columnStats(grid, region);
    const llm = await classifyColumnsWithLlm(grid, region, stats);
    const { columns, overrides } = assignRoles(grid, region, stats, llm.roles);

    analyses.push({
      grid,
      region,
      stats,
      layout: {
        sheetName: grid.name,
        headerRow: region.headerRow,
        firstDataRow: region.firstDataRow,
        lastDataRow: region.lastDataRow,
        columns,
        overrides,
        source: llm.used ? "llm+heuristic" : "heuristic",
      },
    });
  }

  return {
    analyses,
    layout: {
      tierLayout: detectTierLayout(analyses),
      sheets: analyses.map((a) => a.layout),
    },
  };
}
