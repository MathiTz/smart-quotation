import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { ingestQuotation, getQuotation } from "../quotations/ingest.js";
import { errorResponses } from "./errors.js";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Responses are typed loosely on purpose: the parse result is a deep, evolving
 * shape, and mirroring it in a second Zod schema here would buy documentation at
 * the cost of two definitions to keep in step. The request side, where untrusted
 * input arrives, is validated strictly.
 */
const anyJson = z.any().openapi("Quotation");

export const quotations = new OpenAPIHono();

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
            note: z.string().optional(),
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
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: "a file field is required" }, 400);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return c.json({ error: "that file is larger than the 10MB limit" }, 400);
  }
  const note = form.get("note");

  const view = await ingestQuotation({
    source: Buffer.from(await file.arrayBuffer()),
    filename: file.name || "quotation.xlsx",
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
