import { and, asc, desc, eq, sql } from "drizzle-orm";
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
