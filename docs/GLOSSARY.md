# Glossary

Sourcing vocabulary that appears in the code and the UI, in the sense this system uses it.

**Basket** — the full set of lines being bought, at one tier quantity. Everyone bids on the same
basket, which is what makes the offers comparable.

**Cash-flow cost** — what it costs to pay before the goods arrive. Money handed over on day 0 for
goods landing on day 50 is capital tied up for 50 days. This is why 100% upfront is genuinely worse
than 40/60 and not merely less pleasant.

**Coverage** — how much of a requested line a supplier can actually meet. Modelled per line rather
than per supplier, so a capacity cap, an unpriced tier and an unmatched SKU all share one mechanism.

**Curveball** — this exercise's mid-negotiation change: supplier 2 announcing it can only fulfil 60%
of the order after round one.

**Duty rate** — the import tax on goods from a given origin, as a fraction of value. Estimated per
country here; real customs uses an HTS commodity code.

**Effective cost** — landed cost plus cash-flow cost plus a switching penalty for running more than
one supplier. What the brand actually gives up, and what the ranking uses.

**FOB (Free On Board)** — the quoted price with the goods loaded at the origin port. Freight,
insurance and duty are the buyer's from that point. The number on the quotation.

**Incoterms** — the standard shorthand for who pays for what and where risk transfers (FOB, CIF, DDP
and so on). Named here only to say that real landed cost depends on them.

**Incumbent** — the supplier who sent the quotation being uploaded. Supplier 1 in this exercise.

**Landed cost** — FOB plus freight plus duty. What the goods cost once they are actually in the
warehouse.

**Lead time** — days from order to delivery. For a split award it is the slowest supplier in the
plan, because you wait for the last container.

**MOQ (Minimum Order Quantity)** — the smallest quantity a factory will run for a given line. Below
it they will not quote, because the setup cost is not worth it. This is why a naive split award often
produces an order nobody will accept.

**MOQ repair** — moving quantity between suppliers on a line so both sides clear their minimums.
Quantity is only ever moved, never added: buying extra goods to satisfy an arithmetic constraint is
not a fix.

**Outbox** — the pattern of writing the effects of a commit into a table inside the same transaction,
then delivering them afterwards. Prevents the two failure modes of calling out directly: holding a
lock during a network call, and losing the notification if the process dies after the commit.

**PO (Purchase Order)** — the commercial commitment to buy: supplier, lines, quantities, unit prices,
total, lead time and payment terms. Issuing one is what makes the deal real.

**Payment terms** — how the total is split across milestones. `33/33/33` is a third on order, a third
mid-production, a third on delivery. `40/60` is 40% deposit and 60% on delivery. `100` is everything
upfront.

**Quality rating** — the supplier's score out of 5. Static profile data here; in practice it comes
from receiving inspection history.

**SKU (Stock Keeping Unit)** — the code identifying one sellable variant: product, colour, size.
`products.csv` is the source of truth for which SKUs exist.

**Split award** — giving one order to more than one supplier. Cheaper on paper and more work in
practice, which is why the scoring charges a switching penalty per extra supplier.

**Tier** — a quantity break with its own price. A quotation with 1,000 and 5,000 tiers is offering
two prices per SKU depending on how many you buy.

**Volume rebate** — money returned after the fact once a quantity threshold is met, rather than a
lower price upfront. Costs the supplier the same and preserves their headline price.
