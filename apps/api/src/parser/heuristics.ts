import type { ColumnRole } from "@sq/shared";
import { cellAt, type Cell, type SheetGrid } from "./read-workbook.js";

/**
 * A SKU is a compact code: no spaces, letters and digits both present, segments
 * joined by punctuation. Deliberately strict, because this predicate is what
 * decides which rows are line items at all. "90 days", "30/70", "USD" and
 * "2026-02-05" must all fail it, and they do.
 */
export function looksLikeSku(text: string): boolean {
  const s = tidySku(text);
  if (s.length < 4 || s.length > 48) return false;
  if (/\s/.test(s)) return false;
  if (!/^[A-Za-z0-9]+(?:[-_./][A-Za-z0-9]+)*$/.test(s)) return false;
  if (!/[A-Za-z]/.test(s)) return false;
  if (!/\d/.test(s)) return false;
  // A bare ISO date passes every rule above except this one.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return true;
}

/**
 * Repairs the two things that happen to a product code on its way through a word
 * processor and back out of a PDF: hyphens autocorrected into en- or em-dashes,
 * and a footnote marker left glued to the end.
 *
 * This runs before the structural test rather than loosening it, because the
 * test is what decides whether a row is a line item at all — allowing spaces or
 * arbitrary punctuation would let "90 days" and "30/70" through. Repairing known
 * typography keeps the rule strict while stopping a supplier's autocorrect from
 * deleting a row from the order.
 */
export function tidySku(text: string): string {
  return text
    .trim()
    .replace(/[\u2010-\u2015\u2212]/g, "-") // hyphen variants, en/em dash, minus
    .replace(/[*†‡¹²³]+$/, "")
    .trim();
}

/** Prose, not a code: several words, mostly letters. */
export function looksLikeDescription(text: string): boolean {
  const s = text.trim();
  if (s.length < 3) return false;
  const letters = (s.match(/[A-Za-z\u4e00-\u9fff]/g) ?? []).length;
  return letters / s.length > 0.5 && (/\s/.test(s) || /[\u4e00-\u9fff]/.test(s));
}

/**
 * Header words in the languages the fixtures actually use. Only ever a
 * tie-breaker: `quotation_4.xlsx` labels its quantity column "unit price", so a
 * parser that trusts these words gets that file exactly backwards.
 */
const HEADER_WORDS: Record<Exclude<ColumnRole, "ignore">, string[]> = {
  sku: ["sku", "item #", "item no", "item#", "style", "item code", "product code", "article", "货号", "型号", "编号", "款号"],
  description: ["description", "product name", "product", "name", "desc", "品名", "产品", "描述", "名称"],
  quantity: ["qty", "quantity", "pcs", "pieces", "units", "order qty", "数量", "件数"],
  unit_price: ["unit price", "unit cost", "fob price", "fob", "price", "cost", "rate", "单价", "价格", "报价"],
  // "total price" is listed explicitly so it beats "price" on length; otherwise
  // a column headed "Total price" gets claimed as a unit price.
  line_total: ["total price", "line total", "total amount", "total", "amount", "extended", "subtotal", "总价", "金额", "合计"],
  discount_pct: ["discount", "disc", "rebate", "折扣", "优惠"],
  row_number: ["#", "no.", "no", "line", "seq", "序号", "行号"],
};

export function headerRole(header: string): ColumnRole | null {
  const h = header.trim().toLowerCase();
  if (!h) return null;
  let best: { role: ColumnRole; length: number } | null = null;
  for (const [role, words] of Object.entries(HEADER_WORDS)) {
    for (const word of words) {
      if (!h.includes(word)) continue;
      // Longest match wins so "unit price" beats "price" and "total price"
      // does not get claimed by "price".
      if (!best || word.length > best.length) best = { role: role as ColumnRole, length: word.length };
    }
  }
  return best?.role ?? null;
}

/**
 * Pulls the quantity out of a tier header like "Unit FOB Price - Qty 5000".
 * This is the only place a header's text is load-bearing, because when tiers are
 * columns the quantity exists nowhere else in the file.
 */
