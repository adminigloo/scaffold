import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStorageLinkHandlers } from "../link-handlers.js";
import { createMemoryBlobStore, type MemoryBlobStore } from "../memory.js";
import type { BlobStore } from "../types.js";
import type { AttachmentsWire, FileListWire, FileResponse, FileLinkWire, RemoveResponse, UsageWire, WireErrorBody } from "../wire.js";
import { createTestDb, jpeg, PNG, pdf, pngOfSize, tenant, type TestDb } from "./pglite.js";
import {
  buildWorld,
  handlersFor,
  Members,
  MEMBER_PERMISSIONS,
  OWNER_PERMISSIONS,
  readJson,
  request,
  upload,
  type World,
} from "./world.js";

/**
 * The signed-in handlers end to end (6.7): two companies through every
 * route, the Files screen's filters and sort, the mechanics (405, OPTIONS,
 * the same-site check, the rate limit), and — over EVERY response this suite
 * sees — no PRIVATE object key in any body or header (D10).
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});

/** Every private key any store in this suite was handed, and every answer the handlers gave. */
const privateKeys = new Set<string>();
const answers: string[] = [];

function recording(inner: MemoryBlobStore): BlobStore {
  return {
    access: inner.access,
    async put(key, bytes, options) {
      privateKeys.add(key);
      return inner.put(key, bytes, options);
    },
    get: (key) => inner.get(key),
    delete: (key) => inner.delete(key),
  };
}

async function capture(res: Response): Promise<Response> {
  const copy = res.clone();
  answers.push(await copy.text(), [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n"));
  return res;
}

afterAll(async () => {
  // D10: a PRIVATE object's key never leaves the server.
  expect(privateKeys.size).toBeGreaterThan(5);
  expect(answers.length).toBeGreaterThan(20);
  for (const key of privateKeys) {
    for (const answer of answers) expect(answer.includes(key), `an answer carried ${key}`).toBe(false);
    // Not even the random part alone.
    const random = key.split("/").at(-1)?.split(".")[0] ?? "";
    for (const answer of answers) expect(answer.includes(random)).toBe(false);
  }
  await t.close();
});

interface Scene {
  w: World;
  members: Members;
  call: (req: Request) => Promise<Response>;
  link: (req: Request) => Promise<Response>;
  a: string;
  b: string;
}

function scene(extra: Parameters<typeof handlersFor>[2] = {}, worldExtra: Parameters<typeof buildWorld>[1] = {}): Scene {
  const inner = createMemoryBlobStore({ access: "private" });
  const w = buildWorld(t, { stores: { private: recording(inner), public: createMemoryBlobStore({ access: "public" }) }, ...worldExtra });
  const members = new Members();
  const a = tenant("a");
  const b = tenant("b");
  members.set(a, "owner", OWNER_PERMISSIONS);
  members.set(a, "member", MEMBER_PERMISSIONS);
  members.set(b, "owner-b", OWNER_PERMISSIONS);
  w.valid.add(`${a}|owner`).add(`${b}|owner-b`);
  const h = handlersFor(w, members, extra);
  const links = createStorageLinkHandlers({ storage: w.storage });
  return { w, members, call: async (req) => capture(await h.handle(req)), link: async (req) => capture(await links.handle(req)), a, b };
}

describe("two companies through every route", () => {
  it("B gets nothing of A: 404 for A's file and record ids, A's link re-signed for B, and lists without A", async () => {
    const s = scene();
    s.w.records.add("scheduling.visit", s.a, "va", { label: "Visit · Pat Rivera" });
    s.w.records.add("scheduling.visit", s.b, "vb", { label: "Visit · Bravo" });
    const created = await readJson<FileResponse>(await s.call(upload(s.a, "owner", "v1/admin/files", PNG, { filename: "alpha secret plan.png" })));
    const attached = await readJson<FileResponse>(
      await s.call(upload(s.a, "owner", "v1/admin/attachments", jpeg(), { filename: "alpha porch.jpg", query: { record: "scheduling.visit", id: "va" } })),
    );
    const aIds = [created.file.id, attached.file.id];
    for (const id of aIds) {
      for (const path of [`v1/admin/files/${id}`, `v1/admin/files/${id}/content`]) {
        expect((await s.call(request(s.b, "owner-b", path))).status, path).toBe(404);
      }
      for (const action of ["link", "remove"]) {
        expect((await s.call(request(s.b, "owner-b", `v1/admin/files/${id}/${action}`, { method: "POST", json: {} }))).status, action).toBe(404);
      }
    }
    expect((await s.call(request(s.b, "owner-b", "v1/admin/attachments", { query: { record: "scheduling.visit", id: "va" } }))).status).toBe(404);
    expect((await s.call(upload(s.b, "owner-b", "v1/admin/attachments", PNG, { query: { record: "scheduling.visit", id: "va" } }))).status).toBe(404);
    // B's own lists say nothing of A.
    const bList = await s.call(request(s.b, "owner-b", "v1/admin/files"));
    const bText = await bList.text();
    for (const marker of [...aIds, "alpha", s.a]) expect(bText).not.toContain(marker);
    const bUsage = await readJson<UsageWire>(await s.call(request(s.b, "owner-b", "v1/admin/usage")));
    expect(bUsage).toEqual({ usedBytes: 0, fileCount: 0, allowanceBytes: null });
    // A's own routes still work: nothing was removed by B's tries.
    expect((await s.call(request(s.a, "owner", `v1/admin/files/${created.file.id}/content`))).status).toBe(200);
    // A's link, re-pointed at B with its MAC kept: 404.
    const link = await readJson<FileLinkWire>(await s.call(request(s.a, "owner", `v1/admin/files/${created.file.id}/link`, { method: "POST", json: {} })));
    const [v, payload, mac] = (link.url.split("/v1/f/")[1] ?? "").split(".") as [string, string, string];
    const forged = btoa(JSON.stringify({ ...JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))), t: s.b })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect((await s.link(new Request(`https://app.test/api/files/v1/f/${v}.${forged}.${mac}`))).status).toBe(404);
    expect((await s.link(new Request(link.url))).status).toBe(200);
  });
});

