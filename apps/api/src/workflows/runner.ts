import { eq } from "drizzle-orm";
import { SUPPLIER_2_CURVEBALL_RATIO } from "@sq/shared";
import { db, schema } from "../db/client.js";
import { markFailed } from "../negotiation/engine.js";
import { getMastra } from "../agents/mastra.js";

/**
 * The negotiation runs in the background and reports progress by writing rows,
 * not by holding an HTTP connection open. The UI follows along over SSE by
 * reading those rows, so a client that reloads mid-negotiation loses nothing.
 */
export async function startNegotiation(negotiationId: string): Promise<string> {
  const workflow = getMastra().getWorkflow("negotiation");
  const run = await workflow.createRun();

  await db
    .update(schema.negotiations)
    .set({ workflowRunId: run.runId, status: "negotiating", updatedAt: new Date() })
    .where(eq(schema.negotiations.id, negotiationId));

  void run
    .start({ inputData: { negotiationId } })
    .then(async (result) => {
      if (result.status === "suspended") {
        // Expected: the run is parked waiting for the curveball decision.
        await db
          .update(schema.negotiations)
          .set({ status: "suspended", updatedAt: new Date() })
          .where(eq(schema.negotiations.id, negotiationId));
      }
    })
    .catch(async (error: unknown) => {
      // Last line of defence for a run nobody is awaiting. If recording the
      // failure also fails — the database is the usual reason, and it is the
      // same database `markFailed` writes to — there is nowhere left to put it,
      // and rethrowing here would only reach the process-level handler as a
      // rejection with no negotiation attached to it.
      try {
        await markFailed(negotiationId, error instanceof Error ? error.message : "workflow failed");
      } catch (secondary) {
        console.error(`negotiation ${negotiationId} failed, and so did recording it`);
        console.error("  original:", error);
        console.error("  while recording:", secondary);
      }
    });

  return run.runId;
}

export type CurveballInput = {
  supplierCode?: string;
  fulfillmentRatio?: number;
  /** Carry on without a capacity change. The same resume, with nothing injected. */
  skip?: boolean;
};

/**
 * Resumes the suspended run with the new fact. Round one's offers are already in
 * the database, so this continues the negotiation rather than replaying it.
 */
export async function resumeNegotiation(negotiationId: string, input: CurveballInput = {}): Promise<void> {
  const negotiation = await db.query.negotiations.findFirst({
    where: eq(schema.negotiations.id, negotiationId),
  });
  if (!negotiation) throw new Error(`negotiation ${negotiationId} not found`);
  if (!negotiation.workflowRunId) throw new Error("this negotiation has no workflow run to resume");

  const workflow = getMastra().getWorkflow("negotiation");
  const run = await workflow.createRun({ runId: negotiation.workflowRunId });

  await db
    .update(schema.negotiations)
    .set({ status: "negotiating", updatedAt: new Date() })
    .where(eq(schema.negotiations.id, negotiationId));

  void run
    .resume({
      step: "round",
      resumeData: {
        supplierCode: input.supplierCode ?? "supplier_2",
        fulfillmentRatio: input.fulfillmentRatio ?? SUPPLIER_2_CURVEBALL_RATIO,
        skip: input.skip ?? false,
      },
    })
    .then(async (result) => {
      if (result.status === "suspended") {
        await db
          .update(schema.negotiations)
          .set({ status: "suspended", updatedAt: new Date() })
          .where(eq(schema.negotiations.id, negotiationId));
      }
    })
    .catch(async (error: unknown) => {
      await markFailed(negotiationId, error instanceof Error ? error.message : "workflow resume failed");
    });
}
