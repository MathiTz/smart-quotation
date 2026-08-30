import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import type { Award, AwardOption, NegotiationStatus, SupplierOffer } from "@sq/shared";
import { SUPPLIER_PROFILES } from "@sq/shared";
import { db, schema } from "../db/client.js";
import { describeConstraints } from "./constraints.js";

export type TranscriptEntry = {
  sequence: number;
  round: number;
  actor: "brand" | "supplier" | "system";
  supplierCode: string | null;
  supplierName: string | null;
  message: string;
  offer: SupplierOffer | null;
  createdAt: string;
};

export type NegotiationView = {
  id: string;
  quotationId: string;
  status: NegotiationStatus;
  tierQuantity: number;
  constraints: typeof schema.negotiations.$inferSelect["constraints"];
  constraintSummary: string[];
  capacity: Record<string, number>;
  curveballApplied: boolean;
  award: Award | null;
  /**
   * What each plan in the comparison would actually buy, so a buyer who overrules
   * the recommendation can see the lines before committing to them. Empty until
   * there is an award, and rebuilt rather than stored — see `rebuildOptions`.
   */
  plans: PlanView[];
  error: string | null;
  createdAt: string;
  transcript: TranscriptEntry[];
  purchaseOrderIds: string[];
};

export type PlanView = {
  optionId: string;
  label: string;
  allocations: AwardOption["allocations"];
};

const nameOf = (code: string | null) =>
  code ? (SUPPLIER_PROFILES.find((s) => s.code === code)?.name ?? code) : null;

export async function readTranscript(
  negotiationId: string,
  afterSequence = 0,
): Promise<TranscriptEntry[]> {
  const rows = await db
    .select()
    .from(schema.negotiationRounds)
    .where(
      and(
        eq(schema.negotiationRounds.negotiationId, negotiationId),
        gt(schema.negotiationRounds.sequence, afterSequence),
      ),
    )
    .orderBy(asc(schema.negotiationRounds.sequence));

  return rows.map((row) => ({
    sequence: row.sequence,
    round: row.round,
    actor: row.actor as TranscriptEntry["actor"],
    supplierCode: row.supplierCode,
    supplierName: nameOf(row.supplierCode),
    message: row.message,
    offer: row.offer,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function readNegotiation(id: string): Promise<NegotiationView | null> {
  const row = await db.query.negotiations.findFirst({ where: eq(schema.negotiations.id, id) });
  if (!row) return null;

  const pos = await db
    .select({ id: schema.purchaseOrders.id })
    .from(schema.purchaseOrders)
    .where(eq(schema.purchaseOrders.negotiationId, id));

  // Only once there is something to choose between. Before the award this costs
  // a basket rebuild per poll and answers a question nobody has asked yet.
  const plans = row.award ? await readPlans(id) : [];

  return {
    id: row.id,
    quotationId: row.quotationId,
    status: row.status as NegotiationStatus,
    tierQuantity: row.tierQuantity,
    constraints: row.constraints,
    constraintSummary: describeConstraints(row.constraints),
    capacity: row.capacity,
    curveballApplied: row.curveballApplied,
    award: row.award ?? null,
    plans,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    transcript: await readTranscript(id),
    purchaseOrderIds: pos.map((p) => p.id),
  };
}

/**
 * A rebuild depends on the offers still being readable, and this is on the path
 * that renders the page. A negotiation whose plans cannot be reconstructed should
 * still show its transcript and its award, so a failure here costs the override
 * feature rather than the screen.
 */
async function readPlans(id: string): Promise<PlanView[]> {
  try {
    const { rebuildOptions } = await import("./engine.js");
    const options = await rebuildOptions(id);
    return options.map((option) => ({
      optionId: option.id,
      label: option.label,
      allocations: option.allocations,
    }));
  } catch (error) {
    console.warn(`[negotiation] could not rebuild the plans for ${id}:`, error);
    return [];
  }
}

export type NegotiationSummary = {
  id: string;
  status: NegotiationStatus;
  tierQuantity: number;
  filename: string;
  createdAt: string;
  /** Present once an award exists, so the list can show the outcome. */
  winner: string | null;
  total: number | null;
  purchaseOrderCount: number;
};

/**
 * The index of every negotiation, newest first.
 *
 * The work already runs in the background — the HTTP call that starts it returns
 * immediately and a suspended run survives a restart — so the only thing stopping
 * someone walking away from a slow negotiation was having nowhere to walk back
 * to. This is that page.
 *
 * A run that was mid-round when the process died does not survive; it is swept
 * into `failed` by `recoverInterrupted` so this list never shows a spinner that
 * will not stop.
 */
export async function listNegotiations(): Promise<NegotiationSummary[]> {
  const rows = await db
    .select({
      id: schema.negotiations.id,
      status: schema.negotiations.status,
      tierQuantity: schema.negotiations.tierQuantity,
      award: schema.negotiations.award,
      createdAt: schema.negotiations.createdAt,
      filename: schema.quotations.filename,
      purchaseOrderCount: sql<number>`
        (select count(*) from ${schema.purchaseOrders}
          where ${schema.purchaseOrders.negotiationId} = ${schema.negotiations.id})
      `.mapWith(Number),
    })
    .from(schema.negotiations)
    .innerJoin(schema.quotations, eq(schema.quotations.id, schema.negotiations.quotationId))
    .orderBy(desc(schema.negotiations.createdAt));

  return rows.map((row) => {
    const allocations = row.award?.plan.allocations ?? [];
    return {
      id: row.id,
      status: row.status as NegotiationStatus,
      tierQuantity: row.tierQuantity,
      filename: row.filename,
      createdAt: row.createdAt.toISOString(),
      winner:
        allocations.length === 0
          ? null
          : allocations.length === 1
            ? nameOf(allocations[0]!.supplierCode)
            : `Split across ${allocations.length}`,
      total: allocations.length === 0 ? null : allocations.reduce((sum, a) => sum + a.subtotal, 0),
      purchaseOrderCount: row.purchaseOrderCount,
    };
  });
}

/** Status plus the last sequence written: everything the SSE loop needs to poll. */
export async function pollState(id: string): Promise<{ status: NegotiationStatus; award: Award | null } | null> {
  const [row] = await db
    .select({ status: schema.negotiations.status, award: schema.negotiations.award })
    .from(schema.negotiations)
    .where(eq(schema.negotiations.id, id));
  return row ? { status: row.status as NegotiationStatus, award: row.award ?? null } : null;
}
