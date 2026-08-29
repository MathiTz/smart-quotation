import { beforeAll, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  DEFAULT_CONSTRAINTS,
  paymentCashFlowCost,
  paymentMilestones,
  redistributeWeights,
  scoreOptions,
  supplierProfile,
  type Basket,
  type NegotiationConstraints,
  type SupplierProfile,
} from "@sq/shared";
import { clampOffer, humaniseFieldNames } from "../agents/bounds.js";
import { parseQuotation } from "../parser/index.js";
import { CatalogIndex, loadCatalogFromCsv, matchLines } from "../matching/index.js";
import { applyCapacityLimit, buildBasket, buildCoverage, gapsByReason } from "./coverage.js";
import { allocateSingle, allocateSplit, assertNoOverAllocation, type AllocationCandidate } from "./allocation.js";
import { buildAwardOptions, pickWinner } from "./award.js";
import { parseBrandNote } from "./constraints.js";
import { buildCandidates, prepareNegotiation } from "./setup.js";
import { deriveElasticity, openingUnitPrice, volumeFactor } from "./pricing.js";

const fixture = (n: number) => resolve(import.meta.dirname, "../../../../fixtures", `quotation_${n}.xlsx`);

let catalog: CatalogIndex;
beforeAll(() => {
  catalog = loadCatalogFromCsv();
});

async function setupFor(n: number, tier?: number) {
  const parsed = await parseQuotation(fixture(n));
  const matched = matchLines(parsed.lines, catalog);
  return {
    parsed,
    matched,
    setup: prepareNegotiation(parsed, matched, tier ?? parsed.suggestedTier),
  };
}

// --- pricing ---------------------------------------------------------------

describe("volume pricing", () => {
  it("reads the supplier's own elasticity out of a two-tier quotation", async () => {
    const parsed = await parseQuotation(fixture(2));
    const elasticity = deriveElasticity(parsed.lines);
    // quotation_2 drops roughly 8% for five times the volume.
    expect(elasticity).toBeGreaterThan(0.03);
    expect(elasticity).toBeLessThan(0.12);
  });

  it("charges more per unit for less volume, which is the cost of splitting", () => {
    expect(volumeFactor(2000, 5000, 0.073)).toBeGreaterThan(1);
    expect(volumeFactor(5000, 5000, 0.073)).toBe(1);
    expect(volumeFactor(10000, 5000, 0.073)).toBeLessThan(1);
  });

  it("gives the same supplier the same opening price every run", () => {
    const supplier = { code: "supplier_2", openingMultiplier: 1.25 } as SupplierProfile;
    const a = openingUnitPrice(10, "OB007-BAS-L", supplier);
    const b = openingUnitPrice(10, "OB007-BAS-L", supplier);
    expect(a).toBe(b);
    // Jittered around the multiplier rather than sitting exactly on it, so that
    // one supplier is not simply dearer on every single line.
    expect(a).toBeGreaterThan(10 * 1.25 * 0.9);
    expect(a).toBeLessThan(10 * 1.25 * 1.1);
  });
});

// --- payment terms ---------------------------------------------------------

describe("payment terms cash-flow cost", () => {
  it("spreads milestones across the production window", () => {
    expect(paymentMilestones("100", 30)).toEqual([{ fraction: 1, dayOffset: 0 }]);

    const split = paymentMilestones("40/60", 30);
    expect(split[0]).toEqual({ fraction: 0.4, dayOffset: 0 });
    expect(split[1]).toEqual({ fraction: 0.6, dayOffset: 30 });

    const thirds = paymentMilestones("33/33/33", 60);
    expect(thirds).toHaveLength(3);
    expect(thirds[1]!.dayOffset).toBe(30);
  });

  it("prices paying upfront as strictly worse than paying on delivery", () => {
    const upfront = paymentCashFlowCost(100_000, "100", 30);
    const onDelivery = paymentCashFlowCost(100_000, "40/60", 30);
    expect(upfront).toBeGreaterThan(onDelivery);
  });

  it("makes payment terms matter more when the lead time is longer", () => {
    expect(paymentCashFlowCost(100_000, "100", 90)).toBeGreaterThan(
      paymentCashFlowCost(100_000, "100", 15),
    );
  });
});

// --- constraints -----------------------------------------------------------

