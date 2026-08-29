import type { Basket, ParsedLine, SupplierProfile } from "@sq/shared";
import { roundPrice } from "../parser/read-workbook.js";

/** FNV-1a. Any stable hash would do; this one is short enough to read. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** Deterministic value in [-1, 1) for a given key. */
function unitJitter(key: string): number {
  return (hash(key) / 0xffffffff) * 2 - 1;
}

/**
 * A supplier is not uniformly 25% dearer on every line: they are sharp on the
 * products they are set up for and expensive on the rest. Without this, every
 * comparison collapses into one multiplication and a split award can never be
 * the right answer, which would make the whole allocation stage theatre.
 *
 * Derived from a hash so the same file always produces the same negotiation.
 */
const JITTER_AMPLITUDE = 0.09;

export function openingUnitPrice(
  baselineUnitPrice: number,
  sku: string,
  supplier: SupplierProfile,
): number {
  const jitter = 1 + JITTER_AMPLITUDE * unitJitter(`${supplier.code}:${sku}`);
  return roundPrice(baselineUnitPrice * supplier.openingMultiplier * jitter);
}

/** The number the agent is never told, and the workflow silently clamps against. */
export function floorUnitPrice(openingPrice: number, supplier: SupplierProfile): number {
  return roundPrice(openingPrice * supplier.floorRatio);
}

/**
 * Volume discounts follow a power curve: price moves with quantity to the power
 * of a small negative exponent. Both multi-tier fixtures agree on roughly 0.053
 * (quotation_1 drops 11.6% for 10x the volume, quotation_2 drops 8.2% for 5x),
 * so that is the default when a file quotes only one tier.
 */
export const DEFAULT_ELASTICITY = 0.055;

export function volumeFactor(quantity: number, referenceQuantity: number, elasticity: number): number {
  if (quantity <= 0 || referenceQuantity <= 0) return 1;
  return (quantity / referenceQuantity) ** -elasticity;
}

/**
 * Reads the supplier's own volume curve out of their quotation when it prices
 * the same SKU at two quantities. Using the file's real elasticity is what makes
 * "you lose your volume break if you only take 60%" a number from the document
 * rather than one we made up.
 */
export function deriveElasticity(lines: ParsedLine[]): number {
  const bySku = new Map<string, Array<{ qty: number; price: number }>>();
  for (const line of lines) {
    if (!bySku.has(line.rawSku)) bySku.set(line.rawSku, []);
    bySku.get(line.rawSku)!.push({ qty: line.tierQuantity, price: line.unitPrice });
  }

  const observations: number[] = [];
  for (const points of bySku.values()) {
    const sorted = [...points].sort((a, b) => a.qty - b.qty);
    for (let i = 1; i < sorted.length; i++) {
      const low = sorted[i - 1]!;
      const high = sorted[i]!;
      if (low.qty <= 0 || high.qty <= low.qty) continue;
      if (low.price <= 0 || high.price <= 0) continue;
      // p_high / p_low = (q_high / q_low) ^ -e
      const e = -Math.log(high.price / low.price) / Math.log(high.qty / low.qty);
      // A price that rises with volume, or collapses, is a data quirk not a curve.
      if (e > 0 && e < 0.5) observations.push(e);
    }
  }

  if (observations.length === 0) return DEFAULT_ELASTICITY;
  observations.sort((a, b) => a - b);
  // Median rather than mean: one mispriced line should not move the curve.
  const mid = Math.floor(observations.length / 2);
  return observations.length % 2 === 0
    ? (observations[mid - 1]! + observations[mid]!) / 2
    : observations[mid]!;
}

export type SupplierPricing = {
  supplierCode: string;
  elasticity: number;
  /** Opening price per SKU at the basket's reference quantity. */
  opening: Map<string, number>;
  floor: Map<string, number>;
};

export function buildSupplierPricing(
  basket: Basket,
  supplier: SupplierProfile,
  elasticity: number,
): SupplierPricing {
  const opening = new Map<string, number>();
  const floor = new Map<string, number>();

  for (const line of basket.lines) {
    const price = openingUnitPrice(line.baselineUnitPrice, line.sku, supplier);
    opening.set(line.sku, price);
    floor.set(line.sku, floorUnitPrice(price, supplier));
  }

  return { supplierCode: supplier.code, elasticity, opening, floor };
}

/**
 * The price this supplier charges for `quantity` of `sku` after `priceFactor`
 * rounds of negotiation, with the volume curve applied when the quantity differs
 * from what the basket asked for. Clamped to the floor here rather than in the
 * agent, because a bound enforced by a prompt is not a bound.
 */
export function effectiveUnitPrice(
  pricing: SupplierPricing,
  sku: string,
  quantity: number,
  referenceQuantity: number,
  priceFactor: number,
): number | null {
  const opening = pricing.opening.get(sku);
  if (opening === undefined) return null;

  const negotiated = opening * priceFactor;
  const withVolume = negotiated * volumeFactor(quantity, referenceQuantity, pricing.elasticity);
  const floor = pricing.floor.get(sku) ?? 0;
  return roundPrice(Math.max(withVolume, floor));
}
