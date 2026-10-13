import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { defineSetupChecklist } from "../checklist.js";
import { tenancyChecklistItems } from "../server.js";
import { codeOf, harness, type Harness } from "./harness.js";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

async function setup() {
  const owner = await h.user("owner@summit.test");
  const member = await h.user("member@summit.test");
  const viewer = await h.user("viewer@summit.test");
  const tenantId = await h.company(owner, "Summit", { [member]: "member", [viewer]: "viewer" });
  return { owner, member, viewer, tenantId };
}

describe("settings (6.6, scenario step 5)", () => {
  it("get: the sections the caller may view, with canEdit per section", async () => {
    h = await harness();
    const s = await setup();
    const asOwner = await h.tenancy.getSettings({ actorUserId: s.owner, tenantId: s.tenantId });
    expect(asOwner.sections.map((x) => [x.key, x.canEdit])).toEqual([["company", true]]);
    const asViewer = await h.tenancy.getSettings({ actorUserId: s.viewer, tenantId: s.tenantId });
    expect(asViewer.sections[0]?.canEdit).toBe(false);
    expect(asViewer.sections[0]?.fields.find((f) => f.key === "city")?.width).toBe("half");
  });

  it("update: validates (bad email or time zone → invalid with paths), replaces only that section, audits keys not values", async () => {
    h = await harness();
    const s = await setup();
    const bad = await h.tenancy.updateSettings({ actorUserId: s.owner, tenantId: s.tenantId, section: "company", values: { contactEmail: "nope", timeZone: "Mars/Base" } }).catch((e: unknown) => e);
    expect(bad).toMatchObject({ code: "invalid" });
    expect((bad as { details: { issues: { path: string[] }[] } }).details.issues.map((i) => i.path[0]).sort()).toEqual(["contactEmail", "timeZone"]);
    await h.db.execute(sql`update tenants set settings = '{"other":{"keep":true}}'::jsonb where id = ${s.tenantId}`);
    const out = await h.tenancy.updateSettings({
      actorUserId: s.owner,
      tenantId: s.tenantId,
      section: "company",
      values: { timeZone: "America/Denver", contactEmail: "Office@Summit.test", contactPhone: "" },
    });
    expect(out.values).toMatchObject({ timeZone: "America/Denver", contactEmail: "office@summit.test", contactPhone: null });
    const stored = (await h.db.execute(sql`select settings from tenants where id = ${s.tenantId}`)).rows[0] as { settings: Record<string, unknown> };
    expect(stored.settings["other"]).toEqual({ keep: true });
    const audit = h.audit.find((a) => a.action === "company.settings.updated");
    expect(audit?.metadata).toEqual({ section: "company", changed: ["timeZone", "contactEmail"] });
    expect(JSON.stringify(audit)).not.toContain("office@summit.test");
  });

  it("a viewer → forbidden; an unknown section → not_found", async () => {
    h = await harness();
    const s = await setup();
    expect(await codeOf(h.tenancy.updateSettings({ actorUserId: s.viewer, tenantId: s.tenantId, section: "company", values: {} }))).toBe("forbidden");
    expect(await codeOf(h.tenancy.updateSettings({ actorUserId: s.owner, tenantId: s.tenantId, section: "nope", values: {} }))).toBe("not_found");
  });

  it("readSettings gives other packages typed values with no permission check", async () => {
    h = await harness();
    const s = await setup();
    await h.tenancy.updateSettings({ actorUserId: s.owner, tenantId: s.tenantId, section: "company", values: { timeZone: "America/Denver" } });
    expect((await h.tenancy.readSettings(s.tenantId))["company"]?.["timeZone"]).toBe("America/Denver");
  });
});