describe("reading the brand's note", () => {
  it("handles the phrasing from the brief", () => {
    const c = parseBrandNote("prioritize lead time over cost, 30 day deadline");
    expect(c.maxLeadTimeDays).toBe(30);
    expect(c.weights.leadTime).toBeGreaterThan(c.weights.cost);
  });

  it("treats a deadline as disqualifying rather than as a preference", () => {
    const c = parseBrandNote("we need everything within 20 days");
    expect(c.maxLeadTimeDays).toBe(20);
  });

  it("picks up a minimum quality bar and a budget ceiling", () => {
    const c = parseBrandNote("quality at least 4.5 and budget under $250,000");
    expect(c.minQualityRating).toBe(4.5);
    expect(c.maxTotalBudget).toBe(250_000);
  });

  it("does not mistake a day count for a budget", () => {
    expect(parseBrandNote("no more than 45 days").maxTotalBudget).toBeNull();
  });

  it("honours an instruction to use one supplier", () => {
    expect(parseBrandNote("single supplier only please").singleSupplierOnly).toBe(true);
    expect(parseBrandNote("do not split the order").singleSupplierOnly).toBe(true);
  });

  it("returns balanced weights for an empty note", () => {
    const c = parseBrandNote("");
    const total = c.weights.cost + c.weights.quality + c.weights.leadTime + c.weights.paymentTerms;
    expect(total).toBeCloseTo(1, 6);
  });
});

// --- coverage --------------------------------------------------------------

describe("coverage", () => {
  it("reports the incumbent's missing tier as a gap and lets rivals bid it", async () => {
    const { setup } = await setupFor(2, 5000);

    const extrapolated = setup.basket.lines.filter((l) => l.baselineExtrapolated).map((l) => l.sku);
    expect(extrapolated.sort()).toEqual(["OJ3008-SRD-XL", "OPP012-OBS-32-28"]);

    const candidates = buildCandidates(setup, new Map(), new Map());
    const incumbent = candidates.find((c) => c.supplier.code === "supplier_1")!;
    const rival = candidates.find((c) => c.supplier.code === "supplier_3")!;

    for (const sku of extrapolated) {
      expect(incumbent.coverage.lines.find((l) => l.sku === sku)!.reason).toBe("no_price_at_tier");
      expect(rival.coverage.lines.find((l) => l.sku === sku)!.reason).toBe("quoted");
    }
  });

  it("never prices a gap at zero", async () => {
    const { setup } = await setupFor(2, 5000);
    for (const candidate of buildCandidates(setup, new Map(), new Map())) {
      for (const line of candidate.coverage.lines) {
        if (line.offeredQty === 0) expect(line.unitPrice).toBeNull();
        else expect(line.unitPrice).toBeGreaterThan(0);
      }
    }
  });

  it("marks an unmatched SKU as a gap instead of dropping it silently", async () => {
    const { setup } = await setupFor(3);
    const candidates = buildCandidates(setup, new Map(), new Map());
    const counts = gapsByReason(candidates[2]!.coverage);
    // AP004-GLW-28 is ambiguous and AQ009-0BS-XS matches nothing.
    expect(counts.unmatched_sku).toBeGreaterThan(0);
  });

  it("applies a capacity limit through the same path as every other gap", async () => {
    const { setup } = await setupFor(2, 5000);
    const candidates = buildCandidates(setup, new Map(), new Map());
    const full = candidates.find((c) => c.supplier.code === "supplier_2")!.coverage;

    const limited = applyCapacityLimit(full, 0.6);
    const before = full.lines.reduce((s, l) => s + l.offeredQty, 0);
    const after = limited.lines.reduce((s, l) => s + l.offeredQty, 0);

    expect(after / before).toBeCloseTo(0.6, 2);
    expect(limited.lines.every((l) => l.offeredQty === 0 || l.reason === "capacity_limited")).toBe(true);
  });
});

// --- allocation ------------------------------------------------------------

