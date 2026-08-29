import { and, asc, eq, sql } from "drizzle-orm";
import type {
  Award,
  AwardOption,
  MatchedLine,
  NegotiationConstraints,
  NegotiationStatus,
  ParsedQuotation,
  SupplierOffer,
  SupplierProfile,
} from "@sq/shared";
import {
  CURVEBALL_AFTER_ROUND,
  MAX_ROUNDS,
  SUPPLIER_2_CURVEBALL_RATIO,
  SUPPLIER_PROFILES,
  formatPaymentTerms,
} from "@sq/shared";
import { db, schema } from "../db/client.js";
import {
  brandOpening,
  brandPush,
  brandVerdict,
  curveballNote,
  isExhausted,
  proposeOffer,
  type NegotiationBrief,
} from "../agents/index.js";
import { buildAwardOptions, pickWinner } from "./award.js";
import { buildCandidates, prepareNegotiation, supplierByCode, type NegotiationSetup } from "./setup.js";
import { describeConstraints } from "./constraints.js";

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

export type NegotiationRow = typeof schema.negotiations.$inferSelect;

/**
 * Rebuilds the negotiation's world from the database on every step. Nothing is
 * held in memory between rounds, so a restarted process, a resumed workflow and
 * a fresh HTTP request all see exactly the same state — which is the property
 * that makes the curveball a resume rather than a replay.
 */
export async function loadContext(negotiationId: string): Promise<{
  negotiation: NegotiationRow;
  quotation: typeof schema.quotations.$inferSelect;
  setup: NegotiationSetup;
  constraints: NegotiationConstraints;
  offers: Map<string, SupplierOffer>;
  capacity: Map<string, number>;
}> {
  const negotiation = await db.query.negotiations.findFirst({
    where: eq(schema.negotiations.id, negotiationId),
  });
  if (!negotiation) throw new Error(`negotiation ${negotiationId} not found`);

  const quotation = await db.query.quotations.findFirst({
    where: eq(schema.quotations.id, negotiation.quotationId),
  });
  if (!quotation) throw new Error(`quotation ${negotiation.quotationId} not found`);

  const lineRows = await db
    .select()
    .from(schema.quotationLines)
    .where(eq(schema.quotationLines.quotationId, quotation.id));

  const matched: MatchedLine[] = lineRows.map((row) => ({
    rawSku: row.rawSku,
    rawDescription: row.rawDescription,
    quantity: row.quantity,
    unitPrice: Number(row.unitPrice),
    listUnitPrice: Number(row.listUnitPrice),
    discountPct: row.discountPct,
    lineTotal: Number(row.lineTotal),
    tierQuantity: row.tierQuantity,
    sheetName: row.sheetName,
    rowNumber: row.rowNumber,
    totalMismatch: row.totalMismatch,
    matchedSku: row.matchedSku,
    matchedName: row.matchedName,
    matchedBrand: row.matchedBrand,
    matchConfidence: row.matchConfidence,
    matchMethod: row.matchMethod as MatchedLine["matchMethod"],
    candidates: row.candidates,
  }));

  const parsed: ParsedQuotation = {
    metadata: quotation.metadata,
    layout: quotation.layout,
    lines: matched,
    tiers: quotation.tiers,
    warnings: quotation.warnings,
  };

  const setup = prepareNegotiation(parsed, matched, negotiation.tierQuantity);
  const offers = await latestOffers(negotiationId);

  return {
    negotiation,
    quotation,
    setup,
    constraints: negotiation.constraints,
    offers,
    capacity: new Map(Object.entries(negotiation.capacity)),
  };
}

/** The most recent offer from each supplier. The negotiation's actual position. */
export async function latestOffers(negotiationId: string): Promise<Map<string, SupplierOffer>> {
  const rows = await db
    .select()
    .from(schema.negotiationRounds)
    .where(eq(schema.negotiationRounds.negotiationId, negotiationId))
    .orderBy(asc(schema.negotiationRounds.sequence));

  const offers = new Map<string, SupplierOffer>();
  for (const row of rows) {
    if (row.offer && row.supplierCode) offers.set(row.supplierCode, row.offer);
  }
  return offers;
}

