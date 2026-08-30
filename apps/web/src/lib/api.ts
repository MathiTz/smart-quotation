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
    // Coerced rather than trusted. Every route is meant to answer with a string
    // `error`, but this is the one place that assumption would fail silently:
    // an object here renders as "[object Object]" and tells the user nothing.
    const message = typeof body?.error === "string" ? body.error : `request failed (${res.status})`;
    const detail = typeof body?.detail === "string" ? body.detail : undefined;
    throw new ApiError(message, res.status, detail);
  }

  // A 2xx that is not JSON means something between us and the API answered
  // instead of the API — a dev-server proxy returning HTML is the usual one.
  // Without this the caller gets a raw SyntaxError about an unexpected token,
  // which sends you looking in entirely the wrong place.
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError("the server sent a response that could not be read", res.status);
  }
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

  retry: (id: string) => request<Negotiation>(`/negotiations/${id}/retry`, { method: "POST" }),

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
 *
 * Returns a function that closes the stream. Call it on unmount: an EventSource
 * left open reconnects on its own forever.
 */
export function streamNegotiation(
  id: string,
  after: number,
  handlers: {
    onMessage: (entry: TranscriptEntry) => void;
    onStatus: (status: NegotiationStatus) => void;
    onDone: (payload: { status: NegotiationStatus; award: Award | null }) => void;
    /**
     * The connection dropped. EventSource retries on its own, so this is not
     * necessarily fatal — but the caller needs to know, because the alternative
     * is a transcript that stops updating while the page still says "negotiating".
     */
    onError?: (info: { willRetry: boolean }) => void;
  },
): () => void {
  const source = new EventSource(`/api/negotiations/${id}/stream?after=${after}`);
  let closed = false;

  /**
   * A throw inside a listener kills that listener's turn, and since every event
   * arrives on the same source, one malformed frame would otherwise stop the
   * transcript dead with nothing on screen to say why. Parsing is therefore
   * guarded per event, and a bad frame is skipped rather than fatal.
   */
  function on<T>(event: string, handle: (data: T) => void) {
    source.addEventListener(event, (e) => {
      let parsed: T;
      try {
        parsed = JSON.parse((e as MessageEvent).data);
      } catch {
        console.warn(`discarded an unreadable "${event}" frame from the negotiation stream`);
        return;
      }
      handle(parsed);
    });
  }

  on<TranscriptEntry>("message", (entry) => handlers.onMessage(entry));
  on<{ status: NegotiationStatus }>("status", (data) => handlers.onStatus(data.status));
  on<{ status: NegotiationStatus; award: Award | null }>("done", (payload) => {
    handlers.onDone(payload);
    closed = true;
    source.close();
  });

  source.addEventListener("error", () => {
    if (closed) return;
    // EventSource reports both a transient drop and a dead server the same way.
    // `readyState` is the only thing that separates them: CLOSED means it has
    // given up, CONNECTING means it is already trying again.
    handlers.onError?.({ willRetry: source.readyState !== EventSource.CLOSED });
  });

  return () => {
    closed = true;
    source.close();
  };
}
