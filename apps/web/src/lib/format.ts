export const money = (n: number, decimals = 0) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;

/** Unit prices are cents-scale; whole dollars would round the difference away. */
export const unitMoney = (n: number) => `$${n.toFixed(4).replace(/0+$/, "").replace(/\.$/, ".00")}`;

export const qty = (n: number) => n.toLocaleString("en-US");

export const pct = (n: number) => `${Math.round(n * 100)}%`;

export const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

export const dateTime = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export const dateOnly = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/** 33/33/33 reads better as prose the first time someone sees it. */
export function explainTerms(terms: string): string {
  const parts = terms.split("/").map(Number).filter((n) => !Number.isNaN(n));
  if (parts.length === 1) return `${parts[0]}% upfront`;
  if (parts.length === 2) return `${parts[0]}% upfront, ${parts[1]}% on delivery`;
  return `${parts[0]}% upfront, ${parts[1]}% mid-production, ${parts[2]}% on delivery`;
}