async function appendRound(
  negotiationId: string,
  entry: {
    round: number;
    actor: "brand" | "supplier" | "system";
    supplierCode: string | null;
    message: string;
    offer?: SupplierOffer | null;
  },
): Promise<void> {
  // The sequence is allocated inside the insert so two concurrent writers cannot
  // both read the same maximum and collide on the unique index.
  await db.insert(schema.negotiationRounds).values({
    negotiationId,
    round: entry.round,
    actor: entry.actor,
    supplierCode: entry.supplierCode,
    message: entry.message,
    offer: entry.offer ?? null,
    sequence: sql`(select coalesce(max(${schema.negotiationRounds.sequence}), 0) + 1 from ${schema.negotiationRounds} where ${schema.negotiationRounds.negotiationId} = ${negotiationId})`,
  });
}

async function setStatus(negotiationId: string, status: NegotiationStatus, error?: string): Promise<void> {
  await db
    .update(schema.negotiations)
    .set({ status, updatedAt: new Date(), ...(error ? { error } : {}) })
    .where(eq(schema.negotiations.id, negotiationId));
}

function buildBrief(
  setup: NegotiationSetup,
  constraints: NegotiationConstraints,
  supplier: SupplierProfile,
  offers: Map<string, SupplierOffer>,
  capacity: Map<string, number>,
  brandNote: string,
  standings: string[],
): NegotiationBrief {
  const quotedLines = setup.basket.lines.filter((l) => setup.quotedAtTier.has(l.sku));
  const baselineTotal = quotedLines.reduce((sum, l) => sum + l.quantity * l.baselineUnitPrice, 0);

  const offer = offers.get(supplier.code);
  const openingTotal = setup.basket.lines.reduce((sum, line) => {
    const opening = setup.pricing.get(supplier.code)?.opening.get(line.sku) ?? line.baselineUnitPrice;
    return sum + line.quantity * opening * (offer?.priceFactor ?? 1);
  }, 0);

  const priorities = (Object.entries(constraints.weights) as Array<[string, number]>)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([key]) => ({ cost: "cost", quality: "quality", leadTime: "lead time", paymentTerms: "payment terms" })[key]!);

  return {
    supplierName: supplier.name,
    lineCount: setup.basket.lines.length,
    totalUnits: setup.basket.lines.reduce((s, l) => s + l.quantity, 0),
    baselineTotal,
    baselineLineCount: quotedLines.length,
    openingTotal,
    openingLeadTimeDays:
      supplier.code === "supplier_1" ? setup.incumbentLeadTimeDays : supplier.leadTimeDays,
    openingPaymentTerms:
      supplier.code === "supplier_1" ? setup.incumbentPaymentTerms : supplier.paymentTerms,
    incumbentLeadTimeDays: setup.incumbentLeadTimeDays,
    incumbentPaymentTerms: setup.incumbentPaymentTerms,
    uncoveredByIncumbent: setup.basket.lines.filter((l) => l.baselineExtrapolated).map((l) => l.sku),
    priorities,
    hardConstraints: describeConstraints(constraints).filter((d) => !d.startsWith("Weighting")),
    brandNote,
    capacityRatio: capacity.get(supplier.code) ?? 1,
    standings,
  };
}

/** Writes the brand's opening message and marks the negotiation live. */
export async function openNegotiation(negotiationId: string): Promise<void> {
  const { setup, constraints, quotation, offers, capacity } = await loadContext(negotiationId);
  await setStatus(negotiationId, "negotiating");

  const brief = buildBrief(
    setup,
    constraints,
    supplierByCode("supplier_1"),
    offers,
    capacity,
    quotation.brandNote,
    [],
  );

  await appendRound(negotiationId, {
    round: 0,
    actor: "brand",
    supplierCode: null,
    message: await brandOpening(brief),
  });

  for (const note of setup.termsConflict) {
    await appendRound(negotiationId, {
      round: 0,
      actor: "system",
      supplierCode: "supplier_1",
      message: `Worth knowing before we start: ${note}. They have already moved once on this deal.`,
    });
  }
}

