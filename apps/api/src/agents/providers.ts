import type { MastraModelConfig } from "@mastra/core/llm";

/**
 * Which model providers this app knows how to talk to.
 *
 * Models are named `provider/model` everywhere — `google/gemini-2.5-flash`,
 * `ollama/gpt-oss:120b` — so switching provider is one environment variable and
 * never a code change. Three of the four are in Mastra's own router and only
 * need a key; Ollama is not, so it goes through Mastra's OpenAI-compatible
 * config with an explicit base URL.
 */
export type ProviderId = "google" | "openai" | "anthropic" | "ollama";

type ProviderConfig = {
  /** Env vars holding the key, in priority order. */
  keyEnv: readonly string[];
  /** Env var overriding the base URL, for self-hosted or proxied endpoints. */
  urlEnv?: string;
  /** Set when Mastra's router does not know the provider and we must supply a URL. */
  defaultUrl?: string;
  /**
   * A local Ollama needs no key at all, so the presence of a base URL is enough
   * to say the provider is configured.
   */
  urlImpliesConfigured?: boolean;
  /** OpenAI-compatible `/chat/completions`, so one REST client covers it. */
  openAiCompatible: boolean;
  suggested: string;
};

export const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  google: {
    keyEnv: ["GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"],
    openAiCompatible: false,
    suggested: "google/gemini-2.5-flash",
  },
  openai: {
    keyEnv: ["OPENAI_API_KEY"],
    openAiCompatible: true,
    suggested: "openai/gpt-4o-mini",
  },
  anthropic: {
    keyEnv: ["ANTHROPIC_API_KEY"],
    openAiCompatible: false,
    suggested: "anthropic/claude-sonnet-4-5",
  },
  ollama: {
    keyEnv: ["OLLAMA_API_KEY"],
    urlEnv: "OLLAMA_BASE_URL",
    // The OpenAI-compatible surface lives at /v1; /api is the native Ollama one.
    defaultUrl: "https://ollama.com/v1",
    urlImpliesConfigured: true,
    openAiCompatible: true,
    suggested: "ollama/gpt-oss:120b",
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export type ParsedModel = {
  provider: ProviderId;
  /** Kept whole: Ollama model ids carry a `:tag`, and OpenRouter-style ids carry slashes. */
  modelId: string;
};

/**
 * `provider/model`. An unprefixed value is assumed to be Google, which is what
 * the app shipped with before it spoke to anything else.
 */
export function parseModel(spec: string): ParsedModel {
  const slash = spec.indexOf("/");
  if (slash === -1) return { provider: "google", modelId: spec };

  const provider = spec.slice(0, slash);
  if (!(provider in PROVIDERS)) {
    throw new Error(
      `unknown model provider "${provider}" in "${spec}". Known providers: ${PROVIDER_IDS.join(", ")}.`,
    );
  }
  return { provider: provider as ProviderId, modelId: spec.slice(slash + 1) };
}

export function apiKeyFor(provider: ProviderId): string {
  for (const name of PROVIDERS[provider].keyEnv) {
    const value = process.env[name];
    if (value) return value;
  }
  return "";
}

export function baseUrlFor(provider: ProviderId): string {
  const config = PROVIDERS[provider];
  const override = config.urlEnv ? process.env[config.urlEnv] : undefined;
  return (override || config.defaultUrl || "").replace(/\/+$/, "");
}

/** Whether this provider has everything it needs to be called. */
export function isConfigured(provider: ProviderId): boolean {
  if (apiKeyFor(provider)) return true;
  const config = PROVIDERS[provider];
  return Boolean(config.urlImpliesConfigured && config.urlEnv && process.env[config.urlEnv]);
}

/**
 * Turns `provider/model` into whatever Mastra wants for that provider: a router
 * string for the providers it ships with, and an explicit OpenAI-compatible
 * config for the ones it does not.
 */
export function resolveModel(spec: string): MastraModelConfig {
  const { provider, modelId } = parseModel(spec);

  if (provider === "ollama") {
    return {
      providerId: "ollama",
      modelId,
      url: baseUrlFor("ollama"),
      // A local Ollama ignores the key but the OpenAI client insists on one.
      apiKey: apiKeyFor("ollama") || "ollama",
    };
  }

  return `${provider}/${modelId}` as MastraModelConfig;
}

/** One line for the boot log, so it is never a mystery which model answered. */
export function describeModel(spec: string): string {
  const { provider, modelId } = parseModel(spec);
  const url = baseUrlFor(provider);
  return `${provider}:${modelId}${url ? ` via ${url}` : ""}`;
}

const RULE = "─".repeat(78);

/**
 * The whole story, for someone who asked for live agents and has not given us a
 * way to reach one.
 *
 * Long on purpose. The alternative failure is the one this project is most at
 * risk of: `SQ_OFFLINE=0` forces live calls, every call 401s, each one is caught
 * and answered by the scripted offline agent, and the result is a negotiation
 * that completes normally and picks a sensible winner while being entirely fake.
 * Nothing on screen distinguishes it from the real thing. A message nobody can
 * misread costs less than a demo nobody can trust.
 */
export function credentialsReport(specs: string[]): string {
  const lines: string[] = [RULE, "", "  SQ_OFFLINE=0 asks for live model calls, but no provider is configured.", ""];

  for (const spec of new Set(specs)) {
    let provider: ProviderId;
    let modelId: string;
    try {
      ({ provider, modelId } = parseModel(spec));
    } catch (error) {
      lines.push(`  Model requested   ${spec}`, `  Problem           ${(error as Error).message}`, "");
      continue;
    }
    if (isConfigured(provider)) continue;

    const config = PROVIDERS[provider];
    const checked = [...config.keyEnv, ...(config.urlEnv ? [config.urlEnv] : [])];
    lines.push(`  Model requested   ${spec}`, `  Provider          ${provider} (${modelId})`);
    checked.forEach((name, i) => {
      lines.push(`  ${i === 0 ? "Looked for       " : "                 "} ${name}${" ".repeat(Math.max(1, 32 - name.length))}not set`);
    });
    lines.push("");
  }

  lines.push(
    "  Pick one:",
    "",
    "  1. Run without AI. This is the default and needs no account:",
    "",
    "       unset SQ_OFFLINE          # or SQ_OFFLINE=1",
    "",
    "     The agents become deterministic stubs that still concede, hold their",
    "     floors and argue in English. Everything else — parsing, SKU matching,",
    "     scoring, the mid-negotiation curveball, purchase orders and their",
    "     downstream effects — is the real code path either way.",
    "",
    "  2. Use a hosted provider. Put a key in .env and name a matching model:",
    "",
  );

  for (const id of PROVIDER_IDS) {
    const key = PROVIDERS[id].keyEnv[0]!;
    lines.push(`       ${key}=...`.padEnd(45) + `NEGOTIATION_MODEL=${PROVIDERS[id].suggested}`);
  }

  lines.push(
    "",
    "  3. Use a local Ollama, which needs no key at all:",
    "",
    "       ollama serve && ollama pull qwen3.5:9b",
    "       OLLAMA_BASE_URL=http://localhost:11434/v1",
    "       NEGOTIATION_MODEL=ollama/qwen3.5:9b",
    "",
    '  README.md, "Running the agents on a real model", has the detail.',
    "",
    RULE,
  );

  return lines.join("\n");
}

/**
 * Why the agents are stubbed, said once at boot.
 *
 * Offline is a legitimate way to run this — it is the default, and it is what
 * makes the repo clonable without an account — so this is information rather
 * than a warning. It still has to be unmissable, because "the suppliers all
 * sound the same" is a confusing thing to discover an hour later.
 */
export function offlineNotice(reason: "explicit" | "no-credentials"): string {
  const why =
    reason === "explicit"
      ? "SQ_OFFLINE=1 is set."
      : "No provider credentials were found, so this is the default.";

  return [
    "agents: running offline — deterministic stubs, no model calls.",
    `        ${why}`,
    "        Parsing, matching, scoring, the curveball and purchase orders are unaffected.",
    "        To negotiate with a real model, set a provider key and SQ_OFFLINE=0 (see README).",
  ].join("\n");
}
