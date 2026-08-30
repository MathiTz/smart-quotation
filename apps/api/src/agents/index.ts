import { z } from "zod";
import type { SupplierOffer, SupplierProfile } from "@sq/shared";
import { concessionSchema } from "@sq/shared";
import { isOffline } from "../env.js";
import { clampOffer, type RawProposal } from "./bounds.js";
import {
  offlineBrandOpening,
  offlineBrandPush,
  offlineCurveballNote,
  offlineSupplierProposal,
} from "./offline.js";
import {
  brandOpeningPrompt,
  brandVerdictPrompt,
  supplierTurnPrompt,
  type NegotiationBrief,
} from "./prompts.js";

export type { NegotiationBrief } from "./prompts.js";
export { clampOffer, isExhausted } from "./bounds.js";
export { offlineCurveballNote } from "./offline.js";

const proposalSchema = z.object({
  priceFactor: z.number().min(0.5).max(1),
  leadTimeDays: z.number().int().min(1).max(365),
  paymentTerms: z.string(),
  rebatePct: z.number().min(0).max(50),
  freightAllowancePerUnit: z.number().min(0).max(5),
  concessions: z
    .array(concessionSchema)
    .max(6)
    .describe(
      "Each description is a short chip label of at most 64 characters, phrased like '8% off our opening prices' — not a sentence.",
    ),
  message: z.string().min(20).max(1200),
});

/**
 * How long any one agent call may take before the offline stub answers instead.
 *
 * Not a formality: a reasoning model asked for structured output at a low
 * temperature can loop until the HTTP client gives up, which for Node's default
 * is five minutes. Waiting that long to fall back to an answer we could have
 * produced instantly is worse than falling back early, and a round is only as
 * fast as its slowest supplier.
 */
export const MODEL_TIMEOUT_MS = Number(process.env.MODEL_TIMEOUT_MS ?? 60_000);

/** Every model call is wrapped: a negotiation must not fail, or hang, because an API did. */
async function withFallback<T>(attempt: () => Promise<T>, fallback: () => T, label: string): Promise<T> {
  if (isOffline()) return fallback();

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      attempt(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${MODEL_TIMEOUT_MS}ms`)), MODEL_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    console.warn(`[agents] ${label} fell back to the offline agent:`, error instanceof Error ? error.message : error);
    return fallback();
  } finally {
    clearTimeout(timer);
  }
}

export async function proposeOffer(
  supplier: SupplierProfile,
  brief: NegotiationBrief,
  round: number,
  previous: SupplierOffer | null,
): Promise<SupplierOffer> {
  const raw = await withFallback<RawProposal>(
    async () => {
      const { supplierAgents } = await import("./mastra.js");
      const agent = supplierAgents.get(supplier.code);
      if (!agent) throw new Error(`no agent for ${supplier.code}`);

      const result = await agent.generate(supplierTurnPrompt(brief, round, previous), {
        structuredOutput: { schema: proposalSchema },
        modelSettings: { temperature: 0.7 },
      });
      return proposalSchema.parse(result.object) as RawProposal;
    },
    () => offlineSupplierProposal(supplier, brief, round),
    `${supplier.code} round ${round}`,
  );

  // Clamped either way. The offline agent is already inside its bounds, and the
  // model is not to be trusted with them.
  return clampOffer(
    raw,
    supplier,
    round,
    previous,
    brief.openingLeadTimeDays,
    brief.openingPaymentTerms,
  );
}

export async function brandOpening(brief: NegotiationBrief): Promise<string> {
  return withFallback(
    async () => {
      const { brandAgent } = await import("./mastra.js");
      const result = await brandAgent.generate(brandOpeningPrompt(brief), { modelSettings: { temperature: 0.6 } });
      return result.text.trim();
    },
    () => offlineBrandOpening(brief),
    "brand opening",
  );
}

export async function brandPush(brief: NegotiationBrief, round: number, standings: string[]): Promise<string> {
  return withFallback(
    async () => {
      const { brandAgent } = await import("./mastra.js");
      const result = await brandAgent.generate(
        [
          `Round ${round} is in. Where each supplier stands:`,
          ...standings.map((s) => `- ${s}`),
          "",
          `Push them once more, in two or three sentences. Your top priority is ${brief.priorities[0] ?? "cost"}.`,
        ].join("\n"),
        { modelSettings: { temperature: 0.6 } },
      );
      return result.text.trim();
    },
    () => offlineBrandPush(brief, round, standings),
    `brand push round ${round}`,
  );
}

export async function brandVerdict(
  brief: NegotiationBrief,
  winnerLabel: string,
  bullets: string[],
  rejected: string[],
): Promise<string> {
  return withFallback(
    async () => {
      const { brandAgent } = await import("./mastra.js");
      const result = await brandAgent.generate(brandVerdictPrompt(brief, winnerLabel, bullets, rejected), {
        modelSettings: { temperature: 0.4 },
      });
      return result.text.trim();
    },
    // The offline verdict is the scored reasoning read out as prose. It cannot
    // contradict the decision because it is made of the decision.
    () =>
      [
        `${winnerLabel} takes this order.`,
        ...bullets.map((b) => (b.endsWith(".") ? b : `${b}.`)),
        rejected.length > 0 ? `What it beat: ${rejected.join("; ")}.` : "",
      ]
        .filter(Boolean)
        .join(" "),
    "brand verdict",
  );
}

export { offlineBrandOpening, offlineSupplierProposal };
export { offlineCurveballNote as curveballNote };
