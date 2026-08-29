import { z } from "@hono/zod-openapi";
import type { Context, ErrorHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { CommitError } from "../purchase-orders/commit.js";

export const errorSchema = z
  .object({ error: z.string(), detail: z.string().optional() })
  .openapi("Error");

/** Every route can declare these without repeating the shape. */
export const errorResponses = {
  400: { content: { "application/json": { schema: errorSchema } }, description: "Bad request" },
  404: { content: { "application/json": { schema: errorSchema } }, description: "Not found" },
  409: { content: { "application/json": { schema: errorSchema } }, description: "Conflict" },
  422: { content: { "application/json": { schema: errorSchema } }, description: "Unprocessable" },
  500: { content: { "application/json": { schema: errorSchema } }, description: "Internal error" },
} as const;

/**
 * One place that decides how a thrown error becomes a status code, wired in as
 * Hono's `onError`. Handlers stay free of try/catch, which also keeps their
 * return types narrow enough for the OpenAPI types to check.
 *
 * A file we cannot read is the user's problem, not a server fault, so parser
 * failures come back as 422 rather than 500.
 */
export const onError: ErrorHandler = (error, c: Context) => {
  if (error instanceof CommitError) {
    return c.json({ error: error.message }, error.status as ContentfulStatusCode);
  }

  const message = error instanceof Error ? error.message : String(error);
  if (/not a readable|no readable sheets|no line-item table|no priced line items/.test(message)) {
    return c.json({ error: "this file could not be read as a quotation", detail: message }, 422);
  }
  if (/not found/i.test(message)) {
    return c.json({ error: message }, 404);
  }

  console.error("[api]", error);
  return c.json({ error: "internal error", detail: message }, 500);
};
