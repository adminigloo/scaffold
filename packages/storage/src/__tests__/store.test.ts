import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantFolder, STORAGE_KEY_PATTERN } from "../keys.js";
import { createMemoryBlobStore, type MemoryBlobStore } from "../memory.js";
import { StorageError, type BlobStore } from "../types.js";
import { createTestDb, jpeg, PNG, pdf, pngOfSize, tenant, type TestDb } from "./pglite.js";
import { buildWorld, ESTIMATE_PHOTO } from "./world.js";

/**
 * `store` (6.6): each refusal with its sentence, the keys, the extension
 * rule, bytes first and receipt second, and the allowance re-checked under
 * the lock, with two uploads interleaved by hand in both orders.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

async function refusal(promise: Promise<unknown>): Promise<StorageError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(StorageError);
    return error as StorageError;
  }
  throw new Error("expected a refusal");
}

describe("refusals, each with its sentence", () => {
  it("an unknown purpose or record type, empty bytes, a long name", async () => {
    const w = buildWorld(t);
    const a = tenant();
    expect((await refusal(w.storage.store({ tenantId: a, purpose: "nope", bytes: PNG }))).code).toBe("unknown_purpose");
    expect((await refusal(w.storage.store({ tenantId: a, purpose: "attachment", bytes: PNG, record: { type: "nope.thing", id: "1" } }))).code).toBe("unknown_record");
    const empty = await refusal(w.storage.store({ tenantId: a, purpose: "library", bytes: new Uint8Array(0) }));
    expect([empty.code, empty.message]).toEqual(["invalid", "That file is empty."]);
    expect((await refusal(w.storage.store({ tenantId: a, purpose: "library", bytes: PNG, filename: "x".repeat(201) }))).code).toBe("invalid");
    expect((await refusal(w.storage.store({ tenantId: "", purpose: "library", bytes: PNG }))).code).toBe("invalid");
  });

  it("storage off: no store for the purpose's access", async () => {
    const w = buildWorld(t, { stores: { public: createMemoryBlobStore({ access: "public" }) } });
    const error = await refusal(w.storage.store({ tenantId: tenant(), purpose: "library", bytes: PNG }));
    expect([error.code, error.message]).toEqual(["storage_off", "File storage isn't switched on yet, so files can't be kept."]);
    expect(w.storage.available("library")).toEqual({ available: false, reason: "File storage isn't switched on yet, so files can't be kept." });
    expect(w.storage.available("company.logo")).toEqual({ available: true });
  });

  it("too big, from the purpose's own limit", async () => {
    const w = buildWorld(t);
    const error = await refusal(w.storage.store({ tenantId: tenant(), purpose: "company.logo", bytes: pngOfSize(1024 * 1024 + 1) }));
    expect([error.code, error.message]).toEqual(["file_too_big", "That file is too big. Files can be up to 1 MB."]);
  });

  it("the wrong kind: SVG, HTML, a PDF where only photos go", async () => {
    const w = buildWorld(t);
    const a = tenant();
    const svg = await refusal(w.storage.store({ tenantId: a, purpose: "library", bytes: new TextEncoder().encode("<svg><script>x</script></svg>"), declaredType: "image/png" }));
    expect([svg.code, svg.message]).toEqual(["file_type", "That kind of file can't be kept here. Use a photo (JPEG, PNG, WebP, GIF or HEIC) or a PDF."]);
    const logo = await refusal(w.storage.store({ tenantId: a, purpose: "company.logo", bytes: pdf() }));
    expect([logo.code, logo.message]).toEqual(["file_type", "That kind of file can't be kept here. Use a photo (PNG, JPEG or WebP)."]);
    expect(w.priv.objects.size + w.pub.objects.size).toBe(0);
  });
});

describe("keys (D10, review G7)", () => {
  it("a private file: t/{16 hex}/…, never the raw company id; no URL", async () => {
    const w = buildWorld(t);
    const a = tenant("Acme Lawn");
    const file = await w.storage.store({ tenantId: a, purpose: "library", bytes: PNG, filename: "yard.png" });
    expect(STORAGE_KEY_PATTERN.test(file.key)).toBe(true);
    expect(file.key.startsWith(`t/${await tenantFolder(a)}/2026/10/`)).toBe(true);
    expect(file.key).not.toContain(a);
    expect(file.access).toBe("private");
    expect(file.publicUrl).toBeNull();
    expect([...w.priv.objects.keys()]).toEqual([file.key]);
    expect(w.pub.objects.size).toBe(0);
  });

  it("a public file: p/ + 32 characters, no company, no file name; its address on the public route", async () => {
    const w = buildWorld(t);
    const a = tenant();
    const file = await w.storage.store({ tenantId: a, purpose: "company.logo", bytes: PNG, filename: "green-acres-logo.png" });
    expect(file.key).toMatch(/^p\/[A-Za-z0-9_-]{32}\.png$/);
    expect(file.key).not.toContain(a);
    expect(file.key).not.toContain("green");
    expect(file.publicUrl).toBe(`https://app.test/api/files/v1/p/${file.key.slice(2)}`);
    expect([...w.pub.objects.keys()]).toEqual([file.key]);
  });

  it("a company id of a/../b, or %2e%2e, lands under its own hashed folder", async () => {
    const w = buildWorld(t);
    for (const id of ["a/../b", "%2e%2e"]) {
      const file = await w.storage.store({ tenantId: id, purpose: "library", bytes: PNG });
      expect(file.key.split("/")[1]).toBe(await tenantFolder(id));
      expect(STORAGE_KEY_PATTERN.test(file.key)).toBe(true);
      expect(file.tenantId).toBe(id);
    }
  });
});

describe("what is kept", () => {
  it("PDF bytes named x.html are stored as x.pdf, typed application/pdf (review G18)", async () => {
    const w = buildWorld(t);
    const file = await w.storage.store({ tenantId: tenant(), purpose: "library", bytes: pdf(), filename: "x.html", declaredType: "text/html" });
    expect([file.filename, file.contentType]).toEqual(["x.pdf", "application/pdf"]);
    expect(file.key.endsWith(".pdf")).toBe(true);
  });

  it("a photo with no name gets one from its purpose and the day; size and sha256 measured", async () => {
    const w = buildWorld(t);
    const bytes = jpeg(800, 600);
    const file = await w.storage.store({ tenantId: tenant(), purpose: "attachment", bytes, addedBy: "u1" });
    expect(file.filename).toBe("Photo or file 2026-10-15.jpg");
    expect([file.width, file.height, file.sizeBytes]).toEqual([800, 600, bytes.length]);
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(file.addedBy).toBe("u1");
  });

  it("bytes first, receipt second; the bytes are taken back out when the receipt fails", async () => {
    const w = buildWorld(t);
    const a = tenant();
    const transaction = t.db.transaction;
    t.db.transaction = (async () => {
      throw new Error("connection reset");
    }) as typeof t.db.transaction;
    try {
      await expect(w.storage.store({ tenantId: a, purpose: "library", bytes: PNG })).rejects.toThrow("connection reset");
    } finally {
      t.db.transaction = transaction;
    }
    expect(w.priv.calls.put).toBe(1);
    expect(w.priv.calls.delete).toBe(1);
    expect(w.priv.objects.size).toBe(0);
    expect((await w.storage.list({ tenantId: a })).files).toEqual([]);
  });

  it("onUsage is told after each store", async () => {
    const w = buildWorld(t, { allowance: 10_000 });
    const a = tenant();
    await w.storage.store({ tenantId: a, purpose: "library", bytes: PNG });
    expect(w.usage).toEqual([{ tenantId: a, outcome: "stored", purpose: "library", usage: { usedBytes: PNG.length, fileCount: 1, allowanceBytes: 10_000 } }]);
  });
});

describe("the allowance (D11)", () => {
  it("refuses past it with the owner's sentence, and tells onUsage", async () => {
    const w = buildWorld(t, { allowance: 1000 });
    const a = tenant();
    await w.storage.store({ tenantId: a, purpose: "library", bytes: pngOfSize(600) });
    const error = await refusal(w.storage.store({ tenantId: a, purpose: "library", bytes: pngOfSize(500) }));
    expect(error.code).toBe("storage_full");
    expect(error.share).toBeUndefined();
    expect(error.message).toBe("Your storage is full: 600 bytes of 1,000 bytes used. Delete files you no longer need to make room.");
    expect(w.usage.at(-1)).toEqual({ tenantId: a, outcome: "refused", purpose: "library", usage: { usedBytes: 600, fileCount: 1, allowanceBytes: 1000 } });
    expect(w.priv.objects.size).toBe(1);
  });

  it("an exempt purpose is never refused for the company's total: the logo still goes in", async () => {
    const w = buildWorld(t, { allowance: 700 });
    const a = tenant();
    await w.storage.store({ tenantId: a, purpose: "library", bytes: pngOfSize(600) });
    const logo = await w.storage.store({ tenantId: a, purpose: "company.logo", bytes: pngOfSize(500) });
    expect(logo.purpose).toBe("company.logo");
    expect((await w.storage.usage(a)).usedBytes).toBe(1100);
  });

  it("a purpose's share (review G6): the estimate photos stop at 20 %, a staff file still stores, no onUsage refusal", async () => {
    const w = buildWorld(t, { allowance: 10_000 });
    const a = tenant();
    await w.storage.store({ tenantId: a, purpose: "estimator.photo", bytes: pngOfSize(1500) });
    const error = await refusal(w.storage.store({ tenantId: a, purpose: "estimator.photo", bytes: pngOfSize(600) }));
    expect([error.code, error.share, error.message]).toEqual(["storage_full", true, "There's no more room for these right now."]);
    expect(w.usage.some((e) => e.outcome === "refused")).toBe(false);
    const staff = await w.storage.store({ tenantId: a, purpose: "library", bytes: pngOfSize(5000) });
    expect(staff.purpose).toBe("library");
    // Exempt AND capped: a full company still takes a customer's photo while
    // the share has room (review BO-06).
    const full = buildWorld(t, { allowance: 2000 });
    const b = tenant();
    await full.storage.store({ tenantId: b, purpose: "library", bytes: pngOfSize(1900) });
    expect((await full.storage.store({ tenantId: b, purpose: "estimator.photo", bytes: pngOfSize(300) })).purpose).toBe(ESTIMATE_PHOTO.key);
  });

  it("no allowance (null): nothing is refused for room", async () => {
    const w = buildWorld(t, { allowance: null });
    const a = tenant();
    for (let i = 0; i < 3; i += 1) await w.storage.store({ tenantId: a, purpose: "estimator.photo", bytes: pngOfSize(3000) });
    expect((await w.storage.usage(a)).allowanceBytes).toBeNull();
  });
});

/** A store whose next put waits at a gate AFTER the bytes are in (so the other upload can run to the end meanwhile). */
function gated(inner: MemoryBlobStore) {
  let gate: Promise<void> | null = null;
  let open: () => void = () => undefined;
  let arrived: () => void = () => undefined;
  let atGate: Promise<void> = Promise.resolve();
  const store: BlobStore = {
    access: inner.access,
    get: (key) => inner.get(key),
    delete: (key) => inner.delete(key),
    async put(key, bytes, options) {
      const result = await inner.put(key, bytes, options);
      if (gate) {
        const waiting = gate;
        gate = null;
        arrived();
        await waiting;
      }
      return result;
    },
  };
  return {
    store,
    hold() {
      gate = new Promise<void>((resolve) => (open = resolve));
      atGate = new Promise<void>((resolve) => (arrived = resolve));
    },
    waitAtGate: () => atGate,
    release: () => open(),
  };
}

