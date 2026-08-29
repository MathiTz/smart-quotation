import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";
import { eq } from "drizzle-orm";
import { SUPPLIER_2_CURVEBALL_RATIO, convertRequestSchema } from "@sq/shared";
import { db, schema } from "../db/client.js";
import { parseBrandNote } from "../negotiation/constraints.js";
import { listNegotiations, readNegotiation, readTranscript, pollState } from "../negotiation/view.js";
import { resumeNegotiation, startNegotiation } from "../workflows/runner.js";
import { convertNegotiation, getPurchaseOrder } from "../purchase-orders/commit.js";
import { drainAll } from "../purchase-orders/outbox.js";
import { errorResponses } from "./errors.js";

const anyJson = z.any();

export const negotiations = new OpenAPIHono();

const start = createRoute({
  method: "post",
  path: "/negotiations",
  summary: "Start a negotiation from a parsed quotation",
  description:
    "Kicks off the brand agent against all three supplier agents. Returns immediately; follow progress on the SSE stream.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            quotationId: z.string().uuid(),
            /** Defaults to the tier the parser suggested. */
            tierQuantity: z.number().int().positive().optional(),
            /** Overrides the note captured at upload, if the user edited it. */
            note: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: { content: { "application/json": { schema: anyJson } }, description: "Negotiation started" },
    404: errorResponses[404],
  },
});

negotiations.openapi(start, async (c) => {
  const body = c.req.valid("json");
  const quotation = await db.query.quotations.findFirst({
    where: eq(schema.quotations.id, body.quotationId),
  });
  if (!quotation) return c.json({ error: "quotation not found" }, 404);

  const note = body.note ?? quotation.brandNote;
  const [negotiation] = await db
    .insert(schema.negotiations)
    .values({
      quotationId: quotation.id,
      tierQuantity: body.tierQuantity ?? quotation.suggestedTier,
      constraints: body.note === undefined ? quotation.constraints : parseBrandNote(body.note),
    })
    .returning();

  // The note the user typed on the negotiation screen replaces the one captured
  // at upload, so a reload shows what the agent is actually working to.
  if (body.note !== undefined && body.note !== quotation.brandNote) {
    await db
      .update(schema.quotations)
      .set({ brandNote: note, constraints: parseBrandNote(note) })
      .where(eq(schema.quotations.id, quotation.id));
  }

  await startNegotiation(negotiation!.id);
  return c.json(await readNegotiation(negotiation!.id), 201);
});

const list = createRoute({
  method: "get",
  path: "/negotiations",
  summary: "List every negotiation, newest first",
  description:
    "Negotiations run in the background, so this is how you find one again after navigating away.",
  responses: {
    200: { content: { "application/json": { schema: anyJson } }, description: "Negotiations" },
  },
});

negotiations.openapi(list, async (c) => c.json(await listNegotiations(), 200));

const read = createRoute({
  method: "get",
  path: "/negotiations/{id}",
  summary: "Read a negotiation with its full transcript",
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { content: { "application/json": { schema: anyJson } }, description: "Negotiation" },
    404: errorResponses[404],
  },
});

negotiations.openapi(read, async (c) => {
  const view = await readNegotiation(c.req.valid("param").id);
  return view ? c.json(view, 200) : c.json({ error: "negotiation not found" }, 404);
});

const curveball = createRoute({
  method: "post",
  path: "/negotiations/{id}/curveball",
  summary: "Inject the mid-negotiation capacity change",
  description:
    "Resumes the suspended workflow with the new fact. The rounds already negotiated stand; only the plans are re-scored.",
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            supplierCode: z.string().default("supplier_2"),
            fulfillmentRatio: z.number().min(0).max(1).default(SUPPLIER_2_CURVEBALL_RATIO),
            /** Carry on with no capacity change. */
            skip: z.boolean().default(false),
          }),
        },
      },
    },
  },
  responses: {
    202: { content: { "application/json": { schema: anyJson } }, description: "Resumed" },
    404: errorResponses[404],
    409: errorResponses[409],
  },
});

negotiations.openapi(curveball, async (c) => {
  const { id } = c.req.valid("param");
  const state = await pollState(id);
  if (!state) return c.json({ error: "negotiation not found" }, 404);
  if (state.status !== "suspended") {
    return c.json({ error: `this negotiation is ${state.status}, not waiting for input` }, 409);
  }
  await resumeNegotiation(id, c.req.valid("json"));
  return c.json(await readNegotiation(id), 202);
});

const stream = createRoute({
  method: "get",
  path: "/negotiations/{id}/stream",
  summary: "Live transcript",
  description:
    "Server-sent events. Replays everything written so far, then follows. Reconnecting loses nothing because the transcript lives in the database, not in the connection.",
  request: {
    params: z.object({ id: z.string().uuid() }),
    query: z.object({ after: z.coerce.number().int().nonnegative().optional() }),
  },
  responses: { 200: { description: "text/event-stream" } },
});

negotiations.openapi(stream, async (c) => {
  const { id } = c.req.valid("param");
  const after = c.req.valid("query").after ?? 0;

  return streamSSE(c, async (sse) => {
    let cursor = after;
    let lastStatus = "";
    // Polling rather than listen/notify: one query every 400ms against an
    // indexed table is cheap, survives a process restart, and needs no in-memory
    // subscriber registry that a second API instance would not share.
    for (let tick = 0; tick < 1_500; tick++) {
      for (const entry of await readTranscript(id, cursor)) {
        cursor = entry.sequence;
        await sse.writeSSE({ event: "message", id: String(entry.sequence), data: JSON.stringify(entry) });
      }

      const state = await pollState(id);
      if (!state) {
        await sse.writeSSE({ event: "failed", data: JSON.stringify({ error: "negotiation not found" }) });
        return;
      }
      if (state.status !== lastStatus) {
        lastStatus = state.status;
        await sse.writeSSE({ event: "status", data: JSON.stringify({ status: state.status }) });
      }
      if (["awaiting_conversion", "converted", "failed"].includes(state.status)) {
        await sse.writeSSE({ event: "done", data: JSON.stringify({ status: state.status, award: state.award }) });
        return;
      }
      if (c.req.raw.signal.aborted) return;
      await new Promise((r) => setTimeout(r, 400));
    }
  });
});

const convert = createRoute({
  method: "post",
  path: "/negotiations/{id}/convert",
  summary: "Convert a negotiation into purchase orders",
  description:
    "Writes one PO per allocation with the agreed terms frozen, and enqueues the downstream effects in the same transaction. Idempotent on the supplied key. Buys the recommended plan unless `optionId` names another one that was scored.",
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: { content: { "application/json": { schema: convertRequestSchema } } },
  },
  responses: {
    201: { content: { "application/json": { schema: anyJson } }, description: "Purchase orders" },
    400: errorResponses[400],
    404: errorResponses[404],
    409: errorResponses[409],
  },
});

negotiations.openapi(convert, async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const created = await convertNegotiation({
    negotiationId: id,
    idempotencyKey: body.idempotencyKey,
    saveAsDraft: body.saveAsDraft,
    optionId: body.optionId,
  });
  // Deliver what we can before answering so the UI can show the effects as sent
  // rather than as pending. The background worker is what guarantees the rest.
  await drainAll(created.length * 5);
  return c.json(await Promise.all(created.map((po) => getPurchaseOrder(po.id))), 201);
});
