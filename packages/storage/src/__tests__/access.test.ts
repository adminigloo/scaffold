import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AttachmentsWire, FileListWire, FileResponse, WireErrorBody } from "../wire.js";
import { createTestDb, jpeg, PNG, pngOfSize, tenant, type TestDb } from "./pglite.js";
import {
  buildWorld,
  CREW_PERMISSIONS,
  handlersFor,
  Members,
  MEMBER_PERMISSIONS,
  OWNER_PERMISSIONS,
  readJson,
  request,
  upload,
  type World,
  assertNoPrivateKeyLeaked,
} from "./world.js";

/**
 * Who may open what (D12, review G5), through the handlers, against real SQL:
 * the record decides, `files.view` alone opens no record's files, crew reach
 * only their own visits' files (and may take back their own photo within a
 * day), `files.manage` sees and removes orphans, and everyone else gets 404.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  // D10, suite-wide: no answer above carried a private object's key.
  assertNoPrivateKeyLeaked();
  await t.close();
});

interface Scene {
  w: World;
  members: Members;
  h: ReturnType<typeof handlersFor>;
  a: string;
  b: string;
  ids: { library: string; visitPhoto: string; ownerVisitPhoto: string; invoiceFile: string; photoOnNoRecord: string };
}

async function scene(options: { allowance?: number } = {}): Promise<Scene> {
  const w = buildWorld(t, options.allowance !== undefined ? { allowance: options.allowance } : {});
  const members = new Members();
  const a = tenant("a");
  const b = tenant("b");
  members.set(a, "owner", OWNER_PERMISSIONS);
  members.set(a, "member", MEMBER_PERMISSIONS);
  members.set(a, "no-invoices", ["files.view", "schedule.view"]);
  members.set(a, "crew1", CREW_PERMISSIONS);
  members.set(a, "crew2", CREW_PERMISSIONS);
  members.set(b, "owner-b", OWNER_PERMISSIONS);
  w.records.add("scheduling.visit", a, "v1", { label: "Visit · Pat Rivera · Tue, Nov 3, 9:00 AM", href: "/app/schedule?visit=v1", assignedUserIds: ["crew1"] });
  w.records.add("scheduling.visit", a, "v2", { label: "Visit · Sam Lee · Wed, Nov 4, 1:00 PM", assignedUserIds: ["crew2"] });
  w.records.add("invoicing.invoice", a, "i1", { label: "Invoice INV-0042 · Pat Rivera", href: "/app/invoices/i1" });
  w.records.add("estimator.estimate", a, "e1", { label: "Estimate 1042 · Pat Rivera", href: "/app/estimates/e1" });
  const library = await w.storage.store({ tenantId: a, purpose: "library", bytes: PNG, filename: "price list.png", addedBy: "owner" });
  const visitPhoto = await w.storage.store({ tenantId: a, purpose: "attachment", bytes: jpeg(), addedBy: "crew1", record: { type: "scheduling.visit", id: "v1" } });
  const ownerVisitPhoto = await w.storage.store({ tenantId: a, purpose: "attachment", bytes: jpeg(), addedBy: "owner", record: { type: "scheduling.visit", id: "v1" } });
  const invoiceFile = await w.storage.store({ tenantId: a, purpose: "attachment", bytes: PNG, addedBy: "owner", record: { type: "invoicing.invoice", id: "i1" } });
  const photoOnNoRecord = await w.storage.store({ tenantId: a, purpose: "estimator.photo", bytes: PNG });
  return {
    w,
    members,
    h: handlersFor(w, members),
    a,
    b,
    ids: { library: library.id, visitPhoto: visitPhoto.id, ownerVisitPhoto: ownerVisitPhoto.id, invoiceFile: invoiceFile.id, photoOnNoRecord: photoOnNoRecord.id },
  };
}

const content = (s: Scene, user: string, id: string, tenantId = s.a) => s.h.handle(request(tenantId, user, `v1/admin/files/${id}/content`));
const remove = (s: Scene, user: string, id: string, tenantId = s.a) =>
  s.h.handle(request(tenantId, user, `v1/admin/files/${id}/remove`, { method: "POST", json: {} }));
const list = async (s: Scene, user: string, query: Record<string, string> = {}) => {
  const res = await s.h.handle(request(s.a, user, "v1/admin/files", { query }));
  expect(res.status).toBe(200);
  return readJson<FileListWire>(res);
};

describe("files.view and files.manage", () => {
  let s: Scene;
  beforeEach(async () => {
    s = await scene();
  });

  it("files.view opens the company's own files; only files.manage removes them", async () => {
    expect((await content(s, "member", s.ids.library)).status).toBe(200);
    expect((await remove(s, "member", s.ids.library)).status).toBe(404);
    expect((await remove(s, "owner", s.ids.library)).status).toBe(200);
    expect((await content(s, "owner", s.ids.library)).status).toBe(404);
  });

  it("files.view alone opens no record's files: no invoices.view → 404, and not listed", async () => {
    expect((await content(s, "no-invoices", s.ids.invoiceFile)).status).toBe(404);
    const body = await readJson<WireErrorBody>(await content(s, "no-invoices", s.ids.invoiceFile));
    expect(body.error).toEqual({ code: "not_found", message: "That file isn't here." });
    const listed = (await list(s, "no-invoices")).files.map((f) => f.id);
    expect(listed).not.toContain(s.ids.invoiceFile);
    expect(listed).toContain(s.ids.library);
    // A runtime permission filter over the page: the usage is still the company's whole usage.
    const owner = await list(s, "owner");
    expect((await list(s, "no-invoices")).usage).toEqual(owner.usage);
    expect((await list(s, "no-invoices")).recordTypes.map((r) => r.type)).toEqual(["scheduling.visit"]);
  });

  it("the record's view permission opens it; its manage permission removes it", async () => {
    expect((await content(s, "member", s.ids.invoiceFile)).status).toBe(200);
    expect((await remove(s, "member", s.ids.invoiceFile)).status).toBe(404);
    s.members.set(s.a, "billing", ["invoices.manage"]);
    expect((await remove(s, "billing", s.ids.invoiceFile)).status).toBe(200);
  });

  it("a purpose's own view list on no record: estimator.photo needs estimator.view too (and files.view)", async () => {
    expect((await content(s, "member", s.ids.photoOnNoRecord)).status).toBe(200);
    expect((await content(s, "no-invoices", s.ids.photoOnNoRecord)).status).toBe(404);
    s.members.set(s.a, "estimates-only", ["estimator.view"]);
    expect((await content(s, "estimates-only", s.ids.photoOnNoRecord)).status).toBe(404);
  });
});

describe("crew: their own visits only (the assigned rule)", () => {
  let s: Scene;
  beforeEach(async () => {
    s = await scene();
  });

  it("assigned → view and add; not assigned → 404", async () => {
    const own = await s.h.handle(request(s.a, "crew1", "v1/admin/attachments", { query: { record: "scheduling.visit", id: "v1" } }));
    expect(own.status).toBe(200);
    const wire = await readJson<AttachmentsWire>(own);
    expect(wire.record).toEqual({ type: "scheduling.visit", label: "Visit · Pat Rivera · Tue, Nov 3, 9:00 AM", href: "/app/schedule?visit=v1" });
    expect(wire.files.map((f) => f.id).sort()).toEqual([s.ids.visitPhoto, s.ids.ownerVisitPhoto].sort());
    expect(wire.canAdd).toBe(true);
    const added = await s.h.handle(upload(s.a, "crew1", "v1/admin/attachments", jpeg(), { filename: "front porch.jpg", type: "image/jpeg", query: { record: "scheduling.visit", id: "v1" } }));
    expect(added.status).toBe(201);
    const file = (await readJson<FileResponse>(added)).file;
    expect(file.record?.label).toBe("Visit · Pat Rivera · Tue, Nov 3, 9:00 AM");
    expect(file.addedBy).toBe("Person crew1");
    // A crew member never learns the company's usage.
    expect((await readJson<FileResponse>(await s.h.handle(request(s.a, "crew1", `v1/admin/files/${file.id}`)))).usage).toBeNull();

    const other = await s.h.handle(request(s.a, "crew1", "v1/admin/attachments", { query: { record: "scheduling.visit", id: "v2" } }));
    expect(other.status).toBe(404);
    expect((await readJson<WireErrorBody>(other)).error.message).toBe("That isn't here.");
    const addOther = await s.h.handle(upload(s.a, "crew1", "v1/admin/attachments", jpeg(), { query: { record: "scheduling.visit", id: "v2" } }));
    expect(addOther.status).toBe(404);
    expect((await content(s, "crew2", s.ids.visitPhoto)).status).toBe(404);
    expect((await content(s, "crew1", s.ids.visitPhoto)).status).toBe(200);
    // Crew hold neither files permission: the list and the library are not theirs.
    expect((await s.h.handle(request(s.a, "crew1", "v1/admin/files"))).status).toBe(403);
    expect((await content(s, "crew1", s.ids.library)).status).toBe(404);
  });

  it("removes their own file within 24 hours; not after, and never someone else's (review BO-21)", async () => {
    expect((await remove(s, "crew1", s.ids.ownerVisitPhoto)).status).toBe(404);
    const listed = await readJson<AttachmentsWire>(
      await s.h.handle(request(s.a, "crew1", "v1/admin/attachments", { query: { record: "scheduling.visit", id: "v1" } })),
    );
    expect(listed.files.find((f) => f.id === s.ids.visitPhoto)?.canRemove).toBe(true);
    expect(listed.files.find((f) => f.id === s.ids.ownerVisitPhoto)?.canRemove).toBe(false);
    s.w.clock.now = new Date(s.w.clock.now.getTime() + 25 * 60 * 60 * 1000);
    expect((await remove(s, "crew1", s.ids.visitPhoto)).status).toBe(404);
    s.w.clock.now = new Date(s.w.clock.now.getTime() - 25 * 60 * 60 * 1000 + 60_000);
    expect((await remove(s, "crew1", s.ids.visitPhoto)).status).toBe(200);
  });
});

describe("files.manage: any file, orphans included", () => {
  it("views and removes a file whose record type is gone and one whose record is gone, listed as removed", async () => {
    const s = await scene();
    // A record type that isn't installed any more (a feature removed).
    await t.client.query(
      `insert into stored_files (id, tenant_id, owner_id, kind, filename, content_type, size_bytes, pathname, url, access, record_type, record_id, sha256)
       values ($1, $2, 'owner', 'attachment', 'old.png', 'image/png', $3, $4, null, 'private', 'feedback.ticket', 't1', 'x')`,
      ["orphan-type", s.a, PNG.length, `t/${"0".repeat(15)}1/2026/10/${"a".repeat(32)}.png`],
    );
    // A record that was deleted.
    s.w.records.remove("invoicing.invoice", s.a, "i1");
    const owner = await list(s, "owner");
    const removedLabel = "Attached to something that was removed";
    expect(owner.files.find((f) => f.id === "orphan-type")?.record).toEqual({ type: "feedback.ticket", label: removedLabel, href: null });
    expect(owner.files.find((f) => f.id === s.ids.invoiceFile)?.record).toEqual({ type: "invoicing.invoice", label: removedLabel, href: null });
    const member = await list(s, "member");
    expect(member.files.map((f) => f.id)).not.toContain("orphan-type");
    expect(member.files.map((f) => f.id)).not.toContain(s.ids.invoiceFile);
    expect((await content(s, "member", s.ids.invoiceFile)).status).toBe(404);
    const before = owner.usage.usedBytes;
    expect((await remove(s, "owner", s.ids.invoiceFile)).status).toBe(200);
    s.w.priv.plant(`t/${"0".repeat(15)}1/2026/10/${"a".repeat(32)}.png`, PNG, "image/png");
    expect((await remove(s, "owner", "orphan-type")).status).toBe(200);
    expect((await list(s, "owner")).usage.usedBytes).toBeLessThan(before);
  });
});

describe("strangers and other companies", () => {
  it("404 for another company's id under one's own company; the gate's own answer under theirs", async () => {
    const s = await scene();
    expect((await content(s, "owner-b", s.ids.library, s.b)).status).toBe(404);
    expect((await remove(s, "owner-b", s.ids.library, s.b)).status).toBe(404);
    const attachments = await s.h.handle(request(s.b, "owner-b", "v1/admin/attachments", { query: { record: "scheduling.visit", id: "v1" } }));
    expect(attachments.status).toBe(404);
    // Under A's company in the path, B's owner is not a member: the host's 403, as it is.
    const gate = await content(s, "owner-b", s.ids.library);
    expect(gate.status).toBe(403);
    expect((await readJson<WireErrorBody>(gate)).error.message).toBe("You are not part of this company.");
    // Signed out: the host's 401, as it is.
    const signedOut = await s.h.handle(request(s.a, null, `v1/admin/files/${s.ids.library}/content`));
    expect(signedOut.status).toBe(401);
    expect((await readJson<WireErrorBody>(signedOut)).error.message).toBe("You have been signed out.");
    expect((await content(s, "owner", "not-a-file")).status).toBe(404);
  });
});

describe("storage full, worded for the person who reads it (review BO-07)", () => {
  it("the owner is told to delete files; anyone else to ask the owner; a share refusal is the same for all", async () => {
    const s = await scene({ allowance: 2000 });
    const owner = await s.h.handle(upload(s.a, "owner", "v1/admin/files", pngOfSize(1900)));
    expect(owner.status).toBe(409);
    expect((await readJson<WireErrorBody>(owner)).error).toEqual({
      code: "storage_full",
      message: expect.stringMatching(/^Your storage is full: .+ used\. Delete files you no longer need to make room\.$/),
    });
    const crew = await s.h.handle(upload(s.a, "crew1", "v1/admin/attachments", pngOfSize(1900), { query: { record: "scheduling.visit", id: "v1" } }));
    expect(crew.status).toBe(409);
    expect((await readJson<WireErrorBody>(crew)).error).toEqual({
      code: "storage_full",
      message: "Green Acres's storage is full, so this wasn't added. Ask the owner to make room.",
    });
  });
});
