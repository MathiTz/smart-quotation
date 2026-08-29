import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { purchaseOrderSchema } from "@sq/shared";
import { confirmPurchaseOrder, getPurchaseOrder, listPurchaseOrders } from "../purchase-orders/commit.js";
import { drainAll } from "../purchase-orders/outbox.js";
import { errorResponses } from "./errors.js";

const poJson = z.any();

export const purchaseOrders = new OpenAPIHono();

const list = createRoute({
  method: "get",
  path: "/purchase-orders",
  summary: "Every PO the brand has issued",
  responses: {
    200: {
      content: { "application/json": { schema: z.array(purchaseOrderSchema) } },
      description: "Purchase orders, newest first",
    },
  },
});

purchaseOrders.openapi(list, async (c) => c.json(await listPurchaseOrders(), 200));

const read = createRoute({
  method: "get",
  path: "/purchase-orders/{id}",
  summary: "Read one PO with its frozen terms and delivery status",
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { content: { "application/json": { schema: poJson } }, description: "PO" },
    404: errorResponses[404],
  },
});

purchaseOrders.openapi(read, async (c) => {
  const po = await getPurchaseOrder(c.req.valid("param").id);
  return po ? c.json(po, 200) : c.json({ error: "purchase order not found" }, 404);
});

const confirm = createRoute({
  method: "post",
  path: "/purchase-orders/{id}/confirm",
  summary: "Issue a drafted PO",
  description: "Releases the supplier-facing effects that a draft withheld. Terms are not recomputed.",
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { content: { "application/json": { schema: poJson } }, description: "Issued PO" },
    404: errorResponses[404],
  },
});

purchaseOrders.openapi(confirm, async (c) => {
  const po = await confirmPurchaseOrder(c.req.valid("param").id);
  await drainAll(10);
  return c.json((await getPurchaseOrder(po.id))!, 200);
});
