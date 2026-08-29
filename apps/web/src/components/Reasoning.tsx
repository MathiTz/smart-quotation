import { useState } from "react";
import type { Award } from "@sq/shared";
import { Badge, cx } from "./ui.js";

/**
 * The decision, then the working underneath it. The headline is the agent's own
 * words; the bullets below are generated from the same numbers that produced the
 * ranking, so the explanation cannot drift from the decision.
 */
export function Reasoning({ award }: { award: Award }) {
  const [showRejected, setShowRejected] = useState(false);

  return (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-ink">{award.reasoning.headline}</p>

      <ul className="space-y-2 border-l-2 border-accent/30 pl-4">
        {award.reasoning.bullets.map((bullet) => (
          <li key={bullet} className="text-sm leading-relaxed text-ink-dim">
            {bullet}
          </li>
        ))}
      </ul>

      {award.plan.notes.length > 0 && (
        <div className="space-y-1.5">
          {award.plan.notes.map((note, i) => (
            <div
              key={`${note.kind}-${i}`}
              className="rounded-lg border border-edge bg-surface-2/40 px-3.5 py-2 text-xs text-ink-dim"
            >
              <Badge tone={note.kind === "moq_repair" ? "warn" : "neutral"} className="mr-2">
                {note.kind === "moq_repair" ? "Rebalanced" : note.kind.replace(/_/g, " ")}
              </Badge>
              {note.message}
            </div>
          ))}
        </div>
      )}

      {award.reasoning.rejected.length > 0 && (
        <div>
          <button
            onClick={() => setShowRejected((v) => !v)}
            className="text-xs text-ink-faint transition hover:text-ink"
          >
            {showRejected ? "Hide" : "Show"} the {award.reasoning.rejected.length} plans it beat
          </button>
          <ul
            className={cx(
              "mt-2 space-y-1.5 border-l-2 border-edge pl-4",
              showRejected ? "block" : "hidden",
            )}
          >
            {award.reasoning.rejected.map((line) => (
              <li key={line} className="text-xs leading-relaxed text-ink-faint">
                {line}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
