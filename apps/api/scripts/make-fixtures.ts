/**
 * Builds the extra quotation fixtures.
 *
 * The four files the brief supplied cover four shapes. These six are the ones a
 * sourcing inbox actually fills up with, and each exists to break a specific
 * assumption in the parser rather than to add another tidy table:
 *
 *   5  merged multi-row headers, tier prices, subtotal and total rows mixed into
 *      the data
 *   6  every number stored as text — currency symbols, thousands separators, a
 *      European decimal comma, a non-breaking space
 *   7  SKUs as humans type them: wrong case, padded, en-dashes, zero-for-O, and
 *      three that are not in the catalogue at all
 *   8  the real table on the third sheet, offset down and to the right, behind a
 *      read-me and a terms sheet
 *   9  headers that lie — the price column holds quantities and vice versa, with
 *      a total column that proves it
 *  10  the same SKU quoted twice, gaps where the supplier would not quote, and an
 *      MOQ column that is not a price
 *
 * Generated rather than committed by hand so the intent is reviewable: a binary
 * fixture nobody can read is a test you cannot argue with. Re-run with
 * `pnpm fixtures`; the output is deterministic.
 */
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import ExcelJS from "exceljs";

const OUT = resolve(import.meta.dirname, "../../../fixtures");

/** Real catalogue SKUs, so matching has something to succeed at. */
const CATALOG = [
  { sku: "OB007-BAS-L", name: "Thermo Mesh Crew" },
  { sku: "MC026-FNV-S", name: "Keylock Screw-Lock" },
  { sku: "MC001-GLW-M", name: "HMS Twist-Lock" },
  { sku: "MH010-GLW-L", name: "Rescue Tech" },
  { sku: "MR007-LGR-M", name: "Rescue Static 12mm" },
  { sku: "PWW011-FNV-L", name: "GripShell Wrist Protector" },
  { sku: "EKF014-GLW-M", name: "Summit 112" },
  { sku: "MH008-SLT-L", name: "Alpine Core" },
  { sku: "ESF005-DWD-XS", name: "Backcountry Rail" },
  { sku: "MC007-ICB-XL", name: "Screw-Gate Alpine" },
  { sku: "PHK009-SRD-M", name: "AeroShell" },
  { sku: "OPP024-BAS-32-26", name: "Carve Race Pant" },
  { sku: "AP001-FNV-36-28", name: "Traverse Softshell Pant" },
  { sku: "CBC007-SIL-10", name: "Stew Casserole" },
  { sku: "CBC004-SRD-12", name: "Deep Braiser" },
  { sku: "OPP010-EOR-28-24", name: "Backcountry Insulated Pant" },
];

/** Deterministic pseudo-random, so re-running produces byte-identical fixtures. */
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

const price = (r: () => number, lo: number, hi: number) =>
  Math.round((lo + r() * (hi - lo)) * 100) / 100;

async function save(wb: ExcelJS.Workbook, n: number) {
  const path = resolve(OUT, `quotation_${n}.xlsx`);
  await wb.xlsx.writeFile(path);
  console.log(`wrote ${path}`);
}

