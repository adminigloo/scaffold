---
"@adminigloo/create-app": minor
---

Add field-service overlays and flags: `--estimator`, `--scheduling`, `--invoicing`,
`--comms`, `--aeo` (each also promptable and `add`-able). A project generated with
them gets the quote → book → bill spine plus comms and answer-engine citation
tracking:

- estimator: a pricing/takeoff engine, a public instant-estimate page, a
  cross-origin embed handler (client-key authenticated) for a widget on the
  customer's own site, and a staff price-book builder + estimates list.
- scheduling: a public drive-time-aware slots/request-a-booking flow and a staff
  calendar, resources and availability.
- invoicing: invoices with a public pay-by-token page and a staff ledger.
- comms: templated messages with a CRON_SECRET-guarded cron drain and a staff
  console; senders are injected.
- aeo: answer-engine citation tracking with a staff dashboard.

Each overlay is standalone and composable. Where the testbed cross-wires them (a
booking confirmation through comms; a photo takeoff or citation check through a
model), the overlay ships that glue as a degrading, wire-it-yourself stub — a
static overlay cannot conditionally depend on a sibling overlay, and the
generated project builds credential-free and degrades to a notice, never a 500.
