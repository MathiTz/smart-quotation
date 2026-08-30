# Decisions

What was chosen, what was rejected, and why. Ordered roughly by how much they shaped the rest.

---

### The decision is arithmetic; the agent explains it

`packages/shared/src/scoring.ts`

**Chosen:** a pure function ranks the plans. The brand agent receives the ranking already made and
writes it up in English.

**Rejected:** asking the model to pick the winner.

A model asked to choose between five plans on four weighted dimensions will produce an answer that is
usually reasonable and occasionally not, and will justify either equally fluently. Since the output
is a purchase commitment, the ranking has to be reproducible, testable and identical on every run.
Making it a pure function also means the explanation is generated from the same numbers that made the
decision, so the reasoning shown to the brand cannot drift from what actually happened.

The cost is that the agent's contribution is narrower than "AI picks the supplier" sounds. That is
the right trade for money.

---

### Supplier limits are enforced in code, not in prompts

`apps/api/src/agents/bounds.ts`

**Chosen:** `clampOffer` pulls every proposal back inside the supplier's real floor price, minimum
lead time, best payment terms, maximum rebate and maximum freight allowance. The bounds are never put
in the prompt.

**Rejected:** telling the model "your floor is $4.20, do not go below it".

A prompt is a request. Under pressure from a persuasive counterparty a model will cross a line it was
asked not to cross, and the resulting offer is not one the supplier could honour. Worse, putting the
floor in the prompt hands the model the exact number to converge on, which makes every negotiation
end at the floor.

Clamping also produces something useful: when a clamp fires, that supplier has genuinely run out of
road, and the transcript says so. `isExhausted` uses the same signal to end the negotiation early
rather than running empty rounds.

---

### The curveball is a resume, not a restart

`apps/api/src/workflows/negotiation-workflow.ts`

**Chosen:** the Mastra workflow suspends after round one. Injecting the capacity change resumes the
same run with new data. One field changes: a capacity ratio.

**Rejected:** re-running the negotiation with supplier 2's quantity reduced.

The brief asks for the new information to be incorporated "without restarting from scratch", and a
re-run is a restart wearing a hat — the offers already extracted would be thrown away and re-derived,
and the transcript would either lose its history or duplicate it.

What makes the resume cheap is that the workflow steps hold nothing. Every step reloads from
Postgres, so there is no in-memory state to reconcile. The integration test asserts the property
directly: the row sequences written before the curveball are unchanged afterwards, with new rows
appended on top.

---

### Coverage is a vector, not a flag

`packages/shared/src/coverage.ts`

**Chosen:** every line carries a `LineCoverage` describing how much of the request each supplier can
actually meet and why any gap exists.

**Rejected:** a boolean per supplier plus a special case for the curveball.

There are four unrelated reasons a line might not be fully covered: the incumbent never priced the
tier, the SKU did not match the catalog, the supplier declined it, or the supplier is capacity-capped.
Modelled separately, each needs its own handling in the allocator, the scorer and the UI. Modelled as
one vector, the curveball needs no special case anywhere downstream — which is the main reason the
mid-negotiation change was cheap to build.

---

### Extrapolate the missing baseline rather than dropping the line

`apps/api/src/negotiation/coverage.ts`

**Chosen:** when the incumbent did not price a SKU at the chosen tier, estimate a baseline from its
own elasticity across the tiers it did quote, and mark the line `baselineExtrapolated`.

**Rejected:** dropping the line, or leaving the baseline at zero.

`quotation_2` has two such lines. Dropping them means the brand cannot buy something it wants. A zero
baseline makes every competitor look infinitely expensive on that line and distorts the whole
comparison. Extrapolating keeps the basket whole, and marking it keeps the system honest: the brand
agent tells the suppliers this business is genuinely open, which is real leverage.

---

### Suppliers concede on five levers

`packages/shared/src/negotiation.ts`

**Chosen:** price, lead time, payment terms, volume rebate, freight allowance — each already a
dimension in the scoring function.

**Rejected:** price-only negotiation.

The brief asks that "suppliers don't just accept or reject, they find ways to win the deal". A
price-only agent has exactly two moves. More importantly, a concession that is not a scoring
dimension is theatre: it reads well in the transcript and changes nothing. Tying every lever to the
score means "I'll hold price but cover your freight" genuinely moves the ranking.

---

### Two-stage commit, with Convert as the primary action

`apps/api/src/purchase-orders/commit.ts`

