import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, lt, lte, sql } from "drizzle-orm";
import type { AssistantDb } from "./brain.js";
import { recordBrainChange } from "./brain.js";
import type { ContentBlock } from "./provider.js";
import {
  assistantConversations,
  assistantMessages,
  assistantPageDocs,
  assistantPageDocVersions,
  assistantPendingActions,
} from "./schema.js";

/**
 * The answering engine's data layer: conversations and their messages,
 * knowledge pages and FAQs, and pending write-actions. Server-authoritative
 * throughout — the client never supplies history, and no tool commits a write
 * without a row here that a human confirmed.
 *
 * 0.9.0 — EVERY QUERY NAMES THE COMPANY. A conversation, message, page or
 * action id from another company is "not found" here: the id alone never
 * reaches a row. The person is checked too where a thing is theirs (a
 * conversation is its owner's; an action is its proposer's to answer).
 */

export type ConversationRow = typeof assistantConversations.$inferSelect;
export type MessageRow = typeof assistantMessages.$inferSelect;
export type PageDocRow = typeof assistantPageDocs.$inferSelect;
export type PendingActionRow = typeof assistantPendingActions.$inferSelect;

// --- Pure helpers (unit-tested without a database) -------------------------

/** The next monotonic seq for a conversation, given the current max (0 if none). */
export function nextSeq(currentMax: number): number {
  return currentMax + 1;
}

/** A pending action is dead once its expiry has passed. */
export function isActionExpired(expiresAt: Date, now: Date = new Date()): boolean {
  return now.getTime() > expiresAt.getTime();
}

// --- Conversations & messages ----------------------------------------------

export async function createConversation(
  db: AssistantDb,
  input: { tenantId: string; userId: string; title?: string | null },
): Promise<ConversationRow> {
  if (!input.tenantId) throw new Error("createConversation needs the company");
  const [row] = await db
    .insert(assistantConversations)
    .values({ tenantId: input.tenantId, userId: input.userId, title: input.title ?? null })
    .returning();
  return row as ConversationRow;
}

export interface AppendMessageInput {
  tenantId: string;
  conversationId: string;
  role: "user" | "assistant";
  blocks: ContentBlock[];
  status?: "complete" | "truncated" | "errored";
  promptMeta?: Record<string, unknown> | null;
}

/**
 * Append a turn and stamp the conversation's lastMessageAt. Seq is assigned
 * from the current max, so it's monotonic per conversation; the unique index on
 * (conversationId, seq) is the backstop if two writers ever race.
 */
export async function appendMessage(db: AssistantDb, input: AppendMessageInput): Promise<MessageRow> {
  if (!input.tenantId) throw new Error("appendMessage needs the company");
  // The thread must be this company's: a message never lands on another
  // company's conversation, whatever id a caller passes.
  const [owner] = await db
    .select({ id: assistantConversations.id })
    .from(assistantConversations)
    .where(and(eq(assistantConversations.tenantId, input.tenantId), eq(assistantConversations.id, input.conversationId)))
    .limit(1);
  if (!owner) throw new Error("appendMessage: that conversation isn't this company's");
  const [agg] = await db
    .select({ max: sql<number>`coalesce(max(${assistantMessages.seq}), 0)` })
    .from(assistantMessages)
    .where(and(eq(assistantMessages.tenantId, input.tenantId), eq(assistantMessages.conversationId, input.conversationId)));
  const seq = nextSeq(Number((agg as { max: number } | undefined)?.max ?? 0));

  const [row] = await db
    .insert(assistantMessages)
    .values({
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      seq,
      role: input.role,
      status: input.status ?? "complete",
      blocks: input.blocks,
      promptMeta: input.promptMeta ?? null,
    })
    .returning();

  await db
    .update(assistantConversations)
    .set({ lastMessageAt: new Date() })
    .where(and(eq(assistantConversations.tenantId, input.tenantId), eq(assistantConversations.id, input.conversationId)));

  return row as MessageRow;
}

/**
 * A company's conversations, newest first — one person's (`userId`), or
 * everyone's in the company when it's omitted (for a reviewer's screen).
 */
