import { and, count, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PageAudit, SeoCheck } from "./audit.js";
import { SeoReportsError, type SeoReportResult, type SiteCheckResult } from "./crawl.js";
import { seoReports } from "./schema.js";

/**
 * THE RECEIPTS, PER COMPANY (0.2). Every function names its company
 * (`tenantId`) and every query filters on it: another company's report id is
 * null — "not found", like one that never existed.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SeoDb = PgDatabase<any, any, any>;

/** A check still "running" after this long died with its process: it no longer blocks or counts. */
export const STALE_RUNNING_MS = 3 * 60_000;

export type SiteCheckStatus = "running" | "done" | "failed";

export interface SiteCheckSummary {
  id: string;
  status: SiteCheckStatus;
  trigger: string;
  baseUrl: string;
  addresses: string[];
  startedAt: Date;
  finishedAt: Date;
  score: number;
  seoScore: number;
  aeoScore: number;
  pageCount: number;
  passCount: number;
  warnCount: number;
  failCount: number;
  stopped: string | null;
}

export interface SiteCheckRecord extends SiteCheckSummary {
  siteChecks: SeoCheck[];
  pages: PageAudit[];
}

const SUMMARY = {
  id: seoReports.id,
  status: seoReports.status,
  trigger: seoReports.trigger,
  baseUrl: seoReports.baseUrl,
  addresses: seoReports.addresses,
  startedAt: seoReports.startedAt,
  finishedAt: seoReports.finishedAt,
  score: seoReports.score,
  seoScore: seoReports.seoScore,
  aeoScore: seoReports.aeoScore,
  pageCount: seoReports.pageCount,
  passCount: seoReports.passCount,
  warnCount: seoReports.warnCount,
  failCount: seoReports.failCount,
  stopped: seoReports.stopped,
};

function startOfMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** The first of next month, 00:00 UTC: when a month's checks start again. */
export function nextMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

function asSummary(row: Record<string, unknown>): SiteCheckSummary {
  return {
    ...(row as unknown as SiteCheckSummary),
    addresses: Array.isArray(row.addresses) ? (row.addresses as string[]) : [],
    startedAt: new Date(row.startedAt as string | Date),
    finishedAt: new Date(row.finishedAt as string | Date),
    status: row.status as SiteCheckStatus,
  };
}

/**
 * "Check now" presses this calendar month (UTC) — what the plan's monthly
 * checks count. The weekly automatic check is included in every plan and
 * never counts; nor does a check that broke on our side ("failed"), or one
 * that died with its process (still "running" past STALE_RUNNING_MS).
 */
export async function siteChecksThisMonth(db: SeoDb, tenantId: string, now: Date = new Date()): Promise<number> {
  const stale = new Date(now.getTime() - STALE_RUNNING_MS);
  const [row] = await db
    .select({ n: count() })
    .from(seoReports)
    .where(
      and(
        eq(seoReports.tenantId, tenantId),
        eq(seoReports.trigger, "manual"),
        gte(seoReports.startedAt, startOfMonthUtc(now)),
        or(eq(seoReports.status, "done"), and(eq(seoReports.status, "running"), gte(seoReports.startedAt, stale))),
      ),
    );
  return Number(row?.n ?? 0);
}

export interface BeginSiteCheckInput {
  tenantId: string;
  trigger: "manual" | "schedule";
  requestedBy: string | null;
  /** What will be checked, for the row (and the screen while it runs). */
  baseUrl: string;
  addresses: string[];
  /** "Check now" presses a month: a number, or null for no limit. Never applied to the weekly check. */
  monthlyLimit: number | null;
  now?: Date;
}

/**
 * CHECK AND HOLD, AS ONE STEP. Inside a transaction holding this company's
 * lock: a check still running refuses ("running"); a "Check now" past the
 * month's presses refuses ("limit_reached") — the weekly check never does;
 * otherwise a "running" row is written and its id returned. Throws
 * SeoReportsError with the sentence to show.
 */
