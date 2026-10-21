import { eq, inArray, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import {
  assistantChangeLog,
  assistantConfigVersion,
  assistantConversations,
  assistantDrafts,
  assistantEvalResults,
  assistantEvalRuns,
  assistantGlossary,
  assistantGoldens,
  assistantMessages,
  assistantPageDocs,
  assistantPageDocVersions,
  assistantPendingActions,
  assistantSections,
  assistantSectionVersions,
  assistantTenantRules,
} from "./schema.js";

/**
 * FORGET ONE COMPANY (create-app's "delete a company"): everything the
 * assistant keeps for `tenantId` — what it knows about the business (its
 * sections and their versions, house rules, words, pages and their versions),
 * each person's conversations and the changes it offered, its checks and
 * their results, and the counter its cached answers are checked against
 * (assistant_config_version, keyed by the company's id) — children first,
 * each statement filtered by the company's id. Run it on the deletion's transaction. The page-search index
 * (assistant_page_doc_vectors) is cleared too when the project has it. The
 * site's own assistant ("*") is never one company's.
 *
 * Returns how many rows went from each table.
 */
export async function forgetTenant(db: PgDatabase<any, any, any>, tenantId: string): Promise<Readonly<Record<string, number>>> {
  if (typeof tenantId !== "string" || tenantId.trim() === "" || tenantId === "*") {
    throw new Error("forgetTenant needs one company's id; the site's own rows (\"*\") are never forgotten.");
  }
  const one = { one: sql<number>`1` };
  const sections = db.select({ id: assistantSections.id }).from(assistantSections).where(eq(assistantSections.tenantId, tenantId));
  const docs = db.select({ id: assistantPageDocs.id }).from(assistantPageDocs).where(eq(assistantPageDocs.tenantId, tenantId));
  const runs = db.select({ id: assistantEvalRuns.id }).from(assistantEvalRuns).where(eq(assistantEvalRuns.tenantId, tenantId));
  const counts: Record<string, number> = {};
  counts["assistant_pending_actions"] = (await db.delete(assistantPendingActions).where(eq(assistantPendingActions.tenantId, tenantId)).returning(one)).length;
  counts["assistant_messages"] = (await db.delete(assistantMessages).where(eq(assistantMessages.tenantId, tenantId)).returning(one)).length;
  counts["assistant_conversations"] = (await db.delete(assistantConversations).where(eq(assistantConversations.tenantId, tenantId)).returning(one)).length;
  counts["assistant_eval_results"] = (await db.delete(assistantEvalResults).where(inArray(assistantEvalResults.runId, runs)).returning(one)).length;
  counts["assistant_eval_runs"] = (await db.delete(assistantEvalRuns).where(eq(assistantEvalRuns.tenantId, tenantId)).returning(one)).length;
  counts["assistant_goldens"] = (await db.delete(assistantGoldens).where(eq(assistantGoldens.tenantId, tenantId)).returning(one)).length;
  counts["assistant_page_doc_versions"] = (await db.delete(assistantPageDocVersions).where(inArray(assistantPageDocVersions.pageDocId, docs)).returning(one)).length;
  const vectors = await db.execute(sql`select to_regclass('assistant_page_doc_vectors') is not null as present`);
  const vectorRows = (Array.isArray(vectors) ? vectors : (vectors as { rows?: unknown[] }).rows ?? []) as { present?: unknown }[];
  if (vectorRows[0]?.present === true) {
    const gone = await db.execute(
      sql`with gone as (delete from assistant_page_doc_vectors where tenant_id = ${tenantId} returning 1) select count(*)::int as n from gone`,
    );
    const goneRows = (Array.isArray(gone) ? gone : (gone as { rows?: unknown[] }).rows ?? []) as { n?: unknown }[];
    counts["assistant_page_doc_vectors"] = Number(goneRows[0]?.n ?? 0);
  }
  counts["assistant_page_docs"] = (await db.delete(assistantPageDocs).where(eq(assistantPageDocs.tenantId, tenantId)).returning(one)).length;
  counts["assistant_section_versions"] = (await db.delete(assistantSectionVersions).where(inArray(assistantSectionVersions.sectionId, sections)).returning(one)).length;
  counts["assistant_sections"] = (await db.delete(assistantSections).where(eq(assistantSections.tenantId, tenantId)).returning(one)).length;
  counts["assistant_drafts"] = (await db.delete(assistantDrafts).where(eq(assistantDrafts.tenantId, tenantId)).returning(one)).length;
  counts["assistant_tenant_rules"] = (await db.delete(assistantTenantRules).where(eq(assistantTenantRules.tenantId, tenantId)).returning(one)).length;
  counts["assistant_glossary"] = (await db.delete(assistantGlossary).where(eq(assistantGlossary.tenantId, tenantId)).returning(one)).length;
  counts["assistant_change_log"] = (await db.delete(assistantChangeLog).where(eq(assistantChangeLog.tenantId, tenantId)).returning(one)).length;
  // Keyed by the company's id itself (no tenant_id column), never "*" (refused above).
  counts["assistant_config_version"] = (await db.delete(assistantConfigVersion).where(eq(assistantConfigVersion.id, tenantId)).returning(one)).length;
  return counts;
}
