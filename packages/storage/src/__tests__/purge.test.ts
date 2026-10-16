import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_PURGE_ATTEMPTS } from "../instance.js";
import { createMemoryBlobStore, type MemoryBlobStore } from "../memory.js";
import type { BlobStore } from "../types.js";
import { createTestDb, jpeg, PNG, tenant, type TestDb } from "./pglite.js";
import { buildWorld } from "./world.js";

/**
 * Deleting a file removes the stored object (D13), from the store the file
 * is IN (review G11): a 0.1/2a public row's bytes are deleted from the
 * public store, never "deleted" from the private one and left public.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

/** A store whose deletes always fail (a store that is down), counting tries. */
function brokenDeletes(inner: MemoryBlobStore): BlobStore & { tries: number } {
  const store = {
    access: inner.access,
    tries: 0,
    put: (key: string, bytes: Uint8Array, options: { contentType: string }) => inner.put(key, bytes, options),
    get: (key: string) => inner.get(key),
    async delete() {
      store.tries += 1;
      throw new Error("the store is down");
    },
  };
  return store;
}

const row = async (id: string) =>
  (await t.client.query<{ deleted_at: Date | null; purge_attempts: number }>("select deleted_at, purge_attempts from stored_files where id = $1", [id])).rows[0];

describe("remove", () => {
  it("the object goes, then the row", async () => {
    const w = buildWorld(t);
    const a = tenant();
    const file = await w.storage.store({ tenantId: a, purpose: "library", bytes: PNG });
    expect(await w.storage.remove({ tenantId: a, fileId: file.id })).toEqual({ removed: true, objectRemoved: true });
    expect(w.priv.objects.has(file.key)).toBe(false);
    expect(await row(file.id)).toBeUndefined();
    expect(await w.storage.remove({ tenantId: a, fileId: file.id })).toEqual({ removed: false, objectRemoved: false });
  });

  it("another company's id removes nothing and touches no store", async () => {
    const w = buildWorld(t);
    const a = tenant();
    const file = await w.storage.store({ tenantId: a, purpose: "library", bytes: PNG });
    expect(await w.storage.remove({ tenantId: tenant(), fileId: file.id })).toEqual({ removed: false, objectRemoved: false });
    expect(w.priv.calls.delete).toBe(0);
    expect(w.priv.objects.has(file.key)).toBe(true);
  });

  it("a failing store leaves the row marked: out of every list and the usage, one attempt counted", async () => {
    const w = buildWorld(t);
    const a = tenant();
    const file = await w.storage.store({ tenantId: a, purpose: "library", bytes: PNG });
    w.priv.failNext("delete");
    expect(await w.storage.remove({ tenantId: a, fileId: file.id })).toEqual({ removed: true, objectRemoved: false });
    expect(await row(file.id)).toMatchObject({ purge_attempts: 1 });
    expect((await row(file.id))?.deleted_at).not.toBeNull();
    expect((await w.storage.list({ tenantId: a })).files).toEqual([]);
    expect((await w.storage.usage(a)).fileCount).toBe(0);
    expect(await w.storage.get({ tenantId: a, fileId: file.id })).toBeNull();
    expect(w.errors.map((e) => e.step)).toContain("remove-object");
    // The files cron's next run purges it.
    expect(await w.storage.purgeDeleted()).toMatchObject({ purged: 1 });
    expect(w.priv.objects.has(file.key)).toBe(false);
    expect(await row(file.id)).toBeUndefined();
  });
});

describe("purgeDeleted", () => {
  it("retries, and gives up after ten, reporting the key for a person to look at", async () => {
    const inner = createMemoryBlobStore({ access: "private" });
    const broken = brokenDeletes(inner);
    const w = buildWorld(t, { stores: { private: broken } });
    const a = tenant();
    const file = await w.storage.store({ tenantId: a, purpose: "library", bytes: PNG });
    await w.storage.remove({ tenantId: a, fileId: file.id });
    let gaveUp = 0;
    for (let run = 0; run < MAX_PURGE_ATTEMPTS + 2; run += 1) gaveUp += (await w.storage.purgeDeleted()).gaveUp;
    expect(gaveUp).toBe(1);
    expect(broken.tries).toBe(MAX_PURGE_ATTEMPTS);
    expect(await row(file.id)).toMatchObject({ purge_attempts: MAX_PURGE_ATTEMPTS });
    const report = w.errors.find((e) => e.step === "purge-gave-up");
    expect(String((report?.error as Error).message)).toContain(file.key);
    expect(report?.tenantId).toBe(a);
  });

  it("a row whose store isn't configured stays marked (never 'deleted' with its bytes left behind)", async () => {
    const w = buildWorld(t, { stores: { private: createMemoryBlobStore({ access: "private" }) } });
    const a = tenant();
    // A 0.1 public row, with no public store configured now.
    await t.client.query(
      `insert into stored_files (id, tenant_id, owner_id, kind, filename, content_type, size_bytes, pathname, url, access)
       values ($1, $2, 'u', 'library', 'old.png', 'image/png', 10, $3, 'https://blob.example/x', 'public')`,
      ["legacy-no-store", a, `t/${a}/0b0e1a2f-0000-4000-8000-00000000000a-old.png`],
    );
    expect(await w.storage.remove({ tenantId: a, fileId: "legacy-no-store" })).toEqual({ removed: true, objectRemoved: false });
    expect(await w.storage.purgeDeleted()).toMatchObject({ purged: 0, failed: 1 });
    expect(await row("legacy-no-store")).toMatchObject({ purge_attempts: 2 });
  });

  it("stays within its time budget", async () => {
    const w = buildWorld(t);
    const a = tenant();
    for (let i = 0; i < 3; i += 1) {
      const file = await w.storage.store({ tenantId: a, purpose: "library", bytes: PNG });
      w.priv.failNext("delete");
      await w.storage.remove({ tenantId: a, fileId: file.id });
    }
    expect(await w.storage.purgeDeleted({ timeBudgetMs: -1 })).toEqual({ purged: 0, failed: 0, gaveUp: 0 });
    expect((await w.storage.purgeDeleted({ limit: 2 })).purged).toBe(2);
  });
});

describe("the store a file is IN (review G11)", () => {
  it("a 2a PUBLIC estimator.photo deleted through the photo store is deleted from the PUBLIC store", async () => {
    const w = buildWorld(t);
    const a = tenant();
    const key = `t/${a}/0b0e1a2f-0000-4000-8000-00000000000b-estimate-photo.jpg`;
    w.pub.plant(key, jpeg(), "image/jpeg");
    await t.client.query(
      `insert into stored_files (id, tenant_id, owner_id, kind, filename, content_type, size_bytes, pathname, url, access)
       values ($1, $2, 'estimator', 'estimator.photo', 'estimate-photo.jpg', 'image/jpeg', 10, $3, $4, 'public')`,
      ["legacy-photo", a, key, `https://blob.example/${key}`],
    );
    const photos = w.storage.purposeStore("estimator.photo");
    expect(photos).toBeDefined();
    await photos?.delete({ tenantId: a, fileId: "legacy-photo" });
    expect(w.pub.objects.has(key)).toBe(false);
    expect(w.priv.calls.delete).toBe(0);
    expect(await row("legacy-photo")).toBeUndefined();
  });
});