**Chosen:** Convert issues the PO immediately and fires every effect. Save-as-draft is secondary and
withholds only the supplier-facing effects.

**Rejected:** draft-first, requiring a second confirmation before anything happens.

Amber's own flow drafts first, and mirroring it was tempting. But the brief says converting is "a
real commit action... treat it that way", and a reviewer looking for that would find a draft that
notified nobody. Making Convert the primary path satisfies the brief; keeping the draft path
satisfies the real-world approval workflow. Each outbox effect is labelled with its stage in the UI
so which one fires when is visible rather than asserted.

---

### The outbox, rather than calling out during the transaction

`apps/api/src/purchase-orders/outbox.ts`

**Chosen:** effects are enqueued in the same transaction as the PO and delivered afterwards by a
worker with retries, backoff and `FOR UPDATE SKIP LOCKED`.

**Rejected:** calling the supplier API inside the transaction, or after it without a queue.

Inside the transaction, a slow supplier holds a database lock and a failure rolls back an order the
brand has already agreed to. After it without a queue, a crash between the commit and the call loses
the notification silently — the brand believes it has ordered and the factory never hears.

The handlers themselves log rather than calling anything, because there is no ERP here. The machinery
around them is real, and swapping a handler for a network call is the only change needed.

---

### Idempotency keyed on the commit intent

`packages/shared/src/purchase-order.ts`

**Chosen:** `negotiationId : allocationKey : hash(terms)`.

**Rejected:** keying on the negotiation alone.

Keying on the negotiation would make a split award — which legitimately writes two POs — look like a
duplicate. Keying on the allocation allows the split, and including the terms hash means a commit
whose terms have genuinely changed is a different commit, while a double-clicked button is not.
`purchase_orders.negotiation_id` is non-unique from the first migration for the same reason: several
POs per negotiation, and later per supplier, stay reachable without a schema change.

---

### Postgres for everything, including workflow state

**Chosen:** Drizzle for the application tables, Mastra's `PostgresStore` in a separate `mastra`
schema in the same database.

**Rejected:** in-memory workflow state, or a second store.

Suspend and resume are only durable if the run survives the process. Putting the snapshots in the
same database as the negotiation rows means one thing to run and one thing to back up, and the
separate schema keeps Mastra's tables from mingling with ours.

---

### SSE by polling the database

`apps/api/src/http/negotiations.ts`

**Chosen:** the stream re-queries `negotiation_rounds` every 400ms for rows past a cursor.

**Rejected:** `LISTEN/NOTIFY`, or an in-memory subscriber registry.

An in-memory registry breaks the moment there are two API instances, and it loses everything on a
restart. Polling an indexed table every 400ms costs very little, survives a restart, and lets a
client reconnect with `?after=` and miss nothing. `LISTEN/NOTIFY` is the right answer at scale and is
a contained change when that day comes.

---

### Offline is the default

`apps/api/src/env.ts`

**Chosen:** with no API key, the parser uses heuristics alone and the agents use deterministic stubs.
Every model call falls back rather than failing.

**Rejected:** requiring a key.

A repo that cannot be run without a key cannot be reviewed on a clean clone, and a demo that depends
on a third-party API is a demo that fails live. The stubs follow a concession curve and produce real
English, so the offline transcript is a fair representation of the online one — and the determinism
is also what makes the negotiation tests reproducible.

---

### Money rounding: four decimals for unit prices, two for totals

`apps/api/src/parser/read-workbook.ts`

**Chosen:** `roundPrice` keeps four decimals, `roundMoney` keeps two, and line totals are computed
from the unrounded price before being rounded once.

**Rejected:** rounding everything to cents.

At 5,000 units a rounded half-cent is a $25 error on one line. Across a 25-line basket that is enough
for the PO to visibly disagree with the quotation it came from, which is the kind of discrepancy that
destroys trust in the whole system.

---

### The UI renders the API's score breakdown

`packages/shared/src/scoring.ts`, `apps/web/src/components/Comparison.tsx`

**Chosen:** the full `ScoreBreakdown[]` is stored on the award and sent to the client.

**Rejected:** recomputing the comparison in the browser.

Two implementations of the same arithmetic will eventually disagree, and when they do, the screen
will contradict the decision. Storing the breakdown also means the comparison a brand sees months
later is the one the award was actually made from, not a recalculation against today's code.

---

### One text colour per role, dark enough to be read on any surface

`apps/web/src/index.css`

**Chosen:** a light theme whose status colours are defined dark enough to be legible as text, with
tinted backgrounds derived from those same colours at 10% alpha.

