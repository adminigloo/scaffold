import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { createAudience, createDrizzleAudienceStore, type AudienceUser } from "@adminigloo/audience";
import { createAnalytics } from "../instance.js";
import { audienceSessionsSource } from "../context.js";
import { importedVisitorKey } from "../import.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";
import type { AnalyticsTables } from "../schema.js";

/**
 * PAST VISITS BROUGHT IN FROM RECORDS (analytics 0.4): `importVisits` brings
 * a business's visit history in from another tool — each visit once by its
 * key, filed under a hashed visitor key (never the raw id), its source
 * classified by the live rules, its pages in order. Tracking-since moves
 * back to the earliest visit, never forward. The audience still decides what
 * counts: a visit by one of the company's own team is left out of every
 * report, as a live one is. Dates in the future, before 2000 or past the
 * retention window, and another company's website, are refused per visit.
 */

const SECRET = "test-secret-0123456789-abcdefghijklmnopqrstuvwxyz";
const NOW = new Date("2026-10-20T15:00:00.000Z");
interface User extends AudienceUser {
  role: "staff" | "customer";
}
const USERS: User[] = [{ id: "u_staff", email: "sam@greenblade.test", role: "staff" }];

let tdb: TestDb & { tables: AnalyticsTables[] };
beforeAll(async () => {
  tdb = await createTestDb();
});
afterAll(async () => {
  await tdb?.close();
});

function setup() {
  const tenantId = tenant("co");
  const audience = createAudience<User>({
    store: createDrizzleAudienceStore({ db: tdb.db }),
    secret: SECRET,
    tenantId,
    isInternal: (user) => (user.role === "staff" ? "staff" : false),
    getUser: async (id) => USERS.find((user) => user.id === id) ?? null,
    sessions: audienceSessionsSource({ tenantId }),
    now: () => NOW,
  });
  const analytics = createAnalytics({ db: tdb.db, audience, onError: () => {} });
  return { tenantId, analytics };
}

const VISITS = [
  { key: "row-1", at: "2026-03-02T15:00:00Z", path: "/", source: "https://www.google.com/search?q=lawn", visitor: "ga-111" },
  { key: "row-2", at: "2026-03-03T09:30:00Z", path: "/pricing?x=1", pages: [{ path: "/book", at: "2026-03-03T09:33:00Z" }], source: "facebook.com", visitor: "ga-222" },
  { key: "row-3", at: "2026-04-10T12:00:00Z", path: "/", source: { utmSource: "newsletter", utmMedium: "email" }, visitor: "ga-111" },
];
const RANGE = { from: new Date("2026-03-01T00:00:00Z"), to: new Date("2026-05-01T00:00:00Z") };