function candidate(
  code: string,
  overrides: Partial<SupplierProfile> & { price: number; offered: (sku: string) => number },
  basket: Basket,
): AllocationCandidate {
  const supplier = {
    code,
    name: code,
    country: "CN",
    qualityRating: 4,
    leadTimeDays: 30,
    paymentTerms: "50/50",
    openingMultiplier: 1,
    floorRatio: 0.8,
    minLeadTimeDays: 20,
    bestPaymentTerms: "50/50",
    maxRebatePct: 5,
    maxFreightAllowancePerUnit: 0.1,
    moqPerLine: 500,
    ...overrides,
  } as SupplierProfile;

  return {
    supplier,
    coverage: {
      supplierCode: code,
      lines: basket.lines.map((l) => ({
        sku: l.sku,
        requestedQty: l.quantity,
        offeredQty: overrides.offered(l.sku),
        unitPrice: overrides.price,
        reason: "quoted" as const,
      })),
    },
    priceFor: () => overrides.price,
    leadTimeDays: supplier.leadTimeDays,
    paymentTerms: supplier.paymentTerms,
  };
}

const testBasket = (quantity: number): Basket => ({
  lines: [
    { sku: "A-1", rawSku: "A-1", productName: "A", quantity, baselineUnitPrice: 10, matched: true, baselineExtrapolated: false },
  ],
  tierQuantity: quantity,
  currency: "USD",
});

describe("MOQ-aware allocation", () => {
  it("gives the whole line to the cheapest supplier that can cover it", () => {
    const basket = testBasket(5000);
    const plan = allocateSplit(basket, [
      candidate("cheap", { price: 8, offered: () => 5000 }, basket),
      candidate("dear", { price: 12, offered: () => 5000 }, basket),
    ]);

    expect(plan.allocations).toHaveLength(1);
    expect(plan.allocations[0]!.supplierCode).toBe("cheap");
    expect(plan.allocations[0]!.lines[0]!.quantity).toBe(5000);
  });

  it("splits when the cheapest supplier is capacity limited", () => {
    const basket = testBasket(5000);
    const plan = allocateSplit(basket, [
      candidate("cheap", { price: 8, offered: () => 3000, moqPerLine: 500 }, basket),
      candidate("dear", { price: 12, offered: () => 5000, moqPerLine: 500 }, basket),
    ]);

    expect(plan.allocations).toHaveLength(2);
    const total = plan.allocations.flatMap((a) => a.lines).reduce((s, l) => s + l.quantity, 0);
    expect(total).toBe(5000);
  });

  it("moves an orphan share onto a supplier who can absorb it", () => {
    // The cheap supplier can only take 200 units, which is under its own
    // 500-unit minimum. Nobody should be asked to run 200.
    const basket = testBasket(5000);
    const plan = allocateSplit(basket, [
      candidate("cheap", { price: 8, offered: () => 200, moqPerLine: 500 }, basket),
      candidate("dear", { price: 12, offered: () => 5000, moqPerLine: 500 }, basket),
    ]);

    expect(plan.allocations).toHaveLength(1);
    expect(plan.allocations[0]!.supplierCode).toBe("dear");
    expect(plan.allocations[0]!.lines[0]!.quantity).toBe(5000);
    expect(plan.notes.some((n) => n.kind === "moq_repair")).toBe(true);
  });

  it("never buys more than was asked for in order to reach a minimum", () => {
    const basket = testBasket(400);
    const plan = allocateSplit(basket, [
      candidate("a", { price: 8, offered: () => 400, moqPerLine: 500 }, basket),
      candidate("b", { price: 12, offered: () => 400, moqPerLine: 500 }, basket),
    ]);

    const total = plan.allocations.flatMap((a) => a.lines).reduce((s, l) => s + l.quantity, 0);
    expect(total).toBeLessThanOrEqual(400);
    expect(() => assertNoOverAllocation(basket, plan.allocations)).not.toThrow();
  });

  it("records an impossible split rather than throwing", () => {
    const basket = testBasket(400);
    const plan = allocateSplit(basket, [
      candidate("a", { price: 8, offered: () => 400, moqPerLine: 5000 }, basket),
      candidate("b", { price: 12, offered: () => 400, moqPerLine: 5000 }, basket),
    ]);

    expect(plan.allocations).toHaveLength(0);
    expect(plan.notes.some((n) => n.kind === "split_infeasible")).toBe(true);
    expect(plan.uncovered).toHaveLength(1);
  });

  it("leaves a single supplier's shortfall uncovered instead of quietly backfilling", () => {
    const basket = testBasket(5000);
    const plan = allocateSingle(
      basket,
      candidate("only", { price: 8, offered: () => 3000 }, basket),
    );

    expect(plan.allocations[0]!.lines[0]!.quantity).toBe(3000);
    expect(plan.uncovered[0]!.requestedQty - plan.uncovered[0]!.offeredQty).toBe(2000);
  });

  it("holds the no-over-allocation invariant on real data", async () => {
    const { setup } = await setupFor(2, 5000);
    const candidates = buildCandidates(setup, new Map(), new Map([["supplier_2", 0.6]]));
    const plan = allocateSplit(setup.basket, candidates);
    expect(() => assertNoOverAllocation(setup.basket, plan.allocations)).not.toThrow();
  });
});