**Rejected:** hand-picking a separate background tint and text colour for each status.

A badge needs a pale fill and a saturated label. Picking those independently means two values that
have to be kept in sync by hand and drift the first time someone adjusts one. Deriving the fill from
the label colour makes the pair impossible to break, and it forces the label to be chosen for
contrast rather than for how pleasant it looks on white. Every text and badge combination clears
WCAG AA at 4.5:1; the faintest text colour is set from that requirement rather than by eye, which is
what pushed it from `0.60` to `0.54` lightness.

**Ramification:** any new status colour has to be dark enough to read as text before it can be used
as a tint, which rules out pastel accents. That constraint is the point.

---

### Concession labels are trimmed in code

`apps/api/src/agents/bounds.ts`

**Chosen:** concession descriptions are normalised and cut to 64 characters on the way in.

**Rejected:** asking for short labels in the prompt and trusting the answer.

The offline stubs write chip-sized labels because they are templates. A live model, given the same
schema, writes sentences. Those render as pills next to the message, and a pill that will not wrap
drags a CSS grid wider than the viewport, which is exactly what happened the first time the UI was
pointed at a real model. The prompt now asks for a short label and the code guarantees it, the same
split used for prices and lead times. The UI also allows badges to wrap, so a long label degrades
into an ugly chip rather than a broken page.

---

### A negotiation is bought once, and the server is what enforces it

`apps/api/src/purchase-orders/commit.ts`

**Chosen:** `convertNegotiation` refuses a negotiation already in `converted` unless the incoming
idempotency key matches orders that already exist, in which case it replays them. The client derives
its key from the negotiation (`convert:${id}`) rather than generating one per page load.

**Rejected:** relying on the per-allocation idempotency check alone, or on hiding the button.

The original key was `${id}:${crypto.randomUUID()}` held in a `useRef`, which is idempotent against a
double-click and nothing else. Reloading the page minted a new key, the server recognised no prior
order under it, and wrote a second purchase order for the same basket — with `notify_supplier`,
`reserve_capacity` and `schedule_payment_tranches` all firing a second time. It was found in the demo
database as two POs for $948,583.82 against one negotiation.

The lesson is that idempotency keyed on something the client regenerates is not idempotency, it is a
double-click guard. The status check is the real invariant, so it lives on the server; the stable key
keeps honest retries working; hiding the button is only cosmetics on top of both.

**Ramification:** re-converting after a genuine change of terms is now impossible without an explicit
cancel-and-renegotiate path. That is the right default for something that commits money, but it is a
door that is currently locked rather than merely shut.

---

### Negotiations get a list, not a purchase-order status

`apps/api/src/negotiation/view.ts`, `apps/web/src/routes/Negotiations.tsx`

**Chosen:** an index of negotiations with their live status, separate from the purchase-order list.

**Rejected:** giving purchase orders a `negotiating` status so in-flight work shows up there.

The work was already in the background — starting a negotiation is `void run.start(...)`, the HTTP
call returns immediately and Mastra's snapshots survive a restart. The gap was navigational: leave
the page and the negotiation runs happily on with no route back to it.

Putting in-flight negotiations in the PO list would have fixed the navigation by breaking the
meaning. A purchase order is the commitment — frozen terms, supplier notified, money scheduled — and
the list of them is what someone approving spend reads. A row that says "we are still haggling"
turns "what have we bought" into a question you have to filter to answer. The negotiation already
has its own states, and they belong on their own page.

---

### The model provider is one environment variable, not a code path

`apps/api/src/agents/providers.ts`

**Chosen:** models are named `provider/model`, and a single resolver turns that into whatever Mastra
wants. Google, OpenAI and Anthropic are in Mastra's own router and resolve to a router string;
Ollama is not, so it resolves to Mastra's OpenAI-compatible config with an explicit base URL.

**Rejected:** an adapter interface per provider, or committing to one vendor.

The forcing function was mundane: Gemini's free tier allows 20 requests a day and one negotiation is
about sixteen model calls, so a second demo in one afternoon returns 429. That is a bad reason to
lose a demo. Because every provider here speaks the same two verbs — generate text, generate JSON
against a schema — the abstraction only has to answer "which credentials and which URL", which is a
table rather than an interface.

Two consequences fell out of it. Whether the app is online is now decided by the provider the
configured model names, rather than by the presence of one hardcoded Google key, so an unused
provider's key can stay blank. And the parser's column classifier, which was a hand-rolled Gemini
REST call, now goes through the same Mastra agent as everything else: three provider-specific
request shapes would have been the alternative, since Anthropic's API is not OpenAI-compatible.