/** 5 — merged banner, two-row tier header, summary rows inside the sheet. */
async function five() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("PRICE LIST");
  const r = rng(5);

  ws.mergeCells("A1:F1");
  ws.getCell("A1").value = "HANOI GARMENT EXPORT JSC — OFFICIAL QUOTATION";
  ws.mergeCells("A2:F2");
  ws.getCell("A2").value = "Lot 14, Bac Thang Long Industrial Park, Hanoi, Vietnam";
  ws.getCell("A4").value = "Quote ref:";
  ws.getCell("B4").value = "HG-2026-0418";
  ws.getCell("A5").value = "Valid until:";
  ws.getCell("B5").value = "2026-06-30";
  ws.getCell("D4").value = "Payment terms:";
  ws.getCell("E4").value = "30/70";
  ws.getCell("D5").value = "Lead time (days):";
  ws.getCell("E5").value = 45;

  // The tier label sits above the two price columns and is merged across them,
  // so the header is only readable if you look at two rows at once.
  ws.mergeCells("C7:D7");
  ws.getCell("C7").value = "Unit FOB price (USD)";
  ws.getCell("A8").value = "Style code";
  ws.getCell("B8").value = "Description";
  ws.getCell("C8").value = "1,000 pcs";
  ws.getCell("D8").value = "5,000 pcs";
  ws.getCell("E8").value = "Fabric";

  let row = 9;
  CATALOG.slice(0, 12).forEach((item, i) => {
    const base = price(r, 8, 90);
    ws.getRow(row).values = [
      item.sku,
      item.name,
      base,
      Math.round(base * 0.88 * 100) / 100,
      i % 3 === 0 ? "Recycled poly" : "Nylon 66",
    ];
    row++;
    // A blank spacer every few lines, the way a human formats a long list.
    if (i === 5) row++;
  });

  // Summary rows that are not line items. A parser that takes every numeric row
  // buys a product called "SUBTOTAL".
  ws.getCell(`A${row}`).value = "SUBTOTAL";
  ws.getCell(`C${row}`).value = { formula: `SUM(C9:C${row - 1})` } as ExcelJS.CellFormulaValue;
  row++;
  ws.getCell(`A${row}`).value = "Freight (est.)";
  ws.getCell(`C${row}`).value = 4200;
  row++;
  ws.getCell(`A${row}`).value = "TOTAL";
  ws.getCell(`C${row}`).value = { formula: `SUM(C${row - 2}:C${row - 1})` } as ExcelJS.CellFormulaValue;
  row += 2;
  ws.getCell(`A${row}`).value = "Note: prices exclude duty. MOQ 500 pcs per colourway.";

  await save(wb, 5);
}

/** 6 — every number is a string, formatted the way a person types money. */
async function six() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Offer");
  const r = rng(6);

  ws.getCell("A1").value = "Supplier: Anadolu Tekstil A.Ş.";
  ws.getCell("A2").value = "Currency: USD";
  ws.getCell("A3").value = "Terms: 50/50 — Lead time 38 days";

  ws.getRow(5).values = ["SKU", "Item", "Order qty", "Unit price", "Line total"];

  let row = 6;
  for (const item of CATALOG.slice(0, 11)) {
    const unit = price(r, 6, 70);
    const qty = [1000, 2500, 5000][Math.floor(r() * 3)]!;
    const total = Math.round(unit * qty * 100) / 100;

    // Deliberately inconsistent: this is one supplier's spreadsheet, typed by
    // several people over several weeks.
    const unitText =
      row % 3 === 0
        ? `$${unit.toFixed(2)}`
        : row % 3 === 1
          ? `USD ${unit.toFixed(2)}`
          : unit.toFixed(2).replace(".", ","); // European decimal comma

    ws.getRow(row).values = [
      item.sku,
      item.name,
      row % 2 === 0 ? qty.toLocaleString("en-US") : `${qty}`.replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0"),
      unitText,
      `${total.toLocaleString("en-US", { minimumFractionDigits: 2 })} `, // trailing space
    ];
    row++;
  }

  await save(wb, 6);
}

/** 7 — SKUs as they arrive from a supplier who retyped them from a PDF. */
async function seven() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("RFQ response");
  const r = rng(7);

  ws.getCell("A1").value = "Vendor: Coimbatore Knits Pvt Ltd";
  ws.getCell("A2").value = "Payment: 100";
  ws.getCell("A3").value = "Lead time: 52 days";

  ws.getRow(5).values = ["Item code", "Qty", "Price/pc", "Remarks"];

  // Each mangling is one a real file has: case, padding, the wrong dash, a zero
  // typed for a letter O, a footnote marker left glued to the code.
  const mangled: Array<[string, string]> = [
    ["ob007-bas-l", "lowercased"],
    ["  MC026-FNV-S ", "padded"],
    ["MC001\u2013GLW\u2013M", "en-dash instead of hyphen"],
    ["0B007-BAS-L", "zero typed for the letter O"],
    ["MH010-GLW-L*", "footnote marker glued on"],
    ["MR007 LGR M", "spaces instead of hyphens"],
    ["PWW011-FNV-L", "clean"],
    ["EKF014-GLW-M", "clean"],
    ["ZZQ999-XXX-M", "not in the catalogue"],
    ["DISCONTINUED-01", "not in the catalogue"],
    ["SAMPLE ONLY", "not in the catalogue"],
  ];

  let row = 6;
  for (const [sku, remark] of mangled) {
    ws.getRow(row).values = [sku, 5000, price(r, 9, 64), remark];
    row++;
  }

  await save(wb, 7);
}

