/**
 * Recovers negotiations whose process died while they were running.
 *
 * `startNegotiation` hands the run to Mastra and attaches the failure handler to
 * an in-process promise. That handler is what calls `markFailed`, so when the
 * process itself goes — a deploy, a crash, a `tsx` watch restart in dev — it
 * goes too, and the row is left saying `negotiating` with nothing anywhere that
 * will ever touch it again. The UI reads that status honestly and spins forever.
 *
 * Mastra's snapshots make a *suspended* run durable, because resuming one is an
 * explicit call that rebuilds it from Postgres by run id. A run that was midway
 * through a round is a different case: there is no snapshot to resume from and
 * no record of how far it got, so the only honest thing to do is stop claiming
 * it is still running.
 *
 * This marks such rows failed rather than restarting them. Re-running costs a
 * fresh set of model calls and would append to a transcript that already has
 * half a conversation in it, and that is a decision for whoever is buying, not
 * for a boot sequence. `POST /negotiations/{id}/retry` is the deliberate version.
 */
import { and, inArray, lt } from "drizzle-orm";
import type { NegotiationStatus } from "@sq/shared";
import { db, schema } from "../db/client.js";
import { MODEL_TIMEOUT_MS } from "../agents/index.js";

/**
 * Statuses that only a live process advances. `suspended` is deliberately absent:
 * it means the negotiation is parked waiting for a human to answer the curveball,
 * which is a state it can sit in indefinitely without anything being wrong.
 */
const IN_FLIGHT: NegotiationStatus[] = ["pending", "negotiating", "scoring"];

/**
 * How quiet a running negotiation has to go before we call it dead.
 *
 * A healthy round writes a row after each supplier answers, so the longest gap
 * a working negotiation can produce is roughly one model call. Five times that
 * is far outside normal behaviour while still being minutes rather than hours.
 *
 * The threshold is what makes this safe to run on more than one API instance: a
 * negotiation that another process is actively working on has a recent
 * `updatedAt` and is never eligible, so instance B cannot kill instance A's work.
 */
export const STALE_AFTER_MS = MODEL_TIMEOUT_MS * 5;

// #region sweep
export async function recoverInterrupted(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_AFTER_MS);

  const abandoned = await db
    .update(schema.negotiations)
    .set({
      status: "failed",
      // Deliberately does not name a cause. A restart, a crash and a provider
      // that hung past every timeout all arrive here as the same thing — a row
      // nobody has written to — and guessing between them in the one sentence a
      // buyer reads would be inventing detail. What they need is what is true in
      // every case: it is not running, nothing was bought, and they can start it
      // again. The reason, where there is one, is in the logs.
      error:
        "This negotiation stopped before it finished and is no longer running. Nothing was ordered — run it again to start over.",
      updatedAt: now,
    })
    .where(and(inArray(schema.negotiations.status, IN_FLIGHT), lt(schema.negotiations.updatedAt, cutoff)))
    .returning({ id: schema.negotiations.id });

  return abandoned.length;
}
// #endregion sweep

let timer: NodeJS.Timeout | null = null;

/**
 * Swept on an interval rather than only at boot, because a negotiation can also
 * be abandoned by a process that stays up — the runner's promise chain dying
 * without reaching `markFailed`. Boot is simply the first tick.
 */
export function startRecoveryWorker(intervalMs = 60_000): void {
  if (timer) return;

  const sweep = () =>
    recoverInterrupted()
      .then((count) => {
        if (count > 0) {
          console.log(`[recovery] marked ${count} interrupted negotiation${count === 1 ? "" : "s"} failed`);
        }
      })
      .catch((error: unknown) => console.error("[recovery] sweep failed", error));

  void sweep();
  timer = setInterval(sweep, intervalMs);
  timer.unref();
}

export function stopRecoveryWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