export async function listConversations(
  db: AssistantDb,
  tenantId: string,
  options: { userId?: string; limit?: number } | number = {},
): Promise<ConversationRow[]> {
  const opts = typeof options === "number" ? { limit: options } : options;
  const where = opts.userId
    ? and(eq(assistantConversations.tenantId, tenantId), eq(assistantConversations.userId, opts.userId))
    : eq(assistantConversations.tenantId, tenantId);
  return (await db
    .select()
    .from(assistantConversations)
    .where(where)
    .orderBy(desc(assistantConversations.lastMessageAt))
    .limit(Math.min(Math.max(opts.limit ?? 50, 1), 200))) as ConversationRow[];
}

export interface ConversationDetail {
  conversation: ConversationRow;
  messages: MessageRow[];
}

/** One of the company's conversations and its messages, or null for an id that isn't the company's. */
export async function getConversation(db: AssistantDb, tenantId: string, id: string): Promise<ConversationDetail | null> {
  const [conversation] = await db
    .select()
    .from(assistantConversations)
    .where(and(eq(assistantConversations.tenantId, tenantId), eq(assistantConversations.id, id)))
    .limit(1);
  if (!conversation) return null;
  const messages = (await db
    .select()
    .from(assistantMessages)
    .where(and(eq(assistantMessages.tenantId, tenantId), eq(assistantMessages.conversationId, id)))
    .orderBy(asc(assistantMessages.seq))) as MessageRow[];
  return { conversation: conversation as ConversationRow, messages };
}

// --- Knowledge pages and FAQs ----------------------------------------------

export async function upsertPageDoc(
  db: AssistantDb,
  input: {
    tenantId: string;
    pageKey: string;
    title: string;
    body: string;
    kind?: "page" | "faq";
    isApproved?: boolean;
    createdBy?: string;
  },
): Promise<PageDocRow> {
  if (!input.tenantId) throw new Error("upsertPageDoc needs the company");
  const existing = await getPageDoc(db, input.tenantId, input.pageKey);
  if (existing) {
    // Snapshot the outgoing content before overwriting, like sections do.
    const [prev] = await db
      .select({ max: sql<number>`coalesce(max(${assistantPageDocVersions.versionNumber}), 0)` })
      .from(assistantPageDocVersions)
      .where(eq(assistantPageDocVersions.pageDocId, existing.id));
    const versionNumber = Number((prev as { max: number } | undefined)?.max ?? 0) + 1;
    await db.insert(assistantPageDocVersions).values({
      pageDocId: existing.id,
      versionNumber,
      title: existing.title,
      body: existing.body,
      createdBy: input.createdBy ?? null,
    });
    const [row] = await db
      .update(assistantPageDocs)
      .set({
        title: input.title,
        body: input.body,
        isApproved: input.isApproved ?? existing.isApproved,
        isActive: true,
        updatedAt: new Date(),
      })
      .where(and(eq(assistantPageDocs.tenantId, input.tenantId), eq(assistantPageDocs.id, existing.id)))
      .returning();
    return row as PageDocRow;
  }
  const [row] = await db
    .insert(assistantPageDocs)
    .values({
      tenantId: input.tenantId,
      pageKey: input.pageKey,
      title: input.title,
      body: input.body,
      kind: input.kind ?? "page",
      isApproved: input.isApproved ?? true,
    })
    .returning();
  return row as PageDocRow;
}

export async function getPageDoc(db: AssistantDb, tenantId: string, pageKey: string): Promise<PageDocRow | null> {
  const [row] = await db
    .select()
    .from(assistantPageDocs)
    .where(and(eq(assistantPageDocs.tenantId, tenantId), eq(assistantPageDocs.pageKey, pageKey)))
    .limit(1);
  return (row as PageDocRow) ?? null;
}

export async function listPageDocs(
  db: AssistantDb,
  tenantId: string,
  options: { kind?: "page" | "faq"; activeOnly?: boolean } = {},
): Promise<PageDocRow[]> {
  const where = [
    eq(assistantPageDocs.tenantId, tenantId),
    ...(options.kind ? [eq(assistantPageDocs.kind, options.kind)] : []),
    ...(options.activeOnly ? [eq(assistantPageDocs.isActive, true)] : []),
  ];
  return (await db
    .select()
    .from(assistantPageDocs)
    .where(and(...where))
    .orderBy(asc(assistantPageDocs.pageKey))) as PageDocRow[];
}

