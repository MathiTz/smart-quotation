# Open questions and ramifications

Two lists. The first is what I would ask before this went near a real buyer. The second is what I
identified as able to break the flow, and what was done about it.

None of the questions blocked the build, because each is a *value* I am unsure of rather than a
*structure* I am unsure of. Each became a default that is cheap to change.

---

## Questions

**1. The brief and the fixtures disagree about supplier 1.**

The brief says supplier 1 offers 50-day lead time on 33/33/33. `quotation_2.xlsx` says 90 days on
30/70.

*What I did:* the uploaded file wins, because it is the actual offer in hand, and the conflict is
surfaced in the transcript as a system note — the supplier has already moved off their standard terms
once, which is leverage. *What I would ask:* is the profile the standard rate card and the file a
specific deal, or is one of them stale?

**2. Two SKUs in `quotation_2` are not priced at the 5,000 tier.**

Deliberate (the supplier will not do those at volume) or an omission?

*What I did:* extrapolate a baseline from the incumbent's own elasticity, mark the line, and have the
brand agent name it as open business. *What I would ask:* if it is deliberate, the right behaviour is
to exclude supplier 1 from those lines entirely rather than estimate a price for them.

**3. Which tier is actually being bought?**

A quotation with 1,000 and 5,000 tiers does not say which one the brand wants.

*What I did:* the parser suggests the tier that covers the most SKUs, and the review screen lets the
user change it. *What I would ask:* does the order quantity come from a demand plan upstream, in which
case this should not be a UI choice at all?

**4. Is a split award acceptable?**

The scoring charges a switching penalty per extra supplier, currently 1.5% of landed value, which is
a guess at the coordination overhead.

*What I would ask:* what is the real cost of a second supplier on one order — and are there
categories where splitting is simply not allowed?

**5. What is the cost of capital?**

The cash-flow cost of payment terms uses an 8% annual rate. Everything about how payment terms rank
moves with this number.

*What I would ask:* what rate does finance actually use?

**6. Should quality be a floor or a weight?**

Currently both are available: the note can set a hard minimum, and quality is also a weighted
dimension.

*What I would ask:* in practice, do buyers reject below a threshold, or trade quality against price
continuously?

**7. Who is allowed to issue a PO?**

There is no authentication and no approval chain. The draft path exists but nothing enforces who may
confirm.

*What I would ask:* what is the approval threshold, and does it vary by value?

---

## Ramifications register

Everything identified as able to break the expected flow, with its blast radius and what was done.

| Risk | Blast radius | Mitigation |
| --- | --- | --- |
| Unseen spreadsheet layout defeats the parser | Total: nothing downstream runs | Three independent signals for column roles including an arithmetic cross-check; no filename, sheet name or header string is special-cased; all four fixtures pass with the LLM disabled |
| Non-XLSX file uploaded | User sees a stack trace | Caught at the workbook boundary and returned as a 422 with a message aimed at a person |
| No API key at demo time | Parser and agents both dead | Offline is the default: heuristics-only parsing and deterministic agent stubs. Every model call falls back rather than throwing |
| Model proposes an offer the supplier cannot honour | A PO the factory will not accept | `clampOffer` enforces every bound in code after the model answers; clamps are recorded and shown |
| Curveball loses the rounds already negotiated | Fails the brief's core requirement | Workflow steps hold no state; every step reloads from Postgres. Integration test asserts the pre-curveball row sequences are unchanged |
| Process dies mid-negotiation | Negotiation unrecoverable | Mastra snapshots live in Postgres; the transcript is rows, not memory |
| Allocation repair loops or inflates the order | Buying goods nobody asked for | Capped at two passes, quantity is only ever moved between suppliers, and `assertNoOverAllocation` checks every line. Infeasibility is a recorded outcome, not an exception |
| Double-clicked Convert buys twice | Real money | Idempotency key covering negotiation, allocation and a terms hash; replay returns the original PO |
| Two commits race for a PO number | Duplicate or gapped numbering | Allocated by atomic increment inside the commit transaction |
| Supplier API slow or down during commit | Order rolled back after the brand agreed to it | Effects enqueued in the commit transaction and delivered afterwards with retries and backoff |
| Two API instances send the same notification | Supplier receives duplicates | Outbox rows claimed with `FOR UPDATE SKIP LOCKED`; unique index on (purchase order, event type) |
| Rounding drift between quotation and PO | Loss of trust in every number on screen | Unit prices keep four decimals, totals are computed before rounding and rounded once |
| UI recomputes the comparison and disagrees with the award | The screen contradicts the decision | The full score breakdown is stored on the award and rendered, never recalculated client-side |
| SSE connection drops mid-negotiation | User loses the transcript | The transcript is rows; reconnect with `?after=` and miss nothing |
| Draft state reads as a missing commit | Scored as not meeting the brief | Convert is the primary action and issues immediately; the draft path is secondary, and every effect is labelled with its stage in the UI |
| Mastra 1.x API differs from tutorials | Build does not compile | Exact versions pinned and verified against installed types rather than documentation |
