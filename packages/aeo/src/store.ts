import { and, asc, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { AnswerAnalysis } from "./detect.js";
import { aeoChecks, aeoProfiles, aeoQueries } from "./schema.js";

/**
 * A COMPANY'S QUESTIONS, WHO IT IS, AND WHAT THE ANSWERS SAID (0.2). Every
 * function names its company (`tenantId`) and every query filters on it — a
 * question id of another company's is "not found", exactly like one that
 * never existed (0.1's `deactivateQuery(db, id)` and `listChecks(db, queryId)`
 * took any company's id; they don't any more).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AeoDb = PgDatabase<any, any, any>;

export type QueryRow = typeof aeoQueries.$inferSelect;
export type CheckRow = typeof aeoChecks.$inferSelect;
export type ProfileRow = typeof aeoProfiles.$inferSelect;

/** At most this many questions per company: each one is a paid answer every week. */
export const MAX_QUESTIONS = 25;

export class AeoError extends Error {
  readonly name = "AeoError";
  constructor(
    readonly code: "invalid_input" | "not_found" | "limit_reached" | "no_profile" | "off" | "closed" | "rate_limited" | "allowance",
    message: string,
  ) {
    super(message);
  }
}

const words = (max: number) =>
  z
    .array(z.string().trim().max(120))
    .max(max)
    .transform((list) => [...new Set(list.map((item) => item.replace(/\s+/g, " ").trim()).filter(Boolean))]);

export const profileSchema = z.object({
  brand: z.string().trim().min(1, "Type your business's name, the way customers say it.").max(200),
  domain: z.string().trim().max(200).nullish(),
  aliases: z.union([words(20), z.string().max(2_000).transform((text) => text.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 20))]).default([]),
  competitors: z.union([words(20), z.string().max(2_000).transform((text) => text.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 20))]).default([]),
});
export type ProfileInput = z.input<typeof profileSchema>;

export const questionSchema = z.object({
  question: z.string().trim().min(3, "Type a question a customer might ask, like “wheelchair ramp rental Raleigh”.").max(300, "Keep the question under 300 characters."),
});

/** A web address as the profile keeps it: "greenacres.com". Null for nothing; refused for something that isn't one. */
function cleanDomain(input: string | null | undefined): string | null {
  const raw = (input ?? "").trim().toLowerCase();
  if (raw === "") return null;
  try {
    const host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`).hostname.replace(/^www\./, "");
    if (!host.includes(".") || /\s/.test(host)) throw new Error("no dot");
    return host;
  } catch {
    throw new AeoError("invalid_input", `“${raw.slice(0, 80)}” isn't a web address. Type it like greenacres.com.`);
  }
}

// ---------------------------------------------------------------------------
// Who the company is
// ---------------------------------------------------------------------------

export async function getProfile(db: AeoDb, tenantId: string): Promise<ProfileRow | null> {
  const [row] = await db.select().from(aeoProfiles).where(eq(aeoProfiles.tenantId, tenantId)).limit(1);
  return (row as ProfileRow | undefined) ?? null;
}

