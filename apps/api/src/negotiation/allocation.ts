import type {
  Allocation,
  AllocationNote,
  AllocationPlan,
  Basket,
  LineCoverage,
  SupplierCoverage,
  SupplierProfile,
} from "@sq/shared";
import { landedUnitCost } from "@sq/shared";
import { roundMoney, roundPrice } from "../parser/read-workbook.js";
import { REASON_LABELS } from "./coverage.js";

export type AllocationCandidate = {
  supplier: SupplierProfile;
  coverage: SupplierCoverage;
  /** Reprices at whatever quantity is actually allocated, via the volume curve. */
  priceFor: (sku: string, quantity: number) => number | null;
  leadTimeDays: number;
  paymentTerms: string;
};

type Assignment = { supplierCode: string; quantity: number };

/** Two passes is enough to settle every repair the fixtures produce, and it guarantees termination. */
const MAX_REPAIR_PASSES = 2;

function coverageFor(candidate: AllocationCandidate, sku: string): LineCoverage | undefined {
  return candidate.coverage.lines.find((l) => l.sku === sku);
}

/** What this supplier would charge per unit, landed, if it took `quantity` of `sku`. */
function landedCost(candidate: AllocationCandidate, sku: string, quantity: number): number | null {
  const price = candidate.priceFor(sku, quantity);
  if (price === null) return null;
  return landedUnitCost(price, candidate.supplier.country);
}

/**
 * Splits the basket across suppliers, then repairs the splits that no factory
 * would actually run.
 *
 * Greedy by landed cost gets the arithmetic right and the manufacturing wrong:
 * it will happily hand someone 120 units of a line they will not set up a line
 * for under 750. The repair pass moves those orphans onto a supplier who can
 * take them, or gives up on that line and says so. It never invents quantity to
 * reach a minimum, because ordering 750 units to avoid a 120-unit problem is a
 * more expensive mistake than the one it is fixing.
 */
export function allocateSplit(basket: Basket, candidates: AllocationCandidate[]): AllocationPlan {
  const notes: AllocationNote[] = [];
  const uncovered: LineCoverage[] = [];
  const perLine = new Map<string, Assignment[]>();

  for (const line of basket.lines) {
    const ranked = candidates
      .map((candidate) => ({
        candidate,
        coverage: coverageFor(candidate, line.sku),
        cost: landedCost(candidate, line.sku, line.quantity),
      }))
      .filter((r) => r.coverage !== undefined && r.coverage.offeredQty > 0 && r.cost !== null)
      .sort((a, b) => a.cost! - b.cost! || a.candidate.supplier.code.localeCompare(b.candidate.supplier.code));

    let remaining = line.quantity;
    const assignments: Assignment[] = [];

    for (const entry of ranked) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, entry.coverage!.offeredQty);
      if (take <= 0) continue;
      assignments.push({ supplierCode: entry.candidate.supplier.code, quantity: take });
      remaining -= take;
    }

    if (assignments.length === 0) {
      const reason = candidates
        .map((c) => coverageFor(c, line.sku)?.reason)
        .find((r) => r && r !== "quoted");
      uncovered.push({
        sku: line.sku,
        requestedQty: line.quantity,
        offeredQty: 0,
        unitPrice: null,
        reason: reason ?? "declined",
      });
      notes.push({
        sku: line.sku,
        kind: "uncovered",
        message: `no supplier could cover ${line.sku}: ${REASON_LABELS[reason ?? "declined"]}`,
      });
      continue;
    }

    if (remaining > 0) {
      uncovered.push({
        sku: line.sku,
        requestedQty: line.quantity,
        offeredQty: line.quantity - remaining,
        unitPrice: null,
        reason: "capacity_limited",
      });
    }

    perLine.set(line.sku, assignments);
  }

  repairMinimums(basket, candidates, perLine, notes, uncovered);

  return buildPlan(basket, candidates, perLine, notes, uncovered);
}

/**
 * Moves quantity between suppliers until every non-zero share clears that
 * supplier's minimum. Quantity is only ever transferred, never created, so the
 * brand cannot end up buying more than it asked for to satisfy a factory rule.
 */
