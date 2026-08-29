import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core";
import { PostgresStore } from "@mastra/pg";
import { SUPPLIER_PROFILES } from "@sq/shared";
import { env, isOffline } from "../env.js";
import { negotiationWorkflow } from "../workflows/negotiation-workflow.js";
import { BRAND_SYSTEM_PROMPT, supplierSystemPrompt } from "./prompts.js";
import { resolveModel } from "./providers.js";

/**
 * Mastra's snapshots live in their own `mastra` schema alongside our tables in
 * `public`. Same database, so a workflow snapshot and the negotiation row it
 * belongs to are backed up and restored together; separate schema, so Mastra's
 * migrations never collide with Drizzle's.
 */
export const mastraStore = new PostgresStore({
  id: "sq-mastra-store",
  connectionString: env.databaseUrl,
  schemaName: "mastra",
});

const negotiationModel = resolveModel(env.negotiationModel);

export const brandAgent = new Agent({
  id: "brand-agent",
  name: "Brand sourcing agent",
  instructions: BRAND_SYSTEM_PROMPT,
  model: negotiationModel,
});

export const supplierAgents = new Map(
  SUPPLIER_PROFILES.map((profile) => [
    profile.code,
    new Agent({
      id: `supplier-agent-${profile.code}`,
      name: `${profile.name} sales agent`,
      instructions: supplierSystemPrompt(profile),
      model: negotiationModel,
    }),
  ]),
);

let instance: Mastra | null = null;

/**
 * Built lazily and only when a model is actually configured. Constructing the
 * Postgres-backed store on a machine with no database — a test run, a clean
 * clone — would fail at import time for a feature that run is not using.
 */
export function getMastra(): Mastra {
  if (!instance) {
    instance = new Mastra({
      agents: {
        brandAgent,
        ...Object.fromEntries([...supplierAgents].map(([code, agent]) => [`supplier_${code}`, agent])),
      },
      workflows: { negotiation: negotiationWorkflow },
      storage: mastraStore,
      logger: false,
    });
  }
  return instance;
}

export function modelAvailable(): boolean {
  return !isOffline();
}