export type RoundResult = { round: number; shouldContinue: boolean; standings: string[] };

/**
 * One full round: every supplier answers, their offers are clamped to what they
 * can actually do, and the brand pushes back with the standings. Rounds stop
 * early once nobody has anything left to give, because three rounds of a
 * supplier repeating its floor is not a negotiation, it is padding.
 */
export async function runRound(negotiationId: string, round: number): Promise<RoundResult> {
  const { setup, constraints, quotation, offers, capacity } = await loadContext(negotiationId);

  const standings = await currentStandings(negotiationId);
  let exhausted = 0;

  // The suppliers bid concurrently because they genuinely are bidding
  // concurrently: each brief is built from the standings as they were at the
  // start of the round and from that supplier's own previous offer, so nobody
  // is reacting to anybody else's answer within the round. Sequentially this is
  // three model round-trips of dead time per round for no added realism.
  const proposals = await Promise.all(
    SUPPLIER_PROFILES.map(async (profile) => {
      const brief = buildBrief(setup, constraints, profile, offers, capacity, quotation.brandNote, standings);
      const offer = await proposeOffer(profile, brief, round, offers.get(profile.code) ?? null);

      // The capacity ceiling is the system's fact, not the supplier's claim.
      offer.fulfillmentRatio = capacity.get(profile.code) ?? 1;
      return { profile, offer };
    }),
  );

  // Written in profile order rather than completion order: the transcript should
  // read the same way twice, and the sequence numbers are allocated per insert.
  for (const { profile, offer } of proposals) {
    await appendRound(negotiationId, {
      round,
      actor: "supplier",
      supplierCode: profile.code,
      message: offer.message,
      offer,
    });

    offers.set(profile.code, offer);
    if (isExhausted(offer, profile)) exhausted++;
  }

  const nextStandings = await currentStandings(negotiationId);
  const shouldContinue = round < MAX_ROUNDS && exhausted < SUPPLIER_PROFILES.length;

  if (shouldContinue) {
    const brief = buildBrief(
      setup,
      constraints,
      supplierByCode("supplier_1"),
      offers,
      capacity,
      quotation.brandNote,
      nextStandings,
    );
    await appendRound(negotiationId, {
      round,
      actor: "brand",
      supplierCode: null,
      message: await brandPush(brief, round, nextStandings),
    });
  }

  return { round, shouldContinue, standings: nextStandings };
}

/**
 * Every plan that was on the table, with its allocations, rebuilt from the offers
 * in the database.
 *
 * The award stores only the plan that won, because that is the one being bought.
 * Letting a buyer overrule the recommendation means the losing plans need their
 * line-level detail too — and rebuilding is better than storing it, for the same
 * reason `loadContext` rebuilds everything else: the offers are frozen once
 * scoring is done, `buildAwardOptions` is pure, so this returns exactly the plans
 * the ranking was computed from. Storing a second copy in the award jsonb would
 * add a migration and a way for the two to disagree.
 */
export async function rebuildOptions(negotiationId: string): Promise<AwardOption[]> {
  const { setup, constraints, offers, capacity } = await loadContext(negotiationId);
  return buildAwardOptions(setup.basket, buildCandidates(setup, offers, capacity), constraints);
}

/** One line per supplier describing where they currently stand. Feeds both agents and the UI. */
export async function currentStandings(negotiationId: string): Promise<string[]> {
  const { setup, constraints, offers, capacity } = await loadContext(negotiationId);
  const candidates = buildCandidates(setup, offers, capacity);
  const result = pickWinner(buildAwardOptions(setup.basket, candidates, constraints), candidates, constraints);
  if (!result) return [];

  return result.breakdowns
    .filter((b) => b.supplierCount === 1)
    .map((b) => {
      const parts = [
        `${b.label}: ${money(b.effectiveTotal)} effective`,
        `${b.leadTimeDays} days`,
        `quality ${b.qualityRating.toFixed(1)}`,
      ];
      if (b.coverageRatio < 1) parts.push(`covers ${Math.round(b.coverageRatio * 100)}%`);
      if (b.disqualified) parts.push(`ruled out (${b.disqualifiedReasons[0]})`);
      return `${parts.join(", ")}.`;
    });
}