describe("the Files screen's list", () => {
  it("filters by record type, by 'not attached' and by purpose; sorts by size; pages", async () => {
    const s = scene();
    s.w.records.add("scheduling.visit", s.a, "v1", { label: "Visit · Pat Rivera", href: "/app/schedule?visit=v1" });
    s.w.records.add("invoicing.invoice", s.a, "i1", { label: "Invoice INV-0042" });
    const small = await s.w.storage.store({ tenantId: s.a, purpose: "library", bytes: PNG, addedBy: "owner" });
    const big = await s.w.storage.store({ tenantId: s.a, purpose: "library", bytes: pngOfSize(5000), addedBy: "owner" });
    const onVisit = await s.w.storage.store({ tenantId: s.a, purpose: "attachment", bytes: jpeg(), record: { type: "scheduling.visit", id: "v1" } });
    const onInvoice = await s.w.storage.store({ tenantId: s.a, purpose: "attachment", bytes: pdf(), record: { type: "invoicing.invoice", id: "i1" } });
    const logo = await s.w.storage.store({ tenantId: s.a, purpose: "company.logo", bytes: PNG });
    const get = async (query: Record<string, string>) => readJson<FileListWire>(await s.call(request(s.a, "owner", "v1/admin/files", { query })));

    const all = await get({});
    expect(all.files.map((f) => f.id)).toEqual([logo.id, onInvoice.id, onVisit.id, big.id, small.id]);
    expect((await get({ record: "scheduling.visit" })).files.map((f) => f.id)).toEqual([onVisit.id]);
    expect((await get({ record: "none" })).files.map((f) => f.id)).toEqual([logo.id, big.id, small.id]);
    expect((await get({ purpose: "company.logo" })).files.map((f) => f.id)).toEqual([logo.id]);
    expect((await get({ sort: "size" })).files[0]?.id).toBe(big.id);
    expect(all.recordTypes).toEqual([
      { type: "scheduling.visit", label: "Visits" },
      { type: "estimator.estimate", label: "Estimates" },
      { type: "invoicing.invoice", label: "Invoices" },
    ]);
    expect(all.purposes).toEqual([
      { key: "attachment", label: "Photo or file" },
      { key: "company.logo", label: "Company logo" },
      { key: "library", label: "Company file" },
    ]);
    expect(all.canUpload).toBe(true);
    expect(all.uploads).toMatchObject({ available: true, offReason: null, maxBytes: 4 * 1024 * 1024 });
    expect(all.uploads.accept).toContain("application/pdf");
    expect(all.uploads.accept).toContain(".heic");
    const wire = all.files.find((f) => f.id === onVisit.id);
    expect(wire).toMatchObject({
      kind: "photo",
      purpose: "attachment",
      purposeLabel: "Photo or file",
      record: { type: "scheduling.visit", label: "Visit · Pat Rivera", href: "/app/schedule?visit=v1" },
      url: `/api/app/${s.a}/files/v1/admin/files/${onVisit.id}/content`,
      canRemove: true,
      canLink: true,
    });
    expect(all.files.find((f) => f.id === onInvoice.id)?.kind).toBe("document");
    expect(all.files.find((f) => f.id === small.id)?.addedBy).toBe("Person owner");
    // The logo opens at its public address and is removed in company settings, not here.
    expect(all.files.find((f) => f.id === logo.id)).toMatchObject({ url: logo.publicUrl, canRemove: false, canLink: false });
    // One `find` per record type per page.
    s.w.records.finds.length = 0;
    await get({});
    expect(s.w.records.finds.map((f) => f.type).sort()).toEqual(["invoicing.invoice", "scheduling.visit"]);

    for (let i = 0; i < 30; i += 1) await s.w.storage.store({ tenantId: s.a, purpose: "library", bytes: PNG });
    const first = await get({});
    expect(first.files).toHaveLength(30);
    expect(first.nextCursor).not.toBeNull();
    const second = await get({ cursor: first.nextCursor ?? "" });
    expect(second.files).toHaveLength(5);
    expect(new Set([...first.files, ...second.files].map((f) => f.id)).size).toBe(35);
    const bySize = await get({ sort: "size" });
    const nextBySize = await get({ sort: "size", cursor: bySize.nextCursor ?? "" });
    expect(new Set([...bySize.files, ...nextBySize.files].map((f) => f.id)).size).toBe(35);
  });

  it("recordTypes lists only the types the reader can see files of", async () => {
    const s = scene();
    s.members.set(s.a, "scheduler", ["files.view", "schedule.view"]);
    const list = await readJson<FileListWire>(await s.call(request(s.a, "scheduler", "v1/admin/files")));
    expect(list.recordTypes).toEqual([{ type: "scheduling.visit", label: "Visits" }]);
    expect(list.canUpload).toBe(false);
  });

  it("refuses a filter it doesn't know, and a bad cursor", async () => {
    const s = scene();
    const bad: Record<string, string>[] = [{ purpose: "nope" }, { record: "nope.thing" }, { sort: "oldest" }, { cursor: "not-a-cursor" }];
    for (const query of bad) {
      const res = await s.call(request(s.a, "owner", "v1/admin/files", { query }));
      expect(res.status, JSON.stringify(query)).toBe(400);
      expect((await readJson<WireErrorBody>(res)).error.code).toBe("invalid");
    }
  });
});