describe("importVisits", () => {
  it("brings each visit in once, classified and in order, and moves tracking-since back to the earliest", async () => {
    const { tenantId, analytics } = setup();
    // The company started counting live on Oct 1.
    await tdb.db.insert(analytics.tables.sites).values({ tenantId, trackingSince: new Date("2026-10-01T00:00:00Z") });
    const first = await analytics.importVisits({ tenantId, visits: VISITS, now: NOW });
    expect(first).toMatchObject({ imported: 3, alreadyImported: 0, refused: [] });
    expect(first.trackingSince?.toISOString()).toBe("2026-03-02T15:00:00.000Z");

    const again = await analytics.importVisits({ tenantId, visits: VISITS, now: NOW });
    expect(again).toMatchObject({ imported: 0, alreadyImported: 3, refused: [] });

    const s = analytics.tables.sessions;
    const rows = await tdb.db
      .select({ key: s.importKey, visitor: s.visitorKey, landing: s.landingPath, source: s.sourceBucket, referrer: s.referrerHost, views: s.pageViewCount })
      .from(s)
      .where(eq(s.tenantId, tenantId))
      .orderBy(s.startedAt);
    expect(rows.map((r) => [r.key, r.landing, r.source, r.referrer, r.views])).toEqual([
      ["row-1", "/", "organic", "google.com", 1],
      ["row-2", "/pricing", "social", "facebook.com", 2],
      ["row-3", "/", "email", null, 1],
    ]);
    // The raw visitor id is never stored; the same id is the same visitor.
    expect(rows.some((r) => r.visitor.includes("ga-"))).toBe(false);
    expect(rows[0]!.visitor).toBe(rows[2]!.visitor);
    expect(rows[0]!.visitor).toBe(await importedVisitorKey(tenantId, "ga-111"));

    const overview = await analytics.getOverview({ tenantId, ...RANGE });
    expect(overview.visits.current).toBe(3);
    expect(overview.pageViews.current).toBe(4);
    // Moving tracking-since never goes forward: a later import leaves it.
    await analytics.importVisits({ tenantId, visits: [{ key: "row-9", at: "2026-09-01", path: "/", visitor: "x" }], now: NOW });
    expect((await analytics.getTrackingSince(tenantId))?.toISOString()).toBe("2026-03-02T15:00:00.000Z");
  });

  it("the audience still decides: a visit by the company's own team is left out of the numbers", async () => {
    const { tenantId, analytics } = setup();
    await analytics.importVisits({
      tenantId,
      visits: [
        { key: "a", at: "2026-03-02T15:00:00Z", path: "/", visitor: "customer-1" },
        { key: "b", at: "2026-03-02T16:00:00Z", path: "/", visitor: "staff-device", userId: "u_staff" },
      ],
      now: NOW,
    });
    expect((await analytics.getOverview({ tenantId, ...RANGE })).visits.current).toBe(1);
    expect((await analytics.getOverview({ tenantId, ...RANGE, includeInternal: true })).visits.current).toBe(2);
  });

  it("refuses, per visit and in words, a future date, one before 2000, one past the retention window and another company's website", async () => {
    const { tenantId, analytics } = setup();
    const other = setup();
    const site = await other.analytics.addWebsite({ tenantId: other.tenantId, name: "Theirs", domains: ["theirs.test"] });
    const out = await analytics.importVisits({
      tenantId,
      visits: [
        { key: "future", at: "2026-10-21", path: "/", visitor: "v" },
        { key: "y1999", at: "1999-06-01", path: "/", visitor: "v" },
        { key: "old", at: "2024-01-01", path: "/", visitor: "v" },
        { key: "theirs", at: "2026-03-02", path: "/", visitor: "v", siteId: site.id },
        { key: "", at: "2026-03-02", path: "/", visitor: "v" },
        { key: "ok", at: "2026-03-02", path: "/", visitor: "v" },
      ],
      now: NOW,
    });
    expect(out.imported).toBe(1);
    expect(out.refused).toEqual([
      { key: "future", reason: "That date is in the future." },
      { key: "y1999", reason: "That date is before 2000. Check the year." },
      { key: "old", reason: "That's older than the 395 days visits are kept." },
      { key: "theirs", reason: "That website isn't this company's." },
      { key: "", reason: "Give each visit its own key (1 to 200 characters)." },
    ]);
    // Nothing landed in the other company.
    const theirs = await tdb.db
      .select({ n: sql<number>`count(*)::int` })
      .from(analytics.tables.sessions)
      .where(and(eq(analytics.tables.sessions.tenantId, other.tenantId)));
    expect(theirs[0]!.n).toBe(0);
  });

  it("the same key in two companies is two visits (the key is unique per company only)", async () => {
    const a = setup();
    const b = setup();
    const visit = [{ key: "row-1", at: "2026-03-02T15:00:00Z", path: "/", visitor: "v" }];
    expect((await a.analytics.importVisits({ tenantId: a.tenantId, visits: visit, now: NOW })).imported).toBe(1);
    expect((await b.analytics.importVisits({ tenantId: b.tenantId, visits: visit, now: NOW })).imported).toBe(1);
  });
});
