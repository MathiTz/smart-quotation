import type {
  Basket,
  BasketLine,
  CoverageReason,
  LineCoverage,
  MatchedLine,
  SupplierCoverage,
} from "@sq/shared";
import { isBuyable } from "@sq/shared";
import { AS_QUOTED } from "../parser/extract.js";
import { roundPrice } from "../parser/read-workbook.js";

/**
 * Collapses the parsed rows into the thing the brand is actually buying: one
 * line per SKU at one quantity. Which row wins depends on the tier the user
 * chose; `AS_QUOTED` keeps each line at the quantity the file asked for.
 */
export type BasketResult = {
  basket: Basket;
  /** SKUs the incumbent priced at the chosen volume. Everything else is their gap. */
  quotedAtTier: Set<string>;
};

export function buildBasket(
  lines: MatchedLine[],
  tierQuantity: number,
  elasticity: number,
  currency = "USD",
): BasketResult {
  const bySku = new Map<string, MatchedLine[]>();
  for (const line of lines) {
    const key = line.matchedSku ?? line.rawSku;
    if (!bySku.has(key)) bySku.set(key, []);
    bySku.get(key)!.push(line);
  }

  const basketLines: BasketLine[] = [];
  const quotedAtTier = new Set<string>();

  for (const [sku, group] of bySku) {
    const chosen =
      tierQuantity === AS_QUOTED
        ? // No tier on offer: take the largest quantity the file quoted, which is
          // the row a buyer would read as the real order.
          [...group].sort((a, b) => b.quantity - a.quantity)[0]
        : group.find((l) => l.tierQuantity === tierQuantity);

    if (chosen) {
      quotedAtTier.add(sku);
      basketLines.push({
        sku,
        rawSku: chosen.rawSku,
        productName: chosen.matchedName ?? chosen.rawDescription,
        quantity: tierQuantity === AS_QUOTED ? chosen.quantity : tierQuantity,
        baselineUnitPrice: chosen.unitPrice,
        matched: isBuyable(chosen),
        baselineExtrapolated: false,
      });
      continue;
    }

    // Priced at some other volume but not this one. Projecting the baseline
    // along the file's own volume curve keeps the line in play: the rival
    // suppliers have not refused it, only the incumbent has.
    const nearest = [...group].sort(
      (a, b) => Math.abs(a.tierQuantity - tierQuantity) - Math.abs(b.tierQuantity - tierQuantity),
    )[0]!;
    const projected = nearest.unitPrice * (tierQuantity / nearest.tierQuantity) ** -elasticity;

    basketLines.push({
      sku,
      rawSku: nearest.rawSku,
      productName: nearest.matchedName ?? nearest.rawDescription,
      quantity: tierQuantity,
      baselineUnitPrice: roundPrice(projected),
      matched: isBuyable(nearest),
      baselineExtrapolated: true,
    });
  }

  basketLines.sort((a, b) => a.sku.localeCompare(b.sku));

  return { basket: { lines: basketLines, tierQuantity, currency }, quotedAtTier };
}

export type CoverageInput = {
  supplierCode: string;
  /**
   * Prices this supplier will honour. Returns null when they will not quote the
   * line at that quantity, which for the incumbent is exactly the missing-tier
   * case in `quotation_2.xlsx`.
   */
  priceFor: (sku: string, quantity: number) => number | null;
  /** 1 means the whole order. 0.6 is the Supplier 2 curveball. */
  capacityRatio?: number;
  /** SKUs this supplier walked away from during negotiation. */
  declined?: ReadonlySet<string>;
};

/**
 * The one function that decides what a supplier can actually ship, and the
 * reason it computes is the reason the UI displays and the allocator acts on.
 *
 * Everything that can go wrong goes through here: a SKU we could not identify,
 * a tier the supplier never priced, a capacity ceiling announced mid-negotiation,
 * a line they refused. Adding a fifth reason later means adding a branch here
 * and nothing else, which is the entire point of modelling it this way.
 */
export function buildCoverage(basket: Basket, input: CoverageInput): SupplierCoverage {
  const capacityRatio = input.capacityRatio ?? 1;
  const declined = input.declined ?? new Set<string>();

  const lines: LineCoverage[] = basket.lines.map((line): LineCoverage => {
    const gap = (reason: CoverageReason): LineCoverage => ({
      sku: line.sku,
      requestedQty: line.quantity,
      offeredQty: 0,
      // Null, never zero. A zero price reads as "free", which is how you end up
      // awarding an order to whoever failed to quote it.
      unitPrice: null,
      reason,
    });

    if (!line.matched) return gap("unmatched_sku");
    if (declined.has(line.sku)) return gap("declined");

    const offeredQty = capacityRatio >= 1 ? line.quantity : Math.floor(line.quantity * capacityRatio);
    if (offeredQty <= 0) return gap("capacity_limited");

    const unitPrice = input.priceFor(line.sku, offeredQty);
    if (unitPrice === null || unitPrice <= 0) return gap("no_price_at_tier");

    return {
      sku: line.sku,
      requestedQty: line.quantity,
      offeredQty,
      unitPrice,
      reason: offeredQty < line.quantity ? "capacity_limited" : "quoted",
    };
  });

  return { supplierCode: input.supplierCode, lines };
}

/**
 * Re-runs coverage with a new capacity ceiling. This is the whole of the
 * curveball: the negotiation carries on from where it was, with one supplier's
 * coverage vector rebuilt. Nothing restarts, because nothing else changed.
 */
export function applyCapacityLimit(
  coverage: SupplierCoverage,
  ratio: number,
): SupplierCoverage {
  return {
    supplierCode: coverage.supplierCode,
    lines: coverage.lines.map((line): LineCoverage => {
      if (line.offeredQty === 0) return line;
      const offeredQty = Math.floor(line.requestedQty * ratio);
      if (offeredQty <= 0) {
        return { ...line, offeredQty: 0, unitPrice: null, reason: "capacity_limited" };
      }
      return {
        ...line,
        offeredQty,
        reason: offeredQty < line.requestedQty ? "capacity_limited" : line.reason,
      };
    }),
  };
}

export function gapsByReason(coverage: SupplierCoverage): Record<CoverageReason, number> {
  const counts = {
    quoted: 0,
    no_price_at_tier: 0,
    capacity_limited: 0,
    unmatched_sku: 0,
    declined: 0,
  } satisfies Record<CoverageReason, number>;
  for (const line of coverage.lines) counts[line.reason]++;
  return counts;
}

/** Human-readable, and used verbatim in the agent transcript and the award reasoning. */
export const REASON_LABELS: Record<CoverageReason, string> = {
  quoted: "quoted in full",
  no_price_at_tier: "not priced at this volume",
  capacity_limited: "limited by supplier capacity",
  unmatched_sku: "no confident catalog match",
  declined: "declined by the supplier",
};
