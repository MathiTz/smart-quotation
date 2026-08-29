import { and, asc, eq, lte, or, isNull, sql } from "drizzle-orm";
import type { OutboxEventType } from "@sq/shared";
import { db, schema } from "../db/client.js";

/**
 * Delivers the effects a committed purchase order implies.
 *
 * The handlers here are stubs that log, because there is no ERP or supplier API
 * to call in this exercise. What is not a stub is the delivery mechanism: rows
 * are written in the same transaction as the PO, claimed one at a time with
 * `FOR UPDATE SKIP LOCKED` so two workers cannot send the same email twice, and
 * retried with backoff on failure. Swapping `handlers` for real network calls is
 * the only change needed to make this production behaviour.
 */

const MAX_ATTEMPTS = 5;

type Handler = (payload: Record<string, unknown>) => Promise<string>;

const handlers: Record<OutboxEventType, Handler> = {
  reserve_capacity: async (p) =>
    `reserved ${p.supplierCode} capacity for ${p.poNumber}, ${p.leadTimeDays} day window`,
  schedule_payment_tranches: async (p) =>
    `scheduled ${p.paymentTerms} tranches against ${p.poNumber} totalling ${p.total}`,
  notify_internal_approvers: async (p) => `routed ${p.poNumber} to finance for approval`,
  notify_supplier: async (p) => `sent ${p.poNumber} to ${p.supplierCode}`,
  sync_accounting: async (p) => `posted ${p.poNumber} to the ledger as a committed liability`,
};

/** Exponential backoff, so a supplier API that is down is not hammered. */
function nextAttemptAt(attempts: number): Date {
  return new Date(Date.now() + Math.min(2 ** attempts, 60) * 1000);
}

/**
 * Claims one pending event and runs it. Returns false when the queue is empty,
 * which is how the loop knows to sleep.
 */
export async function drainOne(): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .select()
      .from(schema.outbox)
      .where(
        and(
          eq(schema.outbox.status, "pending"),
          or(isNull(schema.outbox.nextAttemptAt), lte(schema.outbox.nextAttemptAt, new Date())),
        ),
      )
      .orderBy(asc(schema.outbox.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });

    if (!claimed) return false;

    const attempts = claimed.attempts + 1;
    try {
      const detail = await handlers[claimed.eventType as OutboxEventType](
        (claimed.payload ?? {}) as Record<string, unknown>,
      );
      await tx
        .update(schema.outbox)
        .set({ status: "sent", attempts, detail, processedAt: new Date() })
        .where(eq(schema.outbox.id, claimed.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Give up loudly rather than retrying forever: a permanently failing
      // effect on a committed order is something a human needs to see.
      const exhausted = attempts >= MAX_ATTEMPTS;
      await tx
        .update(schema.outbox)
        .set({
          status: exhausted ? "failed" : "pending",
          attempts,
          detail: message,
          nextAttemptAt: exhausted ? null : nextAttemptAt(attempts),
        })
        .where(eq(schema.outbox.id, claimed.id));
    }

    return true;
  });
}

/** Drains until empty. Used by tests and by the API right after a commit. */
export async function drainAll(limit = 100): Promise<number> {
  let processed = 0;
  while (processed < limit && (await drainOne())) processed += 1;
  return processed;
}

let timer: NodeJS.Timeout | null = null;

export function startOutboxWorker(intervalMs = 1000): void {
  if (timer) return;
  timer = setInterval(() => {
    drainAll(25).catch((error) => console.error("[outbox] drain failed", error));
  }, intervalMs);
  timer.unref();
}

export function stopOutboxWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function pendingCount(): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.outbox)
    .where(eq(schema.outbox.status, "pending"));
  return row?.count ?? 0;
}
