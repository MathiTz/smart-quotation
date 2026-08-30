import { AS_QUOTED, type ParsedLine } from "@sq/shared";
import { cellAt, cleanFloat, roundMoney, roundPrice } from "./read-workbook.js";
import { looksLikeSku, tidySku } from "./heuristics.js";
import type { SheetAnalysis } from "./detect-layout.js";

export { AS_QUOTED };

export function extractLines(analyses: SheetAnalysis[]): { lines: ParsedLine[]; warnings: string[] } {
  const lines: ParsedLine[] = [];
  const warnings: string[] = [];

  for (const analysis of analyses) {
    const { grid, layout, region } = analysis;
    const col = (role: string) => layout.columns.filter((c) => c.role === role);

    const skuCol = col("sku")[0];
    if (!skuCol) {
      warnings.push(`sheet "${grid.name}": no SKU column found, skipped`);
      continue;
    }

    const descCol = col("description")[0];
    const qtyCol = col("quantity")[0];
    const totalCol = col("line_total")[0];
    const discountCol = col("discount_pct")[0];
    const priceCols = col("unit_price");

    if (priceCols.length === 0) {
      warnings.push(`sheet "${grid.name}": no price column found, skipped`);
      continue;
    }

    // Tier columns carry their quantity in the header; every other layout takes
    // the quantity from the row.
    const tierColumns = priceCols.filter((c) => c.tierQuantity !== null);
    const pricingColumns = tierColumns.length > 0 ? tierColumns : [priceCols[0]!];

    // The region is the longest unbroken run of line items, so a cluster of
    // malformed rows can cut a price list in half and leave the tail outside it.
    // Dropping rows is sometimes right — a totals block is not an order — but
    // dropping them in silence is not, because the missing lines look exactly
    // like lines the supplier never quoted.
    const orphaned: number[] = [];
    for (let r = 0; r < grid.rowCount; r++) {
      if (r >= region.firstDataRow && r <= region.lastDataRow) continue;
      if (looksLikeSku(cellAt(grid, r, skuCol.index).text)) orphaned.push(r + 1);
    }
    if (orphaned.length > 0) {
      warnings.push(
        `sheet "${grid.name}": ${orphaned.length} row(s) outside the detected table look like line ` +
          `items and were not read (row ${orphaned.slice(0, 6).join(", ")}${orphaned.length > 6 ? ", …" : ""})`,
      );
    }

    for (let r = region.firstDataRow; r <= region.lastDataRow; r++) {
      // Repaired before the test, so an autocorrected dash does not delete a row.
      const rawSku = tidySku(cellAt(grid, r, skuCol.index).text);
      // Skips TOTAL rows, blank separators and stray notes without needing to
      // know what they look like: they simply do not carry a SKU.
      if (!looksLikeSku(rawSku)) continue;

      const rawDescription = descCol ? cellAt(grid, r, descCol.index).text || null : null;
      const discountPct = discountCol ? (cellAt(grid, r, discountCol.index).number ?? 0) : 0;

      for (const priceColumn of pricingColumns) {
        const listUnitPrice = cellAt(grid, r, priceColumn.index).number;
        // An absent price is the file declining to quote this line at this tier.
        // Not zero, not free: no offer. Coverage picks it up as a gap later.
        if (listUnitPrice === null || listUnitPrice <= 0) continue;

        const rowQty = qtyCol ? cellAt(grid, r, qtyCol.index).number : null;
        const quantity = priceColumn.tierQuantity ?? (rowQty !== null ? Math.round(rowQty) : null);
        if (quantity === null || quantity <= 0) continue;

        const discounted = listUnitPrice * (1 - discountPct / 100);
        const unitPrice = roundPrice(discounted);
        // Multiply before rounding. Rounding the unit price first turns a 10%
        // discount on $6.25 into $5.63 and the 5000-unit total into $28,150
        // instead of the $28,125 the supplier actually wrote.
        const computedTotal = roundMoney(discounted * quantity);
        const statedTotal = totalCol ? cellAt(grid, r, totalCol.index).number : null;

        // The sheet's own total is authoritative when it exists, but a
        // disagreement is surfaced rather than silently reconciled.
        const totalMismatch =
          statedTotal !== null && Math.abs(cleanFloat(statedTotal) - computedTotal) > 0.02;
        if (totalMismatch) {
          warnings.push(
            `sheet "${grid.name}" row ${r + 1}: ${rawSku} states a total of ${roundMoney(statedTotal!)} but ${quantity} x ${unitPrice} is ${computedTotal}`,
          );
        }

        lines.push({
          rawSku,
          rawDescription,
          quantity,
          unitPrice,
          listUnitPrice: roundPrice(listUnitPrice),
          discountPct,
          lineTotal: statedTotal !== null ? roundMoney(statedTotal) : computedTotal,
          tierQuantity: quantity,
          sheetName: grid.name,
          rowNumber: r + 1,
          totalMismatch,
        });
      }
    }
  }

  return { lines, warnings };
}

function skusByTier(lines: ParsedLine[]): Map<number, Set<string>> {
  const bySku = new Map<number, Set<string>>();
  for (const line of lines) {
    if (!bySku.has(line.tierQuantity)) bySku.set(line.tierQuantity, new Set());
    bySku.get(line.tierQuantity)!.add(line.rawSku);
  }
  return bySku;
}

/**
 * The volume choices the file actually offers, ascending. A quantity that
 * appears on one line is that line's order size, not a tier, so `quotation_3`
 * yields [5000] rather than the seventeen distinct quantities in the sheet.
 */
export function tiersFrom(lines: ParsedLine[]): number[] {
  const skus = new Set(lines.map((l) => l.rawSku));
  if (skus.size === 0) return [];
  return [...skusByTier(lines).entries()]
    .filter(([, covered]) => covered.size >= Math.max(2, skus.size * 0.25))
    .map(([tier]) => tier)
    .sort((a, b) => a - b);
}

/**
 * Picks the volume the brand is most likely buying: the largest tier the file
 * prices for nearly every SKU. When no single quantity covers the sheet — a
 * mixed basket like `quotation_4.xlsx` — there is no tier to choose and each
 * line keeps its own quoted quantity.
 */
export function suggestTier(lines: ParsedLine[]): number {
  const skus = new Set(lines.map((l) => l.rawSku));
  if (skus.size === 0) return AS_QUOTED;

  const covering = [...skusByTier(lines).entries()]
    .filter(([, covered]) => covered.size >= skus.size * 0.8)
    .map(([tier]) => tier)
    .sort((a, b) => b - a);

  return covering[0] ?? AS_QUOTED;
}