**Ramification:** provider-specific behaviour is now the app's problem rather than the vendor's.
A local reasoning model at `temperature: 0` was observed looping past five minutes on a request that
answers in 32 seconds at the default temperature, which is why agent calls have a timeout and the
offline stubs remain the answer of last resort.

---

## The presentation deck imports code instead of quoting it

`deck/slides.md`, `deck/README.md`

**Chosen:** a Slidev deck whose code slides read the real source files at build time, via
`<<< ../apps/api/src/agents/bounds.ts#price-floor`, delimited by `#region` markers in the source.

**Rejected:** pasting snippets into the slides, and screenshotting the editor.

Both rejected options decay the moment the code moves, and they decay silently — a slide showing a
function that no longer exists is worse than no slide, because it is presented with confidence. The
regions cost four pairs of comments in the source and remove the failure mode entirely. Line ranges
were considered instead of regions and rejected for the same reason at one remove: `{45-60}` is
correct until somebody adds an import.

The second-order benefit is the one that changed how the talk is delivered. Because the snippet
carries click-stepped highlighting, the alternative to "switch to the IDE and scroll" is a slide
that already has the right lines lit up in the right order. Combined with short silent screen
recordings for the parts that must move, the demo stops depending on a live app behaving during a
recording.

**Ramification:** `#region` comments in production source exist for the benefit of something outside
it. They are inert and conventional, but they are a coupling, and someone deleting one will not get
an error — the deck will just build with a smaller snippet than intended.

The deck is deliberately outside the pnpm workspace: it pulls in Vue, a second Vite and a Chromium
for PDF export, none of which belong in the dependency graph of the application under review. That
costs one flag, `pnpm install --ignore-workspace`, and the reason is written in `deck/README.md`
because the failure without it is silent — pnpm installs the application's dependencies instead and
reports success.

---

## The connection pool logs idle-client errors instead of dying

`apps/api/src/db/client.ts`

**Chosen:** `pool.on("error", …)` logs the dropped client and lets the pool recover.

**Rejected:** leaving it unhandled, which is the default and was the behaviour until a
`pnpm db:reset` against a running dev server took the API process down with a Postgres 57P01,
"terminating connection due to administrator command".

The failure is worth writing down because it is entirely asymmetric. `pg` emits `error` on *idle*
pooled clients whenever the backend goes away — a database restart, a network blip, an admin running
`pg_terminate_backend` — and Node throws on an EventEmitter `error` with no listener. So the process
dies over an event the pool was already equipped to handle: it discards the dead client and opens a
new one on the next query. The connection recovers either way; the only difference is whether the
server is still alive to use it.

Verified by terminating every backend on the database under a running API: the process stays up, the
warning is logged once, and the next request served a database-backed route normally.

**Ramification:** genuinely broken connectivity now surfaces as a repeated warning rather than a
loud crash, which is quieter than some would like. That is the right trade for a server — an API
that outlives its database restarting is worth more than one that fails fast on a transient — but it
does mean the console is the place that signal lives, so it should not be ignored during a demo.

---

## The response shape is stated in the prompt as well as the schema

`apps/api/src/agents/prompts.ts` — `OUTPUT_CONTRACT`

**Chosen:** the supplier prompt enumerates the exact JSON keys and their ranges, alongside the Zod
schema passed to Mastra's `structuredOutput`.

**Rejected:** relying on the schema alone, which is what the provider abstraction implies should be
enough.

It is not enough, because **Ollama Cloud does not enforce JSON schemas**. It accepts
`response_format: json_schema` on its OpenAI-compatible endpoint and the native `format` field on
`/api/chat`, and ignores both: asked for a structured offer without being told the key names,
`gpt-oss:120b` returns a formatted business letter. This was checked across `gpt-oss:120b`,
`gpt-oss:20b`, `deepseek-v4-flash:0731`, `qwen3.5:397b`, `gemma4:31b`, `mistral-large-3:675b` and
`glm-5.3-flash` — no model on the cloud tier behaved differently. Google, by contrast, honours the
schema exactly.

The diagnosis took a wrong turn worth recording. The first probes *passed*, and the obvious
conclusion was that `gpt-oss:120b` supported structured output. It passed because the probe prompt
happened to name the fields, so the model guessed the shape correctly. A realistic prompt produced
`{"price_concession": …, "lead_time_concession": …}` — invented keys, valid JSON, failed validation.
A test that passes for a reason you did not intend is worse than one that fails.

