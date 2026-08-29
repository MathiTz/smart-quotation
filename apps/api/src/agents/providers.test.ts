import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apiKeyFor, baseUrlFor, isConfigured, parseModel, resolveModel } from "./providers.js";

const PROVIDER_VARS = [
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OLLAMA_API_KEY",
  "OLLAMA_BASE_URL",
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(PROVIDER_VARS.map((k) => [k, process.env[k]]));
  for (const k of PROVIDER_VARS) delete process.env[k];
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("reading a provider/model string", () => {
  it("splits the provider from the model", () => {
    expect(parseModel("openai/gpt-4o-mini")).toEqual({ provider: "openai", modelId: "gpt-4o-mini" });
  });

  it("keeps the tag on an Ollama model id", () => {
    expect(parseModel("ollama/gpt-oss:120b")).toEqual({ provider: "ollama", modelId: "gpt-oss:120b" });
  });

  it("keeps later slashes in the model id rather than treating them as providers", () => {
    expect(parseModel("openai/org/custom-model")).toEqual({
      provider: "openai",
      modelId: "org/custom-model",
    });
  });

  it("assumes Google when no provider is given, which is what the app shipped with", () => {
    expect(parseModel("gemini-2.5-flash")).toEqual({ provider: "google", modelId: "gemini-2.5-flash" });
  });

  it("refuses an unknown provider instead of guessing", () => {
    expect(() => parseModel("acme/model-x")).toThrow(/unknown model provider "acme"/);
  });
});

describe("finding credentials", () => {
  it("accepts either name Google is known by", () => {
    process.env.GOOGLE_API_KEY = "from-google-api-key";
    expect(apiKeyFor("google")).toBe("from-google-api-key");
  });

  it("prefers the more specific Google variable when both are set", () => {
    process.env.GOOGLE_API_KEY = "generic";
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "specific";
    expect(apiKeyFor("google")).toBe("specific");
  });

  it("reports a provider with no key as unconfigured", () => {
    expect(isConfigured("anthropic")).toBe(false);
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(isConfigured("anthropic")).toBe(true);
  });

  it("treats a local Ollama as configured on its base URL alone, since it needs no key", () => {
    expect(isConfigured("ollama")).toBe(false);
    process.env.OLLAMA_BASE_URL = "http://localhost:11434/v1";
    expect(isConfigured("ollama")).toBe(true);
  });
});

describe("handing a model to Mastra", () => {
  it("passes the providers Mastra already knows through as router strings", () => {
    expect(resolveModel("anthropic/claude-sonnet-4-5")).toBe("anthropic/claude-sonnet-4-5");
    expect(resolveModel("openai/gpt-4o-mini")).toBe("openai/gpt-4o-mini");
  });

  it("builds an OpenAI-compatible config for Ollama, which Mastra does not know", () => {
    process.env.OLLAMA_API_KEY = "ollama-key";
    expect(resolveModel("ollama/gpt-oss:120b")).toEqual({
      providerId: "ollama",
      modelId: "gpt-oss:120b",
      url: "https://ollama.com/v1",
      apiKey: "ollama-key",
    });
  });

  it("points at a local Ollama when given one, with a placeholder key it will ignore", () => {
    process.env.OLLAMA_BASE_URL = "http://localhost:11434/v1/";
    expect(resolveModel("ollama/qwen3")).toEqual({
      providerId: "ollama",
      modelId: "qwen3",
      // Trailing slash stripped so the client does not build a double-slashed path.
      url: "http://localhost:11434/v1",
      apiKey: "ollama",
    });
  });

  it("defaults Ollama to the hosted OpenAI-compatible endpoint, not the native /api one", () => {
    expect(baseUrlFor("ollama")).toBe("https://ollama.com/v1");
  });
});
