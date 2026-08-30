import type { ScoreBreakdown } from "@sq/shared";
import { Badge, Hint, cx } from "./ui.js";
import { money, pct } from "../lib/format.js";

export type CostBasis = "fob" | "landed" | "effective";

const AMOUNT: Record<CostBasis, (s: ScoreBreakdown) => number> = {
  fob: (s) => s.fobTotal,
  landed: (s) => s.landedTotal,
  effective: (s) => s.effectiveTotal,
};

/**
 * Every plan the system considered, side by side. Disqualified plans are shown
 * rather than hidden: "why didn't it pick the cheap one" is the first question a
 * sourcing manager asks, and the answer needs to be on screen.
 *
 * Ruled-out plans are not selectable. A hard constraint in the brand note is a
 * hard constraint — the buyer can still pick a different *qualifying* plan over
 * the recommendation, but not one the note itself ruled out.
 */
export function Comparison({
  scores,
  winningId,
  basis,
  selectedId,
  onSelect,
}: {
  scores: ScoreBreakdown[];
  winningId: string;
  basis: CostBasis;
  /** Omitted once the negotiation is committed: there is nothing left to choose. */
  selectedId?: string;
  onSelect?: (optionId: string) => void;
}) {
  const ranked = [...scores].sort((a, b) => b.score - a.score);
  const canChoose = Boolean(onSelect);

  // Each bar is read against the same dimension on every other plan, so it needs
  // the whole column, not just its own cell.
  const column = {
    cost: scores.map((s) => s.components.cost),
    leadTime: scores.map((s) => s.components.leadTime),
    quality: scores.map((s) => s.components.quality),
    paymentTerms: scores.map((s) => s.components.paymentTerms),
  };

  return (
    <div
      className="space-y-3"
      role={canChoose ? "radiogroup" : undefined}
      aria-label={canChoose ? "Which plan to buy" : undefined}
    >
      {ranked.map((score) => {
        const won = score.optionId === winningId;
        const selected = score.optionId === selectedId;
        const pickable = canChoose && !score.disqualified;
        return (
          <div
            key={score.optionId}
            role={pickable ? "radio" : undefined}
            aria-checked={pickable ? selected : undefined}
            aria-disabled={canChoose && score.disqualified ? true : undefined}
            tabIndex={pickable ? 0 : undefined}
            onClick={() => {
              if (pickable) onSelect?.(score.optionId);
            }}
            onKeyDown={(event) => {
              if (!pickable) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect?.(score.optionId);
              }
            }}
            className={cx(
              "rounded-lg border px-4 py-3 transition",
              won
                ? "border-accent/40 bg-accent/6 shadow-[0_1px_2px_rgba(16,18,24,0.05)]"
                : "border-edge bg-surface",
              score.disqualified && "bg-surface-2/70 opacity-75",
              pickable && "cursor-pointer hover:border-accent/60",
              canChoose && score.disqualified && "cursor-not-allowed",
              selected && pickable && "border-accent ring-2 ring-accent/25",
              pickable && "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
            )}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  {pickable && <Radio checked={selected} />}
                  <span className="text-sm font-medium">{score.label}</span>
                  {won && (
                    <Badge tone="accent" className="shrink-0 whitespace-nowrap">
                      Recommended
                    </Badge>
                  )}
                  {score.disqualified && (
                    <Badge tone="bad" className="shrink-0 whitespace-nowrap">
                      Ruled out
                    </Badge>
                  )}
                </div>
                {score.disqualified && (
                  <p className="mt-1 text-xs text-bad">{score.disqualifiedReasons.join("; ")}</p>
                )}
              </div>
              <div className="text-right">
                <Hint
                  as="div"
                  content={
                    basis === "effective"
                      ? `${money(score.landedTotal)} landed + ${money(score.cashFlowCost)} cash tied up${score.switchingPenalty > 0 ? ` + ${money(score.switchingPenalty)} for a second supplier` : ""}`
                      : basis === "landed"
                        ? `${money(score.fobTotal)} quoted, plus freight and duty`
                        : "Straight off the quote, before freight, duty or payment timing"
                  }
                >
                  <div className="nums text-lg font-semibold">{money(AMOUNT[basis](score))}</div>
                </Hint>
                <div className="nums mt-0.5 text-xs text-ink-dim">
                  {score.leadTimeDays}d — ★{score.qualityRating.toFixed(2)}
                  {score.coverageRatio < 1 && ` — covers ${pct(score.coverageRatio)}`}
                </div>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-4 gap-2">
              <Bar label="Cost" value={score.components.cost} column={column.cost} />
              <Bar label="Lead time" value={score.components.leadTime} column={column.leadTime} />
              <Bar label="Quality" value={score.components.quality} column={column.quality} />
              <Bar label="Terms" value={score.components.paymentTerms} column={column.paymentTerms} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Purely decorative: the card carries the `radio` role and the keyboard handling.
 * It exists because a highlighted border alone does not read as "you may pick a
 * different one" — the recommended plan was already highlighted before any of
 * this was selectable.
 */
function Radio({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cx(
        "grid size-3.5 shrink-0 place-items-center rounded-full border transition",
        checked ? "border-accent" : "border-edge-strong",
      )}
    >
      {checked && <span className="size-1.5 rounded-full bg-accent" />}
    </span>
  );
}

/**
 * One dimension of one plan.
 *
 * The bar shows where this plan stands against the others on this dimension alone:
 * the best of them fills it, the worst leaves it empty. That is deliberately not
 * the same quantity as the points the dimension contributes, which is weighted by
 * what the brand said it cared about. Drawing the weighted points instead — the
 * earlier behaviour — made every bar read as a failing grade, because a dimension
 * worth a fifth of the decision can never fill more than a fifth of the bar no
 * matter how good the plan is.
 */
function Bar({ label, value, column }: { label: string; value: number; column: number[] }) {
  const best = Math.max(...column);
  const tied = best - Math.min(...column) < 1e-9;
  const share = tied || best <= 0 ? 0 : value / best;

  // The best plan on a dimension normalises to 1, so its weighted contribution is
  // the weight itself. Reading it off the column saves shipping the weights to the
  // client, where they would only ever be used for this sentence.
  const weightPct = Math.round(best * 100);
  const dimension = label.toLowerCase();

  return (
    <Hint
      as="div"
      content={
        tied ? (
          <>
            Every plan offers the same {dimension}, so it cannot separate them and was
            given no weight in the ranking.
          </>
        ) : (
          <>
            <strong>{Math.round(share * 100)} out of 100</strong> on {dimension}, measured
            against the other plans considered: the best of them fills the bar, the worst
            leaves it empty.
            <br />
            <br />
            {label} is worth <strong>{weightPct} of the 100 points</strong> a plan can score,
            set by the priorities in the brand note. This plan earns{" "}
            <strong>{(value * 100).toFixed(1)}</strong> of them.
          </>
        )
      }
    >
      <div>
        <div className="text-[10px] font-medium uppercase tracking-wider text-ink-dim">{label}</div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full border border-edge bg-surface-2">
          <div
            className="h-full rounded-full bg-accent transition-all"
            style={{ width: `${Math.max(2, share * 100)}%` }}
          />
        </div>
      </div>
    </Hint>
  );
}