// #region moq-repair
function repairMinimums(
  basket: Basket,
  candidates: AllocationCandidate[],
  perLine: Map<string, Assignment[]>,
  notes: AllocationNote[],
  uncovered: LineCoverage[],
): void {
  const byCode = new Map<string, AllocationCandidate>(candidates.map((c) => [c.supplier.code, c]));

  for (let pass = 0; pass < MAX_REPAIR_PASSES; pass++) {
    let changed = false;

    for (const line of basket.lines) {
      const assignments = perLine.get(line.sku);
      if (!assignments || assignments.length === 0) continue;

      for (const assignment of assignments) {
        const candidate = byCode.get(assignment.supplierCode);
        if (!candidate) continue;
        const moq = candidate.supplier.moqPerLine;
        if (assignment.quantity === 0 || assignment.quantity >= moq) continue;

        // Preferred repair: hand the orphan share to somebody who can absorb it.
        // Fewer suppliers on a line is also cheaper to administer, so this is the
        // right move even when both repairs are available.
        const absorber = candidates.find((other) => {
          if (other.supplier.code === assignment.supplierCode) return false;
          const coverage = coverageFor(other, line.sku);
          if (!coverage || coverage.offeredQty === 0) return false;
          const existing = assignments.find((a) => a.supplierCode === other.supplier.code)?.quantity ?? 0;
          const merged = existing + assignment.quantity;
          return merged <= coverage.offeredQty && merged >= other.supplier.moqPerLine;
        });

        if (absorber) {
          const existing = assignments.find((a) => a.supplierCode === absorber.supplier.code);
          if (existing) existing.quantity += assignment.quantity;
          else assignments.push({ supplierCode: absorber.supplier.code, quantity: assignment.quantity });

          notes.push({
            sku: line.sku,
            kind: "moq_repair",
            message: `moved ${assignment.quantity} units of ${line.sku} from ${assignment.supplierCode} to ${absorber.supplier.code}, which was below ${assignment.supplierCode}'s ${moq}-unit minimum`,
          });
          assignment.quantity = 0;
          changed = true;
          continue;
        }

        // Second repair: top this supplier up to its minimum by taking from the
        // dearest other share, provided that share can survive losing it.
        const deficit = moq - assignment.quantity;
        const ownCoverage = coverageFor(candidate, line.sku);
        const donorCost = (a: Assignment): number => {
          const other = byCode.get(a.supplierCode);
          return other ? (landedCost(other, line.sku, a.quantity) ?? 0) : 0;
        };
        const donor =
          ownCoverage && assignment.quantity + deficit <= ownCoverage.offeredQty
            ? [...assignments]
                .filter((a) => a.supplierCode !== assignment.supplierCode && a.quantity > 0)
                .sort((a, b) => donorCost(b) - donorCost(a))
                .find((a) => {
                  const donorMoq = byCode.get(a.supplierCode)?.supplier.moqPerLine ?? 0;
                  const left = a.quantity - deficit;
                  return left === 0 || left >= donorMoq;
                })
            : undefined;

        if (donor) {
          donor.quantity -= deficit;
          assignment.quantity += deficit;
          notes.push({
            sku: line.sku,
            kind: "moq_repair",
            message: `moved ${deficit} units of ${line.sku} from ${donor.supplierCode} to ${assignment.supplierCode} to reach its ${moq}-unit minimum`,
          });
          changed = true;
          continue;
        }

        // Nobody can run it. Reporting a shortfall is the honest outcome; the
        // alternative is a purchase order the factory would reject on receipt.
        notes.push({
          sku: line.sku,
          kind: "split_infeasible",
          message: `dropped ${assignment.quantity} units of ${line.sku}: below ${assignment.supplierCode}'s ${moq}-unit minimum and no other supplier could absorb them`,
        });
        uncovered.push({
          sku: line.sku,
          requestedQty: line.quantity,
          offeredQty: 0,
          unitPrice: null,
          reason: "capacity_limited",
        });
        assignment.quantity = 0;
        changed = true;
      }

      perLine.set(
        line.sku,
        assignments.filter((a) => a.quantity > 0),
      );
    }

    if (!changed) break;
  }
}
// #endregion moq-repair

