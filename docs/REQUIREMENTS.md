# Requirements audit

Every requirement in the brief, traced to the code that satisfies it. `covered` means there is a
concrete mechanism and it is exercised; `partial` means it is addressed with a stated limitation;
`open` means unresolved.

Audited against the built system, not the plan.

---

## Flow

| # | Requirement | Status | Where |
|---|---|---|---|
| 1 | Brand user uploads a supplier quotation XLSX | covered | `POST /api/quotations` → `http/quotations.ts`, `routes/Upload.tsx` |
| 2 | System parses it and matches items against `products.csv` | covered | `parser/`, `matching/`, joined in `quotations/ingest.ts` |
| 3 | Brand agent uses the parsed quote as a baseline and initiates negotiation | covered | `negotiation/setup.ts` builds the basket from parsed prices; `workflows/runner.ts` starts the run; the baseline total is quoted in the opening message |
| 4 | Negotiation between the brand agent and each supplier agent | covered | `negotiation/engine.ts` `runRound`, three supplier agents in `agents/mastra.ts` |
| 5 | Brand agent selects the best supplier and explains the reasoning | covered | `scoreOptions` ranks, `award.ts` builds the reasoning tree, `brandVerdict` narrates it. Rendered by `components/Reasoning.tsx` |
| 6 | Brand user converts the winning negotiation into a PO | covered | `POST /api/negotiations/:id/convert` → `purchase-orders/commit.ts` |
| 7 | PO appears in a list of all POs the brand has issued | covered | `GET /api/purchase-orders`, `routes/PurchaseOrders.tsx`, with a back-link to the negotiation |

## Quotation spreadsheet

| Requirement | Status | Notes |
|---|---|---|
| XLSX input | covered | `parser/read-workbook.ts` via exceljs |
| Messy layout: merged cells, inconsistent headers, mixed formatting | covered | Merged ranges expanded through the merge master; header row located rather than assumed; Excel float noise normalised. All four fixtures parse |
| Robust, not hardcoded to the provided files | covered | No filename, sheet name or header string is special-cased. Column roles come from three independent signals — header text, value shape, and an arithmetic cross-check that identifies a line-total column even when its header is wrong or missing |
| Will be tested with a spreadsheet not provided | covered | The optional LLM classifier is a second opinion only; all four fixtures parse correctly with it disabled, which is how the tests run |

## Product catalog

| Requirement | Status | Notes |
|---|---|---|
| `products.csv` is the source of truth | covered | Seeded by `db/seed.ts`; matching is against the catalog index, never against free text |
| Parsed items matched against it | covered | `matching/catalog.ts`, four tiers |
| Some SKUs contain typos | covered | Handled classes, each with a test in `matcher.test.ts`: zero-for-O, O-for-zero, lowercase-l-for-I, dropped and added leading zeros, and single-character slips within the same SKU prefix. Ambiguous matches keep every candidate and surface them in the review table |

## Suppliers

| Requirement | Status | Notes |
|---|---|---|
| Supplier 1: from the uploaded XLSX, quality 4.0, cheapest, 50 days, 33/33/33 | partial | Prices come from the file. Lead time and payment terms come from the file when stated, falling back to the profile. The brief's figures conflict with `quotation_2` (90 days, 30/70) — the file wins, and the conflict is surfaced in the transcript as leverage. See `OPEN-QUESTIONS.md` Q1 |
| Supplier 2: simulated, quality 4.7, most expensive, 25 days, 40/60 | covered | Opening multiplier is applied to the parsed baseline, so "most expensive" holds for any uploaded file rather than for these fixtures |
| Supplier 3: simulated, quality 4.0, mid-range, 15 days, 100% upfront | covered | Same mechanism |

## AI agents

| Requirement | Status | Notes |
|---|---|---|
| Brand agent uses the extracted data as leverage | covered | The baseline total, the incumbent's terms and the lines the incumbent would not price are all named explicitly in the opening message |
| Brand agent is aware of each supplier's quality ratings | covered | In the brief passed to the agent and a weighted dimension in `scoreOptions` |
| Each supplier has its own agent | covered | Three agents with distinct instructions and distinct bounds |
| Suppliers find ways to win rather than accept or reject | covered | Five concession levers — price, lead time, payment terms, volume rebate, freight allowance — each already a scoring dimension, so a concession genuinely moves the ranking. Bounds enforced by `clampOffer`, never by prompt |
| Made-up materials and data are acceptable | covered | MOQ values and concession bounds are invented, derived deterministically from the supplier profile so runs reproduce |
| Agents communicate in English in natural language | covered | `negotiation_rounds.message` is non-nullable and carries prose in every row, including offline |

## Mid-negotiation change

