import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { CURVEBALL_AFTER_ROUND, MAX_ROUNDS, SUPPLIER_2_CURVEBALL_RATIO } from "@sq/shared";
import {
  applyCurveball,
  finaliseNegotiation,
  markFailed,
  openNegotiation,
  runRound,
} from "../negotiation/engine.js";

const negotiationRef = z.object({ negotiationId: z.string() });

const roundState = z.object({
  negotiationId: z.string(),
  round: z.number().int().nonnegative(),
  shouldContinue: z.boolean(),
});

const openStep = createStep({
  id: "open",
  inputSchema: negotiationRef,
  outputSchema: roundState,
  execute: async ({ inputData }) => {
    await openNegotiation(inputData.negotiationId);
    return { negotiationId: inputData.negotiationId, round: 0, shouldContinue: true };
  },
});

/**
 * One negotiation round, and the suspend point that makes the curveball work.
 *
 * After round one the step suspends instead of returning. The workflow snapshot
 * goes to Postgres and the process is free to die. When the brand injects
 * "Supplier 2 can only fulfil 60%", the run resumes *here* — round one's offers
 * are already banked in the database, so round two continues against them with
 * one number changed. That is what "without restarting from scratch" means
 * mechanically rather than as a claim.
 */
const roundStep = createStep({
  id: "round",
  inputSchema: roundState,
  outputSchema: roundState,
  resumeSchema: z.object({
    supplierCode: z.string().default("supplier_2"),
    fulfillmentRatio: z.number().min(0).max(1).default(SUPPLIER_2_CURVEBALL_RATIO),
    skip: z.boolean().default(false),
  }),
  suspendSchema: z.object({
    reason: z.literal("awaiting_curveball"),
    afterRound: z.number().int(),
  }),
  execute: async ({ inputData, resumeData, suspend }) => {
    // #region suspend
    // Park before running the round that follows the curveball point. Checked
    // first: any branch that runs a round before this one is reached would skip
    // the suspend entirely and quietly turn the resume into a no-op.
    if (inputData.round === CURVEBALL_AFTER_ROUND && !resumeData) {
      return await suspend({ reason: "awaiting_curveball", afterRound: inputData.round });
    }

    if (resumeData && !resumeData.skip) {
      await applyCurveball(inputData.negotiationId, resumeData.supplierCode, resumeData.fulfillmentRatio);
    }
    // #endregion suspend

    const next = inputData.round + 1;
    const result = await runRound(inputData.negotiationId, next);

    return {
      negotiationId: inputData.negotiationId,
      round: next,
      shouldContinue: result.shouldContinue && next < MAX_ROUNDS,
    };
  },
});

const awardStep = createStep({
  id: "award",
  inputSchema: roundState,
  outputSchema: z.object({ negotiationId: z.string(), winningOptionId: z.string() }),
  execute: async ({ inputData }) => {
    try {
      const award = await finaliseNegotiation(inputData.negotiationId);
      return { negotiationId: inputData.negotiationId, winningOptionId: award.winningOptionId };
    } catch (error) {
      await markFailed(inputData.negotiationId, error instanceof Error ? error.message : "unknown error");
      throw error;
    }
  },
});

export const negotiationWorkflow = createWorkflow({
  id: "negotiation",
  inputSchema: negotiationRef,
  outputSchema: z.object({ negotiationId: z.string(), winningOptionId: z.string() }),
})
  .then(openStep)
  .dowhile(roundStep, async ({ inputData }) => inputData.shouldContinue)
  .then(awardStep)
  .commit();
