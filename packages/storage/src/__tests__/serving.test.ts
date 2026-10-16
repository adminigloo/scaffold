import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, jpeg, PNG, pdf, tenant, type TestDb } from "./pglite.js";
import { buildWorld, handlersFor, Members, MEMBER_PERMISSIONS, OWNER_PERMISSIONS, request, assertNoPrivateKeyLeaked, linksFor } from "./world.js";

/**
 * Serving (6.7, 6.8): every private file is streamed by the package (never a
 * redirect), with headers that keep it from ever running as a page; a
 * thumbnail asked for again is answered 304 from the ROW without touching the
 * store; a public file is served only if its row is public.
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

function setup() {
  const w = buildWorld(t);
  const members = new Members();
  const a = tenant();
  members.set(a, "owner", OWNER_PERMISSIONS);
  members.set(a, "member", MEMBER_PERMISSIONS);
  return { w, h: handlersFor(w, members), links: linksFor(w), a };
}

describe("the content route", () => {
  it("a photo: its type, inline, cached privately for five minutes, nosniff, a CSP that allows nothing, no referrer", async () => {
    const { w, h, a } = setup();
    const bytes = jpeg(400, 300);
    const file = await w.storage.store({ tenantId: a, purpose: "library", bytes, filename: "front yard.jpg" });
    const res = await h.handle(request(a, "member", `v1/admin/files/${file.id}/content`));
    expect(res.status).toBe(200);
    expect(Object.fromEntries(res.headers.entries())).toMatchObject({
      "content-type": "image/jpeg",
      "content-length": String(bytes.length),
      "content-disposition": `inline; filename="front yard.jpg"; filename*=UTF-8''front%20yard.jpg`,
      etag: `"${file.sha256}"`,
      "cache-control": "private, max-age=300",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "referrer-policy": "no-referrer",
    });
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it("a document: a download, never cached, under its corrected name (x.html holding a PDF is x.pdf)", async () => {
    const { w, h, a } = setup();
    const file = await w.storage.store({ tenantId: a, purpose: "library", bytes: pdf(), filename: "x.html" });
    const res = await h.handle(request(a, "member", `v1/admin/files/${file.id}/content`));
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="x.pdf"; filename*=UTF-8''x.pdf`);
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
  });

  it("a matching If-None-Match → 304 from the row, before the store is read (review BO-19)", async () => {
    const { w, h, a } = setup();
    const file = await w.storage.store({ tenantId: a, purpose: "library", bytes: PNG });
    const reads = w.priv.calls.get;
    const res = await h.handle(request(a, "member", `v1/admin/files/${file.id}/content`, { headers: { "if-none-match": `"${file.sha256}"` } }));
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
    expect(w.priv.calls.get).toBe(reads);
    // Someone who can't see the file gets 404, not a 304 that confirms it exists.
    const b = tenant();
    const strangerRes = await h.handle(request(b, "member", `v1/admin/files/${file.id}/content`, { headers: { "if-none-match": `"${file.sha256}"` } }));
    expect(strangerRes.status).toBe(403);
    // A different ETag reads the store.
    const fresh = await h.handle(request(a, "member", `v1/admin/files/${file.id}/content`, { headers: { "if-none-match": '"other"' } }));
    expect(fresh.status).toBe(200);
    expect(w.priv.calls.get).toBe(reads + 1);
  });

  it("never a redirect: no route answers 3xx or carries a Location", async () => {
    const { w, h, links, a } = setup();
    const file = await w.storage.store({ tenantId: a, purpose: "library", bytes: PNG });
    const logo = await w.storage.store({ tenantId: a, purpose: "company.logo", bytes: PNG });
    w.valid.add(`${a}|owner`);
    const link = await w.storage.signedLink({ tenantId: a, fileId: file.id, userId: "owner" });
    const answers = [
      await h.handle(request(a, "owner", `v1/admin/files/${file.id}/content`)),
      await h.handle(request(a, "owner", `v1/admin/files/${logo.id}/content`)),
      await links.handle(new Request(link?.url ?? "")),
      await links.handle(new Request(logo.publicUrl ?? "")),
    ];
    for (const res of answers) {
      expect(res.status).toBe(200);
      expect(res.headers.get("location")).toBeNull();
    }
  });

  it("a missing object → 404, and it is reported", async () => {
    const { w, h, a } = setup();
    const file = await w.storage.store({ tenantId: a, purpose: "library", bytes: PNG });
    await w.priv.delete(file.key);
    const res = await h.handle(request(a, "owner", `v1/admin/files/${file.id}/content`));
    expect(res.status).toBe(404);
    expect(w.errors.map((e) => e.step)).toContain("missing-object");
  });
});

describe("the public route", () => {
  it("serves a public file by its random part, cached forever", async () => {
    const { w, links, a } = setup();
    const logo = await w.storage.store({ tenantId: a, purpose: "company.logo", bytes: PNG });
    const res = await links.handle(new Request(`https://app.test/api/files/v1/p/${logo.key.slice(2)}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    const head = await links.handle(new Request(`https://app.test/api/files/v1/p/${logo.key.slice(2)}`, { method: "HEAD" }));
    expect([head.status, head.headers.get("content-length")]).toEqual([200, String(PNG.length)]);
    expect((await links.handle(new Request(`https://app.test/api/files/v1/p/${logo.key.slice(2)}`, { method: "POST" }))).status).toBe(405);
  });

  it("never serves a private file, whatever is asked for", async () => {
    const { w, links, a } = setup();
    const file = await w.storage.store({ tenantId: a, purpose: "library", bytes: PNG });
    const randomPart = file.key.split("/").at(-1) as string;
    expect((await links.handle(new Request(`https://app.test/api/files/v1/p/${randomPart}`))).status).toBe(404);
    expect((await links.handle(new Request(`https://app.test/api/files/v1/p/${encodeURIComponent(file.key)}`))).status).toBe(404);
    expect((await links.handle(new Request(`https://app.test/api/files/v1/p/..%2f${randomPart}`))).status).toBe(404);
    // A removed logo is gone from its address at once.
    const logo = await w.storage.store({ tenantId: a, purpose: "company.logo", bytes: PNG });
    await w.storage.remove({ tenantId: a, fileId: logo.id });
    expect((await links.handle(new Request(logo.publicUrl ?? ""))).status).toBe(404);
  });
});