describe("the allowance under the lock: two uploads, one room (Tenancy 1 section 13's race rule)", () => {
  for (const order of ["first held", "second held"] as const) {
    it(`one wins, the loser's bytes are deleted (${order})`, async () => {
      const inner = createMemoryBlobStore({ access: "private" });
      const g = gated(inner);
      const w = buildWorld(t, { allowance: 1000, stores: { private: g.store } });
      const a = tenant();
      const first = pngOfSize(600);
      const second = pngOfSize(601);
      g.hold();
      // The held upload passes the pre-check and stores its bytes, then waits.
      const held = w.storage.store({ tenantId: a, purpose: "library", bytes: order === "first held" ? first : second, filename: "held.png" });
      await g.waitAtGate();
      // Meanwhile the other runs to the end: pre-check, bytes, lock, re-check, row.
      const winner = await w.storage.store({ tenantId: a, purpose: "library", bytes: order === "first held" ? second : first, filename: "winner.png" });
      g.release();
      const loser = await refusal(held);
      expect(loser.code).toBe("storage_full");
      const listed = (await w.storage.list({ tenantId: a })).files;
      expect(listed.map((f) => f.id)).toEqual([winner.id]);
      // Only the winner's bytes remain.
      expect([...inner.objects.keys()]).toEqual([winner.key]);
      expect(w.usage.filter((e) => e.outcome === "refused")).toHaveLength(1);
    });
  }

  it("the lock is the FIRST statement of the transaction, on the company's key", async () => {
    const w = buildWorld(t, { allowance: 100_000 });
    const a = tenant();
    t.queries.length = 0;
    await w.storage.store({ tenantId: a, purpose: "library", bytes: PNG });
    const firstInTx = t.queries.findIndex((q) => q.inTransaction);
    expect(firstInTx).toBeGreaterThan(0);
    const lock = t.queries[firstInTx];
    expect(lock?.sql).toMatch(/^select pg_advisory_xact_lock\(hashtext\('storage-usage:' \|\| \$1::text\)\)$/);
    expect(lock?.params).toEqual([a]);
    // The re-check and the insert follow inside the same transaction.
    const inTx = t.queries.filter((q) => q.inTransaction).map((q) => q.sql);
    expect(inTx.some((s) => /coalesce\(sum/.test(s))).toBe(true);
    expect(inTx.some((s) => /^insert into "stored_files"/.test(s))).toBe(true);
  });
});
