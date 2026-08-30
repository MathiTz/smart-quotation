import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Torn down once for the whole file: closing it inside a suite would leave any
// later suite talking to a dead pool.
import { CURVEBALL_AFTER_ROUND, SUPPLIER_2_CURVEBALL_RATIO } from "@sq/shared";
import { db, pool, schema } from "./db/client.js";
import { env } from "./env.js";
import { ingestQuotation } from "./quotations/ingest.js";
import { readTranscript } from "./negotiation/view.js";
import { markFailed, rebuildOptions, resetForRetry } from "./negotiation/engine.js";
import { STALE_AFTER_MS, recoverInterrupted } from "./negotiation/recover.js";
import { resumeNegotiation, startNegotiation } from "./workflows/runner.js";
import {
  CommitError,
  confirmPurchaseOrder,
  convertNegotiation,
  getPurchaseOrder,
} from "./purchase-orders/commit.js";
import { drainAll } from "./purchase-orders/outbox.js";

/**
 * The parts that only break when the pieces are wired together: the workflow
 * really suspending and resuming, and the commit really being idempotent. The
 * agents run offline so the assertions are about mechanics, not about what a
 * model happened to say.
 *
 * Needs Postgres. `pnpm db:up && pnpm db:push && pnpm db:seed` first.
 */
process.env.SQ_OFFLINE = "1";

const reachable = await db
  .execute("select 1")
  .then(() => true)
  .catch(() => false);

const suite = reachable ? describe : describe.skip;

/**
 * Not gated on Postgres being reachable, because it is asserting the absence of
 * a crash rather than any database behaviour.
 */
describe("the connection pool", () => {
  it("listens for errors on idle clients, so a Postgres restart cannot kill the process", () => {
    // `pg` emits `error` on idle pooled clients when the backend goes away.
    // Node throws on an unhandled EventEmitter `error`, so dropping this
    // listener turns `docker compose down` into an API crash (Postgres 57P01).
    expect(pool.listenerCount("error")).toBeGreaterThan(0);
  });
});
if (!reachable) {
  console.warn(`[integration] skipped: no Postgres at ${env.databaseUrl}. Run pnpm db:up first.`);
}

