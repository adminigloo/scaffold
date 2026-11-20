import { afterEach, describe, expect, it } from "vitest";
import * as auth from "@adminigloo/auth/schema";
import * as tenancy from "@adminigloo/tenancy/schema";
import * as permissions from "@adminigloo/permissions/schema";
import { createPgliteDb } from "../../../testing/src/pglite.js";
import { companiesGlance, peopleGlance } from "../glances/tenancy.js";

const NOW = new Date("2026-11-19T18:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function setup() {
  const t = await createPgliteDb({ schema: { ...tenancy, ...auth, ...permissions }, logQueries: false });
  close = () => t.close();
  const [template] = await t.db
    .insert(permissions.roleTemplate)
    .values({ scope: "staff", key: "admin", name: "Administrator" })
    .returning({ id: permissions.roleTemplate.id });
  return { ...t, staffTemplate: template!.id };
}

async function grantStaff(t: Awaited<ReturnType<typeof setup>>, userId: string): Promise<void> {
  await t.db.insert(permissions.principalRole).values({ principalId: userId, scope: "staff", templateId: t.staffTemplate });
}

describe("companiesGlance", () => {
  it("is empty when there are no companies", async () => {
    const t = await setup();
    const glance = await companiesGlance({ db: t.db, now: NOW });
    expect(glance.tiles?.map((tile) => tile.value)).toEqual([0, 0, 0, 0]);
    expect(glance.list?.rows).toEqual([]);
    expect(glance.status).toEqual({ text: "No new companies in the last 30 days.", tone: "neutral" });
  });

  it("counts customer companies, excludes personal ones, and lists the newest first", async () => {
    const t = await setup();
    await t.db.insert(tenancy.tenants).values([
      { id: "t-personal", kind: "personal", slug: "p1", name: "Personal", createdAt: daysAgo(1) },
      { id: "t-old", kind: "org", slug: "old-co", name: "Old Co", createdAt: daysAgo(40) },
      { id: "t-new", kind: "org", slug: "new-co", name: "New Co", createdAt: daysAgo(2) },
      { id: "t-suspended", kind: "org", slug: "susp-co", name: "Suspended Co", createdAt: daysAgo(5), suspendedAt: daysAgo(1) },
    ]);
    await t.db.insert(tenancy.tenantInvitations).values([
      { id: "inv-open", tenantId: "t-new", email: "a@example.com", tokenHash: "h1", createdAt: daysAgo(1) },
      { id: "inv-accepted", tenantId: "t-new", email: "b@example.com", tokenHash: "h2", acceptedAt: daysAgo(1), createdAt: daysAgo(2) },
    ]);

    const glance = await companiesGlance({ db: t.db, now: NOW });
    const [total, fresh, suspended, openInvites] = glance.tiles ?? [];

    // 3 of the 4 tenants: the personal workspace is never counted.
    expect(total).toMatchObject({ value: 3, href: "/admin/companies?kind=org" });
    // Under 30 days old: New Co (2 days) and Suspended Co (5 days).
    expect(fresh?.value).toBe(2);
    expect(suspended).toMatchObject({ value: 1, href: "/admin/companies?kind=org&status=suspended", tone: "warn" });
    // inv-accepted is accepted, so only inv-open counts.
    expect(openInvites?.value).toBe(1);
    expect(glance.status?.tone).toBe("warn");

    expect(glance.list?.rows.map((r) => r.title)).toEqual(["New Co", "Suspended Co", "Old Co"]);
    expect(glance.list?.rows[0]).toMatchObject({ href: "/admin/companies/t-new", badge: undefined });
    expect(glance.list?.rows[1]).toMatchObject({ href: "/admin/companies/t-suspended", badge: "Suspended", tone: "warn" });
  });
});

describe("peopleGlance", () => {
  it("is empty when nobody has signed up", async () => {
    const t = await setup();
    const glance = await peopleGlance({ db: t.db, now: NOW });
    expect(glance.tiles?.map((tile) => tile.value)).toEqual([0, 0, 0, 0]);
    expect(glance.list?.rows).toEqual([]);
    expect(glance.spark?.points).toHaveLength(14);
  });

  it("counts people, sign-ups, staff and pending invites, excludes the soft-deleted, and lists the newest sign-ups", async () => {
    const t = await setup();
    await t.db.insert(auth.users).values([
      { id: "u-old", email: "old@example.com", displayName: "Old Person", externalId: "ext-old", createdAt: daysAgo(10) },
      { id: "u-new", email: "new@example.com", displayName: "New Person", externalId: "ext-new", createdAt: daysAgo(1) },
      { id: "u-deleted", email: "gone@example.com", displayName: "Gone", externalId: "ext-gone", createdAt: daysAgo(1), deletedAt: daysAgo(0.5) },
    ]);
    await grantStaff(t, "u-old");
    await t.db.insert(tenancy.staffInvitations).values([
      { id: "si-open", email: "invitee@example.com", templateKey: "cs_agent", expiresAt: daysAgo(-10), createdAt: daysAgo(1) },
      {
        id: "si-claimed",
        email: "claimed@example.com",
        templateKey: "cs_agent",
        expiresAt: daysAgo(-10),
        claimedAt: daysAgo(1),
        createdAt: daysAgo(2),
      },
    ]);

    const glance = await peopleGlance({ db: t.db, now: NOW });
    const [total, fresh, staff, pending] = glance.tiles ?? [];

    // 2 of the 3 users: the soft-deleted one is never counted.
    expect(total?.value).toBe(2);
    // Under 7 days old: New Person (1 day). Old Person is 10 days old.
    expect(fresh?.value).toBe(1);
    expect(staff).toMatchObject({ value: 1, href: "/admin/people?staffOnly=true" });
    // si-claimed is claimed, so only si-open counts.
    expect(pending).toMatchObject({ value: 1, tone: "warn" });

    expect(glance.list?.rows.map((r) => r.title)).toEqual(["New Person", "Old Person"]);
    // Both signups land inside the 14-day spark window; the deleted user never does.
    expect(glance.spark?.points.reduce((a, b) => a + b, 0)).toBe(2);
  });
});
