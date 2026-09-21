import { and, asc, desc, eq } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { z } from "zod";
import { detectCitation, type CitationTarget } from "./detect.js";
import { aeoChecks, aeoQueries } from "./schema.js";

export * from "./detect.js";
export { aeoChecks, aeoQueries } from "./schema.js";

export type AeoDb = PgDatabase<any, any, any>;

export type QueryRow = typeof aeoQueries.$inferSelect;
export type CheckRow = typeof aeoChecks.$inferSelect;

export const createQuerySchema = z.object({
  tenantId: z.string().min(1).max(200),
  query: z.string().min(1).max(500),
  brand: z.string().min(1).max(200),
  domain: z.string().max(200).nullish(),
  aliases: z.array(z.string().max(120)).max(20).default([]),
});
export type CreateQueryInput = z.input<typeof createQuerySchema>;

export async function createQuery(db: AeoDb, input: CreateQueryInput): Promise<QueryRow> {
  const values = createQuerySchema.parse(input);
  const [row] = await db.insert(aeoQueries).values({ ...values, domain: values.domain ?? null }).returning();
  return row as QueryRow;
}

export async function deactivateQuery(db: AeoDb, id: string): Promise<boolean> {
  const [row] = await db
    .update(aeoQueries)
    .set({ isActive: false })
    .where(eq(aeoQueries.id, id))
    .returning({ id: aeoQueries.id });
  return row !== undefined;
}

export async function listQueries(db: AeoDb, tenantId: string): Promise<QueryRow[]> {
  return (await db
    .select()
    .from(aeoQueries)
    .where(and(eq(aeoQueries.tenantId, tenantId), eq(aeoQueries.isActive, true)))
    .orderBy(asc(aeoQueries.createdAt))) as QueryRow[];
}

export async function recordCheck(
  db: AeoDb,
  input: { tenantId: string; queryId: string; engine: string; answer: string; target: CitationTarget },
): Promise<CheckRow> {
  const result = detectCitation(input.answer, input.target);
  const [row] = await db
    .insert(aeoChecks)
    .values({
      tenantId: input.tenantId,
      queryId: input.queryId,
      engine: input.engine,
      cited: result.cited,
      matchedOn: result.matchedOn,
      answerSnippet: input.answer.slice(0, 600),
    })
    .returning();
  return row as CheckRow;
}

export async function listChecks(db: AeoDb, queryId: string, limit = 50): Promise<CheckRow[]> {
  return (await db
    .select()
    .from(aeoChecks)
    .where(eq(aeoChecks.queryId, queryId))
    .orderBy(desc(aeoChecks.checkedAt))
    .limit(limit)) as CheckRow[];
}

export interface QueryWithLatest {
  query: QueryRow;
  latest: CheckRow | null;
}

/** Every active query with its most recent check — the dashboard row. */
export async function queriesWithLatest(db: AeoDb, tenantId: string): Promise<QueryWithLatest[]> {
  const queries = await listQueries(db, tenantId);
  const checks = (await db
    .select()
    .from(aeoChecks)
    .where(eq(aeoChecks.tenantId, tenantId))
    .orderBy(desc(aeoChecks.checkedAt))) as CheckRow[];
  const latestByQuery = new Map<string, CheckRow>();
  for (const c of checks) {
    if (!latestByQuery.has(c.queryId)) latestByQuery.set(c.queryId, c);
  }
  return queries.map((query) => ({ query, latest: latestByQuery.get(query.id) ?? null }));
}

/**
 * Ask an engine each tracked query and record whether it cited the brand. The
 * asker is injected — the app wires it to its own model client (metered), or to
 * a different engine — so this package owns the detection and the record, not
 * the provider. An asker that returns null (rate-limited, no key) is skipped.
 */
export async function runCitationChecks(
  db: AeoDb,
  tenantId: string,
  ask: (query: string) => Promise<string | null>,
  engine: string,
): Promise<{ checked: number; cited: number }> {
  const queries = await listQueries(db, tenantId);
  let checked = 0;
  let cited = 0;
  for (const q of queries) {
    const answer = await ask(q.query);
    if (answer === null) continue;
    const row = await recordCheck(db, {
      tenantId,
      queryId: q.id,
      engine,
      answer,
      target: { brand: q.brand, domain: q.domain, aliases: q.aliases },
    });
    checked += 1;
    if (row.cited) cited += 1;
  }
  return { checked, cited };
}