suite("negotiation end to end", () => {
  let negotiationId: string;
  let sequencesBeforeCurveball: number[] = [];

  beforeAll(async () => {
    const quotation = await ingestQuotation({
      source: resolve(env.repoRoot, "fixtures/quotation_2.xlsx"),
      filename: "quotation_2.xlsx",
      brandNote: "prioritize lead time over cost, 30 day deadline",
    });

    const [negotiation] = await db
      .insert(schema.negotiations)
      .values({
        quotationId: quotation.id,
        tierQuantity: quotation.suggestedTier,
        constraints: quotation.constraints,
      })
      .returning();

    negotiationId = negotiation!.id;
    await startNegotiation(negotiationId);
    await waitForStatus(negotiationId, "suspended");
  }, 120_000);

  it("suspends after the first round instead of running to completion", async () => {
    const rounds = await readTranscript(negotiationId);
    const highest = Math.max(...rounds.map((r) => r.round));
    expect(highest).toBe(CURVEBALL_AFTER_ROUND);

    // Every supplier had its say before the negotiation parked.
    const bidders = new Set(rounds.filter((r) => r.offer).map((r) => r.supplierCode));
    expect(bidders).toEqual(new Set(["supplier_1", "supplier_2", "supplier_3"]));

    sequencesBeforeCurveball = rounds.map((r) => r.sequence);
  });

  it("absorbs the capacity change without replaying what was already negotiated", async () => {
    await resumeNegotiation(negotiationId, {
      supplierCode: "supplier_2",
      fulfillmentRatio: SUPPLIER_2_CURVEBALL_RATIO,
    });
    await waitForStatus(negotiationId, "awaiting_conversion");

    const rounds = await readTranscript(negotiationId);

    // The whole point of resume over restart: round one's rows are still the
    // rows round one wrote, and nothing was re-emitted on top of them.
    expect(rounds.map((r) => r.sequence).slice(0, sequencesBeforeCurveball.length)).toEqual(
      sequencesBeforeCurveball,
    );
    expect(rounds.length).toBeGreaterThan(sequencesBeforeCurveball.length);

    const negotiation = await db.query.negotiations.findFirst({
      where: eq(schema.negotiations.id, negotiationId),
    });
    expect(negotiation?.curveballApplied).toBe(true);
    expect(negotiation?.capacity.supplier_2).toBe(SUPPLIER_2_CURVEBALL_RATIO);
  });

  it("caps supplier 2's award at the capacity it declared", async () => {
    const negotiation = await db.query.negotiations.findFirst({
      where: eq(schema.negotiations.id, negotiationId),
    });
    const award = negotiation!.award!;
    expect(award.plan.allocations.length).toBeGreaterThan(0);

    const requested = award.scores[0]!.requestedQty;
    const supplierTwo = award.plan.allocations.find((a) => a.supplierCode === "supplier_2");
    if (supplierTwo) {
      const units = supplierTwo.lines.reduce((sum, l) => sum + l.quantity, 0);
      expect(units).toBeLessThanOrEqual(Math.ceil(requested * SUPPLIER_2_CURVEBALL_RATIO));
    }

    // Whatever plan won, it may never buy more than was asked for.
    for (const score of award.scores) {
      expect(score.coveredQty).toBeLessThanOrEqual(score.requestedQty);
    }
  });

  it("returns the same purchase order when the same commit is replayed", async () => {
    const key = `test-${negotiationId}`;
    const first = await convertNegotiation({ negotiationId, idempotencyKey: key, saveAsDraft: false });
    const second = await convertNegotiation({ negotiationId, idempotencyKey: key, saveAsDraft: false });

    expect(first.map((po) => po.poNumber)).toEqual(second.map((po) => po.poNumber));
    expect(first.map((po) => po.id)).toEqual(second.map((po) => po.id));

    const all = await db
      .select()
      .from(schema.purchaseOrders)
      .where(eq(schema.purchaseOrders.negotiationId, negotiationId));
    expect(all.length).toBe(first.length);
  });

  it("refuses to convert a negotiation that has already been bought", async () => {
    const before = await db
      .select()
      .from(schema.purchaseOrders)
      .where(eq(schema.purchaseOrders.negotiationId, negotiationId));
    expect(before.length).toBeGreaterThan(0);

    // A different key is a different intent: someone reloaded the page and
    // pressed Convert again. That must not buy the basket a second time or
    // notify the supplier twice, which is exactly what it used to do.
    await expect(
      convertNegotiation({
        negotiationId,
        idempotencyKey: `second-attempt-${negotiationId}`,
        saveAsDraft: false,
      }),
    ).rejects.toThrow(/already been converted/);

    const after = await db
      .select()
      .from(schema.purchaseOrders)
      .where(eq(schema.purchaseOrders.negotiationId, negotiationId));
    expect(after.length).toBe(before.length);
  });

  it("freezes the agreed terms onto the purchase order", async () => {
    const [po] = await db
      .select()
      .from(schema.purchaseOrders)
      .where(eq(schema.purchaseOrders.negotiationId, negotiationId));

    const snapshot = po!.termsSnapshot;
    expect(snapshot.lines.length).toBeGreaterThan(0);
    expect(snapshot.paymentTerms).toBe(po!.paymentTerms);
    expect(snapshot.leadTimeDays).toBe(po!.leadTimeQuotedDays);

    // The snapshot has to be self-consistent on its own, without reading back
    // anything from the negotiation it came from.
    const lineSum = snapshot.lines.reduce((sum, l) => sum + l.lineTotal, 0);
    expect(lineSum).toBeCloseTo(snapshot.subtotal, 1);
    expect(snapshot.landedTotal).toBeGreaterThanOrEqual(snapshot.subtotal);
  });

  it("delivers every downstream effect exactly once", async () => {
    await drainAll();
    const [po] = await db
      .select()
      .from(schema.purchaseOrders)
      .where(eq(schema.purchaseOrders.negotiationId, negotiationId));

    const full = await getPurchaseOrder(po!.id);
    expect(full!.effects.length).toBe(5);
    expect(full!.effects.every((e) => e.status === "sent")).toBe(true);
    expect(full!.effects.every((e) => e.attempts === 1)).toBe(true);
  });
});