Stating the shape in the prompt costs a few dozen tokens per turn against providers that did not
need it, and it is the difference between a negotiation driven by a model and one that silently
falls back to the offline stubs.

**Ramification:** the schema and the prompt now describe the same contract in two places and can
drift apart. The schema still decides — a prompt that disagrees produces a validation failure and a
fallback, not a bad purchase order — so the failure mode is loud in the console and safe in the
data. But it is duplication, and generating the contract text from the Zod schema would be the
better answer if this grew beyond one prompt.

**Ramification:** a silent fallback is now the main thing to watch during a demo. A negotiation
running entirely on stubs completes normally and picks the same winner, so the UI cannot tell you
which mode you are in. Only the console can.

---

## Gemini's free tier is metered per model, which is a usable escape hatch

Google's free tier allows 20 `generateContent` requests per day and a full negotiation is about
sixteen model calls, so the second demo of a day returns `RESOURCE_EXHAUSTED`. The quota id is
`GenerateRequestsPerDayPerProjectPerModel-FreeTier`: the limit is **per model**, so switching from
`gemini-2.5-flash` to `gemini-3.5-flash-lite` gets a fresh twenty. The `retryDelay: 14s` in that
error is misleading — it is a daily cap, not a cooldown.

`gemini-3.5-flash-lite` is also the faster of the two on this workload: 3.1s for a full structured
offer against 22s for `gemini-2.5-flash`.

---

## The comparison bar shows a plan's standing, not the points it scored

`components.cost` and friends are already multiplied by their weight, so a dimension worth 20% of
the decision produces a number between 0 and 0.2. Drawing that number as a bar — the original
behaviour — meant the bar could never fill past a fifth however good the plan was, and the tooltip
read `Cost scores 5 out of 100`, which looks like a failing grade rather than "cost is worth 20
points here and this plan took a quarter of them".

The bar is now the plan's standing against the other plans on that dimension alone: best fills it,
worst leaves it empty. The weighted points moved into the tooltip, alongside the weight itself, so
the two quantities are named rather than conflated.

The weight is read off the column rather than sent from the server: the best plan on a dimension
normalises to 1, so its weighted component *is* the weight. That avoids adding the redistributed
weights to `ScoreBreakdown`, which is persisted as jsonb on `negotiations.award` and would have made
every already-stored award fail to parse.

**Ramification:** this holds only because scoring normalises to the best option in the set. If the
normalisation ever became absolute — scoring against a target price rather than against the other
plans — the derivation breaks silently and the tooltip starts quoting the wrong weight. Sending the
weights explicitly is the honest fix at that point.

**Ramification:** the bars are no longer comparable *across* dimensions, because each is normalised
to its own column. A full quality bar and a full cost bar are not worth the same. The tooltip says
so; the bars alone do not.

---

## Model field names are scrubbed out of supplier prose in code, not just asked for in the prompt

The output contract hands the model `priceFactor`, so it writes back sentences like "a 6% price
reduction (priceFactor 0.94)" — accurate, and not how a sales lead writes to a customer. The bare
decimal is the worse half: 0.94 means 94% of the opening price and reads as a 94% discount.

The prompt now asks for prose without field names, and `clampOffer` rewrites them anyway, turning
`priceFactor 0.94` into `price factor at 94%`. Same split as the bounds clamping either side of it:
the prompt asks, the code guarantees. A presentation rule that depends on a model choosing to follow
it is not a rule.

**Ramification:** the scrub is a fixed list of five field names. A field added to the contract later
will leak until someone adds it to `FIELD_WORDS`, and nothing fails to remind them — the test
covers the names that exist today, not the ones that do not.

---

## A buyer can overrule the recommendation, including a plan the system ruled out

The ranking is computed from priorities somebody typed into a free-text note. That note is never the
whole brief — a relationship, a quality history, a deadline that turned out to be soft, a supplier
someone has already promised work to. Making the recommendation the only committable plan would not
prevent those overrides. It would move them into a spreadsheet, where nothing records that the
system disagreed.

So every plan in the comparison is selectable, ruled-out ones included, and the purchase order
carries `chosenOptionId` alongside `recommendedOptionId`. Overriding is allowed and legible rather
than forbidden and invisible.

The losing plans' lines are rebuilt from the stored offers rather than persisted with the award. The
offers are frozen once scoring finishes and `buildAwardOptions` is pure, so the rebuild returns
exactly the plans the ranking was computed from — the same reasoning `loadContext` already runs on.
Storing a second copy in the award jsonb would have meant a migration and a way for two records of
the same thing to disagree.