/** Retire one of the company's pages by id (kept, with its history); false for one that isn't the company's. */
export async function deactivatePageDoc(db: AssistantDb, tenantId: string, id: string): Promise<PageDocRow | null> {
  const [row] = await db
    .update(assistantPageDocs)
    .set({ isActive: false, updatedAt: new Date() })
    .where(and(eq(assistantPageDocs.tenantId, tenantId), eq(assistantPageDocs.id, id), eq(assistantPageDocs.isActive, true)))
    .returning();
  return (row as PageDocRow | undefined) ?? null;
}

/** An FAQ as the settings screen shows it. */
export interface FaqRow {
  id: string;
  question: string;
  answer: string;
  updatedAt: Date;
}

/** At most this many FAQs a company keeps live: plenty for a small business, and retrieval stays quick. */
export const MAX_FAQS = 200;

function faqOf(row: PageDocRow): FaqRow {
  return { id: row.id, question: row.title, answer: row.body, updatedAt: row.updatedAt };
}

/** The company's FAQs (the questions the owner answered in plain words), newest first. */
export async function listFaqs(db: AssistantDb, tenantId: string): Promise<FaqRow[]> {
  const rows = (await db
    .select()
    .from(assistantPageDocs)
    .where(and(eq(assistantPageDocs.tenantId, tenantId), eq(assistantPageDocs.kind, "faq"), eq(assistantPageDocs.isActive, true)))
    .orderBy(desc(assistantPageDocs.updatedAt))
    .limit(MAX_FAQS)) as PageDocRow[];
  return rows.map(faqOf);
}

/**
 * Lowercase, letters and numbers only — in ANY script (0.9.0: `\p{L}\p{N}`;
 * 0.8 kept only a–z and 0–9, so every Chinese or Arabic question became the
 * same empty key and overwrote the last) — accents folded: how two phrasings
 * of one question are compared.
 */