suite("draft commits withhold the supplier-facing effects", () => {
  it("only tells the supplier once the draft is issued", async () => {
    const quotation = await ingestQuotation({
      source: resolve(env.repoRoot, "fixtures/quotation_1.xlsx"),
      filename: "quotation_1.xlsx",
      brandNote: "cheapest wins",
    });

    const [negotiation] = await db
      .insert(schema.negotiations)
      .values({
        quotationId: quotation.id,
        tierQuantity: quotation.suggestedTier,
        constraints: quotation.constraints,
      })
      .returning();

    await startNegotiation(negotiation!.id);
    await waitForStatus(negotiation!.id, "suspended");
    await resumeNegotiation(negotiation!.id, { skip: true });
    await waitForStatus(negotiation!.id, "awaiting_conversion");

    const [draft] = await convertNegotiation({
      negotiationId: negotiation!.id,
      idempotencyKey: `draft-${negotiation!.id}`,
      saveAsDraft: true,
    });

    expect(draft!.status).toBe("draft");
    expect(draft!.effects.map((e) => e.eventType).sort()).toEqual([
      "notify_internal_approvers",
      "reserve_capacity",
      "schedule_payment_tranches",
    ]);

    const issued = await confirmPurchaseOrder(draft!.id);
    expect(issued.status).toBe("sent");
    expect(issued.effects.map((e) => e.eventType)).toContain("notify_supplier");

    // Confirming twice must not queue a second notification to the supplier.
    await confirmPurchaseOrder(draft!.id);
    const again = await getPurchaseOrder(draft!.id);
    expect(again!.effects.filter((e) => e.eventType === "notify_supplier").length).toBe(1);
  }, 180_000);
});