The recommended plan is still served from the stored award, never rebuilt. A purchase order that
re-derives its own terms at commit time is not a commitment, and that property is worth more than
the symmetry.

**Ramification:** an override is checked against the scored option ids, so an id that was never
ranked is refused rather than assembled on demand. But the rebuild is a second execution of the
allocator, and if it ever stopped being deterministic — a tie broken by map ordering, a rounding
change — a buyer could be shown one set of lines and commit a slightly different one. The
integration test compares the committed allocations against the rebuilt ones for exactly this
reason.

**Ramification:** the plans are rebuilt on every read of a negotiation that has an award, which is
also the poll path. It is bounded by the option count and only runs post-award, but it is real work
on a hot route, and the first thing to cache if that page ever gets slow.

---

## Three totals for one plan, named rather than reconciled away

The comparison ranks on effective cost; the commit card used to show the goods subtotal. Same plan,
same screen, two numbers about a million dollars apart, and nothing explaining which one you were
about to be charged.

The commit card now lists all three — goods, landed, effective — with what each one means, because
they answer different questions and collapsing them would lose information. Goods is what the
supplier is paid, landed adds freight and duty and is the total written on the purchase order, and
effective adds the cost of capital tied up by the payment schedule, which nobody invoices but which
is what the ranking used.

The columns above them are captioned for the same reason: `100` in a payment column is meaningless
until it says `100% upfront`, and `40/60` needs to say it is a milestone split before the cash-flow
line makes any sense.

**Ramification:** the plan a buyer overrides to is often cheaper because it covers less of the
basket, and the three totals cannot show that — a 60% plan is genuinely cheaper on all three. The
coverage shortfall is called out separately under them. Without that line the override screen would
be actively misleading, which is worse than the mismatch it replaced.

## Six more fixtures, generated from a script rather than hand-built

Four workbooks came with the brief and the parser handled all four. That is a weak claim: a parser
that has only ever been pointed at four files has been *tuned* to four files, and there is no way to
tell the difference from the outside.

The six added here each exist to break one assumption rather than to add another tidy table: merged
multi-row headers with summary rows inside the data, every number stored as text, product codes
retyped from a PDF, a table hidden on the third sheet and indented, headers that name the wrong
column, and duplicate lines with holes in the pricing.

They are **generated** by `apps/api/scripts/make-fixtures.ts` rather than committed as opaque
binaries. A reviewer can read what each file is supposed to contain and why, which an `.xlsx` in a
diff does not allow. The generator is seeded, so the output is byte-stable and the tests assert
against fixed files.

**They immediately paid for themselves**, which is the argument for having written them:

- `parseNumeric` read `"5,000"` as five. The rule was "if the last comma is after the last dot, the
  comma is the decimal separator", which is right for `1.234,56` and wrong for a number with no dot
  in it at all. Quantities in `quotation_6` came through as 5 and 3 instead of 5000 and 2500, and
  the arithmetic cross-check dutifully reported six rows whose totals did not add up. The fix reads
  the *shape*: a grouping separator repeats and always takes three digits, a decimal comma appears
  once and rarely has three behind it.
- One mangled product code truncated the rest of the price list. `looksLikeSku` rejects anything
  with unexpected punctuation, and `findDataRegion` ends a run after two consecutive non-item rows —
  so an en-dash from an autocorrect, followed by a code with a footnote marker on it, ended the
  table. `quotation_7` lost 8 of its 11 rows silently. Codes are now repaired for known typography
  (dash variants, trailing footnote markers) *before* the structural test, which keeps the test
  strict — it still has to reject `30/70` and `90 days` — while stopping a supplier's word processor
  from deleting a line from an order.

Both were silent. Neither would have been found by another well-formed file.

**Ramification:** the fixtures assert a floor on what must survive rather than an exact transcript,
so a parser that gets *more* out of these files does not have to update a test to prove it. The
trade is that a small regression inside the floor could pass; a large one cannot.

## An unusable model configuration stops the server instead of warning

`SQ_OFFLINE=0` means "use live models". With no provider key that instruction cannot be carried out,
and the way it failed was invisible: every model call is deliberately wrapped in a fallback to the
offline agent, so all three suppliers would 401, all three would be answered by the scripted stub,
and the negotiation would complete, produce sensible arguments and award a defensible winner while
being entirely fake. Nothing in the UI distinguishes that from a real run.