/**
 * The curveball. It sets one number — a capacity ceiling — and appends a system
 * message. Every downstream consequence, from re-pricing to re-allocating to
 * re-ranking, falls out of the coverage vector being rebuilt on the next read.
 * There is no separate curveball code path, which is the whole design.
 */
export async function applyCurveball(
  negotiationId: string,
  supplierCode = "supplier_2",
  ratio = SUPPLIER_2_CURVEBALL_RATIO,
): Promise<void> {
  const { negotiation } = await loadContext(negotiationId);
  const supplier = supplierByCode(supplierCode);

  await db
    .update(schema.negotiations)
    .set({
      capacity: { ...negotiation.capacity, [supplierCode]: ratio },
      curveballApplied: true,
      updatedAt: new Date(),
    })
    .where(eq(schema.negotiations.id, negotiationId));

  await appendRound(negotiationId, {
    round: CURVEBALL_AFTER_ROUND,
    actor: "system",
    supplierCode,
    message: `${supplier.name} can only fulfil ${Math.round(ratio * 100)}% of the order.`,
  });

  await appendRound(negotiationId, {
    round: CURVEBALL_AFTER_ROUND,
    actor: "brand",
    supplierCode: null,
    message: curveballNote(supplier.name, ratio),
  });
}

/** Scores every way of buying the basket, writes the award, and has the brand explain it. */
export async function finaliseNegotiation(negotiationId: string): Promise<Award> {
  await setStatus(negotiationId, "scoring");

  const { setup, constraints, quotation, offers, capacity } = await loadContext(negotiationId);
  const candidates = buildCandidates(setup, offers, capacity);
  const options = buildAwardOptions(setup.basket, candidates, constraints);
  const result = pickWinner(options, candidates, constraints);

  if (!result) {
    await setStatus(negotiationId, "failed", "no supplier could cover any part of this basket");
    throw new Error("no supplier could cover any part of this basket");
  }

  const brief = buildBrief(
    setup,
    constraints,
    supplierByCode(result.award.plan.allocations[0]?.supplierCode ?? "supplier_1"),
    offers,
    capacity,
    quotation.brandNote,
    [],
  );

  const narrative = await brandVerdict(
    brief,
    result.award.label,
    result.award.reasoning.bullets,
    result.award.reasoning.rejected,
  );

  await appendRound(negotiationId, {
    round: MAX_ROUNDS + 1,
    actor: "brand",
    supplierCode: null,
    message: narrative,
  });

  const award: Award = {
    ...result.award,
    reasoning: { ...result.award.reasoning, headline: narrative },
  };

  await db
    .update(schema.negotiations)
    .set({
      award,
      coverage: candidates.map((c) => c.coverage),
      status: "awaiting_conversion",
      updatedAt: new Date(),
    })
    .where(eq(schema.negotiations.id, negotiationId));

  return award;
}

export async function markFailed(negotiationId: string, error: string): Promise<void> {
  await setStatus(negotiationId, "failed", error);
}

export async function transcript(negotiationId: string) {
  return db
    .select()
    .from(schema.negotiationRounds)
    .where(eq(schema.negotiationRounds.negotiationId, negotiationId))
    .orderBy(asc(schema.negotiationRounds.sequence));
}

export async function roundsSoFar(negotiationId: string): Promise<number> {
  const rows = await db
    .select({ round: schema.negotiationRounds.round })
    .from(schema.negotiationRounds)
    .where(
      and(
        eq(schema.negotiationRounds.negotiationId, negotiationId),
        eq(schema.negotiationRounds.actor, "supplier"),
      ),
    );
  return rows.reduce((max, r) => Math.max(max, r.round), 0);
}

export { formatPaymentTerms };
