import { beforeAll, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { CatalogIndex, loadCatalogFromCsv, matchLines, summariseMatches } from "./index.js";
import { editDistance, foldHomoglyphs, normalizeSku, skuPrefix } from "./normalize.js";
import { parseQuotation } from "../parser/index.js";

const fixture = (n: number) => resolve(import.meta.dirname, "../../../../fixtures", `quotation_${n}.xlsx`);

let catalog: CatalogIndex;
beforeAll(() => {
  catalog = loadCatalogFromCsv();
});

describe("normalisation", () => {
  it("strips everything that is formatting rather than identity", () => {
    expect(normalizeSku("ob007-bas-l")).toBe("OB007BASL");
    expect(normalizeSku("OB007 BAS L")).toBe("OB007BASL");
    expect(normalizeSku("OB007_BAS_L")).toBe("OB007BASL");
  });

  it("collapses the character pairs that look alike on a printed sheet", () => {
    expect(foldHomoglyphs("OB002")).toBe(foldHomoglyphs("0B002"));
    expect(foldHomoglyphs("ICB")).toBe(foldHomoglyphs("1CB"));
  });

  it("buckets by leading letters so fuzzy search stays local", () => {
    expect(skuPrefix("OPP029-ICB-36-26")).toBe("OPP");
    expect(skuPrefix("EKA003-GLW-M")).toBe("EKA");
  });

  it("gives up early once the edit budget is blown", () => {
    expect(editDistance("ABCDEF", "ABCDEF")).toBe(0);
    expect(editDistance("ABCDEF", "ABCDEX")).toBe(1);
    expect(editDistance("ABCDEF", "ZZZZZZ", 2)).toBeGreaterThan(2);
  });
});

describe("catalog matching tiers", () => {
  it("matches a clean SKU exactly and with full confidence", () => {
    const result = catalog.match("OB007-BAS-L");
    expect(result.method).toBe("exact");
    expect(result.confidence).toBe(1);
    expect(result.sku).toBe("OB007-BAS-L");
  });

  it("ignores case and punctuation", () => {
    expect(catalog.match("ob007 bas l").sku).toBe("OB007-BAS-L");
  });

  it.each([
    ["0PP027-FNV-28-30", "OPP027-FNV-28-30", "zero typed for the letter O"],
    ["MBOO2-LGR-S", "MB002-LGR-S", "letter O typed for zero"],
    ["PWE016-lCB-L", "PWE016-ICB-L", "lowercase L typed for capital I"],
    ["MB013-0BS-XL", "MB013-OBS-XL", "zero for O mid-code"],
    ["MH01O-OBS-M", "MH010-OBS-M", "O for zero at the end of the digits"],
  ])("recovers %s as %s (%s)", (typo, expected) => {
    const result = catalog.match(typo);
    expect(result.sku).toBe(expected);
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it.each([
    ["EKA03-GLW-M", "EKA003-GLW-M"],
    ["PWW17-GLW-XS", "PWW017-GLW-XS"],
    ["PHS8-SLT-S", "PHS008-SLT-S"],
  ])("restores the dropped leading zero in %s", (typo, expected) => {
    const result = catalog.match(typo);
    expect(result.method).toBe("padded");
    expect(result.sku).toBe(expected);
  });

  it("falls back to edit distance for a transposed digit", () => {
    const result = catalog.match("PWW106-OBS-L");
    expect(result.method).toBe("fuzzy");
    expect(result.sku).toBe("PWW006-OBS-L");
    expect(result.confidence).toBeLessThan(0.9);
  });
});

describe("when the matcher must not guess", () => {
  it("surfaces every candidate when a SKU is missing its size segment", () => {
    // AP004-GLW-28 could be any of five real products. Picking one would put the
    // wrong garment on a purchase order, so a human decides instead.
    const result = catalog.match("AP004-GLW-28");
    expect(result.method).toBe("ambiguous");
    expect(result.sku).toBeNull();
    expect(result.candidates.length).toBeGreaterThan(1);
    expect(result.candidates.map((c) => c.sku)).toContain("AP004-GLW-28-24");
  });

  it("reports nothing rather than a distant neighbour when the family does not exist", () => {
    // There is no AQ prefix anywhere in the catalog.
    const result = catalog.match("AQ009-0BS-XS");
    expect(result.method).toBe("unmatched");
    expect(result.sku).toBeNull();
    expect(result.candidates).toEqual([]);
  });

  it("does not invent a match for obvious rubbish", () => {
    expect(catalog.match("ZZZZ999-XXX-QQ").sku).toBeNull();
    expect(catalog.match("").method).toBe("unmatched");
  });
});

describe("matching a parsed quotation end to end", () => {
  it("matches every SKU in the clean files", async () => {
    for (const n of [1, 4]) {
      const parsed = await parseQuotation(fixture(n));
      const summary = summariseMatches(matchLines(parsed.lines, catalog));
      expect(summary.unmatched, `quotation_${n}`).toBe(0);
      expect(summary.matched).toBe(summary.total);
    }
  });

  it("recovers all seven typos in quotation_2 without human input", async () => {
    const parsed = await parseQuotation(fixture(2));
    const summary = summariseMatches(matchLines(parsed.lines, catalog));
    expect(summary.total).toBe(25);
    expect(summary.matched).toBe(25);
    expect(summary.byMethod.exact).toBe(18);
  });

  it("flags exactly the two undecidable lines in quotation_3", async () => {
    const parsed = await parseQuotation(fixture(3));
    const matched = matchLines(parsed.lines, catalog);
    const summary = summariseMatches(matched);

    expect(summary.unmatched).toBe(1);
    expect(summary.byMethod.ambiguous).toBe(1);

    const ambiguous = matched.find((l) => l.matchMethod === "ambiguous")!;
    expect(ambiguous.rawSku).toBe("AP004-GLW-28");
  });

  it("gives the same answer for a SKU quoted at two different tiers", async () => {
    const parsed = await parseQuotation(fixture(2));
    const matched = matchLines(parsed.lines, catalog);
    const both = matched.filter((l) => l.rawSku === "EKA03-GLW-M");
    expect(both).toHaveLength(2);
    expect(both[0]!.matchedSku).toBe(both[1]!.matchedSku);
  });
});
