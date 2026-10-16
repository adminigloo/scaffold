import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStorage } from "../instance.js";
import { createMemoryBlobStore } from "../memory.js";
import { createLinkSigner } from "../signing.js";
import type { FileLinkWire, WireErrorBody } from "../wire.js";
import { createTestDb, PNG, tenant, type TestDb } from "./pglite.js";
import { buildWorld, CREW_PERMISSIONS, handlersFor, Members, MEMBER_PERMISSIONS, OWNER_PERMISSIONS, readJson, request, SECRET, assertNoPrivateKeyLeaked, linksFor } from "./world.js";

/**
 * Signed links (D10, review G2): made only for someone who may open the
 * file, at most an hour, and re-checked on EVERY open: the maker must still
 * be an active member of an active company. Every failure is the same 404.
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
  const a = tenant("a");
  const b = tenant("b");
  members.set(a, "owner", OWNER_PERMISSIONS);
  members.set(a, "member", MEMBER_PERMISSIONS);
  members.set(b, "owner-b", OWNER_PERMISSIONS);
  w.valid.add(`${a}|owner`).add(`${a}|member`).add(`${b}|owner-b`);
  return { w, members, h: handlersFor(w, members), links: linksFor(w), a, b };
}

const tokenOf = (url: string) => url.split("/v1/f/")[1] ?? "";
const open = (links: { handle(req: Request): Promise<Response> }, token: string) => links.handle(new Request(`https://app.test/api/files/v1/f/${token}`));

describe("making a link", () => {
  it("through the handler, for someone who may open the file: an hour, the maker in the token", async () => {
    const { w, h, links, a } = setup();
    const file = await w.storage.store({ tenantId: a, purpose: "library", bytes: PNG });
    const res = await h.handle(request(a, "member", `v1/admin/files/${file.id}/link`, { method: "POST", json: {} }));
    expect(res.status).toBe(200);
    const link = await readJson<FileLinkWire>(res);
    expect(link.url.startsWith("https://app.test/api/files/v1/f/v1.")).toBe(true);
    expect(new Date(link.expiresAt).getTime() - w.clock.now.getTime()).toBe(3600 * 1000);
    const served = await open(links, tokenOf(link.url));
    expect(served.status).toBe(200);
    expect(Object.fromEntries(served.headers.entries())).toMatchObject({
      "cache-control": "private, no-cache",
      etag: `"${file.sha256}"`,
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    });
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
    // The payload names the person who made it.
    const payload = JSON.parse(atob((tokenOf(link.url).split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/")));
    expect(payload).toMatchObject({ t: a, f: file.id, u: "member" });
    expect(payload.e - payload.i).toBe(3600);
  });

  it("someone who can't open the file can't make one (404); a file of another company: 404", async () => {
    const { w, h, a, b } = setup();
    const file = await w.storage.store({ tenantId: a, purpose: "attachment", bytes: PNG, record: { type: "invoicing.invoice", id: "i-missing" } });
    expect((await h.handle(request(a, "member", `v1/admin/files/${file.id}/link`, { method: "POST", json: {} }))).status).toBe(404);
    const library = await w.storage.store({ tenantId: a, purpose: "library", bytes: PNG });
    expect((await h.handle(request(b, "owner-b", `v1/admin/files/${library.id}/link`, { method: "POST", json: {} }))).status).toBe(404);
  });

  it("no signing → no links: storage_off from the route, null from the instance", async () => {
    const w = buildWorld(t, { signing: undefined });
    const members = new Members();
    const a = tenant();
    members.set(a, "owner", OWNER_PERMISSIONS);
    const file = await w.storage.store({ tenantId: a, purpose: "library", bytes: PNG });
    const res = await handlersFor(w, members).handle(request(a, "owner", `v1/admin/files/${file.id}/link`, { method: "POST", json: {} }));
    expect(res.status).toBe(409);
    expect((await readJson<WireErrorBody>(res)).error).toEqual({ code: "storage_off", message: "Links to files aren't switched on." });
    expect(await w.storage.signedLink({ tenantId: a, fileId: file.id, userId: "owner" })).toBeNull();
    expect(w.storage.linksEnabled).toBe(false);
  });

  it("a link of more than an hour is refused, here and at construction", async () => {
    const { w, a } = setup();
    const file = await w.storage.store({ tenantId: a, purpose: "library", bytes: PNG });
    await expect(w.storage.signedLink({ tenantId: a, fileId: file.id, userId: "owner", ttlSeconds: 3601 })).rejects.toThrow(/an hour/);
    expect(() =>
      createStorage({
        db: t.db,
        tables: t.tables,
        stores: { private: createMemoryBlobStore({ access: "private" }) },
        urls: { content: () => "/", publicBase: "https://app.test/api/files" },
        signing: { secret: SECRET, ttlSeconds: 7200, stillValid: async () => true },
      }),
    ).toThrow(/ttlSeconds/);
  });
});

describe("opening a link: every failure is the same 404", () => {
  it("expired", async () => {
    const { w, links, a } = setup();
    const file = await w.storage.store({ tenantId: a, purpose: "library", bytes: PNG });
    const link = await w.storage.signedLink({ tenantId: a, fileId: file.id, userId: "owner", ttlSeconds: 60 });
    w.clock.now = new Date(w.clock.now.getTime() + 61_000);
    const res = await open(links, tokenOf(link?.url ?? ""));
    expect(res.status).toBe(404);
    expect((await readJson<WireErrorBody>(res)).error).toEqual({ code: "not_found", message: "This link has expired, or the file was removed." });
  });

  it("tampered: the payload, the MAC, the shape", async () => {
    const { w, links, a, b } = setup();
    const file = await w.storage.store({ tenantId: a, purpose: "library", bytes: PNG });
    const token = tokenOf((await w.storage.signedLink({ tenantId: a, fileId: file.id, userId: "owner" }))?.url ?? "");
    const [v, payload, mac] = token.split(".") as [string, string, string];
    // A's link re-pointed at B, the MAC kept.
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    const rewritten = btoa(JSON.stringify({ ...json, t: b })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const flipped = mac.slice(0, -1) + (mac.endsWith("A") ? "B" : "A");
    for (const bad of [`${v}.${rewritten}.${mac}`, `${v}.${payload}.${flipped}`, `v2.${payload}.${mac}`, `${v}.${payload}`, "garbage", `${token}x`]) {
      expect((await open(links, bad)).status, bad).toBe(404);
    }
    expect((await open(links, token)).status).toBe(200);
  });

  it("a removed file", async () => {
    const { w, links, a } = setup();
    const file = await w.storage.store({ tenantId: a, purpose: "library", bytes: PNG });
    const token = tokenOf((await w.storage.signedLink({ tenantId: a, fileId: file.id, userId: "owner" }))?.url ?? "");
    await w.storage.remove({ tenantId: a, fileId: file.id });
    expect((await open(links, token)).status).toBe(404);
  });

  it("a token CORRECTLY signed for {company B, A's file} finds no row (the lookup is by both)", async () => {
    const { w, links, a, b } = setup();
    const file = await w.storage.store({ tenantId: a, purpose: "library", bytes: PNG });
    const signer = createLinkSigner(SECRET);
    const forged = await signer.sign({ tenantId: b, fileId: file.id, userId: "owner-b", now: w.clock.now, ttlSeconds: 600 });
    expect(await signer.verify(forged, w.clock.now)).not.toBeNull();
    expect(await w.storage.resolveLink(forged)).toBeNull();
    expect((await open(links, forged)).status).toBe(404);
  });

  it("a token signed with a life over an hour is refused, whatever its signer said", async () => {
    const { w, links, a } = setup();
    const file = await w.storage.store({ tenantId: a, purpose: "library", bytes: PNG });
    const long = await createLinkSigner(SECRET).sign({ tenantId: a, fileId: file.id, userId: "owner", now: w.clock.now, ttlSeconds: 7200 });
    expect((await open(links, long)).status).toBe(404);
  });

  it("the maker removed, or the company suspended → 404; back again → 200 (stillValid on every open)", async () => {
    const { w, links, a } = setup();
    const file = await w.storage.store({ tenantId: a, purpose: "library", bytes: PNG });
    const token = tokenOf((await w.storage.signedLink({ tenantId: a, fileId: file.id, userId: "member" }))?.url ?? "");
    expect((await open(links, token)).status).toBe(200);
    w.valid.delete(`${a}|member`);
    expect((await open(links, token)).status).toBe(404);
    w.valid.add(`${a}|member`);
    expect((await open(links, token)).status).toBe(200);
  });

  it("a stillValid that throws is reported and answers the same 404", async () => {
    const w = buildWorld(t, {
      signing: {
        secret: SECRET,
        stillValid: async () => {
          throw new Error("membership lookup down");
        },
      },
    });
    const a = tenant();
    const file = await w.storage.store({ tenantId: a, purpose: "library", bytes: PNG });
    const token = tokenOf((await w.storage.signedLink({ tenantId: a, fileId: file.id, userId: "owner" }))?.url ?? "");
    expect((await open(linksFor(w), token)).status).toBe(404);
    expect(w.errors.map((e) => e.step)).toContain("link-still-valid");
  });
});

describe("the maker's own access to the file, on every open (review SEC-03)", () => {
  // The host's stillValid re-runs the file's rule for the maker with what
  // they hold NOW (`mayView`), the way create-app does: a member demoted, or
  // a crew member taken off the visit, stops opening the file through a link
  // they copied, not only through the screens.
  function hostWorld() {
    const members = new Members();
    const seen: unknown[] = [];
    const w = buildWorld(t, {
      signing: {
        secret: SECRET,
        stillValid: async (check) => {
          seen.push({ tenantId: check.tenantId, userId: check.userId, file: check.file });
          return check.mayView((permission) => {
            const verdict = members.authorize(new Request("https://app.test/", { headers: { "x-user": check.userId } }), permission, check.tenantId);
            return verdict !== false && !(verdict instanceof Response);
          });
        },
      },
    });
    return { w, members, seen, links: linksFor(w) };
  }

  it("stillValid is told which file the link opens", async () => {
    const { w, members, seen, links } = hostWorld();
    const a = tenant();
    members.set(a, "member", MEMBER_PERMISSIONS);
    w.records.add("invoicing.invoice", a, "i1", { label: "Invoice 1001" });
    const file = await w.storage.store({ tenantId: a, purpose: "attachment", bytes: PNG, record: { type: "invoicing.invoice", id: "i1" } });
    const token = tokenOf((await w.storage.signedLink({ tenantId: a, fileId: file.id, userId: "member" }))?.url ?? "");
    expect((await open(links, token)).status).toBe(200);
    expect(seen.at(-1)).toEqual({ tenantId: a, userId: "member", file: { id: file.id, purpose: "attachment", record: { type: "invoicing.invoice", id: "i1" } } });
  });

  it("a maker demoted to crew: the invoice's file stops opening through their link; given it back, it opens again", async () => {
    const { w, members, links } = hostWorld();
    const a = tenant();
    members.set(a, "member", MEMBER_PERMISSIONS);
    w.records.add("invoicing.invoice", a, "i1", { label: "Invoice 1001" });
    const file = await w.storage.store({ tenantId: a, purpose: "attachment", bytes: PNG, record: { type: "invoicing.invoice", id: "i1" } });
    const token = tokenOf((await w.storage.signedLink({ tenantId: a, fileId: file.id, userId: "member" }))?.url ?? "");
    expect((await open(links, token)).status).toBe(200);
    members.set(a, "member", CREW_PERMISSIONS);
    expect((await open(links, token)).status).toBe(404);
    members.set(a, "member", MEMBER_PERMISSIONS);
    expect((await open(links, token)).status).toBe(200);
  });

  it("a crew member taken off the visit: the visit's photo stops opening through their link", async () => {
    const { w, members, links } = hostWorld();
    const a = tenant();
    members.set(a, "cam", CREW_PERMISSIONS);
    w.records.add("scheduling.visit", a, "v1", { label: "Visit · Pat Rivera", assignedUserIds: ["cam"] });
    const photo = await w.storage.store({ tenantId: a, purpose: "attachment", bytes: PNG, record: { type: "scheduling.visit", id: "v1" }, addedBy: "cam" });
    const token = tokenOf((await w.storage.signedLink({ tenantId: a, fileId: photo.id, userId: "cam" }))?.url ?? "");
    expect((await open(links, token)).status).toBe(200);
    w.records.add("scheduling.visit", a, "v1", { label: "Visit · Pat Rivera", assignedUserIds: ["dee"] });
    expect((await open(links, token)).status).toBe(404);
  });
});
