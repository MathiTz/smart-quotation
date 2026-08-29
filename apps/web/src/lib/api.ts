import type {
  Award,
  MatchCandidate,
  MatchMethod,
  NegotiationConstraints,
  NegotiationStatus,
  PurchaseOrder,
  SupplierOffer,
  SupplierProfile,
} from "@sq/shared";

/**
 * Types the server actually returns. Hand-written rather than generated from the
 * OpenAPI document: the surface is small enough that a generator would be more
 * machinery than the problem deserves.
 */
export type QuotationLine = {
  rawSku: string;
  rawDescription: string | null;
  quantity: number;
  tierQuantity: number;
  unitPrice: number;
  listUnitPrice: number;
  discountPct: number;
  lineTotal: number;
  sheetName: string;
  rowNumber: number;
  totalMismatch: boolean;
  matchedSku: string | null;
  matchedName: string | null;
  matchedBrand: string | null;
  matchConfidence: number;
  matchMethod: MatchMethod;
  candidates: MatchCandidate[];
};

export type Quotation = {
  id: string;
  filename: string;
  supplierCode: string;
  createdAt: string;
  metadata: {
    supplierName: string | null;
    currency: string;
    quotationDate: string | null;
    paymentTerms: string | null;
    leadTimeDays: number | null;
  };
  layout: { source: string; overrides: string[] };
  tiers: number[];
  suggestedTier: number;
  warnings: string[];
  brandNote: string | null;
  constraints: NegotiationConstraints;
  constraintSummary: string[];
  lines: QuotationLine[];
  matchSummary: {
    total: number;
    matched: number;
    needsReview: number;
    unmatched: number;
    byMethod: Record<string, number>;
  };
  negotiationId: string | null;
};

export type TranscriptEntry = {
  sequence: number;
  round: number;
  actor: "brand" | "supplier" | "system";
  supplierCode: string | null;
  supplierName: string | null;
  message: string;
  offer: SupplierOffer | null;
  createdAt: string;
};

export type Negotiation = {
  id: string;
  quotationId: string;
  status: NegotiationStatus;
  tierQuantity: number;
  constraints: NegotiationConstraints;
  constraintSummary: string[];
  capacity: Record<string, number>;
  curveballApplied: boolean;
  award: Award | null;
  /** What each ranked plan would actually buy. Empty until there is an award. */
  plans: Plan[];
  error: string | null;
  createdAt: string;
  transcript: TranscriptEntry[];
  purchaseOrderIds: string[];
};

export type Plan = {
  optionId: string;
  label: string;
  allocations: Award["plan"]["allocations"];
};

export type NegotiationSummary = {
  id: string;
  status: NegotiationStatus;
  tierQuantity: number;
  filename: string;
  createdAt: string;
  winner: string | null;
  total: number | null;
  purchaseOrderCount: number;
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers:
      init?.body instanceof FormData
        ? init?.headers
        : { "content-type": "application/json", ...init?.headers },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(body.error ?? "request failed", res.status, body.detail);
  }
  return res.json() as Promise<T>;
}

export const api = {
  suppliers: () => request<SupplierProfile[]>("/suppliers"),

  uploadQuotation: (file: File, note: string) => {
    const form = new FormData();
    form.append("file", file);
    form.append("note", note);
    return request<Quotation>("/quotations", { method: "POST", body: form });
  },

  quotation: (id: string) => request<Quotation>(`/quotations/${id}`),

  startNegotiation: (input: { quotationId: string; tierQuantity?: number; note?: string }) =>
    request<Negotiation>("/negotiations", { method: "POST", body: JSON.stringify(input) }),

  negotiations: () => request<NegotiationSummary[]>("/negotiations"),

  negotiation: (id: string) => request<Negotiation>(`/negotiations/${id}`),

  curveball: (id: string, input: { supplierCode?: string; fulfillmentRatio?: number; skip?: boolean }) =>
    request<Negotiation>(`/negotiations/${id}/curveball`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  convert: (id: string, input: { idempotencyKey: string; saveAsDraft: boolean; optionId?: string }) =>
    request<PurchaseOrder[]>(`/negotiations/${id}/convert`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  purchaseOrders: () => request<PurchaseOrder[]>("/purchase-orders"),

  confirmPurchaseOrder: (id: string) =>
    request<PurchaseOrder>(`/purchase-orders/${id}/confirm`, { method: "POST" }),
};

/**
 * Subscribes to the live transcript. `after` lets a reconnect pick up where it
 * left off instead of replaying the whole negotiation.
 */
export function streamNegotiation(
  id: string,
  after: number,
  handlers: {
    onMessage: (entry: TranscriptEntry) => void;
    onStatus: (status: NegotiationStatus) => void;
    onDone: (payload: { status: NegotiationStatus; award: Award | null }) => void;
  },
): () => void {
  const source = new EventSource(`/api/negotiations/${id}/stream?after=${after}`);

  source.addEventListener("message", (e) => handlers.onMessage(JSON.parse((e as MessageEvent).data)));
  source.addEventListener("status", (e) =>
    handlers.onStatus(JSON.parse((e as MessageEvent).data).status),
  );
  source.addEventListener("done", (e) => {
    handlers.onDone(JSON.parse((e as MessageEvent).data));
    source.close();
  });

  return () => source.close();
}
