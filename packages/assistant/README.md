# @adminigloo/assistant

An AI assistant for each company, installed into your own app. The owner writes what it knows in plain words — a business profile, answers to common questions, house rules, the words the business uses — and the team asks it things from any page. It looks things up through tools that run as the person asking, with that person's permissions, and it **asks before it changes anything**. The model never does math and never reports its own cost: tools hand it finished figures, and every question is metered from the provider's own token counts against a monthly allowance it checks first.

Your own site gets one too, for your staff (`ASSISTANT_PLATFORM`, `"*"`).

## What each install gets you

| You install | You get |
| --- | --- |
| `@adminigloo/assistant` | **The company handler** (`createAssistantHandlers`): the chat (streamed), each person's own conversations, "Yes, do it" / "No" on a change it offers, and the settings (profile, answers, house rules, words, the month's AI use, the change log) — one company per request, every route in `ASSISTANT_ADMIN_ROUTES` (alias `ASSISTANT_ROUTES`). **The brain and the engine**, every function of which takes the company: sections with versions, publish and rollback; house rules and glossary; conversations and messages; knowledge pages and FAQs, found by keyword; proposed changes, answered once. **The tool loop** (`runAssistantLoop`) and **the registry** (`createToolRegistry`) you fill with your own tools. **The contract**: `assistantPermissions` (the keys and their default roles), the route table, the wire types. Evals (`scoreAnswer`, goldens, runs). |
| `@adminigloo/assistant/schema` | The Drizzle tables to add to your schema and migrate. **No database extension needed.** Shipped SQL for a host without drizzle-kit: `@adminigloo/assistant/sql/assistant-0.9.0.sql` (a fresh install) and `…/sql/upgrade-0.8-to-0.9.sql` (from 0.8). |
| `@adminigloo/assistant/anthropic` | `createAnthropicProvider({ client })` — the assistant on Claude: **Claude Haiku 4.5 by default** (`DEFAULT_ASSISTANT_MODEL`, $1 in / $5 out per million tokens), any model you name, with two prompt-cache breakpoints (`withPromptCache`), a stop that's a stop, and failures as plain classes. Needs `@anthropic-ai/sdk` (an optional peer); you make the client and own the key. |
| `@adminigloo/assistant/vector` | OPTIONAL vector search: the `assistant_page_doc_vectors` table (pgvector), `reindexPageDoc`, `removePageDocVector`, and `…/sql/assistant-vector-0.9.0.sql`. Without it, knowledge is found by keyword (Postgres full-text) — a working mode, not a broken one. |
| `@adminigloo/assistant-widget` | The screens: the launcher (a floating button and a slide-over chat), history, Stop, starter questions, the "ask before acting" card, and the owner's settings under `./admin`. See [its README](../assistant-widget). |
| `@adminigloo/ai` | The ledger the allowance is counted in (`ai_usage`), `recordAiUsage`, `aiSpendSince` and `checkAiAllowance` in `@adminigloo/ai/server`. Not a dependency of this package; the seams take your own. See [its README](../ai). |

