import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "../env.js";
import * as schema from "./schema.js";

/**
 * Postgres returns `numeric` as a string to protect precision. Everything
 * downstream does arithmetic, so parse once here rather than sprinkling
 * `Number(...)` across every read path and eventually missing one.
 */
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => Number(value));

export const pool = new pg.Pool({
  connectionString: env.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
});

/**
 * Without this listener, Postgres restarting takes the API process with it.
 *
 * `pg` emits `error` on *idle* pooled clients when the backend goes away —
 * `docker compose down`, `pnpm db:reset`, a dropped network, an admin running
 * `pg_terminate_backend` — and Node throws on an EventEmitter `error` that
 * nobody is listening to. The crash is far worse than the event it reports: the
 * pool already discards the dead client and dials a new one on the next query,
 * so the connection recovers on its own and the only thing missing is somebody
 * to hear about it.
 *
 * Logged rather than swallowed, because a pool that loses clients repeatedly is
 * a real signal and the console is where it should show up.
 */
pool.on("error", (error) => {
  console.warn("[db] idle client dropped; the pool will reconnect:", error.message);
});

export const db = drizzle(pool, { schema });
export type Db = typeof db;
export { schema };
