import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isCrossSiteRequest } from "../http.js";
import type { WireErrorBody } from "../wire.js";
import { createTestDb, PNG, tenant, type TestDb } from "./pglite.js";
import { buildWorld, handlersFor, Members, OWNER_PERMISSIONS, readJson, upload, request } from "./world.js";

/**
 * Review SEC-04: "same-site" is another ORIGIN on the same registrable
 * domain (www.greenacres.com on a CMS, a taken-over sibling subdomain) while
 * the app runs at app.greenacres.com. Its requests carry the SameSite=Lax
 * session cookie, so a state-changing POST from there must be refused like a
 * cross-site one: only the app's own origin (same-origin), or no browser
 * page at all (none), may upload, link or remove.
 */

const at = (headers: Record<string, string>, url = "https://app.greenacres.test/api/app/c1/files/v1/admin/files") =>
  new Request(url, { method: "POST", headers });

describe("isCrossSiteRequest (review SEC-04)", () => {
  it("Sec-Fetch-Site: same-origin and none pass; same-site and cross-site are refused", () => {
    expect(isCrossSiteRequest(at({ "sec-fetch-site": "same-origin" }))).toBe(false);
    expect(isCrossSiteRequest(at({ "sec-fetch-site": "none" }))).toBe(false);
    expect(isCrossSiteRequest(at({ "sec-fetch-site": "same-site" }))).toBe(true);
    expect(isCrossSiteRequest(at({ "sec-fetch-site": "cross-site" }))).toBe(true);
  });

  it("without Sec-Fetch-Site, the Origin must be the request's own origin exactly: a sibling subdomain or another scheme is refused", () => {
    expect(isCrossSiteRequest(at({ origin: "https://app.greenacres.test" }))).toBe(false);
    expect(isCrossSiteRequest(at({ origin: "https://www.greenacres.test" }))).toBe(true);
    expect(isCrossSiteRequest(at({ origin: "http://app.greenacres.test" }))).toBe(true);
    expect(isCrossSiteRequest(at({ origin: "https://app.greenacres.test:8443" }))).toBe(true);
    expect(isCrossSiteRequest(at({ referer: "https://www.greenacres.test/blog" }))).toBe(true);
    expect(isCrossSiteRequest(at({ referer: "https://app.greenacres.test/app/files" }))).toBe(false);
  });

  it("behind a proxy, the forwarded host and scheme name the public origin", () => {
    const inner = "http://localhost:3330/api/app/c1/files/v1/admin/files";
    expect(isCrossSiteRequest(at({ origin: "https://app.greenacres.test", "x-forwarded-host": "app.greenacres.test", "x-forwarded-proto": "https" }, inner))).toBe(false);
    expect(isCrossSiteRequest(at({ origin: "https://www.greenacres.test", "x-forwarded-host": "app.greenacres.test", "x-forwarded-proto": "https" }, inner))).toBe(true);
    expect(isCrossSiteRequest(at({ origin: "http://app.greenacres.test", "x-forwarded-host": "app.greenacres.test", "x-forwarded-proto": "https" }, inner))).toBe(true);
  });
});

describe("the file routes refuse a same-site POST before any work (review SEC-04)", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t.close();
  });

  it("an upload and a remove from a sibling subdomain: 403 cross_site, and authorize is never asked", async () => {
    const w = buildWorld(t);
    const members = new Members();
    const a = tenant();
    members.set(a, "owner", OWNER_PERMISSIONS);
    const h = handlersFor(w, members);
    const file = await w.storage.store({ tenantId: a, purpose: "library", bytes: PNG });
    const sibling = (req: Request) => new Request(req, { headers: { ...Object.fromEntries(req.headers.entries()), "sec-fetch-site": "same-site" } });
    members.asked.length = 0;
    const up = await h.handle(sibling(upload(a, "owner", "v1/admin/files", PNG)));
    expect(up.status).toBe(403);
    expect((await readJson<WireErrorBody>(up)).error.code).toBe("cross_site");
    const remove = await h.handle(sibling(request(a, "owner", `v1/admin/files/${file.id}/remove`, { method: "POST", json: {} })));
    expect(remove.status).toBe(403);
    expect(members.asked).toEqual([]);
    expect(await w.storage.get({ tenantId: a, fileId: file.id })).not.toBeNull();
  });
});
