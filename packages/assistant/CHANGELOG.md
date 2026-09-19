# @adminigloo/assistant

## 0.1.1

### Patch Changes

- Review-pass fixes to the editable brain. The prompt fingerprint now hashes
  section and tenant-rule CONTENT, not its estimated token count — two
  personalities of the same length no longer collide, so the flight recorder
  can actually tie a message to the config that produced it. `publishSection`
  wraps its four writes in a transaction and maps a raced unique-violation to
  the `conflict` its type already promised, instead of leaking a 500. Tenant
  rules and glossary terms move into the package with their own change-log
  writes and token-budget enforcement — the audit trail is now complete and
  the overlay that travels in every turn is bounded, closing the two gaps the
  router had left open. A new `listSectionsForEditor` returns each section's
  head version in one query so the admin editor stops firing one per card.
  Glossary create upserts on the key, so re-adding a removed term reactivates
  it rather than dead-ending on the unique index. Plus a correct stop-reason
  type on the loop and honest docs on the provider's history contract.

## 0.1.0

### Minor Changes

- The editable brain, and the loop it will run on. First release of the
  trustworthy AI assistant platform: the personality is database rows an admin
  edits — drafts, versions, publish, rollback, an append-only change log — with
  the flaws a year of tuning taught us designed out from the start. Content
  history lives in one place; keys are immutable; nothing hard-deletes; publish
  carries a base version and refuses a stale overwrite; rollback runs the same
  budget and identity-phrase guards as any publish. One token estimator
  enforces section budgets where they are declared. Prompt assembly splits the
  provider-cacheable global prefix from per-tenant overlays and turn-filtered
  glossary, and stamps a config fingerprint into promptMeta so behavior is
  always traceable to the config that produced it. The install seeds five core
  guardrail sections — no arithmetic, tool-sourced data only, refusal
  boundaries, internal names stay internal — each one a rule that was learned
  the hard way. Ships alongside the provider-agnostic tool loop (parallel
  calls, abort-as-truncated, cache-write accounting) and the versioned wire
  protocol its widget will speak, ready for the answering engine to consume.
