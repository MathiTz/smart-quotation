import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { createRouter } from "./router.js";
import { ingestQuotation, getQuotation } from "../quotations/ingest.js";
import { errorResponses } from "./errors.js";
import { MAX_NOTE_CHARS, MAX_UPLOAD_BYTES } from "./limits.js";

/**
 * Responses are typed loosely on purpose: the parse result is a deep, evolving
 * shape, and mirroring it in a second Zod schema here would buy documentation at
 * the cost of two definitions to keep in step. The request side, where untrusted
 * input arrives, is validated strictly.
 */
const anyJson = z.any().openapi("Quotation");

export const quotations = createRouter();

const upload = createRoute({
  method: "post",
  path: "/quotations",
  summary: "Upload a supplier quotation",
  description:
    "Parses the workbook, matches every line against the product catalog and stores the result. The optional note is parsed into negotiation constraints.",
  request: {
    body: {
      content: {
        "multipart/form-data": {
          schema: z.object({
            file: z.any().openapi({ type: "string", format: "binary" }),
            note: z.string().max(MAX_NOTE_CHARS).optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: { content: { "application/json": { schema: anyJson } }, description: "Parsed quotation" },
    400: errorResponses[400],
    422: errorResponses[422],
  },
});

quotations.openapi(upload, async (c) => {
  // A body that is not multipart at all makes this throw, which would otherwise
  // surface as a 500 — the wrong answer for a request the client got wrong.
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "expected a multipart/form-data body with a file field" }, 400);
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: "a file field is required" }, 400);
  }
  if (file.size === 0) {
    // Reaching the parser with zero bytes produces an error about the workbook
    // being unreadable, which sends the user looking at the wrong thing.
    return c.json({ error: "that file is empty" }, 400);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return c.json({ error: "that file is larger than the 10MB limit" }, 400);
  }

  const note = form.get("note");
  if (typeof note === "string" && note.length > MAX_NOTE_CHARS) {
    return c.json(
      { error: `that note is ${note.length} characters and the limit is ${MAX_NOTE_CHARS}` },
      400,
    );
  }

  const view = await ingestQuotation({
    source: Buffer.from(await file.arrayBuffer()),
    filename: file.name || "quotation.xlsx",
    // No note is not an error: the negotiation falls back to the default
    // weighting, and the UI echoes back what it understood either way.
    brandNote: typeof note === "string" ? note : null,
  });
  return c.json(view, 201);
});

const read = createRoute({
  method: "get",
  path: "/quotations/{id}",
  summary: "Read a parsed quotation",
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { content: { "application/json": { schema: anyJson } }, description: "Parsed quotation" },
    404: errorResponses[404],
  },
});

quotations.openapi(read, async (c) => {
  const view = await getQuotation(c.req.valid("param").id);
  return view ? c.json(view, 200) : c.json({ error: "quotation not found" }, 404);
});
