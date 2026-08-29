import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, type NegotiationSummary } from "../lib/api.js";
import { Badge, Button, Empty, Hint, Spinner, cx } from "../components/ui.js";
import { dateOnly, money, qty } from "../lib/format.js";
import { STATUS_COPY, isRunning, statusRank } from "../lib/negotiation-status.js";

type SortKey = "filename" | "status" | "winner" | "total" | "createdAt";
type SortDir = "asc" | "desc";
type Sort = { key: SortKey; dir: SortDir };

/**
 * How each column compares, ascending. Direction is applied afterwards so that
 * "descending" cannot mean something subtly different from one column to the
 * next.
 */
const COMPARATORS: Record<SortKey, (a: NegotiationSummary, b: NegotiationSummary) => number> = {
  filename: (a, b) => a.filename.localeCompare(b.filename),
  status: (a, b) => statusRank(a.status) - statusRank(b.status),
  winner: (a, b) => (a.winner ?? "").localeCompare(b.winner ?? ""),
  total: (a, b) => (a.total ?? 0) - (b.total ?? 0),
  createdAt: (a, b) => a.createdAt.localeCompare(b.createdAt),
};

/**
 * Rows with nothing in the sorted column sink to the bottom either way.
 *
 * Flipping to descending to find the largest basket should not first hand you
 * the six negotiations that do not have one yet, and those rows are showing a
 * quantity rather than a cost, so ranking them among the costs would be
 * comparing two different units.
 */
const EMPTY_LAST: Partial<Record<SortKey, (row: NegotiationSummary) => boolean>> = {
  total: (row) => row.total === null,
  winner: (row) => row.winner === null,
};

/**
 * Declared here rather than inside the route: a component defined during render
 * is a new type on every render, so React would unmount and remount each header
 * whenever the sort changed — losing the tooltip mid-hover.
 */
function SortHeader({
  column,
  sort,
  onToggle,
  children,
  align = "left",
}: {
  column: SortKey;
  sort: Sort;
  onToggle: (key: SortKey) => void;
  children: ReactNode;
  align?: "left" | "right";
}) {
  const active = sort.key === column;
  return (
    <th
      className={cx("px-4 py-2.5", align === "right" && "text-right")}
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={() => onToggle(column)}
        className={cx(
          "group inline-flex items-center gap-1 font-medium transition-colors hover:text-ink",
          align === "right" && "flex-row-reverse",
          active ? "text-ink" : "text-ink-dim",
        )}
      >
        {children}
        {/* Inactive columns show their arrow faintly on hover: without it there is
            nothing to say a header can be clicked until you have clicked one. */}
        <span
          aria-hidden
          className={cx(
            "text-[10px] transition-opacity",
            active ? "opacity-100" : "opacity-0 group-hover:opacity-40",
          )}
        >
          {active && sort.dir === "asc" ? "▲" : "▼"}
        </span>
      </button>
    </th>
  );
}

function sortRows(rows: NegotiationSummary[], sort: Sort): NegotiationSummary[] {
  const isEmpty = EMPTY_LAST[sort.key];
  return [...rows].sort((a, b) => {
    if (isEmpty) {
      const [ea, eb] = [isEmpty(a), isEmpty(b)];
      if (ea !== eb) return ea ? 1 : -1;
    }
    const order = COMPARATORS[sort.key](a, b);
    return sort.dir === "asc" ? order : -order;
  });
}

/**
 * Negotiations already run in the background: starting one returns immediately
 * and the workflow survives an API restart. What was missing was a way back to a
 * negotiation you walked away from, which is all this page is.
 */
