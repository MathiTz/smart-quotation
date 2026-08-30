import type { MatchCandidate, MatchMethod } from "@sq/shared";
import { editDistance, normalizeSku, skeleton, skuParts, skuPrefix } from "./normalize.js";

export type CatalogRow = { sku: string; brand: string; name: string; color: string };

type Entry = CatalogRow & { normalized: string; folded: string; numericKey: string | null };

export type MatchOutcome = {
  sku: string | null;
  name: string | null;
  brand: string | null;
  confidence: number;
  method: MatchMethod;
  candidates: MatchCandidate[];
};

const UNMATCHED: MatchOutcome = {
  sku: null,
  name: null,
  brand: null,
  confidence: 0,
  method: "unmatched",
  candidates: [],
};

/**
 * Confidence is a fixed value per tier rather than a learned score. It reflects
 * how much evidence the tier required, and it is what the review table's dots
 * are showing the user, so it needs to mean something stable.
 */
const TIER_CONFIDENCE = {
  exact: 1,
  normalized: 0.97,
  skeleton: 0.9,
  padded: 0.88,
} as const;

/**
 * Collapses a dropped or added leading zero: "EKA03-GLW-M" and "EKA003-GLW-M"
 * produce the same key. A dropped keystroke is a different failure from a
 * misread character, so it gets its own tier rather than being left to fuzzy
 * matching, which would rank it against unrelated neighbours.
 */
function numericKey(normalized: string): string | null {
  const parts = skuParts(normalized);
  if (!parts) return null;
  return `${parts.prefix}|${Number(parts.digits)}|${parts.rest}`;
}

export class CatalogIndex {
  private readonly byNormalized = new Map<string, Entry[]>();
  private readonly byFolded = new Map<string, Entry[]>();
  private readonly byNumericKey = new Map<string, Entry[]>();
  private readonly byPrefix = new Map<string, Entry[]>();
  private readonly bySku = new Map<string, Entry>();

  constructor(rows: readonly CatalogRow[]) {
    for (const row of rows) {
      const normalized = normalizeSku(row.sku);
      const entry: Entry = {
        ...row,
        normalized,
        folded: skeleton(row.sku),
        numericKey: numericKey(normalized),
      };
      this.bySku.set(row.sku, entry);
      push(this.byNormalized, normalized, entry);
      push(this.byFolded, entry.folded, entry);
      if (entry.numericKey) push(this.byNumericKey, entry.numericKey, entry);
      push(this.byPrefix, skuPrefix(row.sku), entry);
    }
  }

  get size(): number {
    return this.bySku.size;
  }

  /**
   * Walks four progressively weaker forms of evidence and stops at the first
   * one that hits. When a tier produces more than one product it returns
   * `ambiguous` with the alternatives instead of picking: buying the wrong
   * variant is a worse outcome than asking a human which one they meant.
   */
  // #region tiers
  match(rawSku: string): MatchOutcome {
    const raw = rawSku.trim();
    if (!raw) return UNMATCHED;

    const exact = this.bySku.get(raw);
    if (exact) return outcome(exact, TIER_CONFIDENCE.exact, "exact", []);

    const normalized = normalizeSku(raw);
    const key = numericKey(normalized);

    // Both the punctuation tier and the homoglyph tier report as "normalized":
    // to someone reading the review table they are the same statement, namely
    // "we recognised this despite how it was typed".
    const tiers: Array<{ hits: Entry[] | undefined; method: MatchMethod; confidence: number }> = [
      { hits: this.byNormalized.get(normalized), method: "normalized", confidence: TIER_CONFIDENCE.normalized },
      { hits: this.byFolded.get(skeleton(raw)), method: "normalized", confidence: TIER_CONFIDENCE.skeleton },
      ...(key ? [{ hits: this.byNumericKey.get(key), method: "padded" as MatchMethod, confidence: TIER_CONFIDENCE.padded }] : []),
    ];

    for (const tier of tiers) {
      const hits = dedupe(tier.hits);
      if (!hits || hits.length === 0) continue;
      if (hits.length === 1) return outcome(hits[0]!, tier.confidence, tier.method, []);
      return ambiguous(hits, tier.confidence);
    }

    return this.fuzzy(raw, normalized);
  }
  // #endregion tiers

  private fuzzy(raw: string, normalized: string): MatchOutcome {
    const bucket = this.byPrefix.get(skuPrefix(raw)) ?? [];
    if (bucket.length === 0) return UNMATCHED;

    const folded = skeleton(raw);
    // Two edits on a short code is already most of the string. Beyond that the
    // "nearest" catalog entry is not a correction, it is a coincidence.
    const budget = normalized.length <= 8 ? 1 : 2;

    let best: Array<{ entry: Entry; distance: number }> = [];
    let bestDistance = budget + 1;

    for (const entry of bucket) {
      const distance = editDistance(folded, entry.folded, budget);
      if (distance > budget) continue;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = [{ entry, distance }];
      } else if (distance === bestDistance) {
        best.push({ entry, distance });
      }
    }

    if (best.length === 0) return UNMATCHED;

    const longest = Math.max(folded.length, best[0]!.entry.folded.length);
    const confidence = Math.min(0.82, Math.max(0.5, 1 - bestDistance / longest));

    const entries = dedupe(best.map((b) => b.entry))!;
    if (entries.length === 1) return outcome(entries[0]!, confidence, "fuzzy", []);
    return ambiguous(entries, confidence);
  }

  lookup(sku: string): CatalogRow | undefined {
    return this.bySku.get(sku);
  }
}

function push(map: Map<string, Entry[]>, key: string, entry: Entry): void {
  const existing = map.get(key);
  if (existing) existing.push(entry);
  else map.set(key, [entry]);
}

function dedupe(entries: Entry[] | undefined): Entry[] | undefined {
  if (!entries) return undefined;
  const seen = new Set<string>();
  return entries.filter((e) => (seen.has(e.sku) ? false : (seen.add(e.sku), true)));
}

function toCandidate(entry: Entry, confidence: number): MatchCandidate {
  return { sku: entry.sku, brand: entry.brand, name: entry.name, color: entry.color, confidence };
}

function outcome(
  entry: Entry,
  confidence: number,
  method: MatchMethod,
  candidates: MatchCandidate[],
): MatchOutcome {
  return {
    sku: entry.sku,
    name: entry.name,
    brand: entry.brand,
    confidence,
    method,
    candidates,
  };
}

function ambiguous(entries: Entry[], confidence: number): MatchOutcome {
  return {
    sku: null,
    name: null,
    brand: null,
    confidence,
    method: "ambiguous",
    // Capped so the review UI stays a decision, not a search results page.
    candidates: entries.slice(0, 5).map((e) => toCandidate(e, confidence)),
  };
}
