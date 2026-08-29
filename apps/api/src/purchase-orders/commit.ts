import { createHash } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Allocation, OutboxEventType, PurchaseOrder, TermsSnapshot } from "@sq/shared";
import { OUTBOX_STAGE_BY_EVENT, landedUnitCost } from "@sq/shared";
import { db, schema } from "../db/client.js";
import { roundMoney } from "../parser/read-workbook.js";
import { supplierByCode } from "../negotiation/setup.js";
import { latestOffers } from "../negotiation/engine.js";

export class CommitError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

/**
 * Every event a real commit would fire. Issuing a PO sends all of them; saving a
 * draft sends only the internal ones, because telling a factory to start cutting
 * fabric is not something an unapproved draft should do.
 */
const ALL_EVENTS: OutboxEventType[] = [
  "reserve_capacity",
  "schedule_payment_tranches",
  "notify_internal_approvers",
  "notify_supplier",
  "sync_accounting",
];

function termsHash(allocation: Allocation): string {
  const canonical = JSON.stringify({
    supplier: allocation.supplierCode,
    leadTime: allocation.leadTimeDays,
    terms: allocation.paymentTerms,
    lines: [...allocation.lines]
      .sort((a, b) => a.sku.localeCompare(b.sku))
      .map((l) => [l.sku, l.quantity, l.unitPrice]),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/**
 * Sequential and gap-free, allocated by an atomic increment inside the same
 * transaction as the PO. Two people clicking Convert at the same moment cannot
 * be handed the same number.
 */
async function nextPoNumber(tx: typeof db): Promise<string> {
  const [row] = await tx
    .update(schema.counters)
    .set({ value: sql`${schema.counters.value} + 1` })
    .where(eq(schema.counters.name, "po_number"))
    .returning({ value: schema.counters.value });

  if (!row) throw new CommitError("the purchase order counter is missing; reseed the database", 409);
  return `PO-${new Date().getUTCFullYear()}-${String(row.value).padStart(4, "0")}`;
}

export type ConvertOptions = {
  negotiationId: string;
  idempotencyKey: string;
  /** false issues the PO immediately, which is the primary action. */
  saveAsDraft: boolean;
  /**
   * Buy a plan other than the recommended one. Omitted means the recommendation,
   * which is what the primary button sends.
   */
  optionId?: string;
};

/**
 * Turns the winning negotiation into purchase orders.
 *
 * One PO per allocation, so a split award writes two. The agreed terms are
 * copied into `terms_snapshot` rather than referenced, because a commitment
 * that re-reads a mutable negotiation is not a commitment. The whole thing is
 * one transaction, and the downstream effects are enqueued inside it: either the
 * brand has bought the goods and the world will be told, or neither happened.
 */
export async function convertNegotiation(options: ConvertOptions): Promise<PurchaseOrder[]> {
  const negotiation = await db.query.negotiations.findFirst({
    where: eq(schema.negotiations.id, options.negotiationId),
  });
  if (!negotiation) throw new CommitError("negotiation not found", 404);

  const award = negotiation.award;
  if (!award) throw new CommitError("this negotiation has not produced an award yet", 409);

  const chosenOptionId = options.optionId ?? award.winningOptionId;
  const allocations = await resolveAllocations(options.negotiationId, award, chosenOptionId);
  if (allocations.length === 0) {
    throw new CommitError("that plan has no lines to buy", 409);
  }

  const keys = allocations.map(
    (allocation) => `${options.idempotencyKey}:${allocation.allocationKey}:${termsHash(allocation)}`,
  );

  // A negotiation is bought once. Replaying the *same* commit still returns the
  // same orders below, which is what makes a retry safe; arriving with a new key
  // is a second purchase and is refused.
  //
  // The per-allocation check inside the transaction cannot do this on its own:
  // it only recognises a key it has seen, so a fresh key looked like a first
  // commit and wrote a duplicate PO — with the supplier notified twice.
  if (negotiation.status === "converted") {
    const replay = await db.query.purchaseOrders.findMany({
      where: inArray(schema.purchaseOrders.idempotencyKey, keys),
    });
    if (replay.length === 0) {
      throw new CommitError("this negotiation has already been converted to a purchase order", 409);
    }
  }

  const offers = await latestOffers(options.negotiationId);
  const agreedAt = new Date().toISOString();
  const status = options.saveAsDraft ? "draft" : "sent";

  return db.transaction(async (tx) => {
    const created: PurchaseOrder[] = [];

    for (const [index, allocation] of allocations.entries()) {
      const supplier = supplierByCode(allocation.supplierCode);
      const key = keys[index]!;

      // Replaying the same commit returns what was written the first time. A
      // double-clicked Convert button must not buy the order twice.
      const existing = await tx.query.purchaseOrders.findFirst({
        where: eq(schema.purchaseOrders.idempotencyKey, key),
      });
      if (existing) {
        created.push(await hydrate(tx, existing));
        continue;
      }

      const landedTotal = roundMoney(
        allocation.lines.reduce(
          (sum, l) => sum + landedUnitCost(l.unitPrice, supplier.country) * l.quantity,
          0,
        ),
      );

      const snapshot: TermsSnapshot = {
        supplierCode: allocation.supplierCode,
        supplierName: supplier.name,
        country: supplier.country,
        qualityRating: allocation.qualityRating,
        leadTimeDays: allocation.leadTimeDays,
        paymentTerms: allocation.paymentTerms,
        currency: "USD",
        subtotal: allocation.subtotal,
        landedTotal,
        lines: allocation.lines.map((l) => ({
          sku: l.sku,
          productName: l.productName,
          quantity: l.quantity,
          unitCostFinal: l.unitPrice,
          lineTotal: l.lineTotal,
        })),
        agreedAt,
        negotiationRounds: offers.get(allocation.supplierCode)?.round ?? 0,
        concessions: (offers.get(allocation.supplierCode)?.concessions ?? []).map((c) => c.description),
        chosenOptionId,
        recommendedOptionId: award.winningOptionId,
      };

      const [po] = await tx
        .insert(schema.purchaseOrders)
        .values({
          poNumber: await nextPoNumber(tx as unknown as typeof db),
          negotiationId: options.negotiationId,
          supplierCode: allocation.supplierCode,
          supplierName: supplier.name,
          allocationKey: allocation.allocationKey,
          status,
          currency: "USD",
          subtotal: String(allocation.subtotal),
          total: String(landedTotal),
          leadTimeQuotedDays: allocation.leadTimeDays,
          paymentTerms: allocation.paymentTerms,
          termsSnapshot: snapshot,
          idempotencyKey: key,
          confirmedAt: options.saveAsDraft ? null : new Date(),
        })
        .returning();

      await tx.insert(schema.purchaseOrderLines).values(
        allocation.lines.map((l) => ({
          purchaseOrderId: po!.id,
          sku: l.sku,
          productName: l.productName,
          quantity: l.quantity,
          unitCostFinal: String(l.unitPrice),
          lineTotal: String(l.lineTotal),
        })),
      );

      // Enqueued in the same transaction as the PO, delivered afterwards by the
      // worker. A slow supplier API can then fail and retry without rolling back
      // an order the brand has already agreed to.
      const events = options.saveAsDraft
        ? ALL_EVENTS.filter((e) => OUTBOX_STAGE_BY_EVENT[e] === "internal")
        : ALL_EVENTS;

      await tx.insert(schema.outbox).values(
        events.map((eventType) => ({
          purchaseOrderId: po!.id,
          eventType,
          stage: OUTBOX_STAGE_BY_EVENT[eventType],
          payload: {
            poNumber: po!.poNumber,
            supplierCode: allocation.supplierCode,
            total: landedTotal,
            leadTimeDays: allocation.leadTimeDays,
            paymentTerms: allocation.paymentTerms,
          },
        })),
      );

      created.push(await hydrate(tx, po!));
    }

    await tx
      .update(schema.negotiations)
      .set({ status: "converted", updatedAt: new Date() })
      .where(eq(schema.negotiations.id, options.negotiationId));

    return created;
  });
}

/**
 * The lines for the plan being bought.
 *
 * The recommendation is served from the award, which is the record of what was
 * decided and must not be recomputed at commit time — a purchase order that
 * re-derives its own terms is not a commitment. Any other plan has to be rebuilt,
 * because only the winner's allocations are stored; that rebuild is deterministic
 * over frozen offers, and it is checked against the ranking the buyer was looking
 * at, so a plan that was never on the table cannot be bought by guessing an id.
 */
async function resolveAllocations(
  negotiationId: string,
  award: NonNullable<Awaited<ReturnType<typeof db.query.negotiations.findFirst>>>["award"],
  optionId: string,
): Promise<Allocation[]> {
  if (!award) return [];
  if (optionId === award.winningOptionId) return award.plan.allocations;

  if (!award.scores.some((score) => score.optionId === optionId)) {
    throw new CommitError(`no plan called "${optionId}" was considered in this negotiation`, 400);
  }

  const { rebuildOptions } = await import("../negotiation/engine.js");
  const option = (await rebuildOptions(negotiationId)).find((o) => o.id === optionId);
  if (!option) {
    throw new CommitError(
      `the plan "${optionId}" could not be rebuilt from this negotiation's offers`,
      409,
    );
  }
  return option.allocations;
}

/**
 * Promotes a draft to issued and releases the supplier-facing effects that were
 * withheld. The terms are not recomputed: what was agreed at conversion is what
 * gets sent.
 */
export async function confirmPurchaseOrder(purchaseOrderId: string): Promise<PurchaseOrder> {
  return db.transaction(async (tx) => {
    const po = await tx.query.purchaseOrders.findFirst({
      where: eq(schema.purchaseOrders.id, purchaseOrderId),
    });
    if (!po) throw new CommitError("purchase order not found", 404);
    if (po.status !== "draft") {
      // Confirming twice is a no-op rather than an error: the caller's intent is
      // already satisfied.
      return hydrate(tx, po);
    }

    await tx
      .update(schema.purchaseOrders)
      .set({ status: "sent", confirmedAt: new Date() })
      .where(eq(schema.purchaseOrders.id, purchaseOrderId));

    const supplierFacing = ALL_EVENTS.filter((e) => OUTBOX_STAGE_BY_EVENT[e] === "supplier_facing");
    const already = await tx
      .select({ eventType: schema.outbox.eventType })
      .from(schema.outbox)
      .where(
        and(
          eq(schema.outbox.purchaseOrderId, purchaseOrderId),
          inArray(schema.outbox.eventType, supplierFacing),
        ),
      );

    const missing = supplierFacing.filter((e) => !already.some((row) => row.eventType === e));
    if (missing.length > 0) {
      await tx.insert(schema.outbox).values(
        missing.map((eventType) => ({
          purchaseOrderId: purchaseOrderId,
          eventType,
          stage: OUTBOX_STAGE_BY_EVENT[eventType],
          payload: { poNumber: po.poNumber, supplierCode: po.supplierCode, total: Number(po.total) },
        })),
      );
    }

    const updated = await tx.query.purchaseOrders.findFirst({
      where: eq(schema.purchaseOrders.id, purchaseOrderId),
    });
    return hydrate(tx, updated!);
  });
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db;

async function hydrate(tx: Tx, row: typeof schema.purchaseOrders.$inferSelect): Promise<PurchaseOrder> {
  const lines = await tx
    .select()
    .from(schema.purchaseOrderLines)
    .where(eq(schema.purchaseOrderLines.purchaseOrderId, row.id));

  const effects = await tx
    .select()
    .from(schema.outbox)
    .where(eq(schema.outbox.purchaseOrderId, row.id));

  return {
    id: row.id,
    poNumber: row.poNumber,
    negotiationId: row.negotiationId,
    supplierCode: row.supplierCode,
    supplierName: row.supplierName,
    allocationKey: row.allocationKey,
    status: row.status as PurchaseOrder["status"],
    currency: row.currency,
    subtotal: Number(row.subtotal),
    total: Number(row.total),
    leadTimeQuotedDays: row.leadTimeQuotedDays,
    paymentTerms: row.paymentTerms,
    termsSnapshot: row.termsSnapshot,
    createdAt: row.createdAt.toISOString(),
    lines: lines.map((l) => ({
      sku: l.sku,
      productName: l.productName,
      quantity: l.quantity,
      unitCostFinal: Number(l.unitCostFinal),
      lineTotal: Number(l.lineTotal),
    })),
    effects: effects.map((e) => ({
      eventType: e.eventType as OutboxEventType,
      stage: e.stage as "internal" | "supplier_facing",
      status: e.status as "pending" | "sent" | "failed",
      attempts: e.attempts,
      detail: e.detail,
    })),
  };
}

export async function listPurchaseOrders(): Promise<PurchaseOrder[]> {
  const rows = await db
    .select()
    .from(schema.purchaseOrders)
    .orderBy(desc(schema.purchaseOrders.createdAt));
  return Promise.all(rows.map((row) => hydrate(db, row)));
}

export async function getPurchaseOrder(id: string): Promise<PurchaseOrder | null> {
  const row = await db.query.purchaseOrders.findFirst({ where: eq(schema.purchaseOrders.id, id) });
  return row ? hydrate(db, row) : null;
}
