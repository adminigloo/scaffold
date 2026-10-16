import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createResource, schedulingBookings, schedulingFileRecords, updateSchedulingSettings } from "../index.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * Tenancy 2b-1, contract 3.5 and 9.5: a visit as a file record. Storage asks
 * `find` which ids are this company's visits, what to call each, where it
 * opens and who is on it; the visit's permissions then decide who sees its
 * photos (D12). On PGlite, so the tenant filter is the real SQL (IF-21).
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

async function visit(
  tenantId: string,
  id: string,
  over: Partial<typeof schedulingBookings.$inferInsert> = {},
): Promise<string> {
  await t.db.insert(schedulingBookings).values({
    id,
    tenantId,
    serviceType: "estimate",
    customerName: "Pat Rivera",
    scheduledDate: new Date("2026-11-03T00:00:00Z"),
    startTime: "09:00",
    endTime: "10:00",
    startsAt: new Date("2026-11-03T16:00:00Z"),
    endsAt: new Date("2026-11-03T17:00:00Z"),
    status: "confirmed",
    ...over,
  });
  return id;
}

describe("schedulingFileRecords (contract 9.5)", () => {
  it("one type: a visit, its permissions, the crew as the assigned permission", () => {
    const [type, ...rest] = schedulingFileRecords(t.db, { visitHref: "/app/schedule?date={date}&visit={id}" });
    expect(rest).toEqual([]);
    expect({
      type: type!.type,
      label: type!.label,
      pluralLabel: type!.pluralLabel,
      view: type!.view,
      manage: type!.manage,
      assigned: type!.assigned,
    }).toEqual({
      type: "scheduling.visit",
      label: "Visit",
      pluralLabel: "Visits",
      view: ["schedule.view"],
      manage: ["schedule.manage"],
      assigned: { permission: "schedule.route" },
    });
  });

  it("finds only this company's visits, in one query, with their label, link and crew", async () => {
    const tenantId = tenant("acme");
    await updateSchedulingSettings(t.db, tenantId, {
      timeZone: "America/Denver",
      services: [{ key: "estimate", name: "Free estimate", durationMinutes: 60 }],
    });
    const crew = await createResource(t.db, { tenantId, name: "Crew A", userId: "user-cam" });
    const unlinked = await createResource(t.db, { tenantId, name: "Crew B" });
    const other = tenant("other");
    const theirCrew = await createResource(t.db, { tenantId: other, name: "Their crew", userId: "user-foreign" });

    const withCrew = await visit(tenantId, `${tenantId}-a`, { resourceId: crew.id });
    const noCrew = await visit(tenantId, `${tenantId}-b`, { customerName: null, title: null, resourceId: unlinked.id });
    const titled = await visit(tenantId, `${tenantId}-c`, { customerName: null, title: "Gate code 1234" });
    // A row in THIS tenant pointing at another company's crew: the crew is never trusted across companies.
    const crossCrew = await visit(tenantId, `${tenantId}-d`, { resourceId: theirCrew.id });
    const theirs = await visit(other, `${other}-z`);

    const [type] = schedulingFileRecords(t.db, { visitHref: "/app/schedule?date={date}&visit={id}" });
    t.queries.length = 0;
    const found = await type!.find({ tenantId, ids: [withCrew, noCrew, titled, crossCrew, theirs, "no-such-visit"] });
    expect(t.queries).toHaveLength(1);
    expect([...found.keys()].sort()).toEqual([withCrew, noCrew, titled, crossCrew].sort());
    expect(found.get(withCrew)).toEqual({
      label: "Visit · Pat Rivera · Tue, Nov 3, 9:00 AM MST",
      href: `/app/schedule?date=2026-11-03&visit=${encodeURIComponent(withCrew)}`,
      assignedUserIds: ["user-cam"],
    });
    expect(found.get(noCrew)).toEqual({
      label: "Visit · Free estimate · Tue, Nov 3, 9:00 AM MST",
      href: `/app/schedule?date=2026-11-03&visit=${encodeURIComponent(noCrew)}`,
      assignedUserIds: [],
    });
    expect(found.get(titled)!.label).toBe("Visit · Gate code 1234 · Tue, Nov 3, 9:00 AM MST");
    expect(found.get(crossCrew)!.assignedUserIds).toEqual([]);
    expect(found.has(theirs)).toBe(false);

    // The other company asking for this company's ids gets nothing.
    expect((await type!.find({ tenantId: other, ids: [withCrew, noCrew] })).size).toBe(0);
  });

  it("no ids asks nothing; the label follows the locale it was given", async () => {
    const tenantId = tenant("acme");
    const [type] = schedulingFileRecords(t.db, { visitHref: "/admin/schedule/visits/{id}/files", locale: "en-GB" });
    t.queries.length = 0;
    expect((await type!.find({ tenantId, ids: [] })).size).toBe(0);
    expect(t.queries).toHaveLength(0);
    const id = await visit(tenantId, `${tenantId}-uk`);
    const found = await type!.find({ tenantId, ids: [id] });
    // No settings row: the visit reads in UTC.
    expect(found.get(id)!.label).toMatch(/^Visit · Pat Rivera · Tue,? 3 Nov,? 16:00 UTC$/);
    expect(found.get(id)!.href).toBe(`/admin/schedule/visits/${encodeURIComponent(id)}/files`);
  });
});