// --- scoring ---------------------------------------------------------------

describe("scoring", () => {
  it("redistributes the weight of a dimension every option ties on", () => {
    const w = redistributeWeights(DEFAULT_CONSTRAINTS.weights, {
      cost: true,
      quality: false,
      leadTime: true,
      paymentTerms: true,
    });
    expect(w.quality).toBe(0);
    expect(w.cost + w.leadTime + w.paymentTerms).toBeCloseTo(1, 6);
  });

  it("ranks a disqualified option below every qualifying one", async () => {
    const { setup } = await setupFor(2, 5000);
    const constraints = parseBrandNote("30 day deadline");
    const candidates = buildCandidates(setup, new Map(), new Map());
    const breakdowns = scoreOptions(
      buildAwardOptions(setup.basket, candidates, constraints),
      Object.fromEntries(candidates.map((c) => [c.supplier.code, { country: c.supplier.country }])),
      constraints,
    );

    const firstDisqualified = breakdowns.findIndex((b) => b.disqualified);
    const lastQualified = breakdowns.map((b) => b.disqualified).lastIndexOf(false);
    expect(firstDisqualified).toBeGreaterThan(lastQualified);

    // The 90-day incumbent is the one that fails the deadline.
    const incumbent = breakdowns.find((b) => b.label.includes("Incumbent") && b.supplierCount === 1)!;
    expect(incumbent.disqualified).toBe(true);
    expect(incumbent.disqualifiedReasons[0]).toContain("90 days");
  });

  it("prefers the option that covers more of the order, all else being equal", () => {
    // Scores are normalised across the options being compared, so the only
    // meaningful comparison is within one set. These two are identical apart
    // from the shortfall.
    const constraints: NegotiationConstraints = parseBrandNote("");
    const allocation = {
      supplierCode: "s",
      allocationKey: "s",
      lines: [{ sku: "A-1", productName: "A", quantity: 1000, unitPrice: 10, lineTotal: 10_000 }],
      subtotal: 10_000,
      leadTimeDays: 30,
      paymentTerms: "50/50",
      qualityRating: 4,
    };

    const [ranked] = [
      scoreOptions(
        [
          { id: "full", label: "full", allocations: [allocation], notes: [], uncoveredQty: 0, requestedQty: 1000 },
          { id: "short", label: "short", allocations: [allocation], notes: [], uncoveredQty: 400, requestedQty: 1000 },
        ],
        { s: { country: "CN" } },
        constraints,
      ),
    ];

    expect(ranked[0]!.optionId).toBe("full");
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
    expect(ranked[1]!.coverageRatio).toBeCloseTo(0.6, 6);
  });

  it("reports a real shortfall for a capacity-limited supplier", async () => {
    const { setup } = await setupFor(2, 5000);
    const constraints = parseBrandNote("");
    const limited = buildCandidates(setup, new Map(), new Map([["supplier_2", 0.6]]));
    const breakdown = scoreOptions(
      buildAwardOptions(setup.basket, limited, constraints),
      Object.fromEntries(limited.map((c) => [c.supplier.code, { country: c.supplier.country }])),
      constraints,
    ).find((b) => b.optionId === "single:supplier_2")!;

    expect(breakdown.coverageRatio).toBeCloseTo(0.6, 1);
  });
});

// --- the curveball end to end ----------------------------------------------

