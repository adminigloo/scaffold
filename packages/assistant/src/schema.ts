import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createdAt, idColumn, logIdColumn, updatedAt } from "@adminigloo/db";
import type { ContentBlock } from "./provider.js";

/**
 * The assistant's editable brain (0.1.0).
 *
 * The whole point of these tables is that a non-engineer changes how the
 * assistant behaves — with a version history, a draft to test against, and a
 * one-click revert — without a deploy. Ask Lou proved the shape; this is the
 * Postgres port, with the flaws the reviews found designed out from the
 * start: content history lives in ONE place (the versions table; the change
 * log points at it rather than duplicating it), keys are immutable because
 * everything references them, and nothing hard-deletes.
 *
 * `tenantId`/`createdBy` are plain text with no FK — the cross-package rule
 * every schema here follows: naming @adminigloo/tenancy or /auth would force
 * them on every consumer of this one.
 */

/**
 * The personality, as rows. Concatenated in `sortOrder` to form the prompt's
 * static, provider-cacheable prefix — so ONLY global sections live here;
 * per-tenant overlays are a separate table that travels in the user message,
 * where it cannot poison the shared cache (the review's cache-economics fix).
 */
export const assistantSections = pgTable(
  "assistant_sections",
  {
    id: idColumn(),
    /**
     * Stable machine name overlays and drafts reference: "core_personality",
     * "no_math". IMMUTABLE after creation — a rename strands every reference,
     * the same rule the feedback statuses learned. The label is what people
     * see and change; the key is the identifier.
     */
    key: text("key").notNull(),
    label: text("label").notNull(),
    description: text("description"),
    content: text("content").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    /**
     * A guardrail the product ships and a buyer should not casually delete
     * (the no-math rule, the refusal boundaries). UI-guard only; the server
     * still lets an owner edit it, but flags the weight of doing so.
     */
    isCore: boolean("is_core").notNull().default(false),
    /**
     * Phrases assembly asserts are present after tenant overlays merge in —
     * "You are …", the brand name. A tenant rule that deletes the assistant's
     * identity fails the publish check rather than shipping a nameless bot.
     */
    requiredPhrases: jsonb("required_phrases").$type<string[]>().notNull().default([]),
    /**
     * ENFORCED at publish, not just metered in the UI. Ask Lou's maxTokens was
     * a number only the editor believed in; here the server refuses a save
     * that blows it, measured by the one shared estimator.
     */
    maxTokens: integer("max_tokens").notNull().default(600),
    /** Deactivate, never delete: history is never destroyed. */
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("assistant_sections_key_idx").on(table.key)],
);

/**
 * The content history — the ONE store of past content. A publish snapshots
 * the outgoing content here before overwriting the live row; a rollback is a
 * publish of an old version's content. The change log below records who and
 * why and points AT these rows rather than copying their content, so the two
 * can never disagree.
 */