/** 8 — the table is on the third sheet, pushed down and right. */
async function eight() {
  const wb = new ExcelJS.Workbook();
  const r = rng(8);

  const readme = wb.addWorksheet("READ ME FIRST");
  readme.getCell("B2").value = "Thank you for your enquiry.";
  readme.getCell("B4").value =
    "Pricing is on the third tab. Please confirm quantities before 30 June.";
  readme.getCell("B6").value = "All prices FOB Chittagong. Duty and freight are not included.";

  const terms = wb.addWorksheet("Terms & Conditions");
  terms.getCell("A1").value = "1. Prices valid 90 days from the date of issue.";
  terms.getCell("A2").value = "2. Payment 30/70 against proforma invoice.";
  terms.getCell("A3").value = "3. Lead time 55 days from receipt of approved sample.";
  terms.getCell("A4").value = "4. Claims must be raised within 14 days of receipt.";

  const ws = wb.addWorksheet("Pricing");
  ws.getCell("C2").value = "Chittagong Apparel Mills Ltd";
  ws.getCell("C3").value = "Quotation 2026/CAM/771";

  // Header on row 9, first column at D: nothing useful in A:C or rows 1-8.
  ws.getRow(9).values = [null, null, null, "SKU", "Product", "Qty", "Unit price USD"];

  let row = 10;
  for (const item of CATALOG.slice(2, 13)) {
    ws.getRow(row).values = [null, null, null, item.sku, item.name, 5000, price(r, 7, 80)];
    row++;
  }

  await save(wb, 8);
}

/** 9 — the headers are wrong; only the arithmetic says which column is which. */
async function nine() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  const r = rng(9);

  ws.getCell("A1").value = "PT Sinar Busana — Quotation";
  ws.getCell("A2").value = "Lead time (days): 42";
  ws.getCell("A3").value = "Payment terms: 40/60";

  // Says price then quantity. Holds quantity then price. The total column is the
  // only thing that settles it, and it is consistent on every row.
  ws.getRow(5).values = ["SKU", "Description", "Unit price", "Quantity", "Amount"];

  let row = 6;
  for (const item of CATALOG.slice(0, 12)) {
    const qty = [1000, 2000, 5000][Math.floor(r() * 3)]!;
    const unit = price(r, 5, 75);
    ws.getRow(row).values = [item.sku, item.name, qty, unit, Math.round(qty * unit * 100) / 100];
    row++;
  }

  await save(wb, 9);
}

/** 10 — duplicate lines, holes in the pricing, and a column that is not money. */
async function ten() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Quote");
  const r = rng(10);

  ws.getCell("A1").value = "Factory: Guangzhou Yifeng Garments Co., Ltd";
  ws.getCell("A2").value = "Lead time (days): 33";
  ws.getCell("A3").value = "Payment terms: 30/40/30";

  ws.getRow(5).values = ["SKU", "Description", "MOQ", "Qty 1000", "Qty 5000", "Notes"];

  const rows: Array<[string, string, number, number | null, number | null, string]> = [];
  for (const item of CATALOG.slice(0, 10)) {
    const base = price(r, 6, 85);
    // Some tiers are simply not quoted. A blank is not a zero.
    const at5k = r() > 0.25 ? Math.round(base * 0.86 * 100) / 100 : null;
    rows.push([item.sku, item.name, 500, base, at5k, at5k === null ? "5k tier on request" : ""]);
  }

  // The same style quoted twice, at different MOQs, a fortnight apart. Which one
  // stands is a question for a person, but it must not silently double the order.
  const dupe = CATALOG[3]!;
  rows.push([dupe.sku, dupe.name, 300, price(r, 6, 85), null, "revised 12 May, supersedes above"]);
  const dupe2 = CATALOG[7]!;
  rows.push([dupe2.sku, dupe2.name, 1000, price(r, 6, 85), null, "second colourway, same code"]);

  let row = 6;
  for (const values of rows) {
    ws.getRow(row).values = values as ExcelJS.CellValue[];
    row++;
  }

  await save(wb, 10);
}

await mkdir(OUT, { recursive: true });
await five();
await six();
await seven();
await eight();
await nine();
await ten();
