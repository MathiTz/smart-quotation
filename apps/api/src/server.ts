import { serve } from "@hono/node-server";
import { createApp } from "./http/app.js";
import { startOutboxWorker, stopOutboxWorker } from "./purchase-orders/outbox.js";
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

async function shutdown() {
  stopOutboxWorker();
  server.close();
  await pool.end();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
