import { useEffect, useRef } from "react";
import type { SupplierProfile } from "@sq/shared";
import type { TranscriptEntry } from "../lib/api.js";
import { Badge, Empty, Hint, cx } from "./ui.js";
import { dateTime } from "../lib/format.js";

/**
 * The negotiation as it reads to a human. Offers carry structured numbers too,
 * but they are shown as the concessions the supplier named, in their words,
 * rather than as a JSON dump.
 */
export function Transcript({
  entries,
  live,
  suppliers,
}: {
  entries: TranscriptEntry[];
  live: boolean;
  suppliers: SupplierProfile[];
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    if (stick.current) endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [entries.length]);

  return (
    <div
      className="max-h-[70vh] space-y-4 overflow-y-auto pr-1"
      onScroll={(e) => {
        const el = e.currentTarget;
        // Stop yanking the view back down once the user scrolls up to reread.
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      {/*
        A negotiation that stops before its first round leaves nothing to render,
        and an empty card reads as a component that failed rather than as a
        conversation that never happened. When it is still live the pulse below
        already says what is going on, so this only speaks once it cannot.
      */}
      {entries.length === 0 && !live && (
        <Empty>Nothing was exchanged. This negotiation stopped before the agents began.</Empty>
      )}
      {entries.map((entry) => (
        <Entry key={entry.sequence} entry={entry} suppliers={suppliers} />
      ))}
      {live && (
        <div className="flex items-center gap-2 pl-1 text-xs text-ink-faint">
          <span className="size-1.5 animate-pulse rounded-full bg-accent" />
          waiting for the next offer
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}

function Entry({ entry, suppliers }: { entry: TranscriptEntry; suppliers: SupplierProfile[] }) {
  const profile = suppliers.find((s) => s.code === entry.supplierCode);

  if (entry.actor === "system") {
    return (
      <div className="animate-in rounded-lg border border-dashed border-edge-strong bg-surface-2/60 px-3.5 py-2.5 text-xs text-ink-dim">
        {entry.message}
      </div>
    );
  }

  const isBrand = entry.actor === "brand";

  return (
    <div className={cx("animate-in flex gap-3", isBrand && "flex-row-reverse")}>
      <div
        className={cx(
          "grid size-8 shrink-0 place-items-center rounded-lg text-[11px] font-bold",
          isBrand
            ? "bg-primary text-primary-ink"
            : "border border-edge bg-surface-2 text-ink-dim",
        )}
      >
        {isBrand ? "YOU" : (profile?.name ?? entry.supplierCode ?? "S").slice(0, 2).toUpperCase()}
      </div>

      <div className={cx("min-w-0 flex-1", isBrand && "text-right")}>
        <div
          className={cx(
            "flex items-baseline gap-2 text-xs text-ink-faint",
            isBrand && "flex-row-reverse",
          )}
        >
          <span className="font-medium text-ink-dim">
            {isBrand ? "Brand agent" : (entry.supplierName ?? entry.supplierCode)}
          </span>
          {profile && (
            <Hint content={`Quality rating ${profile.qualityRating} out of 5, ships from ${profile.country}`}>
              <span className="nums">★ {profile.qualityRating}</span>
            </Hint>
          )}
          <span>round {entry.round}</span>
          <span>{dateTime(entry.createdAt)}</span>
        </div>

        <div
          className={cx(
            "mt-1.5 inline-block rounded-xl border px-3.5 py-2.5 text-left text-sm leading-relaxed",
            isBrand
              ? "border-accent/20 bg-accent/8 text-ink"
              : "border-edge bg-surface-2 text-ink",
          )}
        >
          {entry.message}
        </div>

        {entry.offer && entry.offer.concessions.length > 0 && (
          <div className={cx("mt-2 flex flex-wrap gap-1.5", isBrand && "justify-end")}>
            {entry.offer.concessions.map((c) => (
              <Badge key={c.kind} tone="good">
                {c.description}
              </Badge>
            ))}
            {entry.offer.clamped.map((reason) => (
              <Hint
                key={reason}
                content="The agent proposed something outside this supplier's real limits, so it was pulled back to what they can actually honour. Bounds are enforced in code, never left to the model."
              >
                <Badge tone="warn">held at limit: {reason}</Badge>
              </Hint>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