export async function saveProfile(db: AeoDb, tenantId: string, input: ProfileInput, by: string | null = null): Promise<ProfileRow> {
  const parsed = profileSchema.safeParse(input);
  if (!parsed.success) throw new AeoError("invalid_input", parsed.error.issues[0]?.message ?? "Some details need another look.");
  const values = {
    brand: parsed.data.brand.replace(/\s+/g, " "),
    domain: cleanDomain(parsed.data.domain),
    aliases: parsed.data.aliases,
    competitors: parsed.data.competitors,
    updatedBy: by,
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(aeoProfiles)
    .values({ tenantId, ...values })
    .onConflictDoUpdate({ target: aeoProfiles.tenantId, set: values })
    .returning();
  return row as ProfileRow;
}

// ---------------------------------------------------------------------------
// The questions
// ---------------------------------------------------------------------------

export const createQuerySchema = z.object({
  tenantId: z.string().min(1).max(200),
  query: z.string().trim().min(1).max(500),
  brand: z.string().min(1).max(200).nullish(),
  domain: z.string().max(200).nullish(),
  aliases: z.array(z.string().max(120)).max(20).default([]),
  createdBy: z.string().max(200).nullish(),
});
export type CreateQueryInput = z.input<typeof createQuerySchema>;

/** Add a question for a company (0.1's shape; `addQuestion` adds the limit and the duplicate check). */
export async function createQuery(db: AeoDb, input: CreateQueryInput): Promise<QueryRow> {
  const values = createQuerySchema.parse(input);
  const [row] = await db
    .insert(aeoQueries)
    .values({ tenantId: values.tenantId, query: values.query, brand: values.brand ?? null, domain: values.domain ?? null, aliases: values.aliases, createdBy: values.createdBy ?? null })
    .returning();
  return row as QueryRow;
}

/**
 * A company's question, the way the screen adds it: trimmed, not a
 * duplicate, and under its limit (`limit`: its plan's questions, at most
 * MAX_QUESTIONS) — counted and written inside one lock per company, so two
 * adds at once can't both slip under the limit.
 */
export async function addQuestion(
  db: AeoDb,
  tenantId: string,
  question: string,
  by: string | null = null,
  limit: number | null = MAX_QUESTIONS,
): Promise<QueryRow> {
  const parsed = questionSchema.safeParse({ question });
  if (!parsed.success) throw new AeoError("invalid_input", parsed.error.issues[0]?.message ?? "Type a question.");
  const text = parsed.data.question.replace(/\s+/g, " ");
  const cap = Math.min(limit ?? MAX_QUESTIONS, MAX_QUESTIONS);
  return db.transaction(async (tx: AeoDb) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`adminigloo:aeo-questions:${tenantId}`}))`);
    const active = await listQueries(tx, tenantId);
    if (active.some((q) => q.query.toLowerCase() === text.toLowerCase())) throw new AeoError("invalid_input", "That question is already on the list.");
    if (active.length >= cap) {
      throw new AeoError(
        "limit_reached",
        cap < MAX_QUESTIONS
          ? `Your plan tracks up to ${cap} question${cap === 1 ? "" : "s"}. Remove one to add another, or choose a bigger plan.`
          : `You can track up to ${cap} questions. Remove one to add another.`,
      );
    }
    return createQuery(tx, { tenantId, query: text, createdBy: by });
  });
}

/** Stop tracking one of THIS company's questions; false for another company's id (nothing changes). */
export async function deactivateQuery(db: AeoDb, tenantId: string, id: string): Promise<boolean> {
  const [row] = await db
    .update(aeoQueries)
    .set({ isActive: false })
    .where(and(eq(aeoQueries.tenantId, tenantId), eq(aeoQueries.id, id), eq(aeoQueries.isActive, true)))
    .returning({ id: aeoQueries.id });
  return row !== undefined;
}

export async function listQueries(db: AeoDb, tenantId: string): Promise<QueryRow[]> {
  return (await db
    .select()
    .from(aeoQueries)
    .where(and(eq(aeoQueries.tenantId, tenantId), eq(aeoQueries.isActive, true)))
    .orderBy(asc(aeoQueries.createdAt), asc(aeoQueries.id))) as QueryRow[];
}

/** One of this company's active questions; null for another company's id. */
export async function getQuery(db: AeoDb, tenantId: string, id: string): Promise<QueryRow | null> {
  const [row] = await db
    .select()
    .from(aeoQueries)
    .where(and(eq(aeoQueries.tenantId, tenantId), eq(aeoQueries.id, id), eq(aeoQueries.isActive, true)))
    .limit(1);
  return (row as QueryRow | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// What the answers said
// ---------------------------------------------------------------------------

export interface RecordCheckInput {
  tenantId: string;
  queryId: string;
  engine: string;
  model?: string | null;
  trigger?: "manual" | "schedule";
  /** Code's reading of the answer (analyzeAnswer). */
  analysis: AnswerAnalysis;
  /** The answer's text: only its snippet (or its opening) is kept. */
  answer: string;
  citedUrls: readonly string[];
  costMicros?: bigint | null;
  checkedAt?: Date;
}

/**
 * Keep one answer's result — for one of THIS company's questions only: a
 * question id of another company's writes nothing and returns null.
 */
export async function recordCheck(db: AeoDb, input: RecordCheckInput): Promise<CheckRow | null> {
  const owner = await getQuery(db, input.tenantId, input.queryId);
  if (!owner) return null;
  const a = input.analysis;
  const [row] = await db
    .insert(aeoChecks)
    .values({
      tenantId: input.tenantId,
      queryId: input.queryId,
      engine: input.engine,
      model: input.model ?? null,
      status: "done",
      trigger: input.trigger ?? "manual",
      cited: a.cited,
      mentioned: a.mentioned,
      sourceCited: a.sourceCited,
      matchedOn: a.matchedOn,
      matchedUrl: a.matchedUrl,
      answerSnippet: a.snippet ?? (input.answer.replace(/\s+/g, " ").trim().slice(0, 240) || null),
      citedUrls: input.citedUrls.slice(0, 20),
      competitorsNamed: a.competitorsNamed,
      costMicros: input.costMicros ?? null,
      ...(input.checkedAt ? { checkedAt: input.checkedAt } : {}),
    })
    .returning();
  return row as CheckRow;
}

/** An answer that didn't come (timed out, refused, broke): kept, so the screen says so instead of going quiet. */
export async function recordFailedCheck(
  db: AeoDb,
  input: { tenantId: string; queryId: string; engine: string; model?: string | null; trigger?: "manual" | "schedule"; error: unknown; costMicros?: bigint | null },
): Promise<CheckRow | null> {
  const owner = await getQuery(db, input.tenantId, input.queryId);
  if (!owner) return null;
  const text = input.error instanceof Error ? input.error.message : String(input.error);
  const [row] = await db
    .insert(aeoChecks)
    .values({
      tenantId: input.tenantId,
      queryId: input.queryId,
      engine: input.engine,
      model: input.model ?? null,
      status: "failed",
      trigger: input.trigger ?? "manual",
      cited: false,
      error: text.slice(0, 500),
      costMicros: input.costMicros ?? null,
    })
    .returning();
  return row as CheckRow;
}

/** One of this company's questions' answers, newest first. Another company's question id lists nothing. */
export async function listChecks(db: AeoDb, tenantId: string, queryId: string, limit = 50): Promise<CheckRow[]> {
  return (await db
    .select()
    .from(aeoChecks)
    .where(and(eq(aeoChecks.tenantId, tenantId), eq(aeoChecks.queryId, queryId)))
    .orderBy(desc(aeoChecks.checkedAt), desc(aeoChecks.id))
    .limit(Math.max(1, Math.min(limit, 200)))) as CheckRow[];
}

/** Each of these questions' newest answer (one row per question, not the company's whole history). */
export async function latestChecks(db: AeoDb, tenantId: string, queryIds: readonly string[]): Promise<Map<string, CheckRow>> {
  const out = new Map<string, CheckRow>();
  if (queryIds.length === 0) return out;
  const rows = (await db
    .selectDistinctOn([aeoChecks.queryId])
    .from(aeoChecks)
    .where(and(eq(aeoChecks.tenantId, tenantId), inArray(aeoChecks.queryId, [...queryIds])))
    .orderBy(aeoChecks.queryId, desc(aeoChecks.checkedAt), desc(aeoChecks.id))) as CheckRow[];
  for (const row of rows) out.set(row.queryId, row);
  return out;
}

export interface QueryWithLatest {
  query: QueryRow;
  latest: CheckRow | null;
}

/** Every active question with its newest answer — the dashboard row. */
export async function queriesWithLatest(db: AeoDb, tenantId: string): Promise<QueryWithLatest[]> {
  const queries = await listQueries(db, tenantId);
  const latest = await latestChecks(db, tenantId, queries.map((q) => q.id));
  return queries.map((query) => ({ query, latest: latest.get(query.id) ?? null }));
}

export interface TrendWeek {
  /** Monday of the week, YYYY-MM-DD (UTC). */
  readonly week: string;
  /** Answers that came this week. */
  readonly checks: number;
  /** Of those, how many named the business (or cited its site). */
  readonly cited: number;
}

/** Monday 00:00 UTC of `at`'s week. */
export function weekStartUtc(at: Date): Date {
  const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const offset = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - offset * 86_400_000);
}

/**
 * Each question's weeks: answers and how many named the business, counted in
 * Postgres, one row per question and week — for this company's questions,
 * over the last `weeks` weeks (default 8), oldest week first, empty weeks
 * included as zeros.
 */
export async function questionTrends(db: AeoDb, tenantId: string, options: { weeks?: number; now?: Date; queryIds?: readonly string[] } = {}): Promise<Map<string, TrendWeek[]>> {
  const weeks = Math.max(1, Math.min(options.weeks ?? 8, 52));
  const firstWeek = weekStartUtc(new Date((options.now ?? new Date()).getTime() - (weeks - 1) * 7 * 86_400_000));
  const week = sql<string>`to_char(date_trunc('week', ${aeoChecks.checkedAt} at time zone 'UTC'), 'YYYY-MM-DD')`;
  const rows = (await db
    .select({ queryId: aeoChecks.queryId, week, checks: count(), cited: sql<number>`count(*) filter (where ${aeoChecks.cited})::int` })
    .from(aeoChecks)
    .where(
      and(
        eq(aeoChecks.tenantId, tenantId),
        eq(aeoChecks.status, "done"),
        gte(aeoChecks.checkedAt, firstWeek),
        ...(options.queryIds ? [inArray(aeoChecks.queryId, [...options.queryIds])] : []),
      ),
    )
    .groupBy(aeoChecks.queryId, week)) as { queryId: string; week: string; checks: number | string; cited: number | string }[];
  const labels: string[] = [];
  for (let i = 0; i < weeks; i += 1) labels.push(new Date(firstWeek.getTime() + i * 7 * 86_400_000).toISOString().slice(0, 10));
  const out = new Map<string, TrendWeek[]>();
  for (const row of rows) {
    const series = out.get(row.queryId) ?? labels.map((w) => ({ week: w, checks: 0, cited: 0 }));
    const at = labels.indexOf(row.week);
    if (at >= 0) series[at] = { week: row.week, checks: Number(row.checks), cited: Number(row.cited) };
    out.set(row.queryId, series);
  }
  for (const id of options.queryIds ?? []) if (!out.has(id)) out.set(id, labels.map((w) => ({ week: w, checks: 0, cited: 0 })));
  return out;
}

export interface CheckCostSummary {
  /** Checks with a known cost in the window. */
  readonly checks: number;
  /** Their total, in micros (a decimal string: JSON has no bigint). */
  readonly totalMicros: string;
  /** The average per check, in micros, rounded once; null with no checks. */
  readonly averageMicros: string | null;
}

/**
 * What checks really cost, measured (the provider's counts, priced in code):
 * one company's, or every company's (tenantId omitted), since `since`.
 */
export async function checkCosts(db: AeoDb, input: { readonly since: Date; readonly tenantId?: string }): Promise<CheckCostSummary> {
  const [row] = (await db
    .select({ checks: count(), total: sql<string>`coalesce(sum(${aeoChecks.costMicros}), 0)::text` })
    .from(aeoChecks)
    .where(
      and(
        gte(aeoChecks.checkedAt, input.since),
        sql`${aeoChecks.costMicros} is not null`,
        ...(input.tenantId !== undefined ? [eq(aeoChecks.tenantId, input.tenantId)] : []),
      ),
    )) as { checks: number | string; total: string }[];
  const checks = Number(row?.checks ?? 0);
  const total = BigInt(row?.total ?? "0");
  return { checks, totalMicros: total.toString(), averageMicros: checks > 0 ? ((total + BigInt(checks) / 2n) / BigInt(checks)).toString() : null };
}