describe("the Supplier 2 curveball", () => {
  it("changes the winner without changing anything else", async () => {
    const { setup } = await setupFor(2, 5000);
    const constraints = parseBrandNote("prioritize lead time over cost, 30 day deadline");

    const before = pickWinner(
      buildAwardOptions(setup.basket, buildCandidates(setup, new Map(), new Map()), constraints),
      buildCandidates(setup, new Map(), new Map()),
      constraints,
    )!;

    const after = pickWinner(
      buildAwardOptions(setup.basket, buildCandidates(setup, new Map(), new Map([["supplier_2", 0.6]])), constraints),
      buildCandidates(setup, new Map(), new Map([["supplier_2", 0.6]])),
      constraints,
    )!;

    // Supplier 2 leads on quality while it can ship the whole order.
    expect(before.award.label).toContain("Meridian");
    // Once it can only do 60%, the 15-day supplier that covers everything wins.
    expect(after.award.label).not.toContain("Meridian alone");
    expect(after.award.reasoning.bullets.join(" ")).toMatch(/\$|days/);
  });

  it("explains the decision using the numbers it decided on", async () => {
    const { setup } = await setupFor(2, 5000);
    const constraints = parseBrandNote("30 day deadline");
    const candidates = buildCandidates(setup, new Map(), new Map([["supplier_2", 0.6]]));
    const result = pickWinner(buildAwardOptions(setup.basket, candidates, constraints), candidates, constraints)!;

    expect(result.award.reasoning.bullets.length).toBeGreaterThan(3);
    expect(result.award.reasoning.rejected.length).toBeGreaterThan(0);
    expect(result.award.reasoning.runnerUp).not.toBeNull();

    const winnerScore = result.breakdowns.find((b) => b.optionId === result.award.winningOptionId)!;
    expect(result.award.reasoning.bullets[0]).toContain(
      `$${Math.round(winnerScore.effectiveTotal).toLocaleString("en-US")}`,
    );
  });
});

describe("what a supplier agent is allowed to hand back", () => {
  const supplier = supplierProfile("supplier_1");

  const proposal = (concessions: { kind: "price"; description: string }[]) => ({
    priceFactor: 0.9,
    leadTimeDays: supplier.minLeadTimeDays + 5,
    paymentTerms: supplier.bestPaymentTerms,
    rebatePct: 0,
    freightAllowancePerUnit: 0,
    concessions,
    message: "We can improve on our opening position.",
  });

  it("trims a sentence-length concession down to a chip label", () => {
    const long =
      "Adjusted pricing to cover expedited production, resulting in a total of $6.2M across the basket";
    const offer = clampOffer(
      proposal([{ kind: "price", description: long }]),
      supplier,
      1,
      null,
      90,
      "30/70",
    );

    const description = offer.concessions[0]!.description;
    expect(description.length).toBeLessThanOrEqual(65);
    expect(description.endsWith("…")).toBe(true);
    // Cut on a boundary rather than mid-word.
    expect(description).toBe("Adjusted pricing to cover expedited production…");
  });

  it("leaves a concession that is already chip-sized alone", () => {
    const offer = clampOffer(
      proposal([{ kind: "price", description: "8% off our opening prices" }]),
      supplier,
      1,
      null,
      90,
      "30/70",
    );

    expect(offer.concessions[0]!.description).toBe("8% off our opening prices");
  });

  it("keeps our field names out of the message the brand reads", () => {
    // Observed verbatim from ollama/gpt-oss:120b, which is handed `priceFactor` in
    // the output contract and then helpfully cites it back at the customer.
    const offer = clampOffer(
      {
        ...proposal([]),
        message:
          "We can give you a 6% price reduction (priceFactor 0.94), hold leadTimeDays at 30 and shift paymentTerms to 30/70.",
      },
      supplier,
      1,
      null,
      90,
      "30/70",
    );

    expect(offer.message).toBe(
      "We can give you a 6% price reduction (price factor at 94%), hold lead time at 30 and shift payment terms to 30/70.",
    );
  });
});

describe("humanising the field names a model leaks into its message", () => {
  it("states the price factor as the percentage of list it actually is", () => {
    // 0.94 is 94% of the opening price, not a 94% discount, and the bare decimal
    // is read as the latter often enough to be worth spelling out.
    expect(humaniseFieldNames("a cut to priceFactor 0.94")).toBe("a cut to price factor at 94%");
    expect(humaniseFieldNames("priceFactor of 0.9")).toBe("price factor at 90%");
    expect(humaniseFieldNames("priceFactor: 1.0")).toBe("price factor at 100%");
  });

  it("renames a field mentioned without a value", () => {
    expect(humaniseFieldNames("we cannot move freightAllowancePerUnit further")).toBe(
      "we cannot move freight allowance further",
    );
  });

  it("leaves a message that reads like a person alone", () => {
    const clean = "We can hold 30 days and take another 6% off, but not both.";
    expect(humaniseFieldNames(clean)).toBe(clean);
  });
});