function buildPlan(
  basket: Basket,
  candidates: AllocationCandidate[],
  perLine: Map<string, Assignment[]>,
  notes: AllocationNote[],
  uncovered: LineCoverage[],
): AllocationPlan {
  const byCode = new Map<string, AllocationCandidate>(candidates.map((c) => [c.supplier.code, c]));
  const grouped = new Map<string, Allocation>();

  for (const line of basket.lines) {
    for (const assignment of perLine.get(line.sku) ?? []) {
      if (assignment.quantity <= 0) continue;
      const candidate = byCode.get(assignment.supplierCode);
      if (!candidate) continue;

      // Repriced at the quantity actually awarded. Taking 2000 of a line instead
      // of 5000 costs more per unit, and that is the cost of splitting.
      const unitPrice = candidate.priceFor(line.sku, assignment.quantity);
      if (unitPrice === null) continue;

      let allocation = grouped.get(assignment.supplierCode);
      if (!allocation) {
        allocation = {
          supplierCode: assignment.supplierCode,
          allocationKey: assignment.supplierCode,
          lines: [],
          subtotal: 0,
          leadTimeDays: candidate.leadTimeDays,
          paymentTerms: candidate.paymentTerms,
          qualityRating: candidate.supplier.qualityRating,
        };
        grouped.set(assignment.supplierCode, allocation);
      }

      const lineTotal = roundMoney(unitPrice * assignment.quantity);
      allocation.lines.push({
        sku: line.sku,
        productName: line.productName,
        quantity: assignment.quantity,
        unitPrice: roundPrice(unitPrice),
        lineTotal,
      });
      allocation.subtotal = roundMoney(allocation.subtotal + lineTotal);
    }
  }

  const allocations = [...grouped.values()].sort((a, b) => b.subtotal - a.subtotal);
  assertNoOverAllocation(basket, allocations);

  return { allocations, notes, uncovered: dedupeUncovered(uncovered) };
}

/**
 * The invariant that matters: after every repair and reprice, no line may be
 * bought in greater quantity than it was requested in. A bug here is a bug that
 * spends the brand's money, so it throws rather than warns.
 */
// #region no-over
export function assertNoOverAllocation(basket: Basket, allocations: Allocation[]): void {
  const requested = new Map(basket.lines.map((l) => [l.sku, l.quantity]));
  const awarded = new Map<string, number>();

  for (const allocation of allocations) {
    for (const line of allocation.lines) {
      awarded.set(line.sku, (awarded.get(line.sku) ?? 0) + line.quantity);
    }
  }

  for (const [sku, quantity] of awarded) {
    const want = requested.get(sku);
    if (want === undefined) throw new Error(`allocation invariant: ${sku} is not in the basket`);
    if (quantity > want) {
      throw new Error(`allocation invariant: awarded ${quantity} of ${sku} but only ${want} was requested`);
    }
  }
}
// #endregion no-over

function dedupeUncovered(lines: LineCoverage[]): LineCoverage[] {
  const bySku = new Map<string, LineCoverage>();
  for (const line of lines) {
    const existing = bySku.get(line.sku);
    if (!existing || line.offeredQty < existing.offeredQty) bySku.set(line.sku, line);
  }
  return [...bySku.values()];
}

/**
 * The award where one supplier takes everything it can. Whatever it cannot cover
 * stays uncovered rather than being quietly handed to somebody else, because the
 * point of this option is to show what that supplier alone is worth.
 */
export function allocateSingle(basket: Basket, candidate: AllocationCandidate): AllocationPlan {
  const perLine = new Map<string, Assignment[]>();
  const uncovered: LineCoverage[] = [];
  const notes: AllocationNote[] = [];

  for (const line of basket.lines) {
    const coverage = coverageFor(candidate, line.sku);
    const offered = Math.min(coverage?.offeredQty ?? 0, line.quantity);

    if (offered <= 0) {
      uncovered.push({
        sku: line.sku,
        requestedQty: line.quantity,
        offeredQty: 0,
        unitPrice: null,
        reason: coverage?.reason ?? "declined",
      });
      continue;
    }

    if (offered < candidate.supplier.moqPerLine) {
      notes.push({
        sku: line.sku,
        kind: "single_supplier",
        message: `${candidate.supplier.code} cannot run ${offered} units of ${line.sku} below its ${candidate.supplier.moqPerLine}-unit minimum`,
      });
      uncovered.push({
        sku: line.sku,
        requestedQty: line.quantity,
        offeredQty: 0,
        unitPrice: null,
        reason: "capacity_limited",
      });
      continue;
    }

    if (offered < line.quantity) {
      uncovered.push({
        sku: line.sku,
        requestedQty: line.quantity,
        offeredQty: offered,
        unitPrice: null,
        reason: coverage?.reason ?? "capacity_limited",
      });
    }

    perLine.set(line.sku, [{ supplierCode: candidate.supplier.code, quantity: offered }]);
  }

  return buildPlan(basket, [candidate], perLine, notes, uncovered);
}

export function planRequestedQty(basket: Basket): number {
  return basket.lines.reduce((sum, l) => sum + l.quantity, 0);
}

export function planAwardedQty(plan: AllocationPlan): number {
  return plan.allocations.reduce(
    (sum, a) => sum + a.lines.reduce((s, l) => s + l.quantity, 0),
    0,
  );
}
