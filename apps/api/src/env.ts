import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isConfigured, parseModel } from "./agents/providers.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * A four-line dotenv rather than the dependency. We read one file, we never
 * overwrite a variable the shell already set, and that is the whole feature.
 */
function loadDotEnv(): void {
  for (const name of [".env", ".env.local"]) {
    let contents: string;
    try {
      contents = readFileSync(resolve(repoRoot, name), "utf8");
    } catch {
      continue;
    }
    for (const line of contents.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      if (process.env[key] !== undefined) continue;
      process.env[key] = trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
    }
  }
}

loadDotEnv();

export const env = {
  repoRoot,
  databaseUrl: process.env.DATABASE_URL ?? "postgresql://sq:sq@localhost:5433/smart_quotation",
  apiPort: Number(process.env.API_PORT ?? 8787),
  corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173").split(","),
  /**
   * Read through getters rather than frozen at import, because the tests and the
   * dev server both flip provider variables after this module is first loaded.
   */
  get negotiationModel() {
    return process.env.NEGOTIATION_MODEL || DEFAULT_MODEL;
  },
  get parserModel() {
    return process.env.PARSER_MODEL || DEFAULT_MODEL;
  },
  get isOffline() {
    return isOffline();
  },
} as const;

/**
 * Whichever provider the configured model names is the one that has to be
 * usable. That keeps "is there a model available" a question about the model
 * actually requested rather than about one hardcoded vendor.
 */
const DEFAULT_MODEL = "google/gemini-2.5-flash";

/**
 * Offline is the default whenever the configured provider has no credentials,
 * so the repo runs end to end on a clean clone. The stubs are deterministic,
 * which is also what makes the negotiation tests reproducible.
 */
export function isOffline(): boolean {
  if (process.env.SQ_OFFLINE === "1") return true;
  if (process.env.SQ_OFFLINE === "0") return false;

  try {
    return !isConfigured(parseModel(env.negotiationModel).provider);
  } catch {
    // An unknown provider is a configuration error, not a reason to make live
    // calls with something we cannot authenticate.
    return true;
  }
}