describe("removing, linking, and what can't be removed here", () => {
  it("the logo and an estimate's own photos are removed where they are used (409 not_removable)", async () => {
    // The template names its own page (review FH-11: a host without one gets a sentence naming none).
    const s = scene({ logoSettings: "company settings" });
    s.w.records.add("estimator.estimate", s.a, "e1", { label: "Estimate 1042 · Pat Rivera" });
    const logo = await s.w.storage.store({ tenantId: s.a, purpose: "company.logo", bytes: PNG });
    const photo = await s.w.storage.store({ tenantId: s.a, purpose: "estimator.photo", bytes: PNG, record: { type: "estimator.estimate", id: "e1" } });
    const logoRes = await s.call(request(s.a, "owner", `v1/admin/files/${logo.id}/remove`, { method: "POST", json: {} }));
    expect(logoRes.status).toBe(409);
    expect((await readJson<WireErrorBody>(logoRes)).error).toEqual({ code: "not_removable", message: "This is removed where it's used: in company settings." });
    const photoRes = await s.call(request(s.a, "owner", `v1/admin/files/${photo.id}/remove`, { method: "POST", json: {} }));
    expect((await readJson<WireErrorBody>(photoRes)).error).toEqual({ code: "not_removable", message: "This is removed where it's used: on Estimate 1042 · Pat Rivera." });
    expect(await s.w.storage.get({ tenantId: s.a, fileId: photo.id })).not.toBeNull();
  });

  it("remove answers the new usage; a link to a public file is refused", async () => {
    const s = scene();
    const file = await s.w.storage.store({ tenantId: s.a, purpose: "library", bytes: PNG });
    const removed = await readJson<RemoveResponse>(await s.call(request(s.a, "owner", `v1/admin/files/${file.id}/remove`, { method: "POST", json: {} })));
    expect(removed).toEqual({ removed: true, usage: { usedBytes: 0, fileCount: 0, allowanceBytes: null } });
    const logo = await s.w.storage.store({ tenantId: s.a, purpose: "company.logo", bytes: PNG });
    expect((await s.call(request(s.a, "owner", `v1/admin/files/${logo.id}/link`, { method: "POST", json: {} }))).status).toBe(400);
  });

  it("an attachments list shows the record's `attachment` files only (the estimator's photos show in its own panel)", async () => {
    const s = scene();
    s.w.records.add("estimator.estimate", s.a, "e1", { label: "Estimate 1042 · Pat Rivera" });
    const attachment = await s.w.storage.store({ tenantId: s.a, purpose: "attachment", bytes: pdf(), record: { type: "estimator.estimate", id: "e1" } });
    await s.w.storage.store({ tenantId: s.a, purpose: "estimator.photo", bytes: PNG, record: { type: "estimator.estimate", id: "e1" } });
    const list = await readJson<AttachmentsWire>(await s.call(request(s.a, "owner", "v1/admin/attachments", { query: { record: "estimator.estimate", id: "e1" } })));
    expect(list.files.map((f) => f.id)).toEqual([attachment.id]);
    expect(list.canAdd).toBe(true);
    expect(list.uploads.rule).toBe("Photos (JPEG, PNG, WebP, GIF, HEIC) or PDFs, up to 4 MB");
    const missing = await s.call(request(s.a, "owner", "v1/admin/attachments", { query: { record: "estimator.estimate" } }));
    expect(missing.status).toBe(400);
  });
});

