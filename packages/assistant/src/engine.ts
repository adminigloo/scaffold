import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { AssistantDb } from "./brain.js";
import type { ContentBlock } from "./provider.js";
import {
  assistantConversations,
  assistantMessages,
  assistantPageDocs,
  assistantPageDocVersions,
  assistantPendingActions,
} from "./schema.js";

/**
 * The answering engine's data layer (0.2.0): conversations and their messages,
 * page docs, and pending write-actions. Server-authoritative throughout — the
 * client never supplies history, and no tool commits a write without a row here
 * that a human confirmed.
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
  const [row] = await db
    .insert(assistantConversations)
    .values({ tenantId: input.tenantId, userId: input.userId, title: input.title ?? null })
    .returning();
  return row as ConversationRow;
}

export interface AppendMessageInput {
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
  const [agg] = await db
    .select({ max: sql<number>`coalesce(max(${assistantMessages.seq}), 0)` })
    .from(assistantMessages)
    .where(eq(assistantMessages.conversationId, input.conversationId));
  const seq = nextSeq((agg as { max: number } | undefined)?.max ?? 0);

  const [row] = await db
    .insert(assistantMessages)
    .values({
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
    .where(eq(assistantConversations.id, input.conversationId));

  return row as MessageRow;
}

export async function listConversations(
  db: AssistantDb,
  tenantId: string,
  limit = 50,
): Promise<ConversationRow[]> {
  return (await db
    .select()
    .from(assistantConversations)
    .where(eq(assistantConversations.tenantId, tenantId))
    .orderBy(desc(assistantConversations.lastMessageAt))
    .limit(limit)) as ConversationRow[];
}

export interface ConversationDetail {
  conversation: ConversationRow;
  messages: MessageRow[];
}

export async function getConversation(db: AssistantDb, id: string): Promise<ConversationDetail | null> {
  const [conversation] = await db
    .select()
    .from(assistantConversations)
    .where(eq(assistantConversations.id, id))
    .limit(1);
  if (!conversation) return null;
  const messages = (await db
    .select()
    .from(assistantMessages)
    .where(eq(assistantMessages.conversationId, id))
    .orderBy(asc(assistantMessages.seq))) as MessageRow[];
  return { conversation: conversation as ConversationRow, messages };
}

// --- Page docs -------------------------------------------------------------

export async function upsertPageDoc(
  db: AssistantDb,
  input: { tenantId: string; pageKey: string; title: string; body: string; isApproved?: boolean; createdBy?: string },
): Promise<PageDocRow> {
  const existing = await getPageDoc(db, input.tenantId, input.pageKey);
  if (existing) {
    // Snapshot the outgoing content before overwriting, like sections do.
    const [prev] = await db
      .select({ max: sql<number>`coalesce(max(${assistantPageDocVersions.versionNumber}), 0)` })
      .from(assistantPageDocVersions)
      .where(eq(assistantPageDocVersions.pageDocId, existing.id));
    const versionNumber = ((prev as { max: number } | undefined)?.max ?? 0) + 1;
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
      .where(eq(assistantPageDocs.id, existing.id))
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
      isApproved: input.isApproved ?? true,
    })
    .returning();
  return row as PageDocRow;
}

export async function getPageDoc(
  db: AssistantDb,
  tenantId: string,
  pageKey: string,
): Promise<PageDocRow | null> {
  const [row] = await db
    .select()
    .from(assistantPageDocs)
    .where(and(eq(assistantPageDocs.tenantId, tenantId), eq(assistantPageDocs.pageKey, pageKey)))
    .limit(1);
  return (row as PageDocRow) ?? null;
}

export async function listPageDocs(db: AssistantDb, tenantId: string): Promise<PageDocRow[]> {
  return (await db
    .select()
    .from(assistantPageDocs)
    .where(eq(assistantPageDocs.tenantId, tenantId))
    .orderBy(asc(assistantPageDocs.pageKey))) as PageDocRow[];
}

export interface RetrievedDoc {
  pageKey: string;
  title: string;
  body: string;
  /** Relevance: ts_rank for keyword-only, the fused RRF score when embeddings ran. */
  rank: number;
}

/**
 * Turns text into vectors. Injected (0.3) so the core package never depends on an
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
 * Rank-based, so it needs no score calibration between the two very different
 * scales (ts_rank vs cosine distance) — the reason RRF is the standard fuse.
 */
export function rrfFuse(rankings: string[][], k = 60): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1)));
  }
  return [...scores.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}

function vectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

/**
 * The page docs most relevant to a turn.
 *
 * KEYWORD by default (Postgres full-text; the '&'→'|' rewrite ORs the terms so a
 * natural question matches without containing every word). When an embedder is
 * supplied it ALSO runs a vector search and fuses the two with RRF (0.3) —
 * catching a doc that means the same thing in different words. Either way only
 * ACTIVE, APPROVED docs are eligible: a machine draft never reaches an answer
 * until a human approves it.
 */
