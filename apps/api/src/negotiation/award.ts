import type {
  Award,
  AwardOption,
  Basket,
  NegotiationConstraints,
  ScoreBreakdown,
  SupplierMeta,
} from "@sq/shared";
import { scoreOptions } from "@sq/shared";
import { allocateSingle, allocateSplit, planRequestedQty, type AllocationCandidate } from "./allocation.js";

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
/** Per-unit figures are cents-scale; rounding them to whole dollars says nothing. */
const unitMoney = (n: number) => `$${n.toFixed(2)}`;
const pct = (n: number) => `${Math.round(n * 100)}%`;

/**
 * Enumerates the ways this order could be placed: each supplier alone, plus one
 * split. Comparing complete plans rather than comparing suppliers is what lets a
 * partially-capable supplier stay in contention on its merits — the cost of
 * covering its shortfall is priced into the option that contains it.
 */
export function buildAwardOptions(
  basket: Basket,
  candidates: AllocationCandidate[],
  constraints: NegotiationConstraints,
): AwardOption[] {
  const requestedQty = planRequestedQty(basket);
  const options: AwardOption[] = [];

  for (const candidate of candidates) {
    const plan = allocateSingle(basket, candidate);
    if (plan.allocations.length === 0) continue;
    options.push({
      id: `single:${candidate.supplier.code}`,
      label: `${candidate.supplier.name} alone`,
      allocations: plan.allocations,
      notes: plan.notes,
      uncoveredQty: uncoveredQty(plan.uncovered),
      requestedQty,
    });
  }

  if (candidates.length > 1 && !constraints.singleSupplierOnly) {
    // Two splits get built, not one. Greedy on landed cost alone will hand every
    // line to the cheapest supplier even when that supplier misses the brand's
    // deadline, producing a "split" that is really the disqualified incumbent
    // wearing a different label. The second split is greedy over only the
    // suppliers that clear the hard constraints, which is the plan a buyer
    // working to a deadline would actually put together.
    const eligible = candidates.filter((c) => meetsHardConstraints(c, constraints));

    const variants: Array<{ id: string; pool: AllocationCandidate[] }> = [
      { id: "split", pool: candidates },
    ];
    if (eligible.length > 1 && eligible.length < candidates.length) {
      variants.push({ id: "split:eligible", pool: eligible });
    }

    const seen = new Set<string>();
    for (const variant of variants) {
      const plan = allocateSplit(basket, variant.pool);
      if (plan.allocations.length === 0) continue;

      const signature = plan.allocations
        .map((a) => `${a.supplierCode}:${a.lines.map((l) => `${l.sku}x${l.quantity}`).join(",")}`)
        .sort()
        .join("|");
      if (seen.has(signature)) continue;
      seen.add(signature);

      const names = plan.allocations
        .map((a) => variant.pool.find((c) => c.supplier.code === a.supplierCode)?.supplier.name ?? a.supplierCode)
        .join(" + ");

      options.push({
        id: variant.id,
        label: plan.allocations.length > 1 ? `Split: ${names}` : `${names} (split resolved to one supplier)`,
        allocations: plan.allocations,
        notes: plan.notes,
        uncoveredQty: uncoveredQty(plan.uncovered),
        requestedQty,
      });
    }
  }

  return options;
}

function meetsHardConstraints(
  candidate: AllocationCandidate,
  constraints: NegotiationConstraints,
): boolean {
  if (constraints.maxLeadTimeDays !== null && candidate.leadTimeDays > constraints.maxLeadTimeDays) return false;
  if (constraints.minQualityRating !== null && candidate.supplier.qualityRating < constraints.minQualityRating) {
    return false;
  }
  return true;
}

function uncoveredQty(uncovered: Array<{ requestedQty: number; offeredQty: number }>): number {
  return uncovered.reduce((sum, l) => sum + Math.max(0, l.requestedQty - l.offeredQty), 0);
}

export type AwardResult = { award: Award; breakdowns: ScoreBreakdown[] };

/**
 * Ranks the options and writes down why. The ranking is arithmetic, and the
 * explanation is generated from the same numbers, so the reasoning the brand
 * reads cannot drift from the decision the system made.
 */
