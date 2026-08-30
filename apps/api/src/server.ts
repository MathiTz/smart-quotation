import { serve } from "@hono/node-server";
import { createApp } from "./http/app.js";
import { startOutboxWorker, stopOutboxWorker } from "./purchase-orders/outbox.js";
import { startRecoveryWorker, stopRecoveryWorker } from "./negotiation/recover.js";
import { pool } from "./db/client.js";
import { env } from "./env.js";
import {
  credentialsReport,
  describeModel,
  isConfigured,
  offlineNotice,
  parseModel,
} from "./agents/providers.js";

// Checked before the port is opened. A server that is already listening invites
// you to go and use it, and the point of this check is that using it would be a
// waste of your time.
assertModelsUsable();

const app = createApp();
startOutboxWorker();
startRecoveryWorker();

const server = serve({ fetch: app.fetch, port: env.apiPort }, (info) => {
  console.log(`api listening on http://localhost:${info.port}`);
  console.log(`docs at http://localhost:${info.port}/docs`);
});

/**
 * Refuses to start when the configuration contradicts itself.
 *
 * `SQ_OFFLINE=0` is an instruction to use live models. With no credentials that
 * instruction cannot be carried out, and the way it fails is silent: every call
 * 401s, `withFallback` catches it, the scripted agent answers, and the
 * negotiation completes looking exactly like a real one. Better to stop here
 * than to hand someone a demo that is quietly lying to them.
 *
 * Running offline is not an error and never blocks: it is the default, and it is
 * what lets a fresh clone work without an account.
 */
function assertModelsUsable(): void {
  const specs = [env.negotiationModel, env.parserModel];

  if (env.isOffline) {
    console.log(offlineNotice(process.env.SQ_OFFLINE === "1" ? "explicit" : "no-credentials"));
    return;
  }

  const broken = specs.filter((spec) => {
    try {
      return !isConfigured(parseModel(spec).provider);
    } catch {
      return true; // an unknown provider name is just as unusable
    }
  });

  if (broken.length > 0) {
    console.error(credentialsReport(specs));
    process.exit(1);
  }

  console.log(`negotiation model: ${describeModel(env.negotiationModel)}`);
  console.log(`parser model     : ${describeModel(env.parserModel)}`);
}

/**
 * A negotiation runs in the background, so a rejection it fails to catch belongs
 * to no request and lands here. Since Node 15 the default for that is to kill the
 * process — which would take the API, the outbox worker and every other running
 * negotiation down with it, over one bad round.
 *
 * So it is logged loudly and the process keeps serving. The negotiation that
 * caused it is already marked `failed` by the workflow runner, so the damage
 * stays where it happened. This is a net, not a hiding place: anything caught
 * here is a bug worth fixing, which is why it prints the whole reason.
 */
// #region process-errors
process.on("unhandledRejection", (reason) => {
  console.error("unhandled rejection in background work — the API is still serving");
  console.error(reason instanceof Error ? (reason.stack ?? reason.message) : reason);
});

/**
 * An uncaught exception is different in kind: the stack that threw was abandoned
 * halfway, so a lock may be held or a transaction left open, and the process is
 * no longer in a state its own code would recognise. Log it and go down, rather
 * than serve requests out of memory nobody can reason about.
 */
process.on("uncaughtException", (error) => {
  console.error("uncaught exception — shutting down");
  console.error(error.stack ?? error.message);
  stopOutboxWorker();
  stopRecoveryWorker();
  process.exit(1);
});
// #endregion process-errors

let closing = false;

async function shutdown() {
  // Two Ctrl-Cs should not race each other through pool.end().
  if (closing) return;
  closing = true;

  stopOutboxWorker();
  stopRecoveryWorker();
  server.close();
  try {
    await pool.end();
  } catch (error) {
    console.error("database pool did not close cleanly:", error);
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
