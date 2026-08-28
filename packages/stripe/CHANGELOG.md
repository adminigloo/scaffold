# @adminigloo/stripe

## 0.1.0

### Minor Changes

- The Stripe primitive: sessions, signature verification, an event ledger with
  leased two-phase idempotency, and a typed handler registry.
  
  - The ledger fixes both source repos. riddler-go tracks "did I just insert
    this" in a process-local `Set`, which returns the wrong answer on the first
    delivery to a cold instance and still answers 200, so the event is dropped
    permanently. trailcards has no ledger and lets both
    `checkout.session.completed` and `payment_intent.succeeded` create orders.
  - Claims are LEASED. Without that, a handler that throws leaves the row
    existing-but-unprocessed forever, every retry defers, and Stripe disables the
    endpoint after three days — the ledger reintroducing the loss it prevents. A
    thrown handler releases its claim immediately; a dead process ages out.
  - `attempts` and `last_error` are written by the documented statements, so a row
    stuck at attempts 12 is an alert that can actually fire.
  - Owns the whole `billing.*` permission namespace, including its defaults.
    `billing.refund.issue` is sealed and seeded to nobody.
