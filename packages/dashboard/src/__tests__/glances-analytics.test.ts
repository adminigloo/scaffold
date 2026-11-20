import { afterEach, describe, expect, it } from "vitest";
import * as analyticsSchema from "@adminigloo/analytics/schema";
import { createPgliteDb } from "../../../testing/src/pglite.js";
import { visitsGlance } from "../glances/analytics.js";

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
  const t = await createPgliteDb({ schema: { ...analyticsSchema }, logQueries: false });
  close = () => t.close();
  return t.db;
}

type Db = Awaited<ReturnType<typeof setup>>;

async function trackSince(db: Db, tenantId: string, since: Date) {
  await db.insert(analyticsSchema.analyticsSites).values({ tenantId, trackingSince: since });
}

async function addSession(db: Db, tenantId: string, input: { startedAt: Date; sourceBucket: string; visitorKey?: string }) {
  await db.insert(analyticsSchema.analyticsSessions).values({
    tenantId,
    visitorKey: input.visitorKey ?? `visitor-${Math.random().toString(36).slice(2)}`,
    landingPath: "/",
    sourceBucket: input.sourceBucket,
    startedAt: input.startedAt,
    lastSeenAt: input.startedAt,
  });
}

describe("visitsGlance", () => {
  it("shows a setup card when this tenant has never recorded a visit", async () => {
    const db = await setup();
    const glance = await visitsGlance({ db, tenantId: "tenant-a", now: NOW });
    expect(glance).toEqual({
      setup: {
        text: "No website is sending visits yet. Add the tracking snippet to a page to start counting.",
        href: "/admin/analytics",
        label: "Set up analytics",
      },
    });
  });

  it("counts visits today and this week, by source, and lists where they came from", async () => {
    const db = await setup();
    await trackSince(db, "tenant-a", daysAgo(20));

    // Today: one search visit, one AI-assistant visit.
    await addSession(db, "tenant-a", { startedAt: NOW, sourceBucket: "organic" });
    await addSession(db, "tenant-a", { startedAt: hoursAgo(2), sourceBucket: "aiAssistant" });
    // Within the last 7 days, but not today.
    await addSession(db, "tenant-a", { startedAt: daysAgo(3), sourceBucket: "direct" });
    // Within the 14-day spark, but outside the last 7 days.
    await addSession(db, "tenant-a", { startedAt: daysAgo(10), sourceBucket: "organic" });

    const glance = await visitsGlance({ db, tenantId: "tenant-a", now: NOW });

    expect(glance.tiles?.map((t) => ({ label: t.label, value: t.value }))).toEqual([
      { label: "Today", value: 2 },
      { label: "Last 7 days", value: 3 },
      { label: "From AI assistants", value: 1 },
      { label: "From search engines", value: 1 },
    ]);
    expect(glance.tiles?.every((t) => t.href === "/admin/analytics")).toBe(true);
    expect(glance.status).toEqual({ text: "3 visits in the last 7 days, 2 visits today.", tone: "neutral" });

    expect(glance.spark?.points).toHaveLength(14);
    expect(glance.spark?.points.at(-1)).toBe(2);
    expect(glance.spark?.points.reduce((a, b) => a + b, 0)).toBe(4);

    // Three sources tied at one visit each: order follows SOURCE_BUCKETS
    // (aiAssistant, then organic, then direct), the stable sort's tiebreak.
    expect(glance.list?.rows).toEqual([
      { title: "AI assistants", meta: "1 visit", href: "/admin/analytics" },
      { title: "Search", meta: "1 visit", href: "/admin/analytics" },
      { title: "Direct", meta: "1 visit", href: "/admin/analytics" },
    ]);
  });

  it("never counts another tenant's visits", async () => {
    const db = await setup();
    await trackSince(db, "tenant-a", daysAgo(20));
    await addSession(db, "tenant-a", { startedAt: NOW, sourceBucket: "organic" });

    await trackSince(db, "tenant-b", daysAgo(20));
    for (let i = 0; i < 10; i += 1) await addSession(db, "tenant-b", { startedAt: NOW, sourceBucket: "organic" });

    const glanceA = await visitsGlance({ db, tenantId: "tenant-a", now: NOW });
    expect(glanceA.tiles?.map((t) => t.value)).toEqual([1, 1, 0, 1]);
    expect(glanceA.list?.rows).toEqual([{ title: "Search", meta: "1 visit", href: "/admin/analytics" }]);
  });
});