suite("a buyer can overrule the recommendation", () => {
  it("buys the plan that was chosen, and records that it was not the recommended one", async () => {
    const quotation = await ingestQuotation({
      source: resolve(env.repoRoot, "fixtures/quotation_1.xlsx"),
      filename: "quotation_1.xlsx",
      brandNote: "cheapest wins",
    });

    const [negotiation] = await db
      .insert(schema.negotiations)
      .values({
        quotationId: quotation.id,
        tierQuantity: quotation.suggestedTier,
        constraints: quotation.constraints,
      })
      .returning();

    await startNegotiation(negotiation!.id);
    await waitForStatus(negotiation!.id, "suspended");
    await resumeNegotiation(negotiation!.id, { skip: true });
    await waitForStatus(negotiation!.id, "awaiting_conversion");

    const row = await db.query.negotiations.findFirst({
      where: eq(schema.negotiations.id, negotiation!.id),
    });
    const award = row!.award!;

    // Any plan that is not the one the system put forward.
    const other = award.scores.find((s) => s.optionId !== award.winningOptionId);
    expect(other, "the fixture should produce more than one plan").toBeDefined();

    // Only the winner's allocations are stored, so the loser's lines have to be
    // rebuilt from the offers. That rebuild is what this is really testing.
    const options = await rebuildOptions(negotiation!.id);
    const expected = options.find((o) => o.id === other!.optionId)!;
    expect(expected).toBeDefined();

    const created = await convertNegotiation({
      negotiationId: negotiation!.id,
      idempotencyKey: `override-${negotiation!.id}`,
      saveAsDraft: false,
      optionId: other!.optionId,
    });

    expect(created.map((po) => po.supplierCode).sort()).toEqual(
      expected.allocations.map((a) => a.supplierCode).sort(),
    );
    expect(created.map((po) => po.allocationKey).sort()).toEqual(
      expected.allocations.map((a) => a.allocationKey).sort(),
    );

    // A purchase order that departs from the advice has to say so on its face.
    for (const po of created) {
      expect(po.termsSnapshot.chosenOptionId).toBe(other!.optionId);
      expect(po.termsSnapshot.recommendedOptionId).toBe(award.winningOptionId);
    }
  }, 180_000);

  it("buys once when two tabs commit different plans at the same moment", async () => {
    const quotation = await ingestQuotation({
      source: resolve(env.repoRoot, "fixtures/quotation_1.xlsx"),
      filename: "quotation_1.xlsx",
      brandNote: "cheapest wins",
    });

    const [negotiation] = await db
      .insert(schema.negotiations)
      .values({
        quotationId: quotation.id,
        tierQuantity: quotation.suggestedTier,
        constraints: quotation.constraints,
      })
      .returning();

    await startNegotiation(negotiation!.id);
    await waitForStatus(negotiation!.id, "suspended");
    await resumeNegotiation(negotiation!.id, { skip: true });
    await waitForStatus(negotiation!.id, "awaiting_conversion");

    const row = await db.query.negotiations.findFirst({
      where: eq(schema.negotiations.id, negotiation!.id),
    });
    const award = row!.award!;
    const other = award.scores.find((s) => s.optionId !== award.winningOptionId);
    expect(other, "the fixture should produce more than one plan").toBeDefined();

    // Two different plans produce different allocation keys and different terms
    // hashes, so the unique index on idempotency_key never fires. Nothing but
    // the status check stands between these two and buying the basket twice —
    // and the status check used to run before the transaction opened.
    const outcomes = await Promise.allSettled([
      convertNegotiation({
        negotiationId: negotiation!.id,
        idempotencyKey: `race-${negotiation!.id}`,
        saveAsDraft: false,
      }),
      convertNegotiation({
        negotiationId: negotiation!.id,
        idempotencyKey: `race-${negotiation!.id}`,
        saveAsDraft: false,
        optionId: other!.optionId,
      }),
    ]);

    const won = outcomes.filter((o) => o.status === "fulfilled");
    expect(won, "exactly one of the two commits should succeed").toHaveLength(1);

    // And the loser has to fail for the right reason, not on a deadlock or a
    // constraint violation that happens to look like success from a distance.
    const lost = outcomes.find((o) => o.status === "rejected");
    expect((lost as PromiseRejectedResult).reason).toBeInstanceOf(CommitError);
    expect((lost as PromiseRejectedResult).reason.message).toContain("already been converted");

    // The negotiation was bought once, so exactly one plan's worth of orders exists.
    const stored = await db.query.purchaseOrders.findMany({
      where: eq(schema.purchaseOrders.negotiationId, negotiation!.id),
    });
    const distinctPlans = new Set(stored.map((po) => po.termsSnapshot.chosenOptionId));
    expect(distinctPlans.size).toBe(1);
  }, 180_000);

  it("refuses a plan that was never on the table", async () => {
    const quotation = await ingestQuotation({
      source: resolve(env.repoRoot, "fixtures/quotation_1.xlsx"),
      filename: "quotation_1.xlsx",
      brandNote: "cheapest wins",
    });

    const [negotiation] = await db
      .insert(schema.negotiations)
      .values({
        quotationId: quotation.id,
        tierQuantity: quotation.suggestedTier,
        constraints: quotation.constraints,
      })
      .returning();

    await startNegotiation(negotiation!.id);
    await waitForStatus(negotiation!.id, "suspended");
    await resumeNegotiation(negotiation!.id, { skip: true });
    await waitForStatus(negotiation!.id, "awaiting_conversion");

    // Overriding is a choice between plans that were scored, not a way to name an
    // arbitrary supplier and have the system assemble an order for it.
    await expect(
      convertNegotiation({
        negotiationId: negotiation!.id,
        idempotencyKey: `bogus-${negotiation!.id}`,
        saveAsDraft: false,
        optionId: "single:supplier_that_never_bid",
      }),
    ).rejects.toThrow(/was considered/);

    const written = await db
      .select()
      .from(schema.purchaseOrders)
      .where(eq(schema.purchaseOrders.negotiationId, negotiation!.id));
    expect(written.length).toBe(0);
  }, 180_000);
});

