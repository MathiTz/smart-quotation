import ExcelJS from "exceljs";

export type Cell = {
  /** Trimmed display text. Empty string when the cell holds nothing. */
  text: string;
  /** Set when the cell is numeric, or when its text is unambiguously a number. */
  number: number | null;
  date: Date | null;
  isFormula: boolean;
  empty: boolean;
};

export type SheetGrid = {
  name: string;
  /** Zero-based, rectangular, and already unmerged. */
  rows: Cell[][];
  rowCount: number;
  colCount: number;
};

export type Workbook = { sheets: SheetGrid[] };

const EMPTY: Cell = { text: "", number: null, date: null, isFormula: false, empty: true };

/**
 * Excel stores 23988 as 23987.999999999996 once a formula has touched it. Left
 * alone that becomes a line total that disagrees with quantity times price, so
 * every number coming out of the sheet is snapped back to 6 decimal places.
 */
export function cleanFloat(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const rounded = Number(n.toFixed(6));
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function roundMoney(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Unit prices keep four decimals. At 5000 units a rounded half-cent is a $25
 * error in the line total, which is exactly the kind of drift that makes a PO
 * disagree with the quotation it came from.
 */
export function roundPrice(n: number): number {
  return Math.round((n + Number.EPSILON) * 10_000) / 10_000;
}

/**
 * A currency-formatted string as typed by a human: "$1,234.50", "USD 12.30",
 * "(45.00)" for a negative, "12,5" in a European locale. Returns null rather
 * than guessing when the text is not really a number, because a column of nulls
 * is what tells the heuristics this is not a price column.
 */
export function parseNumeric(text: string): number | null {
  if (!text) return null;
  let s = text.trim();
  if (!s) return null;

  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }

  s = s.replace(/[^\d.,\-+]/g, "");
  if (!s || !/\d/.test(s)) return null;

  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");

  if (lastComma >= 0 && lastDot >= 0) {
    // Both present, so the rightmost is the decimal point and the other groups.
    s = lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (lastComma >= 0) {
    // Only commas, which is the genuinely ambiguous case: "5,000" is five
    // thousand to an American and five to a German. Decided on shape rather than
    // locale, because the file does not say which one wrote it — a grouping
    // separator repeats and always takes exactly three digits, a decimal comma
    // appears once and hardly ever has three behind it. So "5,000" is five
    // thousand, "11,32" is eleven and a third, and a leading zero settles it the
    // other way because nobody writes nought thousand.
    const groups = s.split(",");
    const grouped =
      groups.length > 2 || (/^\d{3}$/.test(groups.at(-1) ?? "") && groups[0] !== "0");
    s = grouped ? s.replace(/,/g, "") : s.replace(",", ".");
  }

  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return cleanFloat(negative ? -n : n);
}

function toCell(raw: ExcelJS.CellValue): Cell {
  if (raw === null || raw === undefined) return EMPTY;

  if (raw instanceof Date) {
    return { text: raw.toISOString().slice(0, 10), number: null, date: raw, isFormula: false, empty: false };
  }

  if (typeof raw === "number") {
    return { text: String(cleanFloat(raw)), number: cleanFloat(raw), date: null, isFormula: false, empty: false };
  }

  if (typeof raw === "boolean") {
    return { text: String(raw), number: null, date: null, isFormula: false, empty: false };
  }

  if (typeof raw === "string") {
    const text = raw.trim();
    return { text, number: parseNumeric(text), date: null, isFormula: false, empty: text === "" };
  }

  if (typeof raw === "object") {
    // A formula cell. Excel caches the last computed value; we use that rather
    // than evaluating, because a quotation is a document, not a spreadsheet
    // engine, and the number the supplier saw is the number they meant.
    if ("result" in raw && raw.result !== undefined) {
      const inner = toCell(raw.result as ExcelJS.CellValue);
      return { ...inner, isFormula: true, empty: inner.empty };
    }
    if ("richText" in raw && Array.isArray(raw.richText)) {
      const text = raw.richText.map((r) => r.text).join("").trim();
      return { text, number: parseNumeric(text), date: null, isFormula: false, empty: text === "" };
    }
    if ("text" in raw && typeof raw.text === "string") {
      const text = raw.text.trim();
      return { text, number: parseNumeric(text), date: null, isFormula: false, empty: text === "" };
    }
    // An error cell (#REF!, #DIV/0!) or a formula with no cached result. Both
    // are "no usable value", which the extractor treats as a gap rather than a zero.
    return EMPTY;
  }

  return EMPTY;
}

export async function readWorkbook(source: Buffer | string): Promise<Workbook> {
  const wb = new ExcelJS.Workbook();
  try {
    if (typeof source === "string") await wb.xlsx.readFile(source);
    else await wb.xlsx.load(source as unknown as ArrayBuffer);
  } catch (error) {
    // An XLSX is a zip. Anything else — a CSV, a PDF, a renamed .xls — fails
    // deep inside the zip reader with a message about central directories, which
    // is not something to put in front of someone who picked the wrong file.
    throw new Error(
      "this file is not a readable .xlsx workbook (an .xls or .csv saved with an .xlsx name will do this)",
      { cause: error },
    );
  }

  const sheets: SheetGrid[] = [];

  wb.eachSheet((ws) => {
    // Trailing formatted-but-empty rows and columns inflate these counts, so the
    // grid is built optimistically and trimmed to the last row that holds data.
    const maxRow = Math.min(ws.rowCount, 5000);
    const maxCol = Math.min(Math.max(ws.columnCount, 1), 200);

    const rows: Cell[][] = [];
    for (let r = 1; r <= maxRow; r++) {
      const row = ws.getRow(r);
      const cells: Cell[] = [];
      for (let c = 1; c <= maxCol; c++) {
        const cell = row.getCell(c);
        // exceljs points every covered cell at its merge master, so reading
        // through `master` is what turns a merged range into a full grid.
        const value = cell.isMerged && cell.master ? cell.master.value : cell.value;
        cells.push(toCell(value));
      }
      rows.push(cells);
    }

    let lastRow = -1;
    let lastCol = -1;
    rows.forEach((cells, r) => {
      cells.forEach((cell, c) => {
        if (cell.empty) return;
        if (r > lastRow) lastRow = r;
        if (c > lastCol) lastCol = c;
      });
    });

    if (lastRow < 0) return;

    const trimmed = rows.slice(0, lastRow + 1).map((cells) => cells.slice(0, lastCol + 1));
    sheets.push({
      name: ws.name,
      rows: trimmed,
      rowCount: trimmed.length,
      colCount: lastCol + 1,
    });
  });

  return { sheets };
}

export function cellAt(grid: SheetGrid, row: number, col: number): Cell {
  return grid.rows[row]?.[col] ?? EMPTY;
}

/** The whole row as one lowercase string. Cheap way to look for "payment terms". */
export function rowText(grid: SheetGrid, row: number): string {
  return (grid.rows[row] ?? [])
    .map((c) => c.text)
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}
