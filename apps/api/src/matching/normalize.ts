/**
 * Case, spacing and punctuation carry no meaning in a SKU. "ob007 bas l",
 * "OB007-BAS-L" and "OB007_BAS_L" are the same product typed by three people.
 */
export function normalizeSku(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .toUpperCase();
}

/**
 * Characters that look alike on a packing list, collapsed onto one representative
 * so O/0, I/1/L and S/5 stop being different SKUs. This is lossy on purpose: it
 * is a lookup key for finding candidates, never a value we store or display.
 */
const HOMOGLYPHS: Record<string, string> = {
  O: "0",
  Q: "0",
  D: "0",
  I: "1",
  L: "1",
  S: "5",
  B: "8",
  Z: "2",
  G: "6",
};

export function foldHomoglyphs(normalized: string): string {
  let out = "";
  for (const ch of normalized) out += HOMOGLYPHS[ch] ?? ch;
  return out;
}

export function skeleton(raw: string): string {
  return foldHomoglyphs(normalizeSku(raw));
}

/** Leading letters: "OB007-BAS-L" buckets under "OB". Keeps fuzzy search small. */
export function skuPrefix(raw: string): string {
  const normalized = normalizeSku(raw);
  const match = /^[A-Z]+/.exec(normalized);
  return match ? match[0] : normalized.slice(0, 2);
}

/**
 * Splits a SKU into its structural segments: letters, digits, then whatever
 * trails. "EKA03-XYZ" gives prefix EKA, digits 03. That lets `EKA03` be repaired
 * to `EKA003` by zero-padding, which is a dropped keystroke rather than a typo.
 */
export function skuParts(raw: string): { prefix: string; digits: string; rest: string } | null {
  const normalized = normalizeSku(raw);
  const match = /^([A-Z]+)(\d+)(.*)$/.exec(normalized);
  if (!match) return null;
  return { prefix: match[1]!, digits: match[2]!, rest: match[3]! };
}

/** Standard Levenshtein, bailing out as soon as the row minimum exceeds `max`. */
export function editDistance(a: string, b: string, max = Number.POSITIVE_INFINITY): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
      if (curr[j]! < rowMin) rowMin = curr[j]!;
    }
    if (rowMin > max) return max + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}