suite("a negotiation interrupted by a restart does not spin forever", () => {
  /**
   * Simulates the process dying mid-round: the row says `negotiating` and the
   * in-process handler that would have marked it failed went with the process.
   * Nothing else in the system is watching it.
   */
  async function abandoned(ageMs: number): Promise<string> {
    const quotation = await ingestQuotation({
      source: resolve(env.repoRoot, "fixtures/quotation_1.xlsx"),
      filename: "quotation_1.xlsx",
      brandNote: "cheapest wins",
    });

    const [negotiation] = await db
      .insert(schema.negotiations)
      .values({
        quotationId: quotation.id,
        tierQuantity: quotation.suggestedTier,
        constraints: quotation.constraints,
        status: "negotiating",
        updatedAt: new Date(Date.now() - ageMs),
      })
      .returning();

    return negotiation!.id;
  }

  it("marks a stale in-flight negotiation failed, with a reason a buyer can act on", async () => {
    const id = await abandoned(STALE_AFTER_MS * 2);

    await recoverInterrupted();

    const row = await db.query.negotiations.findFirst({ where: eq(schema.negotiations.id, id) });
    expect(row?.status).toBe("failed");
    expect(row?.error).toMatch(/no longer running/);
    // The two things that matter to whoever reads it: no money moved, and there
    // is a way out.
    expect(row?.error).toMatch(/Nothing was ordered/);
    expect(row?.error).toMatch(/run it again/i);
    // It cannot know why, so it must not say. A restart, a crash and a hung
    // provider are indistinguishable from a row that stopped being written to.
    expect(row?.error).not.toMatch(/restart|crash|timed out/i);
  }, 60_000);

  it("leaves a negotiation that is still writing alone, so a second instance cannot kill live work", async () => {
    const id = await abandoned(0);

    await recoverInterrupted();

    const row = await db.query.negotiations.findFirst({ where: eq(schema.negotiations.id, id) });
    expect(row?.status).toBe("negotiating");
  }, 60_000);

  it("never sweeps a suspended negotiation, which is parked on purpose", async () => {
    const quotation = await ingestQuotation({
      source: resolve(env.repoRoot, "fixtures/quotation_1.xlsx"),
      filename: "quotation_1.xlsx",
      brandNote: "cheapest wins",
    });

    // Waiting on the curveball is a state it can sit in for as long as the buyer
    // takes to answer, which is exactly what an age threshold would misread.
    const [negotiation] = await db
      .insert(schema.negotiations)
      .values({
        quotationId: quotation.id,
        tierQuantity: quotation.suggestedTier,
        constraints: quotation.constraints,
        status: "suspended",
        updatedAt: new Date(Date.now() - STALE_AFTER_MS * 10),
      })
      .returning();

    await recoverInterrupted();

    const row = await db.query.negotiations.findFirst({
      where: eq(schema.negotiations.id, negotiation!.id),
    });
    expect(row?.status).toBe("suspended");
  }, 60_000);

  it("can be run again, and the retry starts from a clean transcript", async () => {
    const quotation = await ingestQuotation({
      source: resolve(env.repoRoot, "fixtures/quotation_1.xlsx"),
      filename: "quotation_1.xlsx",
      brandNote: "cheapest wins",
    });

    const [negotiation] = await db
      .insert(schema.negotiations)
      .values({
        quotationId: quotation.id,
        tierQuantity: quotation.suggestedTier,
        constraints: quotation.constraints,
      })
      .returning();

    const id = negotiation!.id;
    await startNegotiation(id);
    await waitForStatus(id, "suspended");

    const firstRun = await readTranscript(id);
    expect(firstRun.length).toBeGreaterThan(0);

    await markFailed(id, "pretend the process died");
    await resetForRetry(id);

    // `negotiation_rounds` is unique on (negotiation_id, sequence), so a retry
    // that kept the old rows would collide on the first line the rerun writes.
    expect(await readTranscript(id)).toHaveLength(0);

    const cleared = await db.query.negotiations.findFirst({ where: eq(schema.negotiations.id, id) });
    expect(cleared?.status).toBe("pending");
    expect(cleared?.error).toBeNull();
    expect(cleared?.curveballApplied).toBe(false);

    await startNegotiation(id);
    await waitForStatus(id, "suspended");
    expect((await readTranscript(id)).length).toBeGreaterThan(0);
  }, 240_000);
});

afterAll(async () => {
  if (reachable) await pool.end();
});

async function waitForStatus(id: string, status: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await db.query.negotiations.findFirst({ where: eq(schema.negotiations.id, id) });
    if (row?.status === status) return;
    if (row?.status === "failed") throw new Error(`negotiation failed: ${row.error}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for status ${status}`);
}
