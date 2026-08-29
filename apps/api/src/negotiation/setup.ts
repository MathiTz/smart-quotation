import type {
  Basket,
  MatchedLine,
  NegotiationConstraints,
  ParsedQuotation,
  SupplierOffer,
  SupplierProfile,
} from "@sq/shared";
import { SUPPLIER_PROFILES } from "@sq/shared";
import { roundPrice } from "../parser/read-workbook.js";
import { buildBasket, buildCoverage } from "./coverage.js";
import {
  buildSupplierPricing,
  deriveElasticity,
  effectiveUnitPrice,
  volumeFactor,
  type SupplierPricing,
} from "./pricing.js";
import type { AllocationCandidate } from "./allocation.js";

export type NegotiationSetup = {
  basket: Basket;
  elasticity: number;
  /** Supplier 1's opening terms, taken from the file where it states them. */
  incumbentLeadTimeDays: number;
  incumbentPaymentTerms: string;
  /** Populated when the uploaded file contradicts the supplier profile. */
  termsConflict: string[];
  pricing: Map<string, SupplierPricing>;
  quotedAtTier: Set<string>;
  incumbentPrices: Map<string, number>;
};

export const INCUMBENT_CODE = "supplier_1";

/**
 * Turns a parsed, matched quotation into everything the negotiation needs:
 * the basket, each supplier's price book, and the incumbent's real terms.
 *
 * The uploaded file wins over the supplier profile whenever the two disagree.
 * The whole premise is that this document is the baseline the brand negotiates
 * from, so quoting terms back at the user that contradict the spreadsheet open
 * on their other monitor would be indefensible. The disagreement is recorded
 * instead, because a supplier whose standard terms are 33/33/33 but who wrote
 * 30/70 on this deal has already moved once.
 */
export function prepareNegotiation(
  parsed: ParsedQuotation,
  matched: MatchedLine[],
  tierQuantity: number,
): NegotiationSetup {
  const elasticity = deriveElasticity(parsed.lines);
  const { basket, quotedAtTier } = buildBasket(matched, tierQuantity, elasticity, parsed.metadata.currency);

  const incumbentProfile = supplierByCode(INCUMBENT_CODE);
  const termsConflict: string[] = [];

  const incumbentLeadTimeDays = parsed.metadata.leadTimeDays ?? incumbentProfile.leadTimeDays;
  const incumbentPaymentTerms = parsed.metadata.paymentTerms ?? incumbentProfile.paymentTerms;

  if (parsed.metadata.leadTimeDays !== null && parsed.metadata.leadTimeDays !== incumbentProfile.leadTimeDays) {
    termsConflict.push(
      `the quotation states a ${parsed.metadata.leadTimeDays} day lead time; ${incumbentProfile.name}'s standard terms are ${incumbentProfile.leadTimeDays} days`,
    );
  }
  if (parsed.metadata.paymentTerms !== null && parsed.metadata.paymentTerms !== incumbentProfile.paymentTerms) {
    termsConflict.push(
      `the quotation states ${parsed.metadata.paymentTerms} payment terms; ${incumbentProfile.name}'s standard terms are ${incumbentProfile.paymentTerms}`,
    );
  }

  const incumbentPrices = new Map<string, number>();
  for (const line of basket.lines) {
    if (quotedAtTier.has(line.sku)) incumbentPrices.set(line.sku, line.baselineUnitPrice);
  }

  const pricing = new Map<string, SupplierPricing>();
  for (const profile of SUPPLIER_PROFILES) {
    pricing.set(profile.code, buildSupplierPricing(basket, profile, elasticity));
  }

  return {
    basket,
    elasticity,
    incumbentLeadTimeDays,
    incumbentPaymentTerms,
    termsConflict,
    pricing,
    quotedAtTier,
    incumbentPrices,
  };
}