There was already a `console.warn` for it. A warning in a boot log that is immediately followed by
a working application is not a control.

The API now prints a full report — the model requested, the provider it implies, every environment
variable checked, and the three ways out — and exits `1` **before the port is opened**, because a
server that is already listening invites you to go and use it.

Running offline is never blocked and never warned about. It is the default, it is what makes the
repository clonable without an account, and the boot log states plainly which mode is active and
why. The error is reserved for the one configuration that is internally contradictory.

**Ramification:** `.env.example` had to stop shipping `SQ_OFFLINE=0`. It is now left unset, which
means the app decides from whether a key is present — otherwise the documented first run,
`cp .env.example .env && pnpm dev`, would have died on the very check meant to protect it.

## One error state per page was one too few

Every screen kept a single `error`, and every screen rendered it the same way: `if (error) return
<p>{error}</p>`. That is correct for a failed load and wrong for everything else. Clicking "issue to
supplier" and having it fail replaced the entire purchase-order list with one line of red text —
the other orders, the totals and the button that failed all disappeared, and the only way back was
to navigate away and return. The negotiations list did it on a *background poll*: the table had
loaded fine, one four-second refresh missed, and the page emptied.

Errors are now split by what the user can still do about them. A failed load has nothing to show, so
it takes the page and offers a retry. A failed action leaves the page alone and puts the message
next to the control that failed. A failed background refresh does not even do that — the table stays
and a "Not refreshing" badge appears, because the data on screen is still true, just not current.

**Ramification:** two state variables per route instead of one, and the discipline to pick the right
one at each call site. The alternative — a toast system — would have been more machinery and would
have made the "stale but valid" case harder to express, not easier.

## The client had no idea when the negotiation stream died

`EventSource` reports a dropped connection to an `onerror` handler that did not exist. Losing the
stream therefore looked exactly like a slow round: the transcript stopped growing, the badge stayed
on "Negotiating", and the page waited forever for an event that was never coming. The negotiation
itself was fine — it writes every round to Postgres and does not care whether anyone is listening —
which made this purely a matter of the UI not saying so.

The stream now reports drops, and the page says the thing that is actually true: the negotiation is
still running, nothing is lost, reload to catch up. Parsing is also guarded per event, because a
throw inside one listener silently stops the others, and a single malformed frame would otherwise
freeze the transcript with nothing on screen to explain it.

**Ramification:** the message can appear on a connection that recovers by itself a second later,
since `EventSource` retries without asking. Recovering clears it. Briefly warning about a drop that
healed is a much better failure than never mentioning one that did not.

## Validation error shape, and why the hook has to be on every router

`OpenAPIHono` takes a `defaultHook` that turns a Zod failure into the project's `{ error, detail }`
shape. It was set on the root app, and the three sub-routers were built with a bare
`new OpenAPIHono()` — so every validated route in the API returned Hono's default instead: a
serialised `ZodError` with a nested `issues` array. The client reads `body.error` as a string, so
each of those rendered as `[object Object]`.

The hook does not travel across `app.route()`. Routers are now built by one `createRouter()` factory
so a router without the hook is not something that can be written by accident, and the client
coerces `body.error` rather than trusting it.

**Ramification:** the fix is a constructor everyone has to use, which is a convention rather than a
guarantee. It is enforced by there being no other reason to call `new OpenAPIHono()` in this codebase.

## Guards on the arithmetic, because scoring is comparative

`normalise` maps each option onto the range spanned by all of them, which means the options are not
independent: one non-finite cost made `min` and `max` non-finite and returned `NaN` for *every*
option, so the ranking was decided by nothing. The switching penalty had a sharper version of the
same problem — it multiplies by `allocations.length - 1`, which is zero for a single-supplier plan,
and `0 * Infinity` is `NaN`, so a corrupt price poisoned the total of a plan the penalty should not
have applied to at all.

Non-finite values are now excluded from the range rather than allowed to define it, coverage is
clamped to `[0, 1]` so a shortfall larger than the order cannot produce a negative score, and
`paymentCashFlowCost` clamps both the amount and the lead-time window. The last one mattered most:
`daysEarly` was computed from the raw lead time, so a negative one turned the cost of paying early
into a *discount* and would have ranked 100% upfront as an advantage.

Unreadable payment terms fall back to 100% upfront, which is deliberate. It is the most expensive
schedule, so a term nobody can parse can never make an option look better than one that stated its
terms honestly.

