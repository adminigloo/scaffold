# Ask Lou AI system — extraction map for Product #2

Mapped 2026-09-14 from `askLou/SquireSolutions`, ahead of extracting an
"AI that knows your business" product onto the AdminIgloo platform rails.

## Headline finding

**Ask Lou has no embeddings and no vector database.** Its "RAG" is:

1. **Lexical keyword routing** over a curated corpus (556 markdown docs +
   298 financial-concept records + an API knowledge base), scored by
   substring matching (+10 phrase / +3 term), whole-file loads truncated at
   `maxTokens * 4` chars. Four near-identical copies of the scorer exist
   (`api-kb/retrieval.ts:226`, `kb/kb-retrieval.ts:65`,
   `utils/ai/docRetrieval.ts:210`, `prompt/promptBuilder.ts:187,269`) with
   four different thresholds — consolidating them is the natural first
   commit and makes retrieval swappable for embeddings.
2. **Tool-calling over authorized tRPC procedures** (~250-entry hand
   allowlist in `ai/tools/trpc-executor.ts:94`) — the *actual* source of
   customer-specific answers. Every AI tool call re-runs the same
   `companyProcedure` auth middleware a browser request would
   (`server/api/trpc.ts:386-399`). Isolation lives in the API layer, not
   retrieval; the doc corpus is global with only `company_custom_rules`
   varying per tenant.
3. **DB-driven prompt assembly** (`prompt_sections`, `page_prompts`,
   `api_kb_sections`, `glossary_terms`, per-company rules, all versioned
   with drafts) ordered for Anthropic prompt caching
   (`prompt/promptBuilder.ts:371-594`), with a hardcoded fallback prompt of
   ~485 lines inline in `app/api/chat/route.ts:440-925`.
4. **Guardrails that are the real IP**: the NO MATH rule with a
   banned-phrase list (`route.ts:1474-1502`), `__authoritative`/"quote
   as-is" result tagging, `__divisionScope` disclosure notes, fail-closed
   tools (no companyId ⇒ no financial tools at all, `route.ts:1219`),
   AI mutations as human-approved proposals only (`ai_mutation_log` +
   `execute-action` route), per-company AI kill switch (fail-closed 503),
   Upstash rate limiting, two-phase budget reservation, 90-day chat
   retention, injection detection (log-only), PII redaction for logs.
5. **An eval + tuning loop**: golden questions (expected keywords,
   forbidden identifiers, LLM-judge assertions, a graceful-unknown
   hallucination check) run nightly with retrieval attribution
   (`docsServed[]`); an admin Prompt Tuner that turns a plain-English
   complaint into anchored prompt diffs with publish/revert audit.

Stack: Vercel AI SDK v5, `@ai-sdk/anthropic` (+openai wired but the live
chat call site hardcodes `anthropic()` at `route.ts:1991`), MySQL/
PlanetScale (so no pgvector there — but the AdminIgloo platform is
Neon/Postgres, where pgvector is native). Streaming to the client is
deliberately buffered-and-discarded around tool calls (`route.ts:2187-2235`)
— users see a spinner; reimplement as a filtering stream transform.

## Product implication

What's sellable is not textbook vector-RAG (that part would be net-new,
commodity build). The differentiated asset is a **trustworthy AI assistant
platform**: prompt ops + tenant-scoped tool calling + guardrails + evals.
Pitch trust ("answers from your live data, never invents numbers,
human-approved actions"), not "RAG". Semantic document retrieval becomes
one added capability (pgvector on the platform's Neon DB), not the
foundation.

## Platform-service vs thin-SDK split (summary)

Platform: corpus store + versioning (generalize prompt/page/kb tables to
tenant documents), single retrieval engine (keyword now, embeddings later),
prompt assembly with cache-prefix ordering, model routing tables + resolver,
tool-registration framework (host registers {name, schema, handler} — the
platform never imports a host's tRPC caller), conversation persistence +
retention cron, golden-question eval service, Prompt Tuner loop, tenant
auth/cost/budget/rate machinery.

SDK: ask-box/chat UI, streaming reader with watchdog/abort/retry,
`[[ref:kind:id|display]]` reference rendering with host-registered kinds,
followup/action pills, pending-action approval card, optional Prompt
Inspector debug panel fed by the `X-Prompt-Meta` header.

## The five couplings extraction must break

1. **Domain prompt hardcoded in the route** — `route.ts:455-760` is Lou's
   financial manual; three more domain blocks (NO MATH, fixed assets, debt)
   append unconditionally AFTER the configurable DB path. → Everything
   becomes tenant-authored prompt rows; platform ships empty + templates.
2. **Retrieval reads a git filesystem** — `docRetrieval.ts:95` manifests +
   `readFileSync` from cwd (also `kb-retrieval.ts:35`, `api-kb/retrieval.ts:204`,
   `route.ts:283+`). → All corpus reads behind a tenant-scoped store; the
   DB path in `promptCache.ts` is ~80% of it already.
3. **Hand-maintained 250-procedure registry importing the app's server
   caller** (`trpc-executor.ts:8,94`; `createEnhancedFinancialTools` takes
   11 positional params, 5 of them Ask Lou concepts). → Invert to a
   registration API; generic `{value, authoritative, scopeWarning}` result
   envelope.
4. **Page context is a 100-line finance schema** (`route.ts:96-198`) and
   the prompt builder queries finance tables directly
   (`promptCache.ts:20-21`, `getAvailablePeriods` at `promptBuilder.ts:560`).
   → Opaque context record + tenant-authored rendering template.
5. **Provider/streaming hardwired at one call site** — `route.ts:1991`
   ignores the resolver's provider; ephemeral cache control and
   `stepCountIs(12)` hardcoded; bespoke plain-text stream. → Dispatch on
   resolved provider (pattern already correct in `answer-question.ts:16`),
   config-driven caching/steps, filtering stream transform so
   `toUIMessageStreamResponse()` returns.

## Drop, don't port

`ai/run-agent-loop.ts`, `ai/answer-question.ts`, `ai/guardrails.ts`,
`ai/factuality-scorer.ts` (worth reviving in the eval service),
`ai/system-context.ts`, `ai/types.ts` — a dead earlier agent loop, zero
importers.