export function pickWinner(
  options: AwardOption[],
  candidates: AllocationCandidate[],
  constraints: NegotiationConstraints,
): AwardResult | null {
  if (options.length === 0) return null;

  const suppliers: Record<string, SupplierMeta> = {};
  for (const c of candidates) suppliers[c.supplier.code] = { country: c.supplier.country };

  const breakdowns = scoreOptions(options, suppliers, constraints);
  const winner = breakdowns.find((b) => !b.disqualified) ?? breakdowns[0]!;
  const option = options.find((o) => o.id === winner.optionId)!;
  const runnerUp = breakdowns.find((b) => b.optionId !== winner.optionId);

  const supplierName = (code: string) =>
    candidates.find((c) => c.supplier.code === code)?.supplier.name ?? code;

  const bullets: string[] = [];

  bullets.push(
    `Effective cost ${money(winner.effectiveTotal)} — ${money(winner.landedTotal)} landed, ` +
      `${money(winner.cashFlowCost)} in cash tied up by the payment schedule` +
      (winner.switchingPenalty > 0 ? `, ${money(winner.switchingPenalty)} for running two suppliers` : ""),
  );

  bullets.push(
    `Delivered in ${winner.leadTimeDays} days at a weighted quality rating of ${winner.qualityRating.toFixed(2)}`,
  );

  if (winner.coverageRatio < 1) {
    bullets.push(
      `Covers ${pct(winner.coverageRatio)} of the requested units; the shortfall is priced into the score`,
    );
  } else {
    bullets.push("Covers the full order with no shortfall");
  }

  for (const allocation of option.allocations) {
    const units = allocation.lines.reduce((s, l) => s + l.quantity, 0);
    bullets.push(
      `${supplierName(allocation.supplierCode)}: ${allocation.lines.length} lines, ` +
        `${units.toLocaleString("en-US")} units, ${money(allocation.subtotal)} at ${allocation.paymentTerms} ` +
        `over ${allocation.leadTimeDays} days`,
    );
  }

  for (const note of option.notes.filter((n) => n.kind === "moq_repair").slice(0, 3)) {
    bullets.push(note.message);
  }

  if (runnerUp) {
    // Comparing two plans that buy different quantities on total spend alone is
    // how you talk yourself into a cheap order that does not fill the shelves.
    // When coverage differs the comparison has to be per unit.
    const coverageGap = Math.abs(runnerUp.coverageRatio - winner.coverageRatio) > 0.01;
    if (coverageGap) {
      const perUnit = (b: ScoreBreakdown) => b.effectiveTotal / Math.max(1, b.coveredQty);
      const delta = perUnit(runnerUp) - perUnit(winner);
      bullets.push(
        `${runnerUp.label} looks cheaper in total only because it covers ${pct(runnerUp.coverageRatio)} of the order; ` +
          `per unit actually delivered it is ${delta >= 0 ? unitMoney(delta) + " dearer" : unitMoney(-delta) + " cheaper"}`,
      );
    } else {
      const delta = runnerUp.effectiveTotal - winner.effectiveTotal;
      bullets.push(
        delta >= 0
          ? `${runnerUp.label} would have cost ${money(delta)} more in effective terms`
          : `${runnerUp.label} was ${money(-delta)} cheaper but lost on lead time or quality`,
      );
    }
  }

  const rejected = breakdowns
    .filter((b) => b.optionId !== winner.optionId)
    .map((b) => {
      if (b.disqualified) return `${b.label}: ${b.disqualifiedReasons.join("; ")}`;
      return (
        `${b.label}: ${money(b.effectiveTotal)} effective, ${b.leadTimeDays} days, ` +
        `quality ${b.qualityRating.toFixed(2)}, covers ${pct(b.coverageRatio)}`
      );
    });

  return {
    award: {
      plan: { allocations: option.allocations, notes: option.notes, uncovered: [] },
      winningOptionId: winner.optionId,
      label: winner.label,
      scores: breakdowns,
      reasoning: {
        headline: winner.disqualified
          ? `${winner.label} is the only workable plan, but it breaks a stated constraint`
          : `${winner.label} is the best deal on the brand's stated priorities`,
        bullets,
        runnerUp: runnerUp?.label ?? null,
        rejected,
      },
    },
    breakdowns,
  };
}