export function normalizeQuestion(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** A question's page key: its words, or — for one with no letters or numbers at all — a hash, never empty. */
export function faqKeyOf(question: string): string {
  const words = normalizeQuestion(question);
  if (words.length > 0) return `faq:${Array.from(words).slice(0, 180).join("")}`;
  return `faq:#${createHash("sha256").update(question.trim()).digest("hex").slice(0, 32)}`;
}

export type SaveFaqResult = { saved: true; faq: FaqRow } | { saved: false; reason: "not_found" | "too_many" };

/**
 * Add an FAQ, or change one (`id`). The question is its title and the answer
 * its body, so retrieval finds it by the words of either. The page key is
 * derived from the question, so asking the same question twice updates the
 * one answer rather than keeping two that may disagree.
 */
export async function saveFaq(
  db: AssistantDb,
  tenantId: string,
  input: { id?: string; question: string; answer: string },
  actor?: string,
): Promise<SaveFaqResult> {
  const question = input.question.trim().slice(0, 300);
  const answer = input.answer.trim().slice(0, 4_000);
  let pageKey = faqKeyOf(question);
  if (input.id) {
    const [current] = (await db
      .select()
      .from(assistantPageDocs)
      .where(and(eq(assistantPageDocs.tenantId, tenantId), eq(assistantPageDocs.id, input.id), eq(assistantPageDocs.kind, "faq")))
      .limit(1)) as PageDocRow[];
    if (!current) return { saved: false, reason: "not_found" };
    pageKey = current.pageKey;
  } else {
    const live = await listFaqs(db, tenantId);
    if (live.length >= MAX_FAQS && !live.some((f) => faqKeyOf(f.question) === pageKey)) {
      return { saved: false, reason: "too_many" };
    }
  }
  // "Changed" when the question already had a live answer (asked again, or
  // edited); "added" only for a new one — the change log says what happened.
  const existing = await getPageDoc(db, tenantId, pageKey);
  const row = await upsertPageDoc(db, { tenantId, pageKey, title: question, body: answer, kind: "faq", createdBy: actor });
  await recordBrainChange(db, tenantId, {
    entityType: "faq",
    entityId: row.id,
    action: existing && existing.isActive ? "updated" : "created",
    changeSummary: question.slice(0, 120),
    performedBy: actor ?? null,
  });
  return { saved: true, faq: faqOf(row) };
}

/** Remove one of the company's FAQs; false for one that isn't the company's. */
export async function removeFaq(db: AssistantDb, tenantId: string, id: string, actor?: string): Promise<boolean> {
  const [row] = (await db
    .update(assistantPageDocs)
    .set({ isActive: false, updatedAt: new Date() })
    .where(
      and(
        eq(assistantPageDocs.tenantId, tenantId),
        eq(assistantPageDocs.id, id),
        eq(assistantPageDocs.kind, "faq"),
        eq(assistantPageDocs.isActive, true),
      ),
    )
    .returning()) as PageDocRow[];
  if (!row) return false;
  await recordBrainChange(db, tenantId, {
    entityType: "faq",
    entityId: row.id,
    action: "deactivated",
    changeSummary: row.title.slice(0, 120),
    performedBy: actor ?? null,
  });
  return true;
}

/**
 * The FAQ whose question IS this message (same words, ignoring case and
 * punctuation), or null. Lets the chat answer a question the owner already
 * answered WITHOUT calling the model: the owner's own words, for nothing.
 */
export async function matchFaq(db: AssistantDb, tenantId: string, message: string): Promise<FaqRow | null> {
  const wanted = normalizeQuestion(message);
  // Two characters is a whole question in Chinese or Japanese; one is not.
  if (Array.from(wanted).length < 2) return null;
  const [row] = (await db
    .select()
    .from(assistantPageDocs)
    .where(
      and(
        eq(assistantPageDocs.tenantId, tenantId),
        eq(assistantPageDocs.kind, "faq"),
        eq(assistantPageDocs.isActive, true),
        eq(assistantPageDocs.pageKey, faqKeyOf(message)),
      ),
    )
    .limit(1)) as PageDocRow[];
  return row ? faqOf(row) : null;
}

export interface RetrievedDoc {
  pageKey: string;
  title: string;
  body: string;
  /** Relevance: ts_rank for keyword-only, the fused RRF score when embeddings ran. */
  rank: number;
}

/**
 * Turns text into vectors. Injected so the core package never depends on an
 * embeddings vendor — no embedder means retrieval stays keyword-only, a real
 * working mode (Ask Lou's own approach), not a broken one.
 */
export interface Embedder {
  dimensions: number;
  embed: (texts: string[]) => Promise<number[][]>;
}

/**
 * Reciprocal-rank fusion of several ranked id lists. A doc ranked high by EITHER
 * keyword or vector search floats up; one ranked high by BOTH floats highest.
 */
export function rrfFuse(rankings: string[][], k = 60): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1)));
  }
  return [...scores.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}

function vectorLiteral(vec: number[]): string {
  return `[${vec.map((n) => (Number.isFinite(n) ? n : 0)).join(",")}]`;
}

/**
 * The company's knowledge most relevant to a turn.
 *
 * KEYWORD by default (Postgres full-text; the '&'→'|' rewrite ORs the terms so a
 * natural question matches without containing every word) — no extension
 * needed. With an embedder (and the optional `./vector` table installed) it
 * ALSO runs a vector search and fuses the two. Either way only the company's
 * ACTIVE, APPROVED pages are eligible.
 */
