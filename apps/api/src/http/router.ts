import { OpenAPIHono } from "@hono/zod-openapi";

/**
 * Every router is built here rather than with `new OpenAPIHono()` directly.
 *
 * The `defaultHook` is what turns a Zod failure into the same `{ error, detail }`
 * shape every other route returns, instead of Hono's default, which serialises
 * the raw `ZodError`. The shape matters more than the wording: the client reads
 * `body.error` as a string, and handed a nested object it renders
 * "[object Object]" — so a request the user could have fixed becomes a message
 * nobody can act on.
 *
 * It has to be set per instance. A hook given to the root app does not travel
 * across `app.route()` to a mounted sub-router, so a router built without one
 * answers differently from the rest of the API, and only on the routes it owns —
 * which is exactly the kind of inconsistency nobody notices until a user hits it.
 * Sharing the constructor is what keeps that from being possible.
 */
export function createRouter() {
  return new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(
          {
            error: "invalid request",
            detail: result.error.issues
              .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
              .join("; "),
          },
          400,
        );
      }
      return undefined;
    },
  });
}
