import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STORAGE_KEY_PATTERN } from "../keys.js";
import { createMemoryBlobStore } from "../memory.js";
import { createTestDb, jpeg, PNG, tenant, type TestDb } from "./pglite.js";
import { buildWorld, handlersFor, Members, OWNER_PERMISSIONS, request, type World, assertNoPrivateKeyLeaked } from "./world.js";

/**
 * Moving 0.1's and 2a's public files into the private store (review G11),
 * the logo store and the purpose store (6.9).
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

async function legacyPhoto(w: World, tenantId: string, n: number, age = 0) {
  const id = `legacy-${tenantId}-${n}`;
  const key = `t/${tenantId}/0b0e1a2f-0000-4000-8000-${String(n).padStart(12, "0")}-estimate-photo.jpg`;
  const bytes = jpeg(320, 240);
  w.pub.plant(key, bytes, "image/jpeg");
  await t.client.query(
    `insert into stored_files (id, tenant_id, owner_id, kind, filename, content_type, size_bytes, pathname, url, access, created_at)
     values ($1, $2, 'estimator', 'estimator.photo', 'estimate-photo.jpg', 'image/jpeg', $3, $4, $5, 'public', now() - ($6 || ' minutes')::interval)`,
    [id, tenantId, bytes.length, key, `https://blob.example/${key}`, String(age)],
  );
  return { id, key, bytes };
}

describe("moveToPrivate", () => {
  it("moves a public estimator photo: same id, a private key, the public object deleted, still served", async () => {
    const w = buildWorld(t);
    const a = tenant();
    const old = await legacyPhoto(w, a, 1);
    expect(await w.storage.moveToPrivate({ purpose: "estimator.photo", tenantIds: [a] })).toEqual({ moved: 1, failed: 0, stoppedEarly: false });
    const file = await w.storage.get({ tenantId: a, fileId: old.id });
    expect(file?.access).toBe("private");
    expect(file?.publicUrl).toBeNull();
    expect(STORAGE_KEY_PATTERN.test(file?.key ?? "")).toBe(true);
    expect(file?.key).not.toContain(a);
    expect([file?.width, file?.height]).toEqual([320, 240]);
    expect(file?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(w.pub.objects.has(old.key)).toBe(false);
    expect(w.priv.objects.get(file?.key ?? "")?.bytes).toEqual(old.bytes);
    // The content route still serves it, now from the private store.
    const members = new Members();
    members.set(a, "owner", OWNER_PERMISSIONS);
    const res = await handlersFor(w, members).handle(request(a, "owner", `v1/admin/files/${old.id}/content`));
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(old.bytes);
  });

  it("a copy that fails leaves the row exactly as it was (and the file still opens from the public store)", async () => {
    const w = buildWorld(t);
    const a = tenant();
    const old = await legacyPhoto(w, a, 2);
    w.priv.failNext("put");
    expect(await w.storage.moveToPrivate({ purpose: "estimator.photo", tenantIds: [a] })).toEqual({ moved: 0, failed: 1, stoppedEarly: false });
    const file = await w.storage.get({ tenantId: a, fileId: old.id });
    expect([file?.access, file?.key]).toEqual(["public", old.key]);
    expect(w.pub.objects.has(old.key)).toBe(true);
    expect((await w.storage.open({ tenantId: a, fileId: old.id }))?.object.contentType).toBe("image/jpeg");
    expect(w.errors.map((e) => e.step)).toContain("move-to-private");
  });

  it("oldest first, within the limit; the companies named only; nothing without a private store", async () => {
    const w = buildWorld(t);
    const a = tenant();
    const b = tenant();
    const older = await legacyPhoto(w, a, 3, 30);
    const newer = await legacyPhoto(w, a, 4, 10);
    const other = await legacyPhoto(w, b, 5, 60);
    expect(await w.storage.moveToPrivate({ purpose: "estimator.photo", tenantIds: [a], limit: 1 })).toEqual({ moved: 1, failed: 0, stoppedEarly: true });
    expect((await w.storage.get({ tenantId: a, fileId: older.id }))?.access).toBe("private");
    expect((await w.storage.get({ tenantId: a, fileId: newer.id }))?.access).toBe("public");
    expect((await w.storage.get({ tenantId: b, fileId: other.id }))?.access).toBe("public");
    expect(await w.storage.moveToPrivate({ purpose: "estimator.photo", tenantIds: [] })).toEqual({ moved: 0, failed: 0, stoppedEarly: false });
    const noPrivate = buildWorld(t, { stores: { public: w.pub } });
    expect(await noPrivate.storage.moveToPrivate({ purpose: "estimator.photo" })).toEqual({ moved: 0, failed: 0, stoppedEarly: false });
    expect((await w.storage.get({ tenantId: b, fileId: other.id }))?.access).toBe("public");
  });
});

describe("the logo store (6.9)", () => {
  it("puts the logo public under p/…, answers { url, key: the file id }, and needs the company", async () => {
    const w = buildWorld(t);
    const a = tenant();
    const logos = w.storage.logoStore();
    expect(logos).toBeDefined();
    const put = await logos!.put({ pathname: `tenancy/logos/${a}/ignored.png`, bytes: PNG, contentType: "image/png", tenantId: a });
    const file = await w.storage.get({ tenantId: a, fileId: put.key });
    expect(file?.purpose).toBe("company.logo");
    expect(file?.key).toMatch(/^p\//);
    expect(put.url).toBe(file?.publicUrl);
    await expect(logos!.put({ pathname: "x", bytes: PNG, contentType: "image/png" })).rejects.toThrow(/company/);
    await logos!.delete(put.key, { tenantId: a });
    expect(await w.storage.get({ tenantId: a, fileId: put.key })).toBeNull();
    expect(w.pub.objects.size).toBe(0);
  });

  it("deletes a 2a logo by its pathname from the public store, only under the company's own folder", async () => {
    const w = buildWorld(t);
    const a = tenant();
    const b = tenant();
    const mine = `tenancy/logos/${a}/01890a5d-ac96-774b-bcce-b302099a8057.png`;
    const theirs = `tenancy/logos/${b}/01890a5d-ac96-774b-bcce-b302099a8058.png`;
    w.pub.plant(mine, PNG, "image/png");
    w.pub.plant(theirs, PNG, "image/png");
    const logos = w.storage.logoStore()!;
    await logos.delete(mine, { tenantId: a });
    expect(w.pub.objects.has(mine)).toBe(false);
    await logos.delete(theirs, { tenantId: a });
    expect(w.pub.objects.has(theirs)).toBe(true);
    await logos.delete(theirs);
    expect(w.pub.objects.has(theirs)).toBe(true);
    expect(w.errors.filter((e) => e.step === "logo-delete")).toHaveLength(2);
  });

  it("a logo delete never takes another kind of file with it", async () => {
    const w = buildWorld(t);
    const a = tenant();
    const photo = await w.storage.store({ tenantId: a, purpose: "library", bytes: PNG });
    await w.storage.logoStore()!.delete(photo.id, { tenantId: a });
    expect(await w.storage.get({ tenantId: a, fileId: photo.id })).not.toBeNull();
  });

  it("is undefined without a public store", () => {
    const w = buildWorld(t, { stores: { private: createMemoryBlobStore({ access: "private" }) } });
    expect(w.storage.logoStore()).toBeUndefined();
  });
});

describe("the purpose store (6.9): the estimator's photo store", () => {
  it("stores privately on no record (hidden from Files), opens at the content route, attaches to its estimate", async () => {
    const w = buildWorld(t);
    const a = tenant();
    w.records.add("estimator.estimate", a, "e9", { label: "Estimate 1042 · Pat Rivera" });
    const photos = w.storage.purposeStore("estimator.photo")!;
    const put = await photos.put({ tenantId: a, bytes: PNG, contentType: "image/png", filename: "estimate-photo-abc.png" });
    expect(put.url).toBe(`/api/app/${a}/files/v1/admin/files/${put.fileId}/content`);
    expect(photos.urlFor({ tenantId: a, fileId: put.fileId, url: "https://old.example/x" })).toBe(put.url);
    expect(w.pub.objects.size).toBe(0);
    expect((await w.storage.list({ tenantId: a })).files).toEqual([]);
    expect((await w.storage.list({ tenantId: a, includeHidden: true })).files.map((f) => f.id)).toEqual([put.fileId]);
    await photos.attach({ tenantId: a, fileId: put.fileId, record: { type: "estimator.estimate", id: "e9" } });
    const listed = (await w.storage.list({ tenantId: a })).files;
    expect(listed.map((f) => [f.id, f.record])).toEqual([[put.fileId, { type: "estimator.estimate", id: "e9" }]]);
    await photos.delete({ tenantId: a, fileId: put.fileId });
    expect(w.priv.objects.size).toBe(0);
  });

  it("is undefined for an unknown purpose, or without its store", () => {
    const w = buildWorld(t, { stores: { public: createMemoryBlobStore({ access: "public" }) } });
    expect(w.storage.purposeStore("estimator.photo")).toBeUndefined();
    expect(w.storage.purposeStore("nope")).toBeUndefined();
    expect(w.storage.purposeStore("company.logo")).toBeDefined();
  });
});