export function supplierByCode(code: string): SupplierProfile {
  const found = SUPPLIER_PROFILES.find((s) => s.code === code);
  if (!found) throw new Error(`unknown supplier: ${code}`);
  return found;
}

/**
 * The incumbent's prices come from the document, not from a model. Lines it
 * never priced at this volume return null, which is what makes the missing 5000
 * tier show up as a real gap the rivals can bid into.
 */
function incumbentPriceFor(setup: NegotiationSetup, offer: SupplierOffer | null) {
  return (sku: string, quantity: number): number | null => {
    const base = setup.incumbentPrices.get(sku);
    if (base === undefined) return null;
    const factor = offer?.priceFactor ?? 1;
    const rebate = 1 - (offer?.rebatePct ?? 0) / 100;
    const withVolume = base * factor * rebate * volumeFactor(quantity, setup.basket.tierQuantity, setup.elasticity);
    const floor = base * supplierByCode(INCUMBENT_CODE).floorRatio;
    return roundPrice(Math.max(withVolume, floor));
  };
}

/**
 * Builds the priced, coverage-aware candidate each allocation option is
 * assembled from. `offers` carries whatever the negotiation has agreed so far;
 * with none, this is the opening position.
 */
export function buildCandidates(
  setup: NegotiationSetup,
  offers: Map<string, SupplierOffer>,
  capacity: Map<string, number>,
): AllocationCandidate[] {
  return SUPPLIER_PROFILES.map((profile): AllocationCandidate => {
    const offer = offers.get(profile.code) ?? null;
    const pricing = setup.pricing.get(profile.code)!;

    const priceFor =
      profile.code === INCUMBENT_CODE
        ? incumbentPriceFor(setup, offer)
        : (sku: string, quantity: number) => {
            const price = effectiveUnitPrice(
              pricing,
              sku,
              quantity,
              setup.basket.tierQuantity,
              offer?.priceFactor ?? 1,
            );
            if (price === null) return null;
            const rebate = 1 - (offer?.rebatePct ?? 0) / 100;
            const freight = offer?.freightAllowancePerUnit ?? 0;
            return roundPrice(Math.max(price * rebate - freight, pricing.floor.get(sku) ?? 0));
          };

    const leadTimeDays =
      profile.code === INCUMBENT_CODE
        ? (offer?.leadTimeDays ?? setup.incumbentLeadTimeDays)
        : (offer?.leadTimeDays ?? profile.leadTimeDays);

    const paymentTerms =
      profile.code === INCUMBENT_CODE
        ? (offer?.paymentTerms ?? setup.incumbentPaymentTerms)
        : (offer?.paymentTerms ?? profile.paymentTerms);

    const coverage = buildCoverage(setup.basket, {
      supplierCode: profile.code,
      priceFor,
      capacityRatio: capacity.get(profile.code) ?? offer?.fulfillmentRatio ?? 1,
    });

    return { supplier: profile, coverage, priceFor, leadTimeDays, paymentTerms };
  });
}

export function openingConstraintsSummary(setup: NegotiationSetup, constraints: NegotiationConstraints): string[] {
  const out = [...setup.termsConflict];
  const extrapolated = setup.basket.lines.filter((l) => l.baselineExtrapolated);
  if (extrapolated.length > 0) {
    out.push(
      `${extrapolated.length} line${extrapolated.length === 1 ? "" : "s"} were never priced at ${setup.basket.tierQuantity} units by the incumbent: ${extrapolated.map((l) => l.sku).join(", ")}`,
    );
  }
  const unmatched = setup.basket.lines.filter((l) => !l.matched);
  if (unmatched.length > 0) {
    out.push(`${unmatched.length} line${unmatched.length === 1 ? "" : "s"} could not be matched to the catalog and are excluded from every offer`);
  }
  if (constraints.maxLeadTimeDays !== null) {
    out.push(`the brand will not accept more than ${constraints.maxLeadTimeDays} days`);
  }
  return out;
}
