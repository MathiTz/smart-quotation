import { swaggerUI } from "@hono/swagger-ui";
import { cors } from "hono/cors";
import { SUPPLIER_PROFILES } from "@sq/shared";
import { env } from "../env.js";
import { quotations } from "./quotations.js";
import { negotiations } from "./negotiations.js";
import { purchaseOrders } from "./purchase-orders.js";
import { pendingCount } from "../purchase-orders/outbox.js";
import { onError } from "./errors.js";
import { createRouter } from "./router.js";

export function createApp() {
  // Built through the same factory as the sub-routers. The hook does not travel
  // across `app.route()`, so it has to be on every instance that validates.
  const app = createRouter();

  app.onError(onError);
  app.use("*", cors({ origin: env.corsOrigins, credentials: true }));

  app.get("/health", async (c) =>
    c.json({ ok: true, offline: env.isOffline, pendingEffects: await pendingCount() }),
  );

  /** The agents' fixed characteristics, so the UI does not hardcode them. */
  app.get("/api/suppliers", (c) => c.json(SUPPLIER_PROFILES));

  app.route("/api", quotations);
  app.route("/api", negotiations);
  app.route("/api", purchaseOrders);

  app.doc("/openapi.json", {
    openapi: "3.0.0",
    info: { title: "Smart Quotation", version: "0.1.0" },
  });
  app.get("/docs", swaggerUI({ url: "/openapi.json" }));

  return app;
}
