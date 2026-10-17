import { and, eq, sql } from "drizzle-orm";
import { pgTable, text, timestamp, vector } from "drizzle-orm/pg-core";
import type { AssistantDb } from "./brain.js";
import { getPageDoc, type Embedder } from "./engine.js";

/**
 * @adminigloo/assistant/vector — OPTIONAL vector search for the knowledge
 * pages (0.9.0).
 *
 * The assistant finds knowledge by KEYWORD out of the box: Postgres full-text
 * search, which needs no database extension and is the approach Ask Lou itself
 * runs on. A project that also wants "means the same thing in other words"
 * matching installs THIS table — which needs the pgvector extension
 * (`create extension vector`) — adds it to its drizzle schema, passes an
 * `Embedder` to the handlers, and calls `reindexPageDoc` after a page is saved.
 * Retrieval then fuses keyword and vector rankings (`rrfFuse`).
 *
 * Kept out of `./schema` on purpose: a table with a `vector` column in the
 * default schema made every install need pgvector, for a feature most never
 * turn on.
 *
 * One row per page, keyed by the page, with the company on the row so a
 * vector query is filtered by company in its own WHERE.
 */
export const assistantPageDocVectors = pgTable("assistant_page_doc_vectors", {
  pageDocId: text("page_doc_id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  /** OpenAI text-embedding-3-small is 1536 dimensions; any embedder of that size fits. */
  embedding: vector("embedding", { dimensions: 1536 }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** The SQL table name retrieval queries when an embedder is passed (it never imports this module). */
export const PAGE_DOC_VECTORS_TABLE = "assistant_page_doc_vectors";

/**
 * Embed one of a company's pages and store its vector, so vector search can
 * find it. Returns false when the page doesn't exist in that company.
 */
export async function reindexPageDoc(
  db: AssistantDb,
  embedder: Embedder,
  input: { tenantId: string; pageKey: string },
): Promise<boolean> {
  const doc = await getPageDoc(db, input.tenantId, input.pageKey);
  if (!doc) return false;
  const [vec] = await embedder.embed([`${doc.title}\n\n${doc.body}`]);
  if (!vec) return false;
  await db
    .insert(assistantPageDocVectors)
    .values({ pageDocId: doc.id, tenantId: input.tenantId, embedding: vec })
    .onConflictDoUpdate({
      target: assistantPageDocVectors.pageDocId,
      set: { embedding: vec, updatedAt: new Date() },
      // Never move a vector to another company's page.
      setWhere: sql`${assistantPageDocVectors.tenantId} = ${input.tenantId}`,
    });
  return true;
}

/** Forget a page's vector (when the page is removed). */
export async function removePageDocVector(db: AssistantDb, tenantId: string, pageDocId: string): Promise<void> {
  await db
    .delete(assistantPageDocVectors)
    .where(and(eq(assistantPageDocVectors.tenantId, tenantId), eq(assistantPageDocVectors.pageDocId, pageDocId)));
}