export async function retrievePageDocs(
  db: AssistantDb,
  input: { tenantId: string; queryText: string; limit?: number; maxBodyChars?: number; embedder?: Embedder },
): Promise<RetrievedDoc[]> {
  const query = input.queryText.trim();
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

  // Keyword ranking; over-fetch so RRF has depth to fuse.
  const pool = limit * 3;
  const keywordRows = (await db
    .select({ id: assistantPageDocs.id, rank: sql<number>`ts_rank(${document}, ${tsquery})` })
    .from(assistantPageDocs)
    .where(and(eligible, sql`${document} @@ ${tsquery}`))
    .orderBy(desc(sql`ts_rank(${document}, ${tsquery})`))
    .limit(pool)) as Array<{ id: string; rank: number }>;
  const keywordIds = keywordRows.map((r) => r.id);

  let orderedIds: string[];
  const scoreById = new Map<string, number>();
  if (input.embedder) {
    const [qvec] = await input.embedder.embed([query]);
    const lit = vectorLiteral(qvec ?? []);
    const vectorRows = (await db
      .select({ id: assistantPageDocs.id })
      .from(assistantPageDocs)
      .where(and(eligible, sql`${assistantPageDocs.embedding} is not null`))
      .orderBy(sql`${assistantPageDocs.embedding} <=> ${lit}::vector`)
      .limit(pool)) as Array<{ id: string }>;
    const fused = rrfFuse([keywordIds, vectorRows.map((r) => r.id)]);
    for (const f of fused) scoreById.set(f.id, f.score);
    orderedIds = fused.slice(0, limit).map((f) => f.id);
  } else {
    for (const r of keywordRows) scoreById.set(r.id, r.rank);
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
    .where(inArray(assistantPageDocs.id, orderedIds))) as Array<{
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

/**
 * Embed one page doc and store its vector, so it becomes eligible for vector
 * search. Called after a save when an embedder is configured; returns false if
 * the doc is gone.
 */
export async function reindexPageDoc(
  db: AssistantDb,
  embedder: Embedder,
  input: { tenantId: string; pageKey: string },
): Promise<boolean> {
  const doc = await getPageDoc(db, input.tenantId, input.pageKey);
  if (!doc) return false;
  const [vec] = await embedder.embed([`${doc.title}\n\n${doc.body}`]);
  await db
    .update(assistantPageDocs)
    .set({ embedding: vec ?? null, updatedAt: new Date() })
    .where(eq(assistantPageDocs.id, doc.id));
  return true;
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

export async function getPendingAction(db: AssistantDb, id: string): Promise<PendingActionRow | null> {
  const [row] = await db
    .select()
    .from(assistantPendingActions)
    .where(eq(assistantPendingActions.id, id))
    .limit(1);
  return (row as PendingActionRow) ?? null;
}

export type ConfirmResult =
  | { confirmed: true; action: PendingActionRow }
  | { confirmed: false; reason: "not_found" | "not_pending" | "expired" };

/**
 * Confirm a pending action — but only if it's still pending and unexpired.
 * Expiry is enforced lazily here (an expired row flips to `expired` on the
 * attempt), so a stale confirm can never fire the write.
 */
export async function confirmPendingAction(
  db: AssistantDb,
  id: string,
  now: Date = new Date(),
): Promise<ConfirmResult> {
  const action = await getPendingAction(db, id);
  if (!action) return { confirmed: false, reason: "not_found" };
  if (action.status !== "pending") return { confirmed: false, reason: "not_pending" };
  if (isActionExpired(action.expiresAt, now)) {
    await db
      .update(assistantPendingActions)
      .set({ status: "expired" })
      .where(eq(assistantPendingActions.id, id));
    return { confirmed: false, reason: "expired" };
  }
  const [row] = await db
    .update(assistantPendingActions)
    .set({ status: "confirmed" })
    .where(eq(assistantPendingActions.id, id))
    .returning();
  return { confirmed: true, action: row as PendingActionRow };
}

export async function declinePendingAction(db: AssistantDb, id: string): Promise<boolean> {
  const [row] = await db
    .update(assistantPendingActions)
    .set({ status: "declined" })
    .where(and(eq(assistantPendingActions.id, id), eq(assistantPendingActions.status, "pending")))
    .returning({ id: assistantPendingActions.id });
  return row !== undefined;
}

// --- Retention & erasure ---------------------------------------------------

/** Delete a set of conversations and everything hanging off them, in FK order. */
async function deleteConversations(db: AssistantDb, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const messages = await db
    .delete(assistantMessages)
    .where(inArray(assistantMessages.conversationId, ids))
    .returning({ id: assistantMessages.id });
  await db.delete(assistantPendingActions).where(inArray(assistantPendingActions.conversationId, ids));
  await db.delete(assistantConversations).where(inArray(assistantConversations.id, ids));
  return (messages as { id: string }[]).length;
}

/**
 * Retention sweep: delete conversations idle since `olderThan`, and their
 * messages and pending actions. There are no cross-package FKs, so the cascade
 * is explicit and ordered (children first). A cron calls this; kept here so the
 * order can't drift between callers.
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
  const messages = await deleteConversations(db, ids);
  return { conversations: ids.length, messages };
}

/** Expire any pending write still unconfirmed past its deadline, so the sweep also tidies the action queue. */
export async function sweepExpiredPendingActions(db: AssistantDb, now: Date = new Date()): Promise<number> {
  const rows = await db
    .update(assistantPendingActions)
    .set({ status: "expired" })
    .where(and(eq(assistantPendingActions.status, "pending"), lt(assistantPendingActions.expiresAt, now)))
    .returning({ id: assistantPendingActions.id });
  return (rows as { id: string }[]).length;
}

/**
 * Right-to-erasure: delete every conversation (and its messages and pending
 * actions) belonging to one user in one tenant. The knowledge base and the
 * personality are the tenant's, not the user's, so they are untouched.
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
  const messages = await deleteConversations(db, ids);
  return { conversations: ids.length, messages };
}