| Requirement | Status | Notes |
|---|---|---|
| After round one, supplier 2 can only fulfil 60% | covered | Offered in the UI when the workflow suspends; written as a capacity ratio in `negotiations.capacity` |
| Incorporate without restarting from scratch | covered | Mastra `suspend()` then `resume()` on the same run. The integration test asserts that every transcript row written before the curveball is unchanged afterwards, with new rows appended. Snapshots live in Postgres, so this survives a process restart |
| The system adjusts its strategy | covered | The cap reduces that supplier's coverage; the allocator tries to place the remainder elsewhere with MOQ repair, and the scorer penalises whatever stays uncovered. No code path is specific to the curveball |

## Purchase orders

| Requirement | Status | Notes |
|---|---|---|
| Convert a recommended winner into a PO | covered | Primary action issues immediately. Any other scored plan can be chosen instead, including a ruled-out one; the PO records both which plan was bought and which was recommended |
| PO captures supplier, line items, quantities, unit prices, total, lead time, payment terms | covered | `purchase_orders` + `purchase_order_lines`, with everything also frozen into `terms_snapshot` |
| List of all POs with status and the negotiation they came from | covered | `routes/PurchaseOrders.tsx`, newest first, each with its status badge and a link back to the originating negotiation. Two statuses are reachable — `draft` and `sent` — because issuing the order is where this system's authority ends; the rest of the `po_status` enum is the lifecycle it would hand off to, not behaviour that is implemented |
| Converting is a real commit action with downstream effects | covered | One transaction writes the PO, the lines and the outbox rows. Five effects — reserve capacity, schedule payment tranches, notify approvers, notify supplier, sync accounting — delivered with retries, backoff and duplicate protection. Each is shown in the UI with its status. Idempotent on a key covering the negotiation, the allocation and a hash of the terms |

## Deliverables

| Requirement | Status | Notes |
|---|---|---|
| Source code plus instructions to run | covered | `README.md`. `pnpm setup && pnpm dev` from a clean clone, no API key needed |
| GitHub repo | open | Not yet pushed |
| UI to upload a quotation XLSX | covered | `routes/Upload.tsx` |
| Open text note guiding the negotiating agent | covered | Captured at upload, editable on the review screen, parsed into weights and hard constraints by `negotiation/constraints.ts`, and shown as badges so the effect is visible |
| UI showing the process, outcome and reasoning | covered | Live SSE transcript, explainability tree, per-dimension score bars, cost-basis toggle, and every rejected plan with its reason |
| UI to convert the winner and list all POs | covered | |
| ~10 minute video | open | Script in `PRESENTATION.md`; recording pending |
| 1 hour interview | n/a | `DECISIONS.md` and `ARCHITECTURE.md` are the prep |

---

## Test coverage

92 tests, plus two Playwright journeys.

| Area | File | What it pins down |
|---|---|---|
| Parser | `parser/parser.test.ts` (17) | Float cleanup, SKU recognition, header interpretation, metadata extraction, and end-to-end parsing of all four fixtures |
| Matcher | `matching/matcher.test.ts` (22) | Every typo class, tier ordering, ambiguity, and refusal to match across SKU prefixes |
| Negotiation | `negotiation/negotiation.test.ts` (29) | Pricing derivation, payment cash-flow cost, note parsing, coverage, MOQ repair, over-allocation invariants, and scoring behaviour including coverage penalties |
| Integration | `integration.test.ts` (7) | The workflow suspends after round one; the curveball resumes without replaying; capacity caps the award; commits are idempotent; terms are frozen and self-consistent; effects are delivered exactly once; drafts withhold supplier-facing effects until confirmed |
| End to end | `e2e/happy-path.spec.ts` (2) | Upload through to a purchase order in a browser, and a readable error for a file that is not a workbook |

---

## Deliberate limitations

Stated plainly rather than left to be discovered. Expanded in the README.

1. **Landed cost is estimated per country**, not computed from a bill of materials and an HTS code.
   `products.csv` carries only brand, SKU, name and colour. The scoring function takes landed cost as
   an input, so a real calculator drops in.
2. **Allocation is a heuristic**, greedy with a repair pass capped at two iterations. It can miss a
   split a min-cost-flow solver would find. Bounded, asserted, and infeasibility is surfaced rather
   than thrown.
3. **MOQ values are invented.** Not in the source data; derived deterministically so runs reproduce.
4. **No authentication or approval chain.** Single implied brand user.
5. **The outbox worker is an interval loop**, not a broker. The transactional enqueue, locking,
   retries and dead-lettering are real; the five handlers log because there is nothing to call.
6. **Supplier quality ratings are static**, as given in the brief. In practice they would come from
   receiving inspection history.
