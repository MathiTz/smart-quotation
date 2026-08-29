import type { QuotationMetadata } from "@sq/shared";
import { cellAt, type SheetGrid } from "./read-workbook.js";
import type { DataRegion } from "./heuristics.js";

type Pair = { label: string; value: string; date: Date | null };

const LABELS = {
  supplier: ["factory name", "supplier", "vendor", "company", "from", "工厂名称", "供应商", "厂家"],
  currency: ["currency", "ccy", "币种", "货币"],
  date: ["quotation date", "quote date", "date", "issued", "报价日期", "日期"],
  payment: ["payment terms", "payment term", "payment", "terms", "付款", "付款条件", "支付条款"],
  leadTime: ["lead time", "leadtime", "delivery time", "production time", "交期", "交货期", "生产周期"],
};

function matches(label: string, keywords: string[]): boolean {
  const l = label.trim().toLowerCase().replace(/[:：*]/g, "").trim();
  return keywords.some((k) => l === k || l.startsWith(k) || l.includes(k));
}

/**
 * Metadata sits wherever the person who made the file felt like putting it:
 * above the table, below it, split across two cells, split across two rows, or
 * crammed into one cell after a colon. All five shapes appear in the fixtures,
 * so all five are collected before anything is interpreted.
 */
function collectPairs(grid: SheetGrid, region: DataRegion | null): Pair[] {
  const pairs: Pair[] = [];

  for (let r = 0; r < grid.rowCount; r++) {
    if (region && r >= region.headerRow && r <= region.lastDataRow) continue;

    const cells = (grid.rows[r] ?? []).map((c, i) => ({ ...c, index: i })).filter((c) => !c.empty);
    if (cells.length === 0) continue;

    for (const cell of cells) {
      const split = /^(.{2,40}?)\s*[:：]\s*(.+)$/.exec(cell.text);
      if (split) pairs.push({ label: split[1]!, value: split[2]!.trim(), date: null });
    }

    // Merged label cells repeat their text, so only a genuinely different value counts.
    const first = cells[0]!;
    const next = cells.find((c) => c.index > first.index && c.text !== first.text);
    if (next) pairs.push({ label: first.text, value: next.text, date: next.date });

    // A label with nothing beside it often has its value on the row below.
    if (!next && r + 1 < grid.rowCount) {
      const below = cellAt(grid, r + 1, first.index);
      if (!below.empty && below.text !== first.text) {
        pairs.push({ label: first.text, value: below.text, date: below.date });
      }
    }
  }

  return pairs;
}

/** "T/T 30/70", "30 / 70", "100% upfront" all describe a milestone split. */
export function normalisePaymentTerms(raw: string): string | null {
  const split = /(\d{1,3})\s*(?:\/\s*(\d{1,3}))+/.exec(raw);
  if (split) {
    const all = raw.match(/\d{1,3}(?:\s*\/\s*\d{1,3})+/)?.[0];
    if (all) {
      const parts = all.split("/").map((p) => Number(p.trim()));
      if (parts.every((n) => n > 0 && n <= 100)) return parts.join("/");
    }
  }
  if (/\b100\s*%?\b/.test(raw) && /(upfront|advance|prepaid|in advance|全额|预付)/i.test(raw)) return "100";
  if (/^\s*100\s*%?\s*$/.test(raw)) return "100";
  return null;
}

export function parseLeadTimeDays(raw: string): number | null {
  const m = /(\d{1,4})\s*(?:days?|day|天|工作日)?/i.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 && n <= 720 ? n : null;
}

function parseDate(value: string, date: Date | null): string | null {
  if (date) return date.toISOString().slice(0, 10);
  const iso = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(value);
  if (iso) {
    const [, y, m, d] = iso;
    return `${y}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString().slice(0, 10);
}

export function extractMetadata(
  sheets: Array<{ grid: SheetGrid; region: DataRegion | null }>,
): QuotationMetadata {
  const metadata: QuotationMetadata = {
    supplierName: null,
    currency: "USD",
    quotationDate: null,
    leadTimeDays: null,
    paymentTerms: null,
  };

  for (const { grid, region } of sheets) {
    for (const pair of collectPairs(grid, region)) {
      if (!metadata.supplierName && matches(pair.label, LABELS.supplier) && /[A-Za-z\u4e00-\u9fff]/.test(pair.value)) {
        metadata.supplierName = pair.value;
      }
      if (matches(pair.label, LABELS.currency)) {
        const code = /\b([A-Z]{3})\b/.exec(pair.value.toUpperCase())?.[1];
        if (code) metadata.currency = code;
      }
      if (!metadata.quotationDate && matches(pair.label, LABELS.date)) {
        metadata.quotationDate = parseDate(pair.value, pair.date);
      }
      // Lead time before payment: "Lead Time (Days)" contains "terms" in no
      // language, but "payment terms" and "terms" overlap enough to be careful.
      if (!metadata.leadTimeDays && matches(pair.label, LABELS.leadTime)) {
        metadata.leadTimeDays = parseLeadTimeDays(pair.value);
      }
      if (!metadata.paymentTerms && matches(pair.label, LABELS.payment) && !matches(pair.label, LABELS.leadTime)) {
        metadata.paymentTerms = normalisePaymentTerms(pair.value);
      }
    }
  }

  if (!metadata.supplierName) {
    // No labelled vendor field. The first substantial line of text in the file
    // is the letterhead far more often than it is anything else.
    outer: for (const { grid, region } of sheets) {
      const limit = region ? region.headerRow : Math.min(grid.rowCount, 10);
      for (let r = 0; r < limit; r++) {
        for (const cell of grid.rows[r] ?? []) {
          const t = cell.text.trim();
          if (t.length < 3 || t.length > 60) continue;
          if (cell.number !== null || cell.date) continue;
          if (!/[A-Za-z\u4e00-\u9fff]/.test(t)) continue;
          if (/^(quotation|quote|invoice|purchase order|date|to|from)$/i.test(t)) continue;
          metadata.supplierName = t;
          break outer;
        }
      }
    }
  }

  return metadata;
}
