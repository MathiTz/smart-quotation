import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { NegotiationStatus, SupplierProfile } from "@sq/shared";
import { AS_QUOTED, SUPPLIER_2_CURVEBALL_RATIO, formatPaymentTerms } from "@sq/shared";
import { api, streamNegotiation, type Negotiation, type TranscriptEntry } from "../lib/api.js";
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorNote,
  ErrorPage,
  Hint,
  Segmented,
  Spinner,
  cx,
} from "../components/ui.js";
import { errorText } from "../lib/errors.js";
import { money, pct, qty } from "../lib/format.js";
import { Transcript } from "../components/Transcript.js";
import { Comparison, type CostBasis } from "../components/Comparison.js";
import { Reasoning } from "../components/Reasoning.js";

import { statusCopy } from "../lib/negotiation-status.js";

/** One reconciliation row: a named cost basis and what it comes to. */
function Line({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <Hint content={hint}>
        <span className="text-ink-dim underline decoration-dotted underline-offset-2">{label}</span>
      </Hint>
      <span className="nums font-medium">{children}</span>
    </div>
  );
}

export function NegotiationRoute() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [negotiation, setNegotiation] = useState<Negotiation | null>(null);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [status, setStatus] = useState<NegotiationStatus>("pending");
  const [suppliers, setSuppliers] = useState<SupplierProfile[]>([]);
  const [basis, setBasis] = useState<CostBasis>("effective");
  // Split for the same reason as the review screen: a failed convert must not
  // take the transcript and the comparison down with it.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // The stream dying is not an error the user caused, so it reads as a warning
  // and sits above the transcript rather than beside a button.
  const [streamLost, setStreamLost] = useState(false);
  const [busy, setBusy] = useState(false);
  // Null means "whatever is recommended", so the default survives the award
  // arriving over SSE after the page has already rendered.
  const [pickedId, setPickedId] = useState<string | null>(null);

  // Derived from the negotiation rather than the page load, because a random key
  // per mount is only idempotent until someone reloads: the retry then looks like
  // a brand new purchase and buys the basket a second time. The server appends
  // the allocation and a hash of the agreed terms, so this need only be stable.
  const idempotencyKey = `convert:${id}`;

  const refresh = useCallback(async () => {
    if (!id) return;
    const fresh = await api.negotiation(id);
    setNegotiation(fresh);
    setStatus(fresh.status);
    setEntries(fresh.transcript);
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    api
      .suppliers()
      .then((list) => {
        if (!cancelled) setSuppliers(list);
      })
      // Supplier profiles are only used to put names to codes, so failing to
      // load them degrades a label rather than the page.
      .catch(() => {
        if (!cancelled) setSuppliers([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    let stop = () => {};

    // Anything held from the previous negotiation is wrong for this one. The
    // selected plan matters most: option ids are positional ("single:supplier_1")
    // and repeat across negotiations, so a stale pick silently pre-selects a
    // different plan on a different basket.
    setNegotiation(null);
    setEntries([]);
    setPickedId(null);
    setLoadError(null);
    setActionError(null);
    setStreamLost(false);

    api
      .negotiation(id)
      .then((fresh) => {
        if (cancelled) return;
        setNegotiation(fresh);
        setStatus(fresh.status);
        setEntries(fresh.transcript);

        // Follow from where the snapshot ended rather than from zero, so the
        // opening rounds are not rendered twice.
        const after = fresh.transcript.at(-1)?.sequence ?? 0;
        stop = streamNegotiation(id, after, {
          onMessage: (entry) => {
            if (cancelled) return;
            setEntries((prev) =>
              prev.some((e) => e.sequence === entry.sequence) ? prev : [...prev, entry],
            );
          },
          onStatus: (next) => {
            if (cancelled) return;
            setStreamLost(false);
            setStatus(next);
          },
          onDone: () => {
            if (cancelled) return;
            // The award and the rebuilt plans are not on the stream, so the
            // finished negotiation has to be re-read before it can be committed.
            refresh().catch((e) => {
              if (!cancelled) setActionError(errorText(e));
            });
          },
          onError: () => {
            if (!cancelled) setStreamLost(true);
          },
        });
      })
      .catch((e) => {
        if (!cancelled) setLoadError(errorText(e));
      });

    return () => {
      cancelled = true;
      stop();
    };
  }, [id, refresh]);

  const supplierTwo = suppliers.find((s) => s.code === "supplier_2");
  const award = negotiation?.award ?? null;
  const winningScore = useMemo(
    () => award?.scores.find((s) => s.optionId === award.winningOptionId) ?? null,
    [award],
  );

  const chosenId = pickedId ?? award?.winningOptionId ?? null;
  const chosenScore = award?.scores.find((s) => s.optionId === chosenId) ?? null;
  const overriding = Boolean(award && chosenId !== award.winningOptionId);

  // The award carries the winning plan's lines; the rest are rebuilt by the API.
  // Falling back keeps the recommendation committable even if that rebuild failed.
  const chosenAllocations = useMemo(() => {
    if (!award || !chosenId) return [];
    const rebuilt = negotiation?.plans.find((p) => p.optionId === chosenId);
    if (rebuilt) return rebuilt.allocations;
    return chosenId === award.winningOptionId ? award.plan.allocations : [];
  }, [award, chosenId, negotiation?.plans]);

  const goodsTotal = chosenAllocations.reduce((sum, a) => sum + a.subtotal, 0);

  async function injectCurveball() {
    if (!id) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.curveball(id, { supplierCode: "supplier_2", fulfillmentRatio: SUPPLIER_2_CURVEBALL_RATIO });
      setStatus("negotiating");
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function carryOn() {
    if (!id) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.curveball(id, { skip: true });
      setStatus("negotiating");
    } catch (e) {
      // Previously a bare try/finally. A failure here left the page on "paused
      // for input" with the spinner gone and nothing said, so the negotiation
      // looked resumed when it was not.
      setActionError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Starts the negotiation over. The server clears the partial transcript, so the
   * local copy has to go too or the old rounds would sit above the new ones until
   * the next full load.
   */
  async function runAgain() {
    if (!id) return;
    setBusy(true);
    setActionError(null);
    try {
      const fresh = await api.retry(id);
      setEntries([]);
      setNegotiation(fresh);
      setStatus(fresh.status);
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function convert(saveAsDraft: boolean) {
    if (!id) return;
    setBusy(true);
    setActionError(null);
    try {
      // The key stays keyed on the negotiation alone. The server appends the
      // allocation and a hash of the terms, so switching plans already produces a
      // different commit, and a negotiation can only be bought once either way.
      await api.convert(id, { idempotencyKey, saveAsDraft, optionId: chosenId ?? undefined });
      navigate("/purchase-orders");
    } catch (e) {
      setActionError(errorText(e));
      setBusy(false);
    }
  }

  if (loadError) return <ErrorPage message={loadError} onRetry={() => window.location.reload()} />;
  if (!negotiation) return <Spinner label="Loading negotiation…" />;

  const copy = statusCopy(status);
  const live = status === "negotiating" || status === "scoring";
  const converted = status === "converted";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4 animate-in">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Negotiation</h1>
          <p className="mt-1.5 text-sm text-ink-dim">
            {negotiation.tierQuantity === AS_QUOTED
              ? "Every line at the quantity its own row was quoted for"
              : `${qty(negotiation.tierQuantity)} units per line`}
            , three suppliers, all bidding on the same basket.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {negotiation.constraintSummary.map((line) => (
              <Badge key={line} tone="accent">
                {line}
              </Badge>
            ))}
          </div>
        </div>
        <Badge tone={copy.tone} className="shrink-0">
          {live && <span className="size-1.5 animate-pulse rounded-full bg-current" />}
          {copy.label}
        </Badge>
      </div>

      {/*
        Above everything, because an action can fail while the commit card that
        used to hold the only error slot is not on screen at all — which is the
        case for the whole of the curveball prompt.
      */}
      {actionError && <ErrorNote message={actionError} />}

      {streamLost && !converted && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warn/30 bg-warn/5 px-4 py-2.5 text-sm text-ink-dim">
          <Badge tone="warn">Live updates interrupted</Badge>
          <span>
            The negotiation is still running on the server — it writes every round to the database,
            so nothing is lost. Reload to catch up.
          </span>
          <Button variant="ghost" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      )}

      {status === "suspended" && (
        <Card className="border-warn/40">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-warn">Round one is done. Anything changed?</h3>
              <p className="mt-1 max-w-2xl text-sm text-ink-dim">
                {supplierTwo?.name ?? "Supplier 2"} has come back saying they can only fulfil{" "}
                {pct(SUPPLIER_2_CURVEBALL_RATIO)} of the order. Feeding that in keeps every offer
                already on the table and re-scores the plans around the shortfall — the negotiation
                carries on from here rather than starting again.
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={carryOn} disabled={busy}>
                No change, carry on
              </Button>
              <Button variant="primary" onClick={injectCurveball} disabled={busy}>
                Apply the {pct(SUPPLIER_2_CURVEBALL_RATIO)} cap
              </Button>
            </div>
          </div>
        </Card>
      )}

      {negotiation.curveballApplied && status !== "suspended" && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warn/30 bg-warn/5 px-4 py-2.5 text-sm text-ink-dim">
          <Badge tone="warn">Capacity change absorbed</Badge>
          {Object.entries(negotiation.capacity).map(([code, ratio]) => (
            <span key={code}>
              {suppliers.find((s) => s.code === code)?.name ?? code} capped at {pct(ratio)} of the
              order.
            </span>
          ))}
        </div>
      )}

      {status === "failed" && (
        <Card className="border-bad/40">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-bad">{negotiation.error ?? "This negotiation failed."}</p>
            <Button onClick={runAgain} disabled={busy}>
              {busy ? "Starting…" : "Run it again"}
            </Button>
          </div>
          <p className="mt-2 text-xs text-ink-faint">
            Starts over against the same quotation, tier and note. Nothing was ordered.
          </p>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <Card
          title="Transcript"
          subtitle="Every message the agents exchanged, in the order it happened."
          className="lg:sticky lg:top-20 lg:self-start"
        >
          <Transcript entries={entries} live={live} suppliers={suppliers} />
        </Card>

        <div className="space-y-6">
          {award && winningScore ? (
            <>
              <Card
                title="The recommendation"
                subtitle="Ranked by arithmetic, not by the model. The agent explains the ranking; it does not compute it."
              >
                <Reasoning award={award} />
              </Card>

              <Card
                title="How the plans compared"
                action={
                  <Segmented
                    value={basis}
                    onChange={setBasis}
                    options={[
                      {
                        value: "fob",
                        label: "Quoted",
                        hint: "The price on the quote, before anything is added.",
                      },
                      {
                        value: "landed",
                        label: "Landed",
                        hint: "Quoted price plus freight and duty for that supplier's country.",
                      },
                      {
                        value: "effective",
                        label: "Effective",
                        hint: "Landed cost plus the cost of capital tied up by the payment schedule, plus a penalty for running more than one supplier. This is what the ranking uses.",
                      },
                    ]}
                  />
                }
              >
                <Comparison
                  scores={award.scores}
                  winningId={award.winningOptionId}
                  basis={basis}
                  selectedId={converted ? undefined : (chosenId ?? undefined)}
                  onSelect={converted ? undefined : setPickedId}
                />
              </Card>

              <Card title="Commit">
                {converted ? (
                  <div className="space-y-3">
                    <p className="text-sm text-ink-dim">
                      This negotiation has already been converted. The agreed terms are frozen on the
                      purchase order, and the supplier has been notified — converting again would buy
                      the same basket twice.
                    </p>
                    <Button variant="secondary" onClick={() => navigate("/purchase-orders")}>
                      View purchase orders
                    </Button>
                  </div>
                ) : (
                <>
                <p className="text-sm text-ink-dim">
                  Converting writes {chosenAllocations.length === 1 ? "a purchase order" : `${chosenAllocations.length} purchase orders`} with
                  these terms frozen, reserves capacity with the supplier, schedules the payment
                  tranches and posts the liability to the ledger. It is a real commitment, not a
                  bookmark.
                </p>

                {overriding && (
                  <div className="mt-3 rounded-lg border border-warn/40 bg-warn/5 px-3.5 py-2.5 text-sm">
                    <p className="text-ink">
                      Buying <strong>{chosenScore?.label}</strong> instead of the recommended{" "}
                      {award.label}.
                    </p>
                    {chosenScore?.disqualified ? (
                      <p className="mt-1 text-bad">
                        This plan breaks a stated constraint: {chosenScore.disqualifiedReasons.join("; ")}.
                        The purchase order records that it was chosen over the recommendation.
                      </p>
                    ) : (
                      <p className="mt-1 text-ink-dim">
                        The purchase order records which plan was recommended and which was bought.
                      </p>
                    )}
                    <button
                      type="button"
                      onClick={() => setPickedId(null)}
                      className="mt-1.5 text-xs font-medium text-accent underline underline-offset-2"
                    >
                      Go back to the recommendation
                    </button>
                  </div>
                )}

                {chosenAllocations.length === 0 ? (
                  <p className="mt-3 text-sm text-bad">
                    The lines for this plan could not be rebuilt from the negotiation, so it cannot
                    be committed. Pick another plan, or reload the page.
                  </p>
                ) : (
                  <>
                    <table className="mt-3 w-full text-sm">
                      <thead>
                        <tr className="text-[10px] uppercase tracking-wider text-ink-dim">
                          <th className="pb-1.5 text-left font-medium">Supplier</th>
                          <th className="pb-1.5 pl-3 text-right font-medium">Units</th>
                          <th className="pb-1.5 pl-3 text-right font-medium">
                            <Hint content="The agreed price of the goods. This is the subtotal on the purchase order; freight and duty are added on top of it.">
                              <span className="underline decoration-dotted underline-offset-2">Goods</span>
                            </Hint>
                          </th>
                          <th className="pb-1.5 pl-3 text-right font-medium">
                            <Hint content="Days from placing the order to the goods arriving, as promised in the final offer.">
                              <span className="underline decoration-dotted underline-offset-2">Ship time</span>
                            </Hint>
                          </th>
                          <th className="pb-1.5 pl-3 text-right font-medium">
                            <Hint content="How the payment is split across milestones, from placing the order to delivery. 40/60 is 40% up front and 60% on arrival. Paying earlier ties up cash, which is what the Effective figure prices in.">
                              <span className="underline decoration-dotted underline-offset-2">Payment</span>
                            </Hint>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {chosenAllocations.map((allocation) => (
                          <tr key={allocation.allocationKey} className="border-t border-edge">
                            <td className="py-2 pr-3">
                              {suppliers.find((s) => s.code === allocation.supplierCode)?.name ??
                                allocation.supplierCode}
                            </td>
                            <td className="nums py-2 pl-3 text-right text-ink-dim">
                              {qty(allocation.lines.reduce((s, l) => s + l.quantity, 0))}
                            </td>
                            <td className="nums py-2 pl-3 text-right">{money(allocation.subtotal)}</td>
                            <td className="nums py-2 pl-3 text-right text-ink-dim">
                              {allocation.leadTimeDays}d
                            </td>
                            <td className="nums py-2 pl-3 text-right text-ink-dim">
                              {formatPaymentTerms(allocation.paymentTerms)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>

                    {/* The comparison above ranks on effective cost, which is a bigger
                        number than anything that will appear on the purchase order. Two
                        totals for one plan on one screen needs the difference named. */}
                    {chosenScore && (
                      <div className="mt-3 space-y-1 rounded-lg border border-edge bg-surface-2/40 px-3.5 py-2.5 text-sm">
                        <Line label="Goods" hint="The sum of the lines above: what the supplier is paid for the product.">
                          {money(goodsTotal)}
                        </Line>
                        <Line
                          label="Landed"
                          hint="Goods plus freight and duty for the supplier's country. This is the total recorded on the purchase order."
                        >
                          {money(chosenScore.landedTotal)}
                        </Line>
                        <Line
                          label="Effective"
                          hint="Landed cost plus the cash tied up by the payment schedule, plus a penalty for running more than one supplier. Nobody invoices you for this — it is the basis the plans were ranked on, which is why it is the figure shown in the comparison above."
                        >
                          {money(chosenScore.effectiveTotal)}
                        </Line>
                      </div>
                    )}

                    {/* A plan can be cheaper because it is better or because it buys
                        less, and those look identical in the totals above. The
                        difference matters most here, where the money is committed. */}
                    {chosenScore && chosenScore.coverageRatio < 1 && (
                      <p className="mt-2 text-xs text-warn">
                        Covers {pct(chosenScore.coverageRatio)} of the{" "}
                        {qty(chosenScore.requestedQty)} units asked for —{" "}
                        {qty(chosenScore.requestedQty - chosenScore.coveredQty)} would stay unbought.
                        Part of why this plan costs less is that it buys less.
                      </p>
                    )}
                  </>
                )}


                <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
                  {busy && <Spinner />}
                  <Button
                    variant="secondary"
                    disabled={busy || chosenAllocations.length === 0}
                    onClick={() => convert(true)}
                  >
                    Save as draft
                  </Button>
                  <Hint content="Issues immediately: the supplier is notified and the downstream effects fire.">
                    <Button
                      variant="primary"
                      disabled={busy || chosenAllocations.length === 0}
                      onClick={() => convert(false)}
                    >
                      {overriding ? "Convert this plan instead" : "Convert to purchase order"}
                    </Button>
                  </Hint>
                </div>
                </>
                )}
              </Card>
            </>
          ) : (
            <Card title="The recommendation">
              {status === "failed" ? (
                <Empty>No plan could be assembled from these offers.</Empty>
              ) : (
                <Empty>
                  The brand agent is still working. The comparison and reasoning appear here once
                  every supplier has made its final offer.
                </Empty>
              )}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
