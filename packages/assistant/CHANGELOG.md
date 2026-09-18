# @adminigloo/assistant

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
