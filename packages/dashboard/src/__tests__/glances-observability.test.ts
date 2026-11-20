import { afterEach, describe, expect, it } from "vitest";
import * as observability from "@adminigloo/observability/schema";
import { createPgliteDb } from "../../../testing/src/pglite.js";
import { auditGlance, errorsGlance } from "../glances/observability.js";

const NOW = new Date("2026-11-19T18:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000);

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function setup() {
  const t = await createPgliteDb({ schema: { ...observability }, logQueries: false });
  close = () => t.close();
  return t.db;
}

describe("errorsGlance", () => {
  it("says so in words when nothing is unresolved", async () => {
    const db = await setup();
    const glance = await errorsGlance({ db, now: NOW });
    expect(glance.status).toEqual({ text: "No unresolved errors.", tone: "good" });
    expect(glance.attention).toBe(0);
    expect(glance.tiles?.map((t) => t.value)).toEqual([0, 0, 0]);
    expect(glance.list?.rows).toEqual([]);
    expect(glance.spark?.points).toHaveLength(14);
  });

  it("counts unresolved, seen today and new today from the rows, and lists the most recent first", async () => {
    const db = await setup();
    await db.insert(observability.errorLog).values([
      { fingerprint: "a", message: "Old and quiet", firstSeenAt: hoursAgo(100), lastSeenAt: hoursAgo(90) },
      { fingerprint: "b", message: "Still happening", source: "api", occurrences: 7, firstSeenAt: hoursAgo(80), lastSeenAt: hoursAgo(1) },
      { fingerprint: "c", message: "Brand new", firstSeenAt: hoursAgo(2), lastSeenAt: hoursAgo(2) },
      { fingerprint: "d", message: "Fixed", firstSeenAt: hoursAgo(3), lastSeenAt: hoursAgo(3), resolvedAt: hoursAgo(1) },
    ]);
    const glance = await errorsGlance({ db, now: NOW });
    const [unresolved, seenToday, newToday] = glance.tiles ?? [];
    expect(unresolved?.value).toBe(3);
    expect(seenToday?.value).toBe(2);
    // "Fixed" was first seen today too: new is about arrival, not state.
    expect(newToday?.value).toBe(2);
    expect(glance.attention).toBe(3);
    expect(glance.status?.tone).toBe("bad");
    expect(glance.list?.rows.map((r) => r.title)).toEqual(["Still happening", "Brand new", "Old and quiet"]);
    expect(glance.list?.rows[0]).toMatchObject({ badge: "api", meta: "×7 · 1 h ago", tone: "bad" });
    expect(glance.list?.rows[2]?.tone).toBe("neutral");
    // Two first seen today (c, d), one four days ago (b), one 100 h ago (a): the last day is 2.
    expect(glance.spark?.points.at(-1)).toBe(2);
    expect(glance.spark?.points.reduce((a, b) => a + b, 0)).toBe(4);
  });
});

describe("auditGlance", () => {
  it("counts the last day's actions and flags sensitive access", async () => {
    const db = await setup();
    await db.insert(observability.auditLog).values([
      { action: "staff.role_granted", createdAt: hoursAgo(1) },
      { action: "tenant.suspended", createdAt: hoursAgo(5) },
      { action: "impersonation.started", isSensitive: true, createdAt: hoursAgo(30) },
      { action: "plan.changed", createdAt: hoursAgo(24 * 9) },
    ]);
    const glance = await auditGlance({ db, now: NOW });
    expect(glance.tiles?.[0]?.value).toBe(2);
    expect(glance.tiles?.[1]).toMatchObject({ value: 1, tone: "warn", href: "/admin/audit?sensitive=1" });
    expect(glance.status?.tone).toBe("warn");
    expect(glance.list?.rows[0]).toMatchObject({ title: "Staff role granted", meta: "1 h ago" });
    expect(glance.list?.rows[2]).toMatchObject({ badge: "Sensitive", tone: "warn" });
  });
});
