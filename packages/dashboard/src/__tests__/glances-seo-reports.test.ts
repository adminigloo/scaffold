import { afterEach, describe, expect, it } from "vitest";
import * as seoReportsSchema from "@adminigloo/seo-reports/schema";
import type { PageAudit, SeoCheck } from "@adminigloo/seo-reports";
import { createPgliteDb } from "../../../testing/src/pglite.js";
import { searchCheckGlance } from "../glances/seo-reports.js";

const NOW = new Date("2026-11-19T18:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY_MS);
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000);

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function setup() {
  const t = await createPgliteDb({ schema: { ...seoReportsSchema }, logQueries: false });
  close = () => t.close();
  return t.db;
}

type Db = Awaited<ReturnType<typeof setup>>;

const check = (id: string, status: SeoCheck["status"], detail = ""): SeoCheck => ({ id, label: id, kind: "seo", status, detail });

async function addReport(
  db: Db,
  tenantId: string,
  input: {
    status?: "running" | "done" | "failed";
    startedAt: Date;
    finishedAt?: Date;
    score?: number;
    passCount?: number;
    warnCount?: number;
    failCount?: number;
    siteChecks?: SeoCheck[];
    pages?: PageAudit[];
  },
) {
  await db.insert(seoReportsSchema.seoReports).values({
    tenantId,
    status: input.status ?? "done",
    baseUrl: "https://example.com",
    addresses: ["https://example.com"],
    startedAt: input.startedAt,
    finishedAt: input.finishedAt ?? input.startedAt,
    score: input.score ?? 0,
    seoScore: input.score ?? 0,
    aeoScore: input.score ?? 0,
    pageCount: input.pages?.length ?? 0,
    passCount: input.passCount ?? 0,
    warnCount: input.warnCount ?? 0,
    failCount: input.failCount ?? 0,
    siteChecks: input.siteChecks ?? [],
    pages: input.pages ?? [],
  });
}

describe("searchCheckGlance", () => {
  it("shows a setup card when no check has ever run", async () => {
    const db = await setup();
    const glance = await searchCheckGlance({ db, tenantId: "tenant-a", now: NOW });
    expect(glance).toEqual({
      setup: {
        text: "No search check has run yet. Run one to see how search engines and AI assistants read your site.",
        href: "/admin/seo",
        label: "Run a check",
      },
    });
  });

  it("reads the latest finished check's counts and worklist, and notes a newer one running", async () => {
    const db = await setup();

    // An older finished check: background noise, proving "latest" means latest.
    await addReport(db, "tenant-a", { startedAt: daysAgo(14), finishedAt: daysAgo(14), score: 50, passCount: 3 });

    // The latest FINISHED check: what the card should read.
    await addReport(db, "tenant-a", {
      startedAt: daysAgo(2),
      finishedAt: daysAgo(2),
      score: 75,
      passCount: 1,
      warnCount: 2,
      failCount: 1,
      siteChecks: [check("site.robots", "pass"), check("site.sitemap", "fail", "missing")],
      pages: [
        { path: "/", checks: [check("page.title", "warn", "too short")] },
        { path: "/about", checks: [check("page.title", "warn", "too short")] },
      ],
    });

    // A newer attempt, still running: should be noted, not mistaken for "zero problems".
    await addReport(db, "tenant-a", { status: "running", startedAt: hoursAgo(1), finishedAt: hoursAgo(1) });

    const glance = await searchCheckGlance({ db, tenantId: "tenant-a", now: NOW });

    expect(glance.tiles?.map((t) => ({ label: t.label, value: t.value }))).toEqual([
      { label: "Serious problems", value: 1 },
      { label: "Worth a look", value: 2 },
      { label: "Score", value: 75 },
    ]);
    expect(glance.tiles?.every((t) => t.href === "/admin/seo")).toBe(true);
    expect(glance.attention).toBe(3);
    expect(glance.status).toEqual({ text: "1 serious problem to fix. Last checked 2 days ago.", tone: "bad" });
    expect(glance.note).toBe("A new check is running now.");

    expect(glance.list?.rows).toEqual([
      { title: "Serve a sitemap listing your pages", meta: undefined, badge: "Fix", tone: "bad", href: "/admin/seo" },
      { title: "Give each page a clear title", meta: "2 pages", badge: "Worth a look", tone: "warn", href: "/admin/seo" },
    ]);
  });

  it("never reads or counts another tenant's checks", async () => {
    const db = await setup();
    await addReport(db, "tenant-a", { startedAt: daysAgo(1), finishedAt: daysAgo(1), score: 90, failCount: 0, warnCount: 0, passCount: 5 });
    await addReport(db, "tenant-b", { startedAt: daysAgo(1), finishedAt: daysAgo(1), score: 10, failCount: 5, warnCount: 0, passCount: 0 });

    const glanceA = await searchCheckGlance({ db, tenantId: "tenant-a", now: NOW });
    expect(glanceA.tiles?.map((t) => t.value)).toEqual([0, 0, 90]);

    const glanceB = await searchCheckGlance({ db, tenantId: "tenant-b", now: NOW });
    expect(glanceB.tiles?.map((t) => t.value)).toEqual([5, 0, 10]);
  });
});
