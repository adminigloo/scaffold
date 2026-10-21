import { afterEach, describe, expect, it } from "vitest";
import { companyRowCounts, forgetReport, plantCompanyRows } from "../../../testing/src/forget.js";
import { createPgliteDb } from "../../../testing/src/pglite.js";
import { forgetTenant } from "../index.js";
import * as schema from "../schema.js";

/**
 * DELETE A COMPANY (create-app 0.37): `forgetTenant` takes every row this
 * package keeps for one company — its visits and their links, crews and their hours, and its settings —
 * and nothing of another company's. The tables are read from the database
 * itself (@adminigloo/testing/forget), so a table added later is planted and
 * checked without anyone remembering to list it here.
 */

const A = "co_forget_a";
const B = "co_forget_b";
let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

async function fresh() {
  const t = await createPgliteDb({ schema: { ...schema }, logQueries: false });
  close = () => t.close();
  return t.db;
}

describe("forgetTenant", () => {
  it("takes every row of one company from every table, children first, and leaves the other company's", async () => {
    const db = await fresh();
    const planted = await plantCompanyRows(db, [A, B]);
    expect(planted.companyTables.length).toBeGreaterThan(0);
    const before = await companyRowCounts(db, [A, B]);
    const counts = await forgetTenant(db, A);
    const report = await forgetReport(db, planted, { forgotten: A, before });
    expect(report.left, "tables still holding the forgotten company's rows").toEqual([]);
    expect(report.lost, "tables that lost the other company's rows").toEqual([]);
    // Every table it planted is one the forget answers for, with what it took.
    for (const table of [...planted.companyTables, ...planted.childTables]) {
      expect(counts[table], table).toBeGreaterThanOrEqual(1);
    }
    // Again: nothing left to take, and nothing of B's taken.
    const again = await forgetTenant(db, A);
    expect(Object.values(again).reduce((a, b) => a + b, 0)).toBe(0);
    expect(await companyRowCounts(db, [B])).toEqual(Object.fromEntries(Object.entries(before).map(([t, c]) => [t, { [B]: c[B] }])));
  });

  it("refuses the site's own rows (\"*\") and an empty id", async () => {
    const db = await fresh();
    await expect(forgetTenant(db, "*")).rejects.toThrow(/never forgotten/);
    await expect(forgetTenant(db, " ")).rejects.toThrow(/one company's id/);
  });
});

describe("the drive-time cache (review: rounded job addresses stayed after a company was deleted)", () => {
  it("drives touching the company's visits or crews' home bases go; another company's stay", async () => {
    const db = await fresh();
    const { sql } = await import("drizzle-orm");
    // A's job at 40.7608,-111.8910 and a crew based at 40.5000,-111.9000; B's job across town.
    await db.insert(schema.schedulingResources).values([
      { id: "r-a", tenantId: A, name: "Crew A", homeBaseLat: 40.5, homeBaseLng: -111.9 },
      { id: "r-b", tenantId: B, name: "Crew B" },
    ]);
    const visit = { serviceType: "visit", scheduledDate: new Date("2026-10-21T00:00:00Z"), startTime: "09:00", endTime: "10:00" };
    await db.insert(schema.schedulingBookings).values([
      { ...visit, tenantId: A, resourceId: "r-a", lat: 40.76081, lng: -111.89102 },
      { ...visit, tenantId: B, resourceId: "r-b", lat: 40.65, lng: -111.8 },
    ]);
    const drive = (originLat: number, originLng: number, destLat: number, destLng: number) => ({ originLat, originLng, destLat, destLng, durationMinutes: 20, distanceMiles: 9.5 });
    await db.insert(schema.schedulingDriveCache).values([
      drive(40.5, -111.9, 40.7608, -111.891), // A's crew to A's job
      drive(40.65, -111.8, 40.7608, -111.891), // B's job to A's job: touches A
      drive(40.65, -111.8, 40.7, -111.95), // B's own: stays
    ]);
    const counts = await forgetTenant(db, A);
    expect(counts["scheduling_drive_cache"]).toBe(2);
    const left = await db.execute(sql`select origin_lat, dest_lat from scheduling_drive_cache`);
    const rows = (Array.isArray(left) ? left : (left as { rows: unknown[] }).rows) as Array<{ origin_lat: number; dest_lat: number }>;
    expect(rows.map((r) => [Number(r.origin_lat), Number(r.dest_lat)])).toEqual([[40.65, 40.7]]);
    // NEGATIVE CONTROL: forgetting B now takes B's own drive.
    expect((await forgetTenant(db, B))["scheduling_drive_cache"]).toBe(1);
  });
});