**What you still write** with npm alone: one route file mounting the handler, your `authorize` check, your tools (each a name, a description, a schema, a permission and a `run` that reads), and an `allowance` + `recordUsage` pair (four lines each over `@adminigloo/ai/server`). A project made with create-app has all of it — the company route, the site's own route, tools for the schedule, invoices and price book it installed, and the allowance wired to each company's plan. **What none of the installs give you** is under [Not included](#not-included).

## Install

The package is private, published to GitHub Packages. Add the scope to your project's `.npmrc` (commit this line — it holds no secret):

```
@adminigloo:registry=https://npm.pkg.github.com
```

Your token goes in your **user-level** `~/.npmrc`:

```
//npm.pkg.github.com/:_authToken=<a GitHub token with read:packages>
```

```bash
npm install @adminigloo/assistant @adminigloo/assistant-widget @adminigloo/ai @anthropic-ai/sdk
```

Vercel needs the same two lines in an `NPM_RC` environment variable; GitHub Actions, a `NODE_AUTH_TOKEN` secret.

Peer dependencies: `drizzle-orm ^0.45`, `zod ^3.25 || ^4`, and `@anthropic-ai/sdk >=0.122` for `./anthropic`.

## Set up a company's assistant

```ts
// app/api/app/[tenantId]/assistant/[...path]/route.ts
import Anthropic from "@anthropic-ai/sdk";
import { createAssistantHandlers, createToolRegistry } from "@adminigloo/assistant";
import { createAnthropicProvider } from "@adminigloo/assistant/anthropic";
import { checkAiAllowance, recordAiUsage } from "@adminigloo/ai/server";

const provider = process.env.ANTHROPIC_API_KEY ? createAnthropicProvider({ client: new Anthropic() }) : null;

const { handle } = createAssistantHandlers({
  db,
  resolveTenant: (req) => new URL(req.url).pathname.split("/")[3] ?? null, // the company in the PATH
  authorize: myAuthorize, // (req, permission, tenantId) → { userId } | false | Response
  provider, // null: the chat says it isn't switched on; settings still work
  tools: createToolRegistry([overdueInvoices, rememberAnswer]),
  allowance: async ({ tenantId }) => toVerdict(await checkAiAllowance(db, { tenantId, operations: ["assistant_chat"], allowance: { monthlyMessages: 300, monthlyCents: 300 }, siteDailyCents: 500 })),
  recordUsage: (turn) => recordAiUsage(db, MODEL_RATES, { tenantId: turn.tenantId, userId: turn.userId, operation: "assistant_chat", usage: { model: turn.model, inputTokens: turn.usage.inputTokens, outputTokens: turn.usage.outputTokens, cachedInputTokens: turn.usage.cacheReadTokens, cachedWriteTokens: turn.usage.cacheWriteTokens, reported: turn.usage.complete }, status: turn.aborted ? "cancelled" : "completed" }),
  starters: ["Which invoices are overdue?"],
});
export { handle as GET, handle as POST };
```

Then put `<AssistantLauncher config={{ baseUrl: `/api/app/${company.id}/assistant` }} />` on the company's pages, and `<AssistantSettings baseUrl={…} />` on its settings page.

### The order, and who may do what

Every request: the company (the path) → `authorize` for the route's one permission → an FAQ the owner already answered (answered word for word, **no model call**, free) → a model switched on → the month's allowance (`allowance`; a throw is refused — **it fails closed**) → only then the model. A refused question never spends a token.

| Key | Default roles | What it lets someone do |
| --- | --- | --- |
| `assistant.use` | owner, admin, member | Ask, see their own conversations, answer the changes offered to them |
| `assistant.settings.manage` | owner, admin | Write the profile, answers, house rules and words; see the month's AI use |

`authorize` must answer `{ userId }`: conversations are a person's, and another person's conversation is "not found" like another company's.

### Holding each question's place, and the rate limit

Pass `reserve` and the handler asks it — with the question's worst case (`maxInputTokens`, `maxOutputTokens`) — before the model is called; answer with `reserveAiAllowance` from `@adminigloo/ai/server` and settle the `reservation` in `recordUsage` (`settleAiReservation`). Questions sent at once then see each other, across every server. Without `reserve`, the handler still counts its own questions in flight per company. `rateLimit` (per person, per company) is asked before anything is spent; return `true` or a sentence.

`recordUsage` gets every question that was let through — finished, stopped (priced at what was sent and streamed: `usage.estimated`) or failed (`answered: false`: it shouldn't use up a message).

### Tools run as the person

Each tool declares the permission it needs. Before the model sees a single tool, the handler asks `authorize` that same permission for the person, in the company — so the model is offered only what the person could reach on their own screens, and a tool it names anyway is refused. Every tool reads `ctx.tenantId`, the company the person is working in; the model can't name another.

A **write** tool (`write: true`, with a `summarize` sentence) is never run during the chat. The card shows its `fields` — every text parameter by default — **in full**, and the person can change them; confirm sends `{ edits }`, re-parsed before the offer is used up, and what runs (and what the record keeps) is what they confirmed. Results are `authoritative` only when a tool says so (`authoritative: true`, for the business's own records); every result, and the prompt, say tool data is data, never instructions. It becomes a proposal the person sees as a card; "Yes, do it" calls the confirm route, which moves the proposal off "pending" in **one conditional update** (this company, this person, still pending, not expired) and only then runs it, with the person's permission checked again. A double click, two tabs or a retried request acts **once**.

### The model never does math

Every system prompt ends with `NO_MATH_FLOOR` — a line no editor can remove: quote figures exactly as a tool gave them; never calculate. Every tool result carries `TOOL_RESULT_NOTE`. Write your tools to return finished figures — counts, totals, dates and money worked out and formatted in code.

### Spending as little as possible

- Claude Haiku 4.5 by default; any model you name (`model`).
- Small by default: 4 tool steps, 1,024 output tokens, the last 8 turns of history (~6,000 tokens), questions up to 2,000 characters, at most 3 knowledge pages of 1,200 characters.
- An FAQ asked word for word is answered with no model call at all, and doesn't count against the allowance.
- Prompt caching: the company's sections are the system prompt (the cached prefix); house rules, matched words and knowledge ride in the question, so they never break the cache. (On Haiku 4.5 a prefix under 4,096 tokens isn't cached — not an error, and not billed as a write.)
- `recordUsage` is told every turn that reached the model — finished, stopped or failed — with the provider's counts.

## The wire

`ASSISTANT_ADMIN_ROUTES`, relative to where you mount the handler (`{mount}/v1/…`): `GET status`, `POST chat`, `GET conversations`, `GET conversations/{conversation}`, `POST conversations/{conversation}/messages`, `POST actions/{action}/confirm`, `POST actions/{action}/decline`, `GET settings`, `POST settings/profile`, `POST settings/rules`, `POST settings/rules/{house-rule}/remove`, `POST settings/glossary`, `POST settings/glossary/{glossary-term}/remove`, `POST settings/faqs`, `POST settings/faqs/{faq}`, `POST settings/faqs/{faq}/remove`, `GET settings/changes`. Refusals are `{ error: { code, message } }` with a plain sentence; the chat streams the events in `AssistantStreamEvent` (`start`, `text`, `step`, `action`, `error`, `done`).

## Upgrading from 0.8

0.9 gives every company its own assistant. **Every brain, engine and eval function now takes the company** (`listSections(db, tenantId)`, `publishSection(db, tenantId, input)`, `getConversation(db, tenantId, id)`, `getPendingAction(db, tenantId, id)`, `deactivateGolden(db, tenantId, id)` …), and `seedDefaultSections(db, tenantId)` seeds one company. `createAssistantChatHandler` / `createAssistantConfirmHandler` keep working, scoped by the principal's `tenantId`.

The database: run `sql/upgrade-0.8-to-0.9.sql` (safe twice). It puts 0.8's one assistant on `'*'` — or, if your site's own assistant used another id, say so first in the same session: `select set_config('assistant.upgrade_tenant', 'my-company-hq', false);`. House rules saved under 0.8's made-up `"default"` move with it; messages take their conversation's company; the page docs' `embedding` column moves to the optional `assistant_page_doc_vectors` table (kept only if pgvector was installed). A project made with create-app: run `pnpm db:generate`, then replace the assistant statements in the migration it wrote with this file (its DEPLOYMENT.md, "Upgrading").

`reindexPageDoc` moved to `@adminigloo/assistant/vector`.

## Not included

- A model of its own: you bring the key (Anthropic through `./anthropic`, or any provider behind the `ProviderAdapter` seam).
- Tools for your data: the registry is yours to fill (create-app wires the schedule, invoices and price book it installed).
- The assistant writing to your other features: the one change create-app offers is saving an answer to a common question. Anything else is yours to add as a confirmed write tool.
- Embeddings: vector search needs the optional `./vector` table, pgvector and an embedder you supply.
- Answering customers on a public page: this is the team's assistant, behind sign-in.
- Voice, file uploads and images in the chat.
- A judge model for evals: scoring is substring checks, on purpose.

## The tables

`assistant_sections`, `assistant_section_versions`, `assistant_drafts`, `assistant_tenant_rules` (house rules), `assistant_glossary`, `assistant_change_log`, `assistant_config_version`, `assistant_conversations`, `assistant_messages`, `assistant_page_docs` (pages and FAQs), `assistant_page_doc_versions`, `assistant_pending_actions`, `assistant_goldens`, `assistant_eval_runs`, `assistant_eval_results` — every company's rows under its own `tenant_id`, with no default. Optional: `assistant_page_doc_vectors` (`./vector`).
