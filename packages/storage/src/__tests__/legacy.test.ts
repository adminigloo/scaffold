import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_SIZE_BYTES,
  deleteFile,
  getFile,
  listFiles,
  sanitizeFilename,
  storeFile,
  type BlobStoreV1,
} from "../index.js";
import { createTestDb, PNG, tenant, type TestDb } from "./pglite.js";
import { buildWorld } from "./world.js";

/**
 * 0.1's API on 0.2 (6.11): the eleven cases of 0.1's suite (storage.test.ts,
 * which ran on a fake db that answered every query the same whatever its
 * WHERE said), kept, now against PGlite and the 0.2 table built from the
 * shipped SQL, so the tenant filters are really checked. Plus what 0.2 adds
 * to them: rows written public, and 0.2's private files invisible to them.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

/** A store that remembers its puts and deletes, and can be told to fail. */
function fakeStore(options: { deleteRejects?: boolean } = {}) {
  const puts: Array<{ pathname: string; contentType: string }> = [];
  const deletes: string[] = [];
  const store: BlobStoreV1 = {
    put: async (pathname, _body, opts) => {
      puts.push({ pathname, contentType: opts.contentType });
      return { url: `https://blobs.example/${pathname}`, pathname };
    },
    delete: async (pathname) => {
      deletes.push(pathname);
      if (options.deleteRejects) throw new Error("store unavailable");
    },
  };
  return { store, puts, deletes };
}

const input = (tenantId: string) => ({
  tenantId,
  ownerId: "user_1",
  kind: "library.file",
  filename: "Q3 report.pdf",
  contentType: "application/pdf",
  sizeBytes: 1024,
  body: "bytes",
});

describe("sanitizeFilename", () => {
  it("keeps ordinary names and their extension dots", () => {
    expect(sanitizeFilename("invoice-2026.final.pdf")).toBe("invoice-2026.final.pdf");
  });

  it("underscores separators, spaces and specials", () => {
    const backslash = String.fromCharCode(92);
    const cleaned = sanitizeFilename(`a/b${backslash}c: d*e?.png`);
    expect(cleaned).not.toContain("/");
    expect(cleaned).not.toContain(backslash);
    expect(cleaned).not.toContain(" ");
    expect(cleaned.endsWith(".png")).toBe(true);
  });

  it("refuses to produce a dotfile or an empty name", () => {
    expect(sanitizeFilename("..htaccess").startsWith(".")).toBe(false);
    expect(sanitizeFilename("   ")).toBe("file");
  });
});

describe("storeFile", () => {
  it("puts the blob under the tenant's prefix, then writes the receipt (public, 0.2's access column)", async () => {
    const a = tenant("acme");
    const { store, puts } = fakeStore();
    const row = await storeFile(t.db, store, input(a));
    expect(puts).toHaveLength(1);
    expect(puts[0]?.pathname.startsWith(`t/${a}/`)).toBe(true);
    expect(puts[0]?.pathname.endsWith("Q3_report.pdf")).toBe(true);
    expect(puts[0]?.contentType).toBe("application/pdf");
    expect(row.tenantId).toBe(a);
    expect(row.filename).toBe("Q3_report.pdf");
    expect(row.url).toContain(`t/${a}/`);
    const stored = await t.client.query<{ access: string; tenant_id: string }>("select access, tenant_id from stored_files where id = $1", [row.id]);
    expect(stored.rows[0]).toEqual({ access: "public", tenant_id: a });
  });

  it("rejects a file over the size cap before touching the store", async () => {
    const { store, puts } = fakeStore();
    await expect(storeFile(t.db, store, { ...input(tenant()), sizeBytes: DEFAULT_MAX_SIZE_BYTES + 1 })).rejects.toThrow(/limit/);
    expect(puts).toHaveLength(0);
  });

  it("rejects a content type that is not a media type", async () => {
    const { store, puts } = fakeStore();
    await expect(storeFile(t.db, store, { ...input(tenant()), contentType: "not a type" })).rejects.toThrow();
    expect(puts).toHaveLength(0);
  });

  it("takes the blob back out when the receipt cannot be written", async () => {
    const { store, puts, deletes } = fakeStore();
    const a = tenant();
    const first = await storeFile(t.db, store, input(a));
    // Same pathname again: the unique index refuses the second receipt.
    const clash: BlobStoreV1 = { put: async () => ({ url: first.url, pathname: first.pathname }), delete: store.delete };
    await expect(storeFile(t.db, clash, input(a))).rejects.toThrow();
    expect(puts).toHaveLength(1);
    expect(deletes).toEqual([first.pathname]);
  });
});

describe("deleteFile", () => {
  it("never touches the store when the row was not this tenant's", async () => {
    const { store, deletes } = fakeStore();
    const row = await storeFile(t.db, store, input(tenant()));
    const result = await deleteFile(t.db, store, { id: row.id, tenantId: tenant("other") });
    expect(result).toEqual({ deleted: false, blobRemoved: false });
    expect(deletes).toHaveLength(0);
  });

  it("deletes the blob the row named", async () => {
    const { store, deletes } = fakeStore();
    const a = tenant();
    const row = await storeFile(t.db, store, input(a));
    const result = await deleteFile(t.db, store, { id: row.id, tenantId: a });
    expect(result).toEqual({ deleted: true, blobRemoved: true });
    expect(deletes).toEqual([row.pathname]);
    expect(await getFile(t.db, { id: row.id, tenantId: a })).toBeNull();
  });

  it("reports a store failure instead of throwing — the receipt is already gone", async () => {
    const { store } = fakeStore({ deleteRejects: true });
    const a = tenant();
    const row = await storeFile(t.db, store, input(a));
    const result = await deleteFile(t.db, store, { id: row.id, tenantId: a });
    expect(result).toEqual({ deleted: true, blobRemoved: false });
  });
});

describe("listFiles", () => {
  it("returns only the tenant's files, newest first, by kind when asked", async () => {
    const { store } = fakeStore();
    const a = tenant();
    const one = await storeFile(t.db, store, input(a));
    const two = await storeFile(t.db, store, { ...input(a), kind: "other.kind" });
    await storeFile(t.db, store, input(tenant("elsewhere")));
    expect((await listFiles(t.db, { tenantId: a })).map((r) => r.id).sort()).toEqual([one.id, two.id].sort());
    expect((await listFiles(t.db, { tenantId: a, kind: "other.kind" })).map((r) => r.id)).toEqual([two.id]);
  });
});

describe("0.1's functions and 0.2's private files", () => {
  it("never see a private file: it has no URL to hand them, and its bytes aren't in their store", async () => {
    const w = buildWorld(t);
    const a = tenant();
    const file = await w.storage.store({ tenantId: a, purpose: "library", bytes: PNG });
    expect(await listFiles(t.db, { tenantId: a })).toEqual([]);
    expect(await getFile(t.db, { id: file.id, tenantId: a })).toBeNull();
    const { store, deletes } = fakeStore();
    expect(await deleteFile(t.db, store, { id: file.id, tenantId: a })).toEqual({ deleted: false, blobRemoved: false });
    expect(deletes).toEqual([]);
    expect(await w.storage.get({ tenantId: a, fileId: file.id })).not.toBeNull();
  });
});