describe("the setup checklist (6.7, scenario step 2)", () => {
  it("progresses as the details, an invite and the branding are added", async () => {
    h = await harness();
    const s = await setup();
    // `setup()` added members, so the team item starts done; use a fresh solo company.
    const solo = await h.user("solo@x.test");
    const t = await h.company(solo, "Solo Co");
    const at = async () => (await h.tenancy.getChecklist({ actorUserId: solo, tenantId: t })).done;
    expect((await h.tenancy.getChecklist({ actorUserId: solo, tenantId: t })).total).toBe(3);
    expect(await at()).toBe(0);
    await h.tenancy.updateSettings({ actorUserId: solo, tenantId: t, section: "company", values: { timeZone: "America/Denver", contactPhone: "555 0100" } });
    expect(await at()).toBe(1);
    await h.tenancy.sendInvitation({ actorUserId: solo, tenantId: t, email: "x@x.test", roleKey: "member" });
    expect(await at()).toBe(2);
    await h.tenancy.updateBranding({ actorUserId: solo, tenantId: t, brandColor: "#0f766e" });
    const done = await h.tenancy.getChecklist({ actorUserId: solo, tenantId: t });
    expect(done).toMatchObject({ done: 3, total: 3, complete: true, hidden: false });
    void s;
  });

  it("items are filtered by permission: a member sees none", async () => {
    h = await harness();
    const s = await setup();
    expect((await h.tenancy.getChecklist({ actorUserId: s.member, tenantId: s.tenantId })).items).toEqual([]);
  });

  it("dismiss, undo the dismissal (review T1-13), hide and show again; kept in setup_state", async () => {
    h = await harness();
    const s = await setup();
    let view = await h.tenancy.dismissChecklistItem({ actorUserId: s.owner, tenantId: s.tenantId, key: "company.branding" });
    expect(view.items.find((i) => i.key === "company.branding")?.dismissed).toBe(true);
    view = await h.tenancy.restoreChecklistItem({ actorUserId: s.owner, tenantId: s.tenantId, key: "company.branding" });
    expect(view.items.find((i) => i.key === "company.branding")?.dismissed).toBe(false);
    expect((await h.tenancy.hideChecklist({ actorUserId: s.owner, tenantId: s.tenantId })).hidden).toBe(true);
    expect((await h.tenancy.getChecklist({ actorUserId: s.owner, tenantId: s.tenantId })).hidden).toBe(true);
    expect((await h.tenancy.showChecklist({ actorUserId: s.owner, tenantId: s.tenantId })).hidden).toBe(false);
    expect(await codeOf(h.tenancy.dismissChecklistItem({ actorUserId: s.owner, tenantId: s.tenantId, key: "nope.item" }))).toBe("not_found");
  });

  it("a hidden list comes back when a package adds an item later (review T1-13)", async () => {
    h = await harness();
    const s = await setup();
    await h.tenancy.hideChecklist({ actorUserId: s.owner, tenantId: s.tenantId });
    // Tenancy 2 ships scheduling's "Set your hours": the SAME database, read
    // through a service whose checklist has grown.
    const { createTenancyService } = await import("../server.js");
    const tenantCatalog = (await import("./harness.js")).tenantCatalog;
    const service = createTenancyService({
      db: h.db,
      mode: "companies",
      tenantCatalog,
      bootstrap: { mode: "off" },
      checklist: defineSetupChecklist([
        ...tenancyChecklistItems({}),
        { key: "schedule.hours", order: 40, title: "Set your hours", description: "", actionLabel: "Set hours", href: "/schedule/settings", isDone: () => false },
      ]),
    });
    const view = await service.getChecklist({ actorUserId: s.owner, tenantId: s.tenantId });
    expect(view.hidden).toBe(false);
    expect(view.items.map((i) => i.key)).toContain("schedule.hours");
  });

  it("an isDone that throws → that item is not done, the rest still render, the error is reported", async () => {
    const reported: unknown[] = [];
    h = await harness({
      onEventError: (e) => reported.push(e),
      checklist: defineSetupChecklist([
        ...tenancyChecklistItems({}),
        { key: "broken.item", order: 50, title: "Broken", description: "", actionLabel: "Go", href: "/", isDone: () => { throw new Error("boom"); } },
      ]),
    });
    const s = await setup();
    const view = await h.tenancy.getChecklist({ actorUserId: s.owner, tenantId: s.tenantId });
    expect(view.items).toHaveLength(4);
    expect(view.items.find((i) => i.key === "broken.item")?.done).toBe(false);
    expect(reported).toHaveLength(1);
  });

  it("the copy promises only what this release does (review T1-10)", () => {
    const branding = tenancyChecklistItems({}).find((i) => i.key === "company.branding")!;
    expect(branding.description).not.toMatch(/email/i);
  });
});