export async function retrievePageDocs(
  db: AssistantDb,
  input: { tenantId: string; queryText: string; limit?: number; maxBodyChars?: number; embedder?: Embedder },
): Promise<RetrievedDoc[]> {
  const query = input.queryText.trim().slice(0, 2_000);
  if (!query) return [];
  const limit = Math.min(Math.max(input.limit ?? 3, 1), 10);
  const maxBodyChars = input.maxBodyChars ?? 1_500;
  const eligible = and(
    eq(assistantPageDocs.tenantId, input.tenantId),
    eq(assistantPageDocs.isActive, true),
    eq(assistantPageDocs.isApproved, true),
  );
  const document = sql`to_tsvector('english', ${assistantPageDocs.title} || ' ' || ${assistantPageDocs.body})`;
  const tsquery = sql`to_tsquery('english', replace(plainto_tsquery('english', ${query})::text, '&', '|'))`;

  // A question of only stop words ("what is it?") has an empty tsquery; asking
  // Postgres to match it is a notice, not a result.
  const pool = limit * 3;
  const keywordRows = (await db
    .select({ id: assistantPageDocs.id, rank: sql<number>`ts_rank(${document}, ${tsquery})` })
    .from(assistantPageDocs)
    .where(and(eligible, sql`numnode(plainto_tsquery('english', ${query})) > 0`, sql`${document} @@ ${tsquery}`))
    .orderBy(desc(sql`ts_rank(${document}, ${tsquery})`))
    .limit(pool)) as Array<{ id: string; rank: number }>;
  const keywordIds = keywordRows.map((r) => r.id);

  let orderedIds: string[];
  const scoreById = new Map<string, number>();
  if (input.embedder) {
    const [qvec] = await input.embedder.embed([query]);
    const lit = vectorLiteral(qvec ?? []);
    // The optional ./vector table, by name: this module never imports it, so a
    // keyword-only install never needs pgvector.
    const vectorRows = (await db.execute(sql`
      select v.page_doc_id as id
        from assistant_page_doc_vectors v
        join ${assistantPageDocs} d on d.id = v.page_doc_id
       where v.tenant_id = ${input.tenantId}
         and d.tenant_id = ${input.tenantId}
         and d.is_active and d.is_approved
       order by v.embedding <=> ${lit}::vector
       limit ${pool}`)) as unknown as { rows?: Array<{ id: string }> } | Array<{ id: string }>;
    const list = Array.isArray(vectorRows) ? vectorRows : (vectorRows.rows ?? []);
    const fused = rrfFuse([keywordIds, list.map((r) => r.id)]);
    for (const f of fused) scoreById.set(f.id, f.score);
    orderedIds = fused.slice(0, limit).map((f) => f.id);
  } else {
    for (const r of keywordRows) scoreById.set(r.id, Number(r.rank));
    orderedIds = keywordIds.slice(0, limit);
  }
  if (orderedIds.length === 0) return [];

  const rows = (await db
    .select({
      id: assistantPageDocs.id,
      pageKey: assistantPageDocs.pageKey,
      title: assistantPageDocs.title,
      body: assistantPageDocs.body,
    })
    .from(assistantPageDocs)
    .where(and(eq(assistantPageDocs.tenantId, input.tenantId), inArray(assistantPageDocs.id, orderedIds)))) as Array<{
    id: string;
    pageKey: string;
    title: string;
    body: string;
  }>;
  const byId = new Map(rows.map((r) => [r.id, r]));
  // Preserve the fused order; cap each body so one long doc can't blow the budget.
  return orderedIds
    .map((id) => byId.get(id))
    .filter((r): r is (typeof rows)[number] => r !== undefined)
    .map((r) => ({
      pageKey: r.pageKey,
      title: r.title,
      body: r.body.length > maxBodyChars ? `${r.body.slice(0, maxBodyChars)}…` : r.body,
      rank: scoreById.get(r.id) ?? 0,
    }));
}

// --- Pending actions -------------------------------------------------------

export async function createPendingAction(
  db: AssistantDb,
  input: {
    tenantId: string;
    conversationId: string;
    toolName: string;
    params: Record<string, unknown>;
    summary: string;
    idempotencyKey: string;
    expiresAt: Date;
    createdBy?: string;
  },
): Promise<PendingActionRow> {
  if (!input.tenantId) throw new Error("createPendingAction needs the company");
  const [row] = await db
    .insert(assistantPendingActions)
    .values({
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      toolName: input.toolName,
      params: input.params,
      summary: input.summary,
      idempotencyKey: input.idempotencyKey,
      expiresAt: input.expiresAt,
      createdBy: input.createdBy ?? null,
    })
    .returning();
  return row as PendingActionRow;
}