export async function beginSiteCheck(db: SeoDb, input: BeginSiteCheckInput): Promise<string> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx: SeoDb) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`adminigloo:seo-reports:${input.tenantId}`}))`);
    // A check that died with its process stops blocking (and counting).
    await tx
      .update(seoReports)
      .set({ status: "failed", error: "did not finish" })
      .where(and(eq(seoReports.tenantId, input.tenantId), eq(seoReports.status, "running"), lt(seoReports.startedAt, new Date(now.getTime() - STALE_RUNNING_MS))));
    const [running] = await tx
      .select({ id: seoReports.id })
      .from(seoReports)
      .where(and(eq(seoReports.tenantId, input.tenantId), eq(seoReports.status, "running")))
      .limit(1);
    if (running) throw new SeoReportsError("running", "A check is already running. It takes up to a minute.");
    if (input.trigger === "manual" && input.monthlyLimit !== null) {
      const used = await siteChecksThisMonth(tx, input.tenantId, now);
      if (used >= input.monthlyLimit) {
        const resets = nextMonthUtc(now).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
        throw new SeoReportsError(
          "limit_reached",
          `You've used this month's ${input.monthlyLimit} Check now press${input.monthlyLimit === 1 ? "" : "es"}. They start again on ${resets}; the weekly check still runs.`,
        );
      }
    }
    const [row] = await tx
      .insert(seoReports)
      .values({
        tenantId: input.tenantId,
        status: "running",
        trigger: input.trigger,
        requestedBy: input.requestedBy,
        baseUrl: input.baseUrl,
        addresses: input.addresses,
        startedAt: now,
        finishedAt: now,
        score: 0,
        seoScore: 0,
        aeoScore: 0,
        pageCount: 0,
        siteChecks: [],
        pages: [],
      })
      .returning({ id: seoReports.id });
    if (!row) throw new Error("search check insert returned no row");
    return row.id;
  });
}

/** Write a finished check's results onto its row (this company's only). */
export async function finishSiteCheck(db: SeoDb, tenantId: string, id: string, result: SiteCheckResult): Promise<void> {
  await db
    .update(seoReports)
    .set({
      status: "done",
      baseUrl: result.baseUrl,
      addresses: result.addresses,
      finishedAt: result.finishedAt,
      score: result.score,
      seoScore: result.seoScore,
      aeoScore: result.aeoScore,
      pageCount: result.pageCount,
      passCount: result.counts.pass,
      warnCount: result.counts.warn,
      failCount: result.counts.fail,
      stopped: result.stopped,
      siteChecks: result.siteChecks,
      pages: result.pages,
    })
    .where(and(eq(seoReports.tenantId, tenantId), eq(seoReports.id, id)));
}

/** Mark a check that broke on our side (it doesn't count against the month). */
export async function failSiteCheck(db: SeoDb, tenantId: string, id: string, error: unknown, at: Date = new Date()): Promise<void> {
  const text = error instanceof Error ? error.message : String(error);
  await db
    .update(seoReports)
    .set({ status: "failed", finishedAt: at, error: text.slice(0, 1_000) })
    .where(and(eq(seoReports.tenantId, tenantId), eq(seoReports.id, id)));
}

/** This company's checks, newest first. */
export async function listSiteChecks(db: SeoDb, tenantId: string, limit = 20): Promise<SiteCheckSummary[]> {
  const rows = await db
    .select(SUMMARY)
    .from(seoReports)
    .where(eq(seoReports.tenantId, tenantId))
    .orderBy(desc(seoReports.startedAt), desc(seoReports.id))
    .limit(Math.max(1, Math.min(limit, 100)));
  return rows.map((row) => asSummary(row as Record<string, unknown>));
}

/** One of this company's checks, with every piece of evidence; null for another company's id, or one that never existed. */
export async function getSiteCheck(db: SeoDb, tenantId: string, id: string): Promise<SiteCheckRecord | null> {
  const [row] = await db
    .select({ ...SUMMARY, siteChecks: seoReports.siteChecks, pages: seoReports.pages })
    .from(seoReports)
    .where(and(eq(seoReports.tenantId, tenantId), eq(seoReports.id, id)))
    .limit(1);
  if (!row) return null;
  return {
    ...asSummary(row as Record<string, unknown>),
    siteChecks: (Array.isArray(row.siteChecks) ? row.siteChecks : []) as SeoCheck[],
    pages: (Array.isArray(row.pages) ? row.pages : []) as PageAudit[],
  };
}

/** When this company's last finished check started; null when it has none. */
export async function lastSiteCheckAt(db: SeoDb, tenantId: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: seoReports.startedAt })
    .from(seoReports)
    .where(and(eq(seoReports.tenantId, tenantId), inArray(seoReports.status, ["running", "done"])))
    .orderBy(desc(seoReports.startedAt))
    .limit(1);
  return row ? new Date(row.at) : null;
}

// ---------------------------------------------------------------------------
// 0.1's names, per company now
// ---------------------------------------------------------------------------

/** Save a finished report for this company in one step (0.1's shape; the handlers use begin/finish). */
export async function saveSeoReport(db: SeoDb, tenantId: string, result: SeoReportResult | SiteCheckResult): Promise<string> {
  const all = [...result.siteChecks, ...result.pages.flatMap((page) => page.checks)];
  const counts = "counts" in result ? result.counts : { pass: all.filter((c) => c.status === "pass").length, warn: all.filter((c) => c.status === "warn").length, fail: all.filter((c) => c.status === "fail").length };
  const [row] = await db
    .insert(seoReports)
    .values({
      tenantId,
      status: "done",
      trigger: "manual",
      baseUrl: result.baseUrl,
      addresses: "addresses" in result ? result.addresses : [result.baseUrl],
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      score: result.score,
      seoScore: result.seoScore,
      aeoScore: result.aeoScore,
      pageCount: result.pageCount,
      passCount: counts.pass,
      warnCount: counts.warn,
      failCount: counts.fail,
      stopped: "stopped" in result ? result.stopped : null,
      siteChecks: result.siteChecks,
      pages: result.pages,
    })
    .returning({ id: seoReports.id });
  if (!row) throw new Error("report insert returned no row");
  return row.id;
}

export const listSeoReports = listSiteChecks;
export const getSeoReport = getSiteCheck;