export function NegotiationsRoute() {
  const [rows, setRows] = useState<NegotiationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Matches the order the API already returns, so the first paint does not move.
  const [sort, setSort] = useState<Sort>({ key: "createdAt", dir: "desc" });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const next = await api.negotiations();
        if (!cancelled) setRows(next);
        return next;
      } catch (e) {
        if (!cancelled) setError(e instanceof ApiError ? e.message : String(e));
        return null;
      }
    }

    void load();

    // Polled rather than streamed: this page only needs to know that a status
    // changed, not what was said. The transcript stream stays on the detail page
    // where someone is actually reading it.
    const timer = setInterval(async () => {
      const next = await load();
      if (next && !next.some((row) => isRunning(row.status))) clearInterval(timer);
    }, 4000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const sorted = useMemo(() => (rows ? sortRows(rows, sort) : null), [rows, sort]);

  if (error) return <p className="text-sm text-bad">{error}</p>;
  if (!rows || !sorted) return <Spinner label="Loading negotiations…" />;

  const running = rows.filter((row) => isRunning(row.status)).length;

  /**
   * A fresh column starts descending for the two where the interesting end is
   * the top — the newest negotiation and the biggest basket — and ascending
   * where reading order is what you expect, as with a filename.
   */
  function toggle(key: SortKey) {
    setSort((current) =>
      current.key === key
        ? { key, dir: current.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "createdAt" || key === "total" ? "desc" : "asc" },
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4 animate-in">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Negotiations</h1>
          <p className="mt-1.5 text-sm text-ink-dim">
            {rows.length === 0
              ? "Nothing negotiated yet."
              : running > 0
                ? `${rows.length} total, ${running} still running. They keep going if you leave this page.`
                : `${rows.length} negotiation${rows.length === 1 ? "" : "s"}, none running.`}
          </p>
        </div>
        <Link to="/">
          <Button variant="secondary">New quotation</Button>
        </Link>
      </div>

      {rows.length === 0 ? (
        <Empty>Upload a quotation and start a negotiation. It will appear here while it runs.</Empty>
      ) : (
        <div className="overflow-hidden rounded-xl border border-edge bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-edge bg-surface-2/60 text-left text-xs font-medium text-ink-dim">
                <SortHeader column="filename" sort={sort} onToggle={toggle}>Quotation</SortHeader>
                <SortHeader column="status" sort={sort} onToggle={toggle}>Status</SortHeader>
                <SortHeader column="winner" sort={sort} onToggle={toggle}>Outcome</SortHeader>
                <SortHeader column="total" align="right" sort={sort} onToggle={toggle}>
                  <Hint
                    content={
                      <>
                        <strong>Once a winner is picked</strong>, the cost of the winning plan —
                        every allocation in it, added up.
                        <br />
                        <br />
                        <strong>Before that</strong>, there is no cost yet, so this shows the volume
                        tier the basket is being priced at instead: units per line. Sorting keeps
                        those rows at the bottom.
                      </>
                    }
                  >
                    <span className="underline decoration-dotted underline-offset-2">Basket</span>
                  </Hint>
                </SortHeader>
                <SortHeader column="createdAt" sort={sort} onToggle={toggle}>Started</SortHeader>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => {
                const copy = STATUS_COPY[row.status];
                return (
                  <tr key={row.id} className="border-b border-edge/60 last:border-0 hover:bg-surface-2/40">
                    <td className="px-4 py-3">{row.filename}</td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-2">
                        {isRunning(row.status) && <Spinner />}
                        <Badge tone={copy.tone}>{copy.label}</Badge>
                      </span>
                    </td>
                    <td className="px-4 py-3 text-ink-dim">
                      {row.winner ?? <span className="text-ink-faint">—</span>}
                      {row.purchaseOrderCount > 0 && (
                        <span className="text-ink-faint">
                          {" "}
                          · {row.purchaseOrderCount} PO{row.purchaseOrderCount === 1 ? "" : "s"}
                        </span>
                      )}
                    </td>
                    <td className="nums px-4 py-3 text-right text-ink-dim">
                      {row.total === null ? (
                        <span className="text-ink-faint">{qty(row.tierQuantity)}/line</span>
                      ) : (
                        money(row.total)
                      )}
                    </td>
                    <td className="px-4 py-3 text-ink-dim">{dateOnly(row.createdAt)}</td>
                    <td className="px-4 py-3 text-right">
                      <Link to={`/negotiations/${row.id}`} className="text-accent hover:underline">
                        Open
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