/** One of the company's actions, or null for an id that isn't the company's. */
export async function getPendingAction(db: AssistantDb, tenantId: string, id: string): Promise<PendingActionRow | null> {
  const [row] = await db
    .select()
    .from(assistantPendingActions)
    .where(and(eq(assistantPendingActions.tenantId, tenantId), eq(assistantPendingActions.id, id)))
    .limit(1);
  return (row as PendingActionRow) ?? null;
}

/** A conversation's actions, oldest first (the history shows each one's answer). */
export async function listPendingActions(db: AssistantDb, tenantId: string, conversationId: string): Promise<PendingActionRow[]> {
  return (await db
    .select()
    .from(assistantPendingActions)
    .where(and(eq(assistantPendingActions.tenantId, tenantId), eq(assistantPendingActions.conversationId, conversationId)))
    .orderBy(asc(assistantPendingActions.createdAt))) as PendingActionRow[];
}

export type DecideResult =
  | { decided: true; action: PendingActionRow }
  | { decided: false; reason: "not_found" | "not_pending" | "expired"; action: PendingActionRow | null };

/**
 * Answer a proposed write — "Yes, do it" or "No" — ATOMICALLY.
 *
 * ONE conditional UPDATE moves the action off "pending": it matches only the
 * company's action, proposed by THIS person, still pending, not expired. Two
 * clicks (or two tabs, or a retried request) race for that one row; exactly
 * one update returns it, and only that caller may run the write. Everyone else
 * learns why not (`not_pending`), and nothing runs twice.
 */
export async function decidePendingAction(
  db: AssistantDb,
  input: { tenantId: string; id: string; userId: string; decision: "confirm" | "decline"; now?: Date },
): Promise<DecideResult> {
  const now = input.now ?? new Date();
  const mine = and(
    eq(assistantPendingActions.tenantId, input.tenantId),
    eq(assistantPendingActions.id, input.id),
    eq(assistantPendingActions.createdBy, input.userId),
  );
  const [won] = (await db
    .update(assistantPendingActions)
    .set({ status: input.decision === "confirm" ? "confirmed" : "declined", decidedAt: now })
    .where(and(mine, eq(assistantPendingActions.status, "pending"), gt(assistantPendingActions.expiresAt, now)))
    .returning()) as PendingActionRow[];
  if (won) return { decided: true, action: won };

  const [current] = (await db.select().from(assistantPendingActions).where(mine).limit(1)) as PendingActionRow[];
  if (!current) return { decided: false, reason: "not_found", action: null };
  if (current.status !== "pending") return { decided: false, reason: "not_pending", action: current };
  // Pending but past its time: mark it expired (only if still pending) so it
  // can never be answered later.
  await db
    .update(assistantPendingActions)
    .set({ status: "expired", decidedAt: now })
    .where(and(mine, eq(assistantPendingActions.status, "pending"), lte(assistantPendingActions.expiresAt, now)));
  return { decided: false, reason: "expired", action: current };
}

export type ConfirmResult =
  | { confirmed: true; action: PendingActionRow }
  | { confirmed: false; reason: "not_found" | "not_pending" | "expired" };

/**
 * Confirm one of the company's pending actions (whoever proposed it) — the
 * 0.8 shape, kept for `createAssistantConfirmHandler`; atomic like
 * `decidePendingAction`.
 */
export async function confirmPendingAction(
  db: AssistantDb,
  tenantId: string,
  id: string,
  now: Date = new Date(),
): Promise<ConfirmResult> {
  const theirs = and(eq(assistantPendingActions.tenantId, tenantId), eq(assistantPendingActions.id, id));
  const [won] = (await db
    .update(assistantPendingActions)
    .set({ status: "confirmed", decidedAt: now })
    .where(and(theirs, eq(assistantPendingActions.status, "pending"), gt(assistantPendingActions.expiresAt, now)))
    .returning()) as PendingActionRow[];
  if (won) return { confirmed: true, action: won };
  const current = await getPendingAction(db, tenantId, id);
  if (!current) return { confirmed: false, reason: "not_found" };
  if (current.status !== "pending") return { confirmed: false, reason: "not_pending" };
  await db
    .update(assistantPendingActions)
    .set({ status: "expired", decidedAt: now })
    .where(and(theirs, eq(assistantPendingActions.status, "pending"), lte(assistantPendingActions.expiresAt, now)));
  return { confirmed: false, reason: "expired" };
}

