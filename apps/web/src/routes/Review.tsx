import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, ApiError, type Quotation, type QuotationLine } from "../lib/api.js";
import {
  Badge,
  Button,
  Card,
  ConfidenceDot,
  Hint,
  Segmented,
  Spinner,
  Stat,
  cx,
} from "../components/ui.js";
import { money, qty, unitMoney } from "../lib/format.js";

type Filter = "all" | "review";

export function ReviewRoute() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [quotation, setQuotation] = useState<Quotation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tier, setTier] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (!id) return;
    api
      .quotation(id)
      .then((q) => {
        setQuotation(q);
        setTier(q.suggestedTier);
        setNote(q.brandNote ?? "");
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  }, [id]);

  const linesAtTier = useMemo(
    () => (quotation && tier ? quotation.lines.filter((l) => l.tierQuantity === tier) : []),
    [quotation, tier],
  );

  // The basket is one line per distinct SKU in the whole file, not per row at
  // the selected tier: a line the incumbent declined to price at this volume is
  // still a line the brand wants, and the rival suppliers have not refused it.
  const basketSkus = useMemo(
    () => new Set((quotation?.lines ?? []).map((l) => l.matchedSku ?? l.rawSku)).size,
    [quotation],
  );

  const visible = filter === "review" ? linesAtTier.filter(needsReview) : linesAtTier;

  if (error) return <p className="text-sm text-bad">{error}</p>;
  if (!quotation || tier === null) return <Spinner label="Loading quotation…" />;

  const baseline = linesAtTier.reduce((sum, l) => sum + l.lineTotal, 0);
  const flagged = linesAtTier.filter(needsReview).length;
  const unpricedAtTier = basketSkus - linesAtTier.length;
  const basketUnits = basketSkus * tier;

  async function start() {
    if (!quotation || tier === null) return;
    setStarting(true);
    setError(null);
    try {
      const negotiation = await api.startNegotiation({
        quotationId: quotation.id,
        tierQuantity: tier,
        note,
      });
      navigate(`/negotiations/${negotiation.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setStarting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4 animate-in">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{quotation.filename}</h1>
          <p className="mt-1.5 text-sm text-ink-dim">
            {quotation.metadata.supplierName ?? "Supplier not named in the file"}
            {quotation.metadata.quotationDate && ` — quoted ${quotation.metadata.quotationDate}`}
          </p>
        </div>
        <Badge tone={quotation.layout.source === "llm" ? "accent" : "neutral"}>
          Layout read by {quotation.layout.source === "llm" ? "model + heuristics" : "heuristics"}
        </Badge>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Baseline value" value={money(baseline)} hint="What this quotation is worth at the selected tier. The number the brand agent negotiates against." />
        <Stat
          label="Units to buy"
          value={qty(basketUnits)}
          hint={
            unpricedAtTier > 0
              ? `${qty(basketSkus)} lines at ${qty(tier)} each. The incumbent priced ${qty(linesAtTier.length)} of them at this tier; the other ${qty(unpricedAtTier)} still go to the rival suppliers.`
              : `${qty(basketSkus)} lines at ${qty(tier)} each.`
          }
        />
        <Stat
          label="Lines"
          value={qty(basketSkus)}
          tone={unpricedAtTier > 0 ? "warn" : "neutral"}
          hint={
            unpricedAtTier > 0
              ? `${qty(unpricedAtTier)} of these are not priced at this tier in the file. They stay in the basket, and the shortfall counts against the incumbent when the plans are scored.`
              : "Every line in the file is priced at this tier."
          }
        />
        <Stat
          label="Need a look"
          value={qty(flagged)}
          tone={flagged > 0 ? "warn" : "good"}
          hint="Lines matched by something other than an exact SKU, or where the file's own total does not agree with quantity times price."
        />
      </div>

      {quotation.warnings.length > 0 && (
        <Card title="What the parser had to work around">
          <ul className="space-y-1.5 text-sm text-ink-dim">
            {quotation.warnings.map((w) => (
              <li key={w} className="flex gap-2">
                <span className="text-warn">•</span>
                {w}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card
        title="Matched lines"
        subtitle="Every row is matched against products.csv. Colour shows how confident that match is."
        action={
          <div className="flex items-center gap-3">
            {quotation.tiers.length > 1 && (
              <Segmented
                value={tier}
                onChange={setTier}
                options={quotation.tiers.map((t) => ({
                  value: t,
                  label: <span className="nums">{qty(t)}/unit tier</span>,
                }))}
              />
            )}
            <Segmented
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "All" },
                { value: "review", label: `Needs review (${flagged})` },
              ]}
            />
          </div>
        }
      >
        <div className="mb-3 flex flex-wrap items-center gap-4 text-xs text-ink-faint">
          <Legend tone="bg-good" label="Exact SKU" />
          <Legend tone="bg-warn" label="Read through a typo" />
          <Legend tone="bg-bad" label="Weak — please check" />
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-edge text-left text-[11px] uppercase tracking-wider text-ink-dim">
                <th className="py-2 pr-3 font-semibold">In the file</th>
                <th className="py-2 pr-3 font-semibold">Matched to</th>
                <th className="py-2 pr-3 text-right font-semibold">Qty</th>
                <th className="py-2 pr-3 text-right font-semibold">Unit</th>
                <th className="py-2 text-right font-semibold">Line total</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((line) => (
                <LineRow key={`${line.sheetName}-${line.rowNumber}`} line={line} />
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card
        title="Brief for the brand agent"
        subtitle="Edit before you start. The agent works to this, and the hard limits are enforced in code rather than left to the model's discretion."
      >
        <textarea
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. prioritize lead time over cost, 30 day deadline"
          className="w-full resize-none rounded-lg border border-edge bg-surface-2/60 px-3.5 py-2.5 text-sm outline-none placeholder:text-ink-faint focus:border-accent"
        />
        <div className="mt-3 flex flex-wrap gap-2">
          {quotation.constraintSummary.map((line) => (
            <Badge key={line} tone="accent">
              {line}
            </Badge>
          ))}
        </div>
        <p className="mt-3 text-xs text-ink-faint">
          Re-read when you start the negotiation, so what you see above updates to match.
        </p>

        {error && <p className="mt-3 text-sm text-bad">{error}</p>}

        <div className="mt-5 flex items-center justify-end gap-3">
          {starting && <Spinner label="Opening the negotiation…" />}
          <Button variant="primary" onClick={start} disabled={starting}>
            Negotiate {qty(basketUnits)} units
          </Button>
        </div>
      </Card>
    </div>
  );
}

function Legend({ tone, label }: { tone: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cx("size-2.5 rounded-full", tone)} />
      {label}
    </span>
  );
}

function needsReview(line: QuotationLine): boolean {
  return line.matchMethod !== "exact" || line.totalMismatch;
}

function LineRow({ line }: { line: QuotationLine }) {
  return (
    <tr className="border-b border-edge/50 transition-colors last:border-0 hover:bg-surface-2/40">
      <td className="py-2.5 pr-3">
        <div className="flex items-center gap-2">
          <ConfidenceDot confidence={line.matchConfidence} method={line.matchMethod} />
          <span className="nums font-medium">{line.rawSku}</span>
        </div>
        {line.rawDescription && (
          <div className="mt-0.5 pl-4.5 text-xs text-ink-faint">{line.rawDescription}</div>
        )}
      </td>
      <td className="py-2.5 pr-3">
        {line.matchedSku ? (
          <>
            <div className="nums">
              {line.matchedSku !== line.rawSku ? (
                <Hint
                  content={`The file says ${line.rawSku}. We read that as ${line.matchedSku} (${line.matchMethod} match).`}
                >
                  <span className="text-warn">{line.matchedSku}</span>
                </Hint>
              ) : (
                line.matchedSku
              )}
            </div>
            <div className="mt-0.5 text-xs text-ink-faint">{line.matchedName}</div>
          </>
        ) : (
          <Badge tone="bad">Not in the catalog</Badge>
        )}
        {line.candidates.length > 1 && (
          <div className="mt-1 text-xs text-ink-faint">
            Also close: {line.candidates.slice(1, 3).map((c) => c.sku).join(", ")}
          </div>
        )}
      </td>
      <td className="nums py-2.5 pr-3 text-right">{qty(line.quantity)}</td>
      <td className="nums py-2.5 pr-3 text-right">
        {unitMoney(line.unitPrice)}
        {line.discountPct > 0 && (
          <div className="text-xs text-good">−{line.discountPct}% applied</div>
        )}
      </td>
      <td className="nums py-2.5 text-right">
        {money(line.lineTotal, 2)}
        {line.totalMismatch && (
          <Hint content="The total printed in the file does not equal quantity times unit price. We recomputed it rather than trusting the sheet.">
            <span className="ml-1.5 text-warn">recomputed</span>
          </Hint>
        )}
      </td>
    </tr>
  );
}