export function tierQuantityFromHeader(header: string): number | null {
  const h = header.toLowerCase();
  const patterns = [
    /(?:qty|quantity|pcs|moq|数量)\s*[:\-–]?\s*([\d,]+)/i,
    /([\d,]+)\s*(?:pcs|pieces|units|\+)/i,
    /@\s*([\d,]+)/,
  ];
  for (const re of patterns) {
    const m = re.exec(h);
    if (!m) continue;
    const n = Number(m[1]!.replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

export type DataRegion = { headerRow: number; firstDataRow: number; lastDataRow: number };

/**
 * Finds the table by looking for the rows that are line items, then treating
 * whatever sits directly above them as the header. Going the other way round —
 * find a header, assume the table follows — breaks on `quotation_1.xlsx`, whose
 * 15 preamble rows contain better header candidates than the real header does.
 */
// #region data-region
export function findDataRegion(grid: SheetGrid): DataRegion | null {
  const isItemRow = grid.rows.map(
    (cells) => cells.some((c) => !c.empty && looksLikeSku(c.text)) && cells.some((c) => c.number !== null),
  );

  // A single blank or subtotal row inside a table is common, so one non-item row
  // does not end the run. Two in a row does.
  const runs: Array<{ start: number; end: number }> = [];
  let current: { start: number; end: number } | null = null;
  let gap = 0;

  for (let r = 0; r < grid.rowCount; r++) {
    if (isItemRow[r]) {
      if (!current) current = { start: r, end: r };
      current.end = r;
      gap = 0;
    } else if (current) {
      gap++;
      if (gap > 1) {
        runs.push(current);
        current = null;
        gap = 0;
      }
    }
  }
  if (current) runs.push(current);
  if (runs.length === 0) return null;

  const longest = runs.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
  const bestStart = longest.start;
  const bestEnd = longest.end;

  let headerRow = bestStart - 1;
  while (headerRow >= 0) {
    const cells = grid.rows[headerRow] ?? [];
    const labels = cells.filter((c) => !c.empty && c.number === null).length;
    if (labels >= 2) break;
    headerRow--;
  }

  return {
    headerRow: headerRow >= 0 ? headerRow : bestStart - 1,
    firstDataRow: bestStart,
    lastDataRow: bestEnd,
  };
}
// #endregion data-region

export type ColumnStats = {
  index: number;
  header: string;
  cells: Cell[];
  nonEmpty: number;
  numericCount: number;
  integerCount: number;
  skuLikeCount: number;
  descriptionLikeCount: number;
  distinctCount: number;
  numbers: Array<number | null>;
  mean: number;
  max: number;
  isSequential: boolean;
  tierQuantity: number | null;
};

export function columnStats(grid: SheetGrid, region: DataRegion): ColumnStats[] {
  const stats: ColumnStats[] = [];

  for (let c = 0; c < grid.colCount; c++) {
    const cells: Cell[] = [];
    for (let r = region.firstDataRow; r <= region.lastDataRow; r++) cells.push(cellAt(grid, r, c));

    const numbers = cells.map((cell) => cell.number);
    const present = numbers.filter((n): n is number => n !== null);
    const header = region.headerRow >= 0 ? cellAt(grid, region.headerRow, c).text : "";

    stats.push({
      index: c,
      header,
      cells,
      nonEmpty: cells.filter((cell) => !cell.empty).length,
      numericCount: present.length,
      integerCount: present.filter((n) => Number.isInteger(n)).length,
      skuLikeCount: cells.filter((cell) => !cell.empty && looksLikeSku(cell.text)).length,
      descriptionLikeCount: cells.filter((cell) => !cell.empty && looksLikeDescription(cell.text)).length,
      distinctCount: new Set(cells.filter((cell) => !cell.empty).map((cell) => cell.text)).size,
      numbers,
      mean: present.length ? present.reduce((a, b) => a + b, 0) / present.length : 0,
      max: present.length ? Math.max(...present) : 0,
      isSequential: isSequential(present),
      tierQuantity: tierQuantityFromHeader(header),
    });
  }

  return stats;
}

function isSequential(values: number[]): boolean {
  if (values.length < 3) return false;
  if (!values.every((n) => Number.isInteger(n) && n >= 0)) return false;
  return values.every((n, i) => i === 0 || n === values[i - 1]! + 1);
}

export type ArithmeticTriple = {
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  discount: number | null;
  /** Fraction of rows where quantity x price (less discount) reproduced the total. */
  agreement: number;
};

/**
 * The parser's strongest signal, and the reason `quotation_4.xlsx` parses
 * correctly despite its headers being swapped: exactly one assignment of
 * columns to quantity, price and total makes the sheet's own arithmetic work.
 * Labels can lie about which column is which. The multiplication cannot.
 */
export function findArithmeticTriple(stats: ColumnStats[], rowCount: number): ArithmeticTriple | null {
  const numeric = stats.filter((s) => s.numericCount >= Math.max(2, rowCount * 0.5));
  if (numeric.length < 3) return null;

  const discountCandidates: Array<ColumnStats | null> = [
    null,
    ...numeric.filter((s) => s.max <= 100 && s.mean >= 0),
  ];

  let best: ArithmeticTriple | null = null;

  for (const q of numeric) {
    // Quantities are whole units. A column of 7.92s is a price, whatever it is called.
    if (q.integerCount < q.numericCount * 0.9) continue;
    for (const p of numeric) {
      if (p.index === q.index) continue;
      for (const t of numeric) {
        if (t.index === q.index || t.index === p.index) continue;
        for (const d of discountCandidates) {
          if (d && (d.index === q.index || d.index === p.index || d.index === t.index)) continue;

          // #region arithmetic-check
          let hits = 0;
          let tested = 0;
          for (let i = 0; i < rowCount; i++) {
            const qv = q.numbers[i];
            const pv = p.numbers[i];
            const tv = t.numbers[i];
            if (qv == null || pv == null || tv == null) continue;
            tested++;
            const discount = d ? (d.numbers[i] ?? 0) : 0;
            const expected = qv * pv * (1 - discount / 100);
            // Excel's own totals carry float noise (23987.999999999996), so the
            // tolerance is relative rather than exact.
            if (Math.abs(expected - tv) <= Math.max(0.02, Math.abs(tv) * 1e-6)) hits++;
          }
          // #endregion arithmetic-check

          if (tested < 2) continue;
          const agreement = hits / tested;
          if (agreement < 0.6) continue;
          if (best && agreement <= best.agreement) continue;

          best = {
            quantity: q.index,
            unitPrice: p.index,
            lineTotal: t.index,
            discount: d?.index ?? null,
            agreement,
          };
        }
      }
    }
  }

  return best;
}