export async function declinePendingAction(db: AssistantDb, tenantId: string, id: string): Promise<boolean> {
  const [row] = await db
    .update(assistantPendingActions)
    .set({ status: "declined", decidedAt: new Date() })
    .where(
      and(
        eq(assistantPendingActions.tenantId, tenantId),
        eq(assistantPendingActions.id, id),
        eq(assistantPendingActions.status, "pending"),
      ),
    )
    .returning({ id: assistantPendingActions.id });
  return row !== undefined;
}

// --- Retention & erasure ---------------------------------------------------

/** Delete a set of conversations (one company's, or any) and everything hanging off them, children first. */
async function deleteConversations(db: AssistantDb, tenantId: string | null, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const messages = await db
    .delete(assistantMessages)
    .where(
      tenantId === null
        ? inArray(assistantMessages.conversationId, ids)
        : and(eq(assistantMessages.tenantId, tenantId), inArray(assistantMessages.conversationId, ids)),
    )
    .returning({ id: assistantMessages.id });
  await db
    .delete(assistantPendingActions)
    .where(
      tenantId === null
        ? inArray(assistantPendingActions.conversationId, ids)
        : and(eq(assistantPendingActions.tenantId, tenantId), inArray(assistantPendingActions.conversationId, ids)),
    );
  await db
    .delete(assistantConversations)
    .where(
      tenantId === null
        ? inArray(assistantConversations.id, ids)
        : and(eq(assistantConversations.tenantId, tenantId), inArray(assistantConversations.id, ids)),
    );
  return (messages as { id: string }[]).length;
}

/**
 * Retention sweep: delete conversations idle since `olderThan`, and their
 * messages and pending actions — one company's (`tenantId`), or every
 * company's when a cron sweeps the site.
 */
export async function sweepConversations(
  db: AssistantDb,
  input: { olderThan: Date; tenantId?: string },
): Promise<{ conversations: number; messages: number }> {
  const where = input.tenantId
    ? and(lt(assistantConversations.lastMessageAt, input.olderThan), eq(assistantConversations.tenantId, input.tenantId))
    : lt(assistantConversations.lastMessageAt, input.olderThan);
  const stale = (await db
    .select({ id: assistantConversations.id })
    .from(assistantConversations)
    .where(where)) as { id: string }[];
  const ids = stale.map((s) => s.id);
  const messages = await deleteConversations(db, input.tenantId ?? null, ids);
  return { conversations: ids.length, messages };
}

/** Expire any pending write still unconfirmed past its deadline, so the sweep also tidies the action queue. */
export async function sweepExpiredPendingActions(db: AssistantDb, now: Date = new Date()): Promise<number> {
  const rows = await db
    .update(assistantPendingActions)
    .set({ status: "expired", decidedAt: now })
    .where(and(eq(assistantPendingActions.status, "pending"), lt(assistantPendingActions.expiresAt, now)))
    .returning({ id: assistantPendingActions.id });
  return (rows as { id: string }[]).length;
}

/**
 * Delete every conversation (and its messages and pending actions) belonging
 * to one person in one company. The company's knowledge and personality are
 * the company's, not the person's, so they are untouched.
 */
export async function deleteUserData(
  db: AssistantDb,
  input: { tenantId: string; userId: string },
): Promise<{ conversations: number; messages: number }> {
  const convs = (await db
    .select({ id: assistantConversations.id })
    .from(assistantConversations)
    .where(and(eq(assistantConversations.tenantId, input.tenantId), eq(assistantConversations.userId, input.userId)))) as {
    id: string;
  }[];
  const ids = convs.map((c) => c.id);
  const messages = await deleteConversations(db, input.tenantId, ids);
  return { conversations: ids.length, messages };
}
