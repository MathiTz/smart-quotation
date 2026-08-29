import { OpenAPIHono } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import { cors } from "hono/cors";
import { SUPPLIER_PROFILES } from "@sq/shared";
import { env } from "../env.js";
import { quotations } from "./quotations.js";
import { negotiations } from "./negotiations.js";
import { purchaseOrders } from "./purchase-orders.js";
import { pendingCount } from "../purchase-orders/outbox.js";
import { onError } from "./errors.js";

export function createApp() {
  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      // Turns a Zod failure into the same error shape every other route uses,
      // instead of Hono's default which the UI would have to special-case.
      if (!result.success) {
        return c.json(
          { error: "invalid request", detail: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") },
          400,
        );
      }
    },
  });

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