**Ramification:** these guards hide bad input rather than reporting it. That is the right trade for a
comparative score — one bad option should lose, not take the other four down with it — but it means
a corrupt price shows up as a poor ranking rather than an error. The tests pin the behaviour so the
guards cannot quietly become the normal path.

## Limits on the free-text inputs

The brand note was `z.string()`, which accepts a megabyte. It is read by regexes with `matchAll`,
stored on the row, and echoed into every agent prompt on every round — so an unbounded note is a slow
parse, a large row and a large prompt at once. It is now capped at 2000 characters, tier quantity at
a million, and uploads reject an empty file before the parser reports it as an unreadable workbook.

Not passing a note remains entirely valid and is the common case: the default weighting applies and
the UI echoes it back, so "no instruction" and "an instruction that was not understood" never look
the same on screen.

## The idempotency key was never the whole guard

The unique index on `idempotency_key` protects against a repeat of the *same* commit, which is the
double-clicked button. It does nothing about two tabs committing *different* plans: a different plan
means a different `allocationKey` and a different terms hash, so the composed key differs, no
constraint fires, and both writes are perfectly legal as far as the database is concerned.

The only thing standing between that and buying one basket twice was the negotiation's status — and
that check ran *before* the transaction opened. Both requests read `awaiting_conversion`, both
passed, both wrote. Two purchase orders on two different plans for one negotiation, both `sent`,
both suppliers told.

The check now runs inside the transaction against a `SELECT ... FOR UPDATE` on the negotiation row,
so the second request waits for the first to commit and then reads the status it set. The row lock
is what serialises them; the unique index never could, because the two keys were genuinely different
and describing genuinely different purchases.

**Ramification:** commits on the same negotiation are now serialised, which is exactly the intent —
a negotiation is bought once. Commits on *different* negotiations are unaffected, since they lock
different rows. The integration test drives both requests concurrently through `Promise.allSettled`
and asserts one succeeds and one fails with the right error; removing the lock makes it fail with
two successes, which is how the bug was confirmed rather than assumed.

---

## "Durable" was doing too much work in that sentence

**Decision:** sweep interrupted negotiations into `failed` on an interval, and give the buyer an
explicit retry.

**Rejected:** resuming them automatically, or restarting them from scratch on boot.

Mastra's Postgres snapshots make a *suspended* run durable, and that is a real guarantee: resuming
one is an explicit call that rebuilds it by run id, so a negotiation parked at the curveball survives
any restart. The mistake was extending that word to cover a run that was mid-round. There is no
snapshot for one of those — `startNegotiation` hands the run to Mastra and attaches the failure
handler to an in-process promise, so when the process dies the handler dies with it and the row is
left saying `negotiating` with nothing left anywhere that will ever touch it again.

It was found the way these things usually are: a `tsx` watch restart during development killed a live
negotiation, and the UI sat spinning on it for nine minutes. The row said `negotiating`, the
`mastra_workflow_snapshot` table had no row for its run id at all, and no code path existed that
would ever look at it again.

Restarting it automatically was tempting and wrong. It spends a fresh set of model calls on a
decision nobody asked to re-open, and it appends to a transcript that already holds half a
conversation — `negotiation_rounds` is unique on `(negotiation_id, sequence)`, so the rerun collides
on its first write anyway. Resuming mid-round is not available: nothing records which supplier had
answered. So the sweep does the only honest thing, which is to stop claiming the negotiation is still
running, and leaves the decision to re-spend that money with the person spending it.

The threshold is what makes it safe to run more than one API instance. Eligibility is not "status is
`negotiating`" but "status is `negotiating` **and** nothing has written to the row in five model
timeouts", so a negotiation another process is actively working on is never a candidate. `suspended`
is excluded outright, because waiting for a human to answer the curveball is a state it is entitled
to sit in indefinitely.

**Ramification:** an interrupted negotiation now costs a retry click instead of a dead row. The sweep
runs on an interval rather than only at boot, so a run abandoned by a process that stays up is caught
too.

What it cannot do is say why. A restart, a crash and a provider that hung past every timeout all
reach it as the same evidence — a row nobody has written to for five model timeouts — so the message
deliberately names no cause. The first draft said "the server restarted", which was true of the case
that produced it and would be a guess in the other two. It now states only what holds in every case:
it is not running, nothing was bought, and it can be started again. A test asserts the message does
*not* mention a restart, a crash or a timeout, because the tempting fix when someone asks "why did
this fail" is to put a plausible reason in the sentence rather than in the logs.