describe("mechanics", () => {
  it("405 with allow, OPTIONS without CORS, unknown paths 404, cross-site POSTs refused before any work", async () => {
    const s = scene();
    const put = await s.call(request(s.a, "owner", "v1/admin/files", { method: "PUT" }));
    expect([put.status, put.headers.get("allow")]).toEqual([405, "GET, POST"]);
    const options = await s.call(request(s.a, "owner", "v1/admin/files", { method: "OPTIONS" }));
    expect(options.status).toBe(204);
    expect(options.headers.get("access-control-allow-origin")).toBeNull();
    expect((await s.call(request(s.a, "owner", "v1/admin/nope"))).status).toBe(404);
    s.members.asked.length = 0;
    const cross = await s.call(upload(s.a, "owner", "v1/admin/files", PNG));
    expect(cross.status).toBe(201);
    const fromElsewhere = upload(s.a, "owner", "v1/admin/files", PNG);
    const forged = new Request(fromElsewhere, { headers: { ...Object.fromEntries(fromElsewhere.headers.entries()), "sec-fetch-site": "cross-site" } });
    s.members.asked.length = 0;
    const refused = await s.call(forged);
    expect(refused.status).toBe(403);
    expect((await readJson<WireErrorBody>(refused)).error.code).toBe("cross_site");
    expect(s.members.asked).toEqual([]);
    expect(refused.headers.get("cache-control")).toBe("no-store");
  });

  it("rateLimit hears the bucket and the person; false is 429", async () => {
    const heard: [string, string, string | null][] = [];
    const s = scene({
      rateLimit: (_req, bucket, tenantId, userId) => {
        heard.push([bucket, tenantId, userId]);
        return bucket !== "link";
      },
    });
    expect((await s.call(upload(s.a, "owner", "v1/admin/files", PNG))).status).toBe(201);
    const file = await s.w.storage.store({ tenantId: s.a, purpose: "library", bytes: PNG });
    const link = await s.call(request(s.a, "owner", `v1/admin/files/${file.id}/link`, { method: "POST", json: {} }));
    expect(link.status).toBe(429);
    expect((await readJson<WireErrorBody>(link)).error.message).toBe("Too many links for now. Try again in a few minutes.");
    expect(heard).toEqual([
      ["upload", s.a, "owner"],
      ["link", s.a, "owner"],
    ]);
  });

  it("without a private store: the list says files are off, and an upload is refused with the same sentence", async () => {
    const s = scene({}, { stores: { public: createMemoryBlobStore({ access: "public" }) } });
    const list = await readJson<FileListWire>(await s.call(request(s.a, "owner", "v1/admin/files")));
    expect(list.uploads).toMatchObject({ available: false, offReason: "File storage isn't switched on yet, so files can't be kept." });
    expect(list.canUpload).toBe(false);
    const res = await s.call(upload(s.a, "owner", "v1/admin/files", PNG));
    expect(res.status).toBe(409);
    expect((await readJson<WireErrorBody>(res)).error).toEqual({ code: "storage_off", message: "File storage isn't switched on yet, so files can't be kept." });
  });

  it("an authorize that throws is a 500 with a fixed sentence, reported", async () => {
    const reported: string[] = [];
    const s = scene({
      authorize: () => {
        throw new Error("session store down");
      },
      onError: (_e, context) => reported.push(context.route),
    });
    const res = await s.call(request(s.a, "owner", "v1/admin/usage"));
    expect(res.status).toBe(500);
    expect((await readJson<WireErrorBody>(res)).error).toEqual({ code: "internal", message: "Something went wrong. Please try again." });
    expect(reported).toEqual(["usage"]);
  });

  it("a member without files.manage can't upload to the company's files", async () => {
    const s = scene();
    const res = await s.call(upload(s.a, "member", "v1/admin/files", PNG));
    expect(res.status).toBe(403);
    expect((await readJson<WireErrorBody>(res)).error.message).toBe("You don't have permission to add files.");
  });
});
