# Smart Quotation

A brand uploads a messy supplier quotation, the system reads it, and three AI agents negotiate against
it. The brand agent scores every way of buying the basket, explains the one it recommends, and the
brand converts that into a purchase order.

The whole thing runs offline with no API key. See [Running without a model](#running-without-a-model).

**Walkthrough:** [Part 1](https://cap.so/s/7887wzaz46p7zrp) · [Part 2](https://cap.so/s/f347y97d7e1waqe) · [Part 3](https://cap.so/s/gmpwrk5tcn8abmk)

---

## The stack

![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/Node-22.13+-5FA04E?logo=nodedotjs&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-10.9-F69220?logo=pnpm&logoColor=white)
![React](https://img.shields.io/badge/React-19.2-61DAFB?logo=react&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-7.1-646CFF?logo=vite&logoColor=white)
![Tailwind](https://img.shields.io/badge/Tailwind-4.1-06B6D4?logo=tailwindcss&logoColor=white)
![Hono](https://img.shields.io/badge/Hono-4.9-E36002?logo=hono&logoColor=white)
![Mastra](https://img.shields.io/badge/Mastra-1.63-000000)
![Drizzle](https://img.shields.io/badge/Drizzle-0.44-C5F74F?logo=drizzle&logoColor=white)
![Postgres](https://img.shields.io/badge/Postgres-16-4169E1?logo=postgresql&logoColor=white)
![Zod](https://img.shields.io/badge/Zod-3.25-3E67B1?logo=zod&logoColor=white)
![Vitest](https://img.shields.io/badge/Vitest-3.2-6E9F18?logo=vitest&logoColor=white)
![Playwright](https://img.shields.io/badge/Playwright-1.56-2EAD33)

React and Hono were specified in the brief, so they are not decisions to defend. The rest are, and
each one is doing a job the alternative could not:

| | Version | The job it is doing |
| --- | --- | --- |
| **React + Vite** | 19.2 / 7.1 | The client renders decisions and recomputes none of them. Every number on screen was computed by the server |
| **Tailwind + Radix** | 4.1 / per-primitive | Styling without a component library to fight, with accessible tooltip and dialog primitives |
| **Hono** + `zod-openapi` | 4.9 / 0.19 | The request validator and the API documentation are the same object, so the spec cannot describe a request the API would reject |
| **Mastra** | 1.63 | The negotiation needs a step that can suspend mid-run and resume with a new fact — which is the curveball requirement exactly. Its snapshots live in Postgres, so a suspended run is a row |
| **Drizzle + Postgres** | 0.44 / 16 | One database, two schemas. Suspend-and-resume is only durable if the run survives the process, and `FOR UPDATE SKIP LOCKED` is what makes the outbox and the commit safe under concurrency |
| **Zod** | 3.25 | One schema is the TypeScript type, the runtime validator and the OpenAPI entry. Shared by the API and the client, so both agree by construction |
| **Vitest + Playwright** | 3.2 / 1.56 | 124 unit and integration tests against real Postgres, plus two browser journeys |

The pieces that decide how money is spent — parsing, scoring, allocation, the commit — are ordinary
typed functions in `packages/shared`, not agents. The model negotiates and explains; it never
computes a number that ends up on a purchase order.

---

## What you need

| | Version | Why that one | Check |
| --- | --- | --- | --- |
| **Node** | **22.13 or newer** | Enforced by `engines`. 22.13 is the first release with the `node:sqlite` and stable `--env-file` behaviour the toolchain assumes; built and tested on 22 LTS and 24 | `node -v` |
| **pnpm** | **10.x** | Pinned by `packageManager`. This is a pnpm workspace — npm and yarn will not resolve the `workspace:*` links | `pnpm -v` |
| **Docker** | any recent | Runs Postgres 16 and nothing else. Compose v2 syntax (`docker compose`, not `docker-compose`) | `docker compose version` |

No API key is needed. The app runs fully offline on deterministic agents — see
[Running without a model](#running-without-a-model).

<details>
<summary>Installing them</summary>

The pnpm version does not need to be installed by hand. Node 22.13+ ships Corepack, which reads the
`packageManager` field and fetches the right pnpm on first use:

```bash
corepack enable
```

Otherwise `npm install -g pnpm@10`.

For Node itself, if you use a version manager:

```bash
nvm install 22 && nvm use 22     # or: fnm use --install-if-missing 22
```

Docker Desktop covers Docker and Compose together on macOS and Windows. On Linux you want
`docker-ce` plus the `docker-compose-plugin` package — the standalone `docker-compose` binary is the
old v1 and is not what these scripts call.

</details>

---

## Quick start

**Nothing else is required. No API key, no account, no external service.** A clone of this
repository contains the sample quotations, the product catalogue and everything needed to take a
spreadsheet all the way to a purchase order.

```bash
git clone <this repo> && cd smart-quotation
pnpm install
cp .env.example .env
pnpm setup      # starts Postgres, pushes the schema, seeds products.csv and the suppliers
pnpm dev        # API on :8787, UI on :5173
```

Then, in the browser:

1. Open **http://localhost:5173**.
2. Upload a workbook from [`fixtures/`](#the-sample-quotations) — **`quotation_2.xlsx` is the best
   first run**, because its SKUs contain the typos that show the matcher working.
3. In the note field, type something like `prioritize lead time over cost, 30 day deadline`. That
   sentence is parsed into the scoring weights and the hard constraint, and you will see it come
   back as badges.
4. Review the parsed lines and the matched products, then start the negotiation.
5. After round one it pauses and offers the capacity curveball. Apply it or carry on.
6. When it settles, pick a plan — the recommended one or any other — and convert it into a
   purchase order.

The whole run takes about 15 seconds with no API key. See
[Running without a model](#running-without-a-model) for what is real and what is stubbed in that
mode, and [Choosing a provider](#choosing-a-provider) to put a real model behind the agents.

Every variable has a working default, so the app will in fact start without a `.env` at all. Copy it
anyway — it is where the API keys go, and having the file present makes it obvious which knobs
exist.

### The sample quotations

Ten workbooks in [`fixtures/`](fixtures/), all of which parse. The first four came with the brief;
the rest were written to break specific assumptions, because a parser that has only ever seen four
files is a parser that has been tuned to four files.

| File | What it is | What it exercises |
| --- | --- | --- |
| `quotation_1.xlsx` | A purchase-order template | 15 rows of letterhead above the table, merged cells, two tiers stacked as row blocks |
| `quotation_2.xlsx` | A clean two-tier price list | Tier columns; SKUs with typos that need normalising, padding and fuzzy matching |
| `quotation_3.xlsx` | Two sheets, one per tier | Metadata rows, a discount column, formula totals, an `Item No.` column that is really a row number |
| `quotation_4.xlsx` | Chinese headers | Non-English labels, and headers naming the wrong columns |
| `quotation_5.xlsx` | A vendor price list | A tier label merged across two columns so the header spans two rows, and `SUBTOTAL` / `Freight` / `TOTAL` rows sitting inside the table |
| `quotation_6.xlsx` | Everything stored as text | `$41.84`, `USD 12.30`, a European decimal comma, `5,000` and `5 000` as quantities |
| `quotation_7.xlsx` | Codes retyped from a PDF | Wrong case, padding, en-dashes for hyphens, a zero for the letter O, a footnote marker, and three SKUs that are genuinely not in the catalogue |
| `quotation_8.xlsx` | A read-me and a terms sheet first | The real table on the third sheet, starting at row 9, column D |
| `quotation_9.xlsx` | Headers that lie | The "Unit price" column holds quantities and vice versa; only the arithmetic settles it |
| `quotation_10.xlsx` | A working quote | The same SKU quoted twice, blanks where the supplier would not quote a tier, and an MOQ column that is not a price |

`quotation_5` through `quotation_10` are generated by `pnpm fixtures`, so what each one contains is
readable in [`apps/api/scripts/make-fixtures.ts`](apps/api/scripts/make-fixtures.ts) rather than
locked inside a binary. The output is deterministic; re-running produces the same files.

### What `pnpm setup` actually does

Four steps, and it is worth knowing which one failed if it does.

| Step | Command | If it fails |
| --- | --- | --- |
| 1 | `pnpm install` | Usually a Node or pnpm version mismatch. Check both against the table above |
| 2 | `pnpm db:up` | Docker is not running, or port 5433 is taken — see [Ports](#ports) |
| 3 | `pnpm db:push` | Drizzle pushing the schema. Almost always a step-2 failure surfacing late |
| 4 | `pnpm db:seed` | Loads `products.csv` and the four supplier profiles |

Steps 2–4 are re-runnable. `pnpm db:reset` drops the volume and redoes all three from scratch, which
is the right move any time the database is in a state you do not recognise.

<details id="wait-for-db">
<summary>Why <code>db:up</code> runs <code>scripts/wait-for-db.ts</code></summary>

`docker compose up -d` returns as soon as the container is **created**, which is a few seconds
before Postgres accepts connections. Without a wait, `db:push` runs against a database that is
listening but still starting, and fails perhaps one cold run in three with "the database system is
starting up" — an error that reads like a misconfiguration rather than a race.

The script polls `pg_isready` **inside the container** rather than over the mapped port. The
official Postgres image starts a temporary server on a Unix socket to run its init scripts, and that
server accepts local connections while the real one is still unreachable from outside. Probing the
host port therefore reports ready too early, which is the failure this is meant to prevent.

</details>

---

## Ports

| Port | What | Change it with |
| --- | --- | --- |
| `5173` | Vite dev server (UI) | `--port` on the Vite command |
| `8787` | Hono API | `API_PORT`, **exported in the shell** |
| `5433` | Postgres, mapped from the container's 5432 | `docker-compose.yml` **and** `DATABASE_URL` |

Postgres is deliberately on **5433**, not 5432, so that a Postgres you already have running locally
does not collide with this one.

### When a port is already taken

Find the offender:

```bash
lsof -i :8787        # macOS and Linux
netstat -ano | findstr :8787   # Windows
```

If it is a stale process from an earlier run, `kill <pid>` and start again. If it is something you
need to keep:

**The API (8787).** Export it in the shell rather than putting it in `.env`:

```bash
API_PORT=8788 pnpm dev
```

Both processes need to agree on this port, and only one of them reads `.env`. The API has its own
small dotenv loader; the UI's Vite config reads `process.env.API_PORT` to point its proxy, and Vite
does not load the root `.env` into `process.env`. Set it in `.env` alone and you move the API while
the UI keeps proxying to 8787, which looks like every request failing for no reason. Exporting it
covers both, because the API's loader never overwrites a variable the shell already set.

**The UI (5173).** Pass `--port`, which overrides the config:

```bash
pnpm --filter @sq/web dev -- --port 5174
```

Then add that origin to `CORS_ORIGINS` in `.env`, or the browser blocks the API calls. Note that
`pnpm test:e2e` has 5173 hardcoded in `playwright.config.ts`.

**Postgres (5433).** Change the host side of the mapping in `docker-compose.yml` — `"5434:5432"`,
leaving the right-hand side alone — and change the port in `DATABASE_URL` to match. Then
`pnpm db:reset`.

---

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | API and UI together, both with hot reload |
| `pnpm dev:api` / `pnpm dev:web` | One side only, when you want a quiet log |
| `pnpm build` | Production build of every package |
| `pnpm typecheck` | Every package, plus `scripts/` |
| `pnpm test` | 124 unit and integration tests |
| `pnpm test:watch` | The same, on change |
| `pnpm test:e2e` | Playwright, end to end |
| `pnpm db:up` / `pnpm db:down` | Start or stop Postgres |
| `pnpm db:reset` | Drop the volume and rebuild schema and seed |
| `pnpm fixtures` | Regenerate `quotation_5`–`quotation_10` in `fixtures/` |

The API documents itself at http://localhost:8787/docs, which is also reachable at
http://localhost:5173/docs while the UI dev server is running.

---

## Testing

### Unit and integration

```bash
pnpm db:up      # required: the integration tests use a real Postgres
pnpm test
```

124 tests across five files. The integration tests deliberately run against real Postgres rather than
a mock, because the things most worth testing here — the transaction around the commit, the gap-free
PO number allocation, `FOR UPDATE SKIP LOCKED` in the outbox worker — are database behaviour, and a
mock would assert that the mock works.

They run offline, so they need no API key and take about three seconds.

### End to end

```bash
pnpm exec playwright install chromium   # once
pnpm db:up
pnpm test:e2e
```

Playwright starts both servers itself, so you do not need `pnpm dev` running. It will reuse servers
that are already up (`reuseExistingServer`), which makes it much faster to re-run while you are
working — but it also means a stale server on 5173 or 8787 will be used as-is. If a failure makes no
sense, stop everything on those ports and run it again.

It forces `SQ_OFFLINE=1` for the API. A live model would make the run take minutes and, worse, make
it flaky for reasons that have nothing to do with the code under test.

Two journeys. The happy path — upload, review, negotiate, curveball, convert — and a file that is
not a quotation being rejected with a readable message. They are there to catch the wiring the unit
tests cannot see: the upload form reaching the parser, the SSE stream reaching the transcript, the
Convert button reaching a purchase order. Not to re-test arithmetic that already has coverage.

```bash
pnpm exec playwright test --ui       # step through it
pnpm exec playwright show-report     # after a failure
```

Traces and screenshots are retained on failure only.

---

## Running without a model

Set `SQ_OFFLINE=1`, or simply leave the configured provider's key blank — offline is the default
whenever there is no key. Two things change:

> ### If you set `SQ_OFFLINE=0` with no key, the API refuses to start
>
> `SQ_OFFLINE=0` is an instruction to use live models. With no credentials that instruction cannot
> be carried out, so the server prints a full report and exits `1` **before opening the port**:
>
> ```
> ──────────────────────────────────────────────────────────────────────────
>
>   SQ_OFFLINE=0 asks for live model calls, but no provider is configured.
>
>   Model requested   openai/gpt-4o-mini
>   Provider          openai (gpt-4o-mini)
>   Looked for        OPENAI_API_KEY                  not set
>
>   Pick one:
>
>   1. Run without AI. This is the default and needs no account:
>
>        unset SQ_OFFLINE          # or SQ_OFFLINE=1
>   ...
> ```
>
> It names the model you asked for, the provider that implies, every environment variable it looked
> in, and the three ways out: run offline, add a hosted key, or point at a local Ollama.
>
> **It fails rather than warns on purpose.** Every model call is wrapped in a fallback to the
> offline agent, so without this check a keyless `SQ_OFFLINE=0` would 401 on every call, fall back
> silently, and produce a negotiation that completes normally and picks a sensible winner while
> being entirely scripted. Nothing on screen would tell you. Refusing to start is the only version
> of that failure you cannot miss.
>
> Leaving `SQ_OFFLINE` unset is never an error. That is the default path, it needs no account, and
> the boot log says plainly which mode you are in:
>
> ```
> agents: running offline — deterministic stubs, no model calls.
>         No provider credentials were found, so this is the default.
> ```

- **The parser** skips the LLM column classifier and uses heuristics alone. It parses all ten
  fixtures correctly this way; the model is a second opinion on ambiguous headers, not the mechanism.
- **The agents** use deterministic stubs that follow a concession curve, write real English, and hit
  the same code-enforced bounds a model would. The negotiation is genuinely different per supplier
  because the numbers driving it are, but it is reproducible.

Everything else — parsing, matching, scoring, allocation, the curveball, the commit — is ordinary
code and behaves identically either way. This is deliberate: the parts that decide how the brand's
money is spent are not the parts that call a language model.

With a key set, `NEGOTIATION_MODEL` and `PARSER_MODEL` control which model is used. Every model call
falls back to its offline equivalent on failure rather than failing the request.

**The two modes feel very different, and it is worth knowing which one you are watching.** A full
four-round negotiation takes roughly 12 seconds offline and a few minutes against a hosted model,
because online it is about sixteen model calls end to end. If a demo finishes in seconds, it ran
offline. Both modes were measured on the same fixture and pick the same winner, which is the point:
the model writes the arguments, the arithmetic makes the decision.

Within a round the four suppliers are called concurrently, since none of them can see another's
answer before replying. That is what keeps a round near the latency of one model call rather than
four.

---

## Choosing a provider

Models are named `provider/model` and nothing else in the app is provider-specific, so switching is
one environment variable. Four providers are supported:

| `NEGOTIATION_MODEL` / `PARSER_MODEL` | Key to set |
| --- | --- |
| `google/gemini-2.5-flash` | `GOOGLE_GENERATIVE_AI_API_KEY` (or `GOOGLE_API_KEY`) |
| `openai/gpt-4o-mini` | `OPENAI_API_KEY` |
| `anthropic/claude-sonnet-4-5` | `ANTHROPIC_API_KEY` |
| `ollama/gpt-oss:120b` | `OLLAMA_API_KEY` |

Whether the app runs online is decided by the provider its model ids name, so you only ever need the
one key you are actually using. Setting a model id for a provider with no key leaves the app offline
rather than failing at the first call.

**Ollama** is the one provider Mastra's router does not ship with, so it is wired through Mastra's
OpenAI-compatible config against `https://ollama.com/v1`. The `/v1` matters: `/api` is Ollama's native
protocol and returns 404 to an OpenAI client. To use a local Ollama instead of the hosted one, set
`OLLAMA_BASE_URL=http://localhost:11434/v1` and leave the key blank — a local daemon needs no auth,
and the base URL alone is enough to mark the provider configured.

**Ollama Cloud does not enforce JSON schemas at all**, which is worth knowing because the failure is
silent. It accepts `response_format: json_schema` on the OpenAI-compatible endpoint *and* the
native `format` field on `/api/chat`, and honours neither: asked for a structured offer without
being told the key names, `gpt-oss:120b` returns a formatted business letter. No model on the cloud
tier behaved differently — `deepseek-v4-flash:0731`, `qwen3.5:397b`, `gemma4:31b`,
`mistral-large-3:675b` and `glm-5.3-flash` all ignore it.

The agents therefore spell the response shape out in the prompt as well as in the schema (see
`OUTPUT_CONTRACT` in `apps/api/src/agents/prompts.ts`). That is redundant against providers that
enforce a schema and it is the only thing that works against providers that do not. With it,
`gpt-oss:120b` returns a valid offer in seven to nine seconds; without it, every supplier turn fails
validation and falls back to the offline stub.

**That fallback is the thing to watch for.** A negotiation running entirely on stubs still completes
and still picks the same winner, so online and offline look alike from the UI. The console is where
the difference shows:

```
[agents] supplier_1 round 1 fell back to the offline agent: Structured output validation failed
```

If you see that repeatedly, the model is not actually driving the negotiation.

Ollama Cloud serves a subset of the Ollama library, and some entries carry dated tags.
`curl https://ollama.com/api/tags -H "Authorization: Bearer $OLLAMA_API_KEY"` lists what is actually
servable. A bare name that exists in the local library is not necessarily servable hosted, and a tag
can be retired outright — `qwen3-coder:480b` now answers `410 Gone`.

Two things are worth knowing before running against a **local** Ollama, both measured on `qwen3.5:9b`:

- Reasoning models are slow enough here to change the demo. One structured call took 214 seconds on
  an M-series laptop against the 9B model, versus about a second for the same call to a hosted
  model. The negotiation still completes, but expect the offline stubs to answer most rounds.
- Reasoning models can loop at `temperature: 0`. The same request that returns valid JSON in 32
  seconds at the default temperature produced nothing at all in over 300 at zero. The parser's
  classifier is the one call that asks for zero, and it has its own 15-second budget for exactly this
  reason.

Any agent call that outruns `MODEL_TIMEOUT_MS` (60s by default) is abandoned and answered by the
offline stub, so a stalled provider costs one round its flavour rather than stalling the request.

---

## Environment

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://sq:sq@localhost:5433/smart_quotation` | 5433 on the host to avoid clashing with a local Postgres |
| `NEGOTIATION_MODEL` | `google/gemini-2.5-flash` | `provider/model`; see [Choosing a provider](#choosing-a-provider) |
| `PARSER_MODEL` | `google/gemini-2.5-flash` | As above |
| `GOOGLE_GENERATIVE_AI_API_KEY` | empty | Also accepts `GOOGLE_API_KEY` |
| `OPENAI_API_KEY` | empty | |
| `ANTHROPIC_API_KEY` | empty | |
| `OLLAMA_API_KEY` | empty | Ollama Cloud; not needed for a local Ollama |
| `OLLAMA_BASE_URL` | `https://ollama.com/v1` | Point at `http://localhost:11434/v1` for a local Ollama |
| `SQ_OFFLINE` | unset | `1` forces offline, `0` forces online |
| `MODEL_TIMEOUT_MS` | `60000` | Per agent call; the offline stub answers past it |
| `API_PORT` | `8787` | |
| `CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | |

---

## How it works

```
XLSX ──▶ parse ──▶ match to products.csv ──▶ basket
                                               │
                                               ▼
                        brand agent opens ──▶ 4 supplier agents bid
                                               │
                                  ┌────────────┴────────────┐
                                  │  round 1 done: SUSPEND  │
                                  │  "supplier 2 can only   │
                                  │   do 60%" — RESUME      │
                                  └────────────┬────────────┘
                                               ▼
                              rounds 2–3 ──▶ score every plan
                                               │
                                               ▼
                              award ──▶ convert ──▶ purchase order(s)
                                                        │
                                                        ▼
                                          outbox: notify, reserve, schedule, post
```

**A negotiation runs in the background.** Starting one returns immediately: the workflow is a Mastra
run with its snapshots in Postgres, so it survives an API restart and does not need the browser to
stay open. The `Negotiations` tab lists them all with live status, which is how you get back to one
you walked away from — useful when a live model takes minutes per round. The negotiation page streams
the transcript over SSE when you are watching, and that is the only difference.

Five things are worth knowing about the design.

**The parser is not told what the file looks like.** It finds the data region by looking for runs of
rows that behave like line items, classifies columns by header text and by what the values actually
are, and cross-checks with arithmetic — if column C equals A times B down the block, C is the line
total whatever its header says. Merged cells are expanded, Excel's float noise is snapped back, and
where the printed total disagrees with quantity times price, the total is recomputed and the row is
flagged rather than silently trusted.

**Matching is tiered and honest about doubt.** Exact, then normalised, then zero-padded, then a
bounded fuzzy pass. Each tier carries its own confidence, and where more than one catalog SKU is
close, the alternatives are kept and shown. The UI colours the dot by confidence so a human can see
which rows were read through a typo.

**The negotiation is basket-level and multi-lever.** A supplier that can only cut price has two
moves: capitulate or refuse. These have five — price, lead time, payment terms, volume rebate and
freight allowance — and every one of them is already a dimension in the scoring function, so a
concession moves the ranking through the same arithmetic as a discount. Their limits are enforced by
`clampOffer` in code. A model that promises 5-day delivery from a factory that cannot go below 12
gets pulled back, and the clamp is shown in the transcript.

**The decision is arithmetic; the agent only explains it.** `scoreOptions` is a pure function over
landed cost, quality, lead time and the cash-flow cost of the payment schedule, weighted by whatever
the brand typed in the note. The explanation the brand reads is generated from the same numbers, so
it cannot drift from the decision that was made.

**The recommendation can be overruled.** Every plan in the comparison is selectable, including the
ones that were ruled out, because the ranking is computed from priorities somebody typed into a
note and that note is never the whole brief. The purchase order records which plan was recommended
alongside the one that was bought, so an override is legible rather than invisible.

**Converting is a real commit.** One transaction writes the PO with the agreed terms frozen into
`terms_snapshot`, allocates a gap-free PO number, and enqueues the downstream effects. The effects
are delivered afterwards by a worker with retries and backoff, claimed with `FOR UPDATE SKIP LOCKED`.
A slow supplier API cannot roll back an order the brand has already agreed to, and a double-clicked
Convert returns the same PO rather than buying twice.

Longer version in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Every decision and the alternative
that was rejected is in [`docs/DECISIONS.md`](docs/DECISIONS.md).

---

## The curveball

After round one the workflow suspends. The UI offers the capacity change, and injecting it resumes
the same Mastra run with the new fact.

Nothing restarts. The offers already made stand — they are rows in `negotiation_rounds`, not state in
memory — and only one thing changes: a capacity ratio for that supplier. From there the shortfall
propagates on its own. The coverage vector shrinks, the allocator tries to place the remainder
elsewhere, MOQ repair moves quantity between suppliers rather than inflating the order, and the
scoring penalises whatever cannot be covered. The integration test asserts exactly this: the row
sequences written before the curveball are byte-identical afterwards, with new rows on top.

`suspend`/`resume` is also why this works if the process dies mid-negotiation. The run lives in
Postgres.

---

## Layout of the code

```
apps/api/src/
  parser/         read the workbook, find the table, classify columns, extract lines
  matching/       normalise SKUs, tiered catalog match
  negotiation/    pricing, coverage, allocation, award, scoring glue
  agents/         Mastra agents, prompts, offline stubs, bounds enforcement
  workflows/      the durable negotiation loop with suspend/resume
  purchase-orders/ two-stage commit, outbox worker
  http/           Hono routes with OpenAPI
apps/web/src/     React UI
packages/shared/  zod schemas and the scoring function, imported by both sides
```

The scoring function lives in `packages/shared` because the UI renders the same breakdown the API
decided with, rather than recomputing it.

---

## Documentation

This README covers running the thing. Everything else is in [`docs/`](docs/), and each file has a
job rather than being a pile of notes.

| Document | What is in it | Go there when |
| --- | --- | --- |
| [`ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Topology, the complete data flow stage by stage, the negotiation and PO state machines, the database schema with the reasoning behind each table | You want to know **how** something works — the parser's three signals, how coverage propagates, what the outbox worker actually does |
| [`DECISIONS.md`](docs/DECISIONS.md) | Every significant choice, the alternatives that were rejected, and why. Numbered and cross-referenced to the files that implement them | You want to know **why** it is built this way. Why the model does not pick the winner, why bounds are enforced in code, why POs snapshot their terms |
| [`OPEN-QUESTIONS.md`](docs/OPEN-QUESTIONS.md) | Ambiguities in the brief that were closed by assumption, each with the seam where it could be flipped. Plus a ramifications register with blast radius and mitigation | You want to know **what was assumed** and what it would cost to assume otherwise |
| [`REQUIREMENTS.md`](docs/REQUIREMENTS.md) | Every requirement traced to the file and test that satisfies it, plus the deliberate omissions | You are checking coverage against the brief |
| [`GLOSSARY.md`](docs/GLOSSARY.md) | Sourcing vocabulary — MOQ, landed cost, incoterms, tier pricing — with terms invented for this project marked as such | A term in the code or the UI is unfamiliar |
| [`PLAN.md`](docs/PLAN.md) | The implementation plan as it stood while building: data findings, schema, risks, task list | You want the archaeology of how this was sequenced |

### The API reference

The API describes itself. With the server running:

- **http://localhost:8787/docs** — Swagger UI, with every route, schema and example. Also proxied to
  http://localhost:5173/docs so the link in the UI sidebar works.
- **http://localhost:8787/openapi.json** — the raw spec, if you want to generate a client.

The spec is generated from the same Zod schemas the routes validate with, so it cannot describe a
request shape the API would reject.

Responses are described rather than validated — re-parsing a typed view model on the way out would
cost work and catch nothing. What keeps those descriptions honest is the compiler: each response
schema in `apps/api/src/http/schemas.ts` is `satisfies Describes<T>` against the type the handler
actually returns, so a view model that gains a field fails the build until the schema gains it too.
Wiring that up immediately caught three handlers that could answer `null` where the route promised
an object.

---

## Walkthrough

A recorded explanation of how the system works, in three parts:

1. [Part 1](https://cap.so/s/7887wzaz46p7zrp)
2. [Part 2](https://cap.so/s/f347y97d7e1waqe)
3. [Part 3](https://cap.so/s/gmpwrk5tcn8abmk)

---

## Troubleshooting

**`pnpm install` fails on an engine check.** `node -v` is below 22.13. A version manager is the fix;
see [What you need](#what-you-need).

**`pnpm: command not found`, or pnpm is version 9.** `corepack enable` — Node ships it, and it reads
the `packageManager` field to pick the right version.

**`pnpm db:up` hangs, then "postgres did not become ready within 60s".** Docker is not running, or
the container is unhealthy. `docker compose ps` and `docker compose logs postgres` will say which.

**`ECONNREFUSED ::1:5433` or `role "sq" does not exist`.** Postgres is not up, or the volume is from
an older schema. `pnpm db:reset`.

**`[db] idle client dropped; the pool will reconnect`.** Expected, and not an error. Postgres went
away underneath a pooled connection — usually because you ran `pnpm db:reset` or `docker compose
down` while the API was running. The pool discards the dead client and dials a new one on the next
query, so nothing needs restarting. If it repeats without you touching the database, that is a real
signal worth chasing.

**Port already in use.** See [When a port is already taken](#when-a-port-is-already-taken).

**Every UI request fails but the API is clearly running.** Usually the API and the UI's proxy
disagreeing about the port. Export `API_PORT` rather than setting it in `.env`.

**The API exits immediately with a boxed message about `SQ_OFFLINE=0`.** You asked for live models
and no provider key is set. The message lists every variable it checked and the three ways to fix
it; the quickest is `unset SQ_OFFLINE`. See
[Running without a model](#running-without-a-model).

**The negotiation finishes in seconds and the messages look formulaic.** It ran offline, which is
the default with no API key. That is working as intended — see
[Running without a model](#running-without-a-model).

**The negotiation takes minutes, or stalls a round.** A live model. Check the API console: model
failures and timeouts are logged with the reason before falling back to the offline stub.

**Playwright fails with "browser not found".** `pnpm exec playwright install chromium`.

**e2e failures that make no sense.** A stale dev server on 5173 or 8787 is being reused. Stop
everything on those ports and re-run.

What was deliberately left out, and what it would take.

- **Landed cost is estimated per country**, not computed from a bill of materials and an HTS code.
  Freight per unit and a duty rate by origin is a reasonable model at this level of detail and a bad
  one for actual customs. Real landed cost needs the commodity code, incoterms and a rate table.
- **The allocation repair is a heuristic**, capped at two passes. It fixes the common MOQ violation
  cheaply. It is not an optimiser and will not find the best split on an adversarial basket; that is
  a mixed-integer program, which is the right answer at a scale this exercise does not have.
- **No authentication and no tenancy.** One brand, no users, no permissions.
- **The outbox handlers log.** The delivery machinery around them — transactional enqueue, locking,
  retries, backoff, dead-lettering after five attempts — is real. The five handlers are one line each
  because there is no ERP to call.
- **Supplier quality ratings are static profile data**, as given in the brief. In practice these
  would come from receiving inspection history and would move.
- **Three suppliers, fixed.** Nothing in the schema assumes it, but the seed does.
- **PO cardinality is one per allocation.** A split award writes two. `purchase_orders.negotiation_id`
  is deliberately non-unique so several POs per supplier per negotiation stay reachable without a
  migration.

## Known rough edges

- The tier a quotation is bought at is picked by the parser and adjustable in the review screen, but
  a workbook with more than two tiers has not been exercised beyond the fixtures.
- The SSE stream polls the database every 400ms. Correct and restart-safe, but `LISTEN/NOTIFY` would
  be the right call at scale.
- A negotiation killed mid-round cannot be resumed, only re-run. A *suspended* negotiation is durable
  — it is a snapshot in Postgres, and resuming it is an explicit call — but a run halfway through a
  round has no snapshot and no record of which supplier had already answered. Those are swept into
  `failed` once they have been silent for five model timeouts, and "Run it again" restarts them
  against the same quotation, tier and note. The retry clears the partial transcript rather than
  appending to it.
- That sweep cannot tell "the process died" from "the model provider hung past every timeout" — both
  arrive as a row nobody is writing to. So the message names no cause, only what is true either way:
  it is not running, nothing was bought, and it can be started again. The cause, where there is one,
  is in the API logs.
