# @adminigloo/assistant

## 0.9.1

### Patch Changes

- dba20d8: The company assistant's usage takes ai 0.3's `"feature"` limit (a feature's share of the site's day, which AI mentions added) and tells the customer the same as for the day's share. A project with both the assistant and AI mentions no longer fails to typecheck.

## 0.9.0

### Minor Changes

- b525490: An assistant for each company (0.9.0): everything it keeps belongs to one company, and it asks before it changes anything.
  
  - **Per company, every query.** Sections, house rules, glossary, change log, conversations, messages, proposed changes and knowledge pages all carry the company (`tenant_id`, no default), and every function takes it: `listSections(db, tenantId)`, `publishSection(db, tenantId, …)`, `getConversation(db, tenantId, id)`, `getPendingAction(db, tenantId, id)` and the rest. Another company's id is "not found" — it neither reads nor changes a thing. The site's own assistant is `ASSISTANT_PLATFORM` ("*"). Each company's guardrails are seeded the first time it's used (insert-if-absent per key, so a profile written first doesn't stop them).
  - **`createAssistantHandlers`** (new): one fetch handler for a company's chat, its own conversations, "Yes, do it" / "No" on a proposed change, and its settings — every route in `ASSISTANT_ADMIN_ROUTES` (also `ASSISTANT_ROUTES`), each asking `authorize(req, permission, tenantId)` for one key of the new `assistantPermissions` fragment (`assistant.use`: owner, admin, member; `assistant.settings.manage`: owner, admin). Plain-word errors in `{ error: { code, message } }`. Every refusal — who, which company, no model, the month's allowance (`allowance` seam, failing closed) — happens before a token is spent.
  - **Tools run as the person.** Each tool's permission is asked of `authorize` for the signed-in person in the company before the model sees a single tool; a write is never done in the chat — it's a proposal, and `decidePendingAction` answers it with ONE conditional update (only the person it was offered to, still pending, not expired), so a double-clicked "Yes, do it" acts once. The confirm re-checks the permission; a refused or failed run is marked `failed`. `AssistantTool.done` gives the sentence shown after it runs; a write tool must declare `summarize`.
  - **The model never does math.** Every system prompt ends with `NO_MATH_FLOOR` (no editor can remove it), and every tool result carries `TOOL_RESULT_NOTE`. Usage is reported from the provider's counts through `recordUsage`, never from the model.
  - **Spend as little as possible.** A question the owner answered as an FAQ, asked word for word, is answered with their words and NO model call (`matchFaq`); defaults are small (4 tool steps, 1,024 output tokens, 8 turns of history, 2,000-character questions, 3 knowledge pages of 1,200 characters).
  - **The business profile, FAQs, house rules and words**, written in plain words: `saveBusinessProfile`/`getBusinessProfile` (the company's own section, at the top of its cacheable prompt), `saveFaq`/`listFaqs`/`removeFaq`, `listTenantRules`, `listGlossary`, `termKeyFor`, `listChangeLog`.
  - **`./anthropic`** (new): `createAnthropicProvider({ client, model? })` — Claude Haiku 4.5 by default (`DEFAULT_ASSISTANT_MODEL`), with the two prompt-cache breakpoints (`withPromptCache`) measured on the AdminIgloo site, abort as a stop and failures as plain classes.
  - **Keyword knowledge with no extension.** The page docs' `embedding` column is gone from `./schema`; `./vector` (new, optional, pgvector) holds `assistant_page_doc_vectors` and `reindexPageDoc`. Retrieval is Postgres full-text by default and fuses vectors when an embedder is passed.
  - Fixes found on a real Postgres: a raced publish is a `conflict` again (drizzle 0.45 wraps the driver's 23505), a message can't be appended to another company's conversation, and a request already stopped stops the answer.
  - Ship `sql/assistant-0.9.0.sql`, `sql/upgrade-0.8-to-0.9.sql` (0.8's one assistant becomes '*', or the id you set with `assistant.upgrade_tenant`; safe twice) and `sql/assistant-vector-0.9.0.sql`.
  
  - After an independent review:
    - **A stop is never free.** A step cut short (Stop, a dropped connection) is priced at the input sent plus the output streamed so far — or the step's `maxTokens` when nothing came back — and marked `estimated`; `./anthropic` reports message_start's input and the streamed output on an abort. Before, the turn's cost was null and SUM() skipped it, so stopped questions never counted against the month or the site's day, and a finished tool step before the stop was lost too.
    - **Questions in flight count.** New `reserve` seam: the handler asks it, with the question's worst case (`maxInputTokens`, `maxOutputTokens`), before the model is called, and hands its `reservation` to `recordUsage` to settle. Without `reserve`, the handler still counts its own questions in flight per company (40 sent at once on a 3-question month: 3 answered). New `rateLimit` seam (per person and per company), refused with its sentence (429 `rate_limited`) before anything is spent.
    - **"Yes, do it" saves what the person saw.** A write's `fields` (default: every text parameter) travel with the `action` event and the history, shown in full on the card; confirm takes `{ edits }` for those fields only, re-parsed before the offer is used up (a bad edit is a 400 and the offer stays open), and the saved params are what was confirmed. Tool results are no longer `authoritative` unless the tool says so, every result says it is data, never instructions, and the prompt's floor says the same.
    - Stored user turns hold the question only, so an old turn's house rules, words and knowledge are never sent again; `recordUsage` gets `answered` (false for a failed or refused question, which doesn't use up a message); FAQ keys work in any script (`\p{L}\p{N}`, never empty: `faqKeyOf`); `freeStarters` on the status; `limitedBy` ("messages", "cents", "day", "site") on the allowance wire, with the site's own reset day.
  
  Breaking: every brain, engine and eval function takes the company. `createAssistantChatHandler` and `createAssistantConfirmHandler` keep working, scoped by the principal's `tenantId`.

## 0.8.1

### Patch Changes

- 9d117d3: Document the prompt-cache contract on `ProviderRequest`: an adapter should mark the end of `system` and the end of the newest message, because the loop keeps both prefixes stable (global-only system, append-only transcript, byte-equivalent rehydration). On Anthropic that is two `cache_control: { type: "ephemeral" }` breakpoints; unmarked, every step pays full price for the same tokens.

## 0.8.0

### Minor Changes

- 834bd84: Budget conversation history to the model's context window. A chat handler that
  rehydrated the entire stored transcript every turn would, on a long thread,
  eventually exceed the window and hard-fail every further turn — bricking the
  conversation with no way to recover it. `budgetHistory` now keeps the most
  recent stored turns that fit a token ceiling (whole turns, so a replay never
  severs a tool_use from its tool_result) before the model call. Ported from the
  source's message-truncation, which runs before every call for this reason.
- 88a9fe0: Add an optional AdminIgloo license gate to the feedback intake and the assistant
  chat handler. Both take a new optional `license` option ({ key, publicKey, mode })
  and, only when it is passed with `mode: "enforce"`, answer 402 for a deployment
  that does not hold a valid license for the feature — before the feedback intake
  runs or the assistant stream opens. Omitted, or `mode: "off"` (the default a
  consuming app reads from `ADMINIGLOO_LICENSE_MODE`), behaviour is unchanged, so
  every existing install keeps working. Depends on the new `@adminigloo/license`.

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
