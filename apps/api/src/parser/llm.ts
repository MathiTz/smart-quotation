import { columnRoleSchema, type ColumnRole } from "@sq/shared";
import { z } from "zod";
import { env, isOffline } from "../env.js";
import { cellAt, type SheetGrid } from "./read-workbook.js";
import type { ColumnStats, DataRegion } from "./heuristics.js";

const responseSchema = z.object({
  columns: z.array(z.object({ index: z.number().int(), role: columnRoleSchema })),
});

export type LlmClassification = { roles: Map<number, ColumnRole>; used: boolean; error?: string };

const NONE: LlmClassification = { roles: new Map(), used: false };

const TIMEOUT_MS = 15_000;

function sheetPreview(grid: SheetGrid, region: DataRegion, stats: ColumnStats[]): string {
  const lines: string[] = [];
  lines.push(`Sheet: ${grid.name}`);
  lines.push(
    `Columns (0-based): ${stats.map((s) => `${s.index}=${JSON.stringify(s.header || "(blank)")}`).join(", ")}`,
  );
  const last = Math.min(region.lastDataRow, region.firstDataRow + 7);
  for (let r = region.firstDataRow; r <= last; r++) {
    const cells = stats.map((s) => cellAt(grid, r, s.index).text || "-");
    lines.push(`row ${r}: ${cells.join(" | ")}`);
  }
  return lines.join("\n");
}

/**
 * A second opinion on what each column holds, used only for columns the
 * data-shape heuristics could not settle on their own. Every failure path — no
 * key, timeout, malformed JSON, a hallucinated column index — returns "no
 * opinion", because a parser that stops working when an API does is not robust.
 */
export async function classifyColumnsWithLlm(
  grid: SheetGrid,
  region: DataRegion,
  stats: ColumnStats[],
): Promise<LlmClassification> {
  if (isOffline()) return NONE;

  const prompt = [
    "You are reading one sheet of a supplier price quotation spreadsheet.",
    "Assign a role to every column. Valid roles:",
    "sku, description, quantity, unit_price, line_total, discount_pct, row_number, ignore.",
    "",
    "Headers are often wrong, translated, or missing. Judge by the values.",
    "A quantity column holds whole units. A unit_price column holds per-item money.",
    "A line_total column is approximately quantity x unit_price.",
    "",
    sheetPreview(grid, region, stats),
    "",
    "Reply with JSON only: {\"columns\":[{\"index\":0,\"role\":\"sku\"}, ...]}",
  ].join("\n");

  try {
    const object = await withTimeout(classify(prompt), TIMEOUT_MS);
    const parsed = responseSchema.safeParse(object);
    if (!parsed.success) return { ...NONE, error: "schema mismatch" };

    const roles = new Map<number, ColumnRole>();
    const valid = new Set(stats.map((s) => s.index));
    for (const c of parsed.data.columns) {
      // A hallucinated column index is dropped rather than trusted.
      if (valid.has(c.index)) roles.set(c.index, c.role);
    }
    return { roles, used: roles.size > 0 };
  } catch (error) {
    return { ...NONE, error: error instanceof Error ? error.message : "unknown" };
  }
}

/**
 * Built on first use rather than at import, so a misconfigured provider surfaces
 * as "no opinion from the model" on one parse instead of crashing the module for
 * every caller, including the offline ones that never wanted a model.
 */
let agent: import("@mastra/core/agent").Agent | null = null;

async function classify(prompt: string): Promise<unknown> {
  if (!agent) {
    const { Agent } = await import("@mastra/core/agent");
    const { resolveModel } = await import("../agents/providers.js");
    agent = new Agent({
      id: "layout-classifier",
      name: "Spreadsheet layout classifier",
      instructions:
        "You label the columns of supplier price quotations. You answer only with the requested JSON.",
      model: resolveModel(env.parserModel),
    });
  }

  const result = await agent.generate(prompt, {
    structuredOutput: { schema: responseSchema },
    modelSettings: { temperature: 0 },
  });
  return result.object;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
