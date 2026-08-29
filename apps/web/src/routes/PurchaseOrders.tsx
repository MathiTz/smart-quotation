import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { PurchaseOrder } from "@sq/shared";
import { api, ApiError } from "../lib/api.js";
import { Badge, Button, Card, Empty, Hint, Spinner, cx } from "../components/ui.js";
import { dateOnly, explainTerms, money, qty, unitMoney } from "../lib/format.js";

const STATUS_TONE = {
  draft: "warn",
  sent: "accent",
  acknowledged: "accent",
  in_production: "accent",
  fulfilled: "good",
  cancelled: "bad",
} as const;

export function PurchaseOrdersRoute() {
  const [orders, setOrders] = useState<PurchaseOrder[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    api
      .purchaseOrders()
      .then(setOrders)
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  }, []);

  async function confirm(id: string) {
    setBusy(id);
    try {
      const updated = await api.confirmPurchaseOrder(id);
      setOrders((prev) => prev?.map((po) => (po.id === id ? updated : po)) ?? null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (error) return <p className="text-sm text-bad">{error}</p>;
  if (!orders) return <Spinner label="Loading purchase orders…" />;

  const committed = orders.reduce((sum, po) => sum + po.total, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4 animate-in">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Purchase orders</h1>
          <p className="mt-1.5 text-sm text-ink-dim">
            {orders.length === 0
              ? "Nothing issued yet."
              : `${orders.length} order${orders.length === 1 ? "" : "s"}, ${money(committed)} committed.`}
          </p>
        </div>
        <Link to="/">
          <Button variant="secondary">New quotation</Button>
        </Link>
      </div>

      {orders.length === 0 ? (
        <Empty>
          Upload a quotation, run the negotiation, then convert the winner. Purchase orders land
          here.
        </Empty>
      ) : (
        <div className="space-y-3">
          {orders.map((po) => (
            <Card key={po.id} className="overflow-hidden">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="nums text-sm font-semibold">{po.poNumber}</span>
                    <Badge tone={STATUS_TONE[po.status]}>{po.status.replace(/_/g, " ")}</Badge>
                    {po.termsSnapshot.negotiationRounds > 0 && (
                      <Hint content={po.termsSnapshot.concessions.join(" · ") || "No concessions recorded"}>
                        <Badge>
                          won over {po.termsSnapshot.negotiationRounds} round
                          {po.termsSnapshot.negotiationRounds === 1 ? "" : "s"}
                        </Badge>
                      </Hint>
                    )}
                  </div>
                  <div className="mt-1.5 text-sm text-ink">{po.supplierName}</div>
                  <div className="nums mt-0.5 text-xs text-ink-faint">
                    {qty(po.lines.reduce((s, l) => s + l.quantity, 0))} units across {po.lines.length}{" "}
                    lines — issued {dateOnly(po.createdAt)} —{" "}
                    <Link
                      to={`/negotiations/${po.negotiationId}`}
                      className="underline decoration-edge underline-offset-2 hover:text-ink"
                    >
                      from this negotiation
                    </Link>
                  </div>
                </div>

                <div className="flex items-start gap-4">
                  <div className="text-right">
                    <div className="nums text-lg font-semibold">{money(po.total, 2)}</div>
                    <div className="nums mt-0.5 text-xs text-ink-faint">
                      {po.leadTimeQuotedDays} days —{" "}
                      <Hint content={explainTerms(po.paymentTerms)}>
                        <span>{po.paymentTerms}</span>
                      </Hint>
                    </div>
                  </div>
                  <div className="flex flex-col gap-2">
                    {po.status === "draft" && (
                      <Button
                        variant="primary"
                        disabled={busy === po.id}
                        onClick={() => confirm(po.id)}
                      >
                        Issue to supplier
                      </Button>
                    )}
                    <Button variant="ghost" onClick={() => setOpenId(openId === po.id ? null : po.id)}>
                      {openId === po.id ? "Hide detail" : "View detail"}
                    </Button>
                  </div>
                </div>
              </div>

              {openId === po.id && <Detail po={po} />}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function Detail({ po }: { po: PurchaseOrder }) {
  return (
    <div className="mt-5 space-y-5 border-t border-edge pt-5">
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-faint">
          Downstream effects
        </h4>
        <p className="mt-1 text-xs text-ink-faint">
          Queued in the same transaction as the order, delivered afterwards and retried on failure.
          A supplier API being slow cannot roll back an order the brand has already agreed to.
        </p>
        <div className="mt-2.5 space-y-1.5">
          {po.effects.map((effect) => (
            <div
              key={effect.eventType}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-edge bg-surface-2/40 px-3 py-2 text-xs"
            >
              <span
                className={cx(
                  "size-1.5 rounded-full",
                  effect.status === "sent" ? "bg-good" : effect.status === "failed" ? "bg-bad" : "bg-warn",
                )}
              />
              <span className="font-medium">{effect.eventType.replace(/_/g, " ")}</span>
              <Badge tone={effect.stage === "supplier_facing" ? "accent" : "neutral"}>
                {effect.stage === "supplier_facing" ? "leaves the building" : "internal"}
              </Badge>
              <span className="text-ink-faint">{effect.detail ?? "queued"}</span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-faint">
          Agreed terms, frozen {dateOnly(po.termsSnapshot.agreedAt)}
        </h4>
        <div className="mt-2.5 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-edge text-left text-[11px] uppercase tracking-wider text-ink-dim">
                <th className="py-2 pr-3 font-semibold">SKU</th>
                <th className="py-2 pr-3 font-semibold">Product</th>
                <th className="py-2 pr-3 text-right font-semibold">Qty</th>
                <th className="py-2 pr-3 text-right font-semibold">Unit</th>
                <th className="py-2 text-right font-semibold">Total</th>
              </tr>
            </thead>
            <tbody>
              {po.lines.map((line) => (
                <tr key={line.sku} className="border-b border-edge/50 last:border-0">
                  <td className="nums py-2 pr-3">{line.sku}</td>
                  <td className="py-2 pr-3 text-ink-dim">{line.productName}</td>
                  <td className="nums py-2 pr-3 text-right">{qty(line.quantity)}</td>
                  <td className="nums py-2 pr-3 text-right">{unitMoney(line.unitCostFinal)}</td>
                  <td className="nums py-2 text-right">{money(line.lineTotal, 2)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-edge">
                <td colSpan={4} className="py-2.5 pr-3 text-right text-ink-dim">
                  Goods value
                </td>
                <td className="nums py-2.5 text-right font-semibold">
                  {money(po.termsSnapshot.subtotal, 2)}
                </td>
              </tr>
              <tr>
                <td colSpan={4} className="pb-2 pr-3 text-right text-ink-dim">
                  <Hint content="Goods value plus freight and duty for this supplier's country. What the order actually costs to land.">
                    <span>Landed total</span>
                  </Hint>
                </td>
                <td className="nums pb-2 text-right font-semibold">{money(po.total, 2)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}