export const assistantSectionVersions = pgTable(
  "assistant_section_versions",
  {
    id: idColumn(),
    sectionId: text("section_id")
      .notNull()
      .references(() => assistantSections.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    content: text("content").notNull(),
    changeSummary: text("change_summary"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("assistant_section_versions_idx").on(table.sectionId, table.versionNumber),
  ],
);

/**
 * A work-in-progress edit, testable before it goes live. `status` walks
 * draft → testing → applied; the partial unique index below enforces "one
 * active draft per target" as a database property rather than app logic that
 * holds in unit tests and races in production.
 *
 * `aiInstruction`/`aiSuggestion` are the Prompt Tuner's fields (0.4). Present
 * from 0.1 so the migration is stable before the Tuner writes through it; the
 * one-active-draft invariant is enforced by the partial unique index below,
 * and the CRUD that exercises it ships with the Tuner in 0.4.
 */
export const assistantDrafts = pgTable(
  "assistant_drafts",
  {
    id: idColumn(),
    /** "section" | "tenant_rule" — what this draft edits. */
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    content: text("content").notNull(),
    /** The plain-English complaint that prompted a tuner draft. */
    aiInstruction: text("ai_instruction"),
    /** The tuner's proposed change, in its own words. */
    aiSuggestion: text("ai_suggestion"),
    status: text("status").$type<"draft" | "testing" | "applied">().notNull().default("draft"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (table) => [
    // One live draft per target. A partial unique index is the invariant;
    // "applied" drafts fall out of it, so a target can be edited again.
    uniqueIndex("assistant_drafts_active_idx")
      .on(table.targetType, table.targetId)
      .where(sql`${table.status} <> 'applied'`),
    index("assistant_drafts_target_idx").on(table.targetType, table.targetId),
  ],
);

/**
 * The per-tenant overlay — the feature every B2B buyer asks for. A rule with
 * a `sectionKey` appends to that global section for one tenant; a null key is
 * a standalone block. This is what lets one customer say "always mention our
 * refund window" without forking the base personality.
 */
export const assistantTenantRules = pgTable(
  "assistant_tenant_rules",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    /** Matches assistant_sections.key to append; null renders standalone. */
    sectionKey: text("section_key"),
    label: text("label").notNull(),
    instruction: text("instruction").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    maxTokens: integer("max_tokens").notNull().default(200),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (table) => [index("assistant_tenant_rules_tenant_idx").on(table.tenantId, table.sortOrder)],
);

/**
 * Terms the assistant should use the buyer's way. Exact/alias matched against
 * the turn and injected as a small block — never shed under budget pressure
 * (the review's fix: filter it to matched terms instead, so it stays small).
 */
export const assistantGlossary = pgTable(
  "assistant_glossary",
  {
    id: idColumn(),
    termKey: text("term_key").notNull(),
    preferred: text("preferred").notNull(),
    aliases: jsonb("aliases").$type<string[]>().notNull().default([]),
    definition: text("definition"),
    category: text("category"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("assistant_glossary_term_idx").on(table.termKey)],
);

/**
 * Who changed the bot, when, and why. Append-only (bigserial), and it points
 * at the version it created rather than storing content — the review's
 * "one history" fix. Small enough to keep forever.
 */
export const assistantChangeLog = pgTable(
  "assistant_change_log",
  {
    id: logIdColumn(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    entityKey: text("entity_key"),
    action: text("action").notNull(),
    /** For section edits: the version row this change produced. */
    sectionId: text("section_id"),
    versionNumber: integer("version_number"),
    changeSummary: text("change_summary"),
    performedBy: text("performed_by"),
    createdAt: createdAt(),
  },
  (table) => [
    index("assistant_change_log_entity_idx").on(table.entityType, table.entityId),
  ],
);

/**
 * A single bumped counter, so a per-request assembly read can tell in one
 * cheap SELECT whether its cached view of the brain is stale — the review's
 * alternative to the source system's 2-minute TTL, which served stale
 * personalities right through the "watch it change live" demo. Bumped inside
 * every publish transaction; assembly reads config fresh per request today,
 * and this exists for the day measurement says otherwise.
 */
export const assistantConfigVersion = pgTable("assistant_config_version", {
  id: text("id").primaryKey().default("singleton"),
  version: integer("version").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// 0.2.0 — the answering engine
//
// Conversations and their messages, the page docs assembly grounds answers in,
// and the pending-action rows that gate every write behind a human confirm.
// Message content is the SAME neutral block format the provider loop speaks
// (provider.ts), so history rehydrates byte-equivalent — the property that
// makes conversations continuable and evals reproducible.
// ---------------------------------------------------------------------------

/** One chat thread. Server-authoritative — the client never supplies history. */
export const assistantConversations = pgTable(
  "assistant_conversations",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    /** The principal who owns it — indexed so erasure can find every thread. */
    userId: text("user_id").notNull(),
    title: text("title"),
    /** active | archived */
    status: text("status").notNull().default("active"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    index("assistant_conversations_tenant_idx").on(t.tenantId, t.lastMessageAt),
    index("assistant_conversations_user_idx").on(t.userId),
  ],
);

/** A turn in a conversation. `seq` is monotonic per conversation and unique. */
export const assistantMessages = pgTable(
  "assistant_messages",
  {
    id: idColumn(),
    conversationId: text("conversation_id").notNull(),
    seq: integer("seq").notNull(),
    /** user | assistant */
    role: text("role").notNull(),
    /** complete | truncated | errored — persisted via an awaited write. */
    status: text("status").notNull().default("complete"),
    /** The neutral ContentBlock[] the model saw; what we hold is what it saw. */
    blocks: jsonb("blocks").$type<ContentBlock[]>().notNull().default([]),
    /** Compact assembly record: fingerprint, block names, tier outcomes, shed events. */
    promptMeta: jsonb("prompt_meta").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("assistant_messages_seq_idx").on(t.conversationId, t.seq),
    index("assistant_messages_conversation_idx").on(t.conversationId),
  ],
);

/** What the assistant knows about a page the user might be standing on. */
export const assistantPageDocs = pgTable(
  "assistant_page_docs",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    /** Stable route key, e.g. "/admin/invoices". Immutable identity. */
    pageKey: text("page_key").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    /** A machine draft (from ingestion) a human hasn't approved yet. */
    isApproved: boolean("is_approved").notNull().default(true),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("assistant_page_docs_key_idx").on(t.tenantId, t.pageKey)],
);

export const assistantPageDocVersions = pgTable(
  "assistant_page_doc_versions",
  {
    id: logIdColumn(),
    pageDocId: text("page_doc_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    changeSummary: text("change_summary"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [index("assistant_page_doc_versions_doc_idx").on(t.pageDocId)],
);

/** A proposed write, held until a human confirms. No tool commits directly. */
export const assistantPendingActions = pgTable(
  "assistant_pending_actions",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    toolName: text("tool_name").notNull(),
    params: jsonb("params").$type<Record<string, unknown>>().notNull().default({}),
    summary: text("summary").notNull(),
    /** pending | confirmed | declined | expired */
    status: text("status").notNull().default("pending"),
    /** Dedupes a double-propose; unique so confirm is exactly-once. */
    idempotencyKey: text("idempotency_key").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("assistant_pending_actions_idem_idx").on(t.idempotencyKey),
    index("assistant_pending_actions_conversation_idx").on(t.conversationId),
  ],
);

// --- 0.4: the safety / eval loop -------------------------------------------

/**
 * A golden: a question with what a good answer must (and must not) contain. The
 * check is deterministic — substring presence, not a judge model — so an eval
 * run costs one model call per golden (the answer), never two, and a pass/fail
 * a person can read without trusting a grader.
 */
export const assistantGoldens = pgTable(
  "assistant_goldens",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    question: text("question").notNull(),
    /** Substrings the answer MUST contain (case-insensitive), all required. */
    mustInclude: jsonb("must_include").$type<string[]>().notNull().default([]),
    /** Substrings the answer must NOT contain — a safety boundary. */
    mustNotInclude: jsonb("must_not_include").$type<string[]>().notNull().default([]),
    category: text("category"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("assistant_goldens_tenant_idx").on(t.tenantId, t.isActive)],
);

/** One evaluation run: N goldens scored against the assistant at a moment. */
export const assistantEvalRuns = pgTable(
  "assistant_eval_runs",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    total: integer("total").notNull().default(0),
    passed: integer("passed").notNull().default(0),
    /** The config fingerprint this run scored, so a regression ties to a change. */
    fingerprint: text("fingerprint"),
    trigger: text("trigger").notNull().default("manual"),
    createdAt: createdAt(),
  },
  (t) => [index("assistant_eval_runs_tenant_idx").on(t.tenantId, t.createdAt)],
);

export const assistantEvalResults = pgTable(
  "assistant_eval_results",
  {
    id: logIdColumn(),
    runId: text("run_id").notNull(),
    goldenId: text("golden_id").notNull(),
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    passed: boolean("passed").notNull(),
    /** Which required substrings were missing / which forbidden ones appeared. */
    missing: jsonb("missing").$type<string[]>().notNull().default([]),
    forbidden: jsonb("forbidden").$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [index("assistant_eval_results_run_idx").on(t.runId)],
);
