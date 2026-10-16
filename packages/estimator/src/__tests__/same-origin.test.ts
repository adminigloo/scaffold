import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEstimatorAdminHandlers, createEstimatorHandlers, isCrossSiteRequest } from "../index.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * Tenancy 2b-1 review SEC-04: `Sec-Fetch-Site: same-site` is another ORIGIN
 * on the same registrable domain (www.greenacres.test on a CMS, or a
 * taken-over sibling subdomain, while the app runs at app.greenacres.test).
 * Its requests carry the SameSite=Lax session cookie, so a page there could
 * drive a signed-in owner's browser to change the estimator, or send leads
 * in the company's name. Only same-origin (and none: typed, bookmarked)
 * passes now, as tenancy's check always did. The business's own website
 * embeds the estimator with a key (`x-adminigloo-key`), which needs no
 * same-site check at all.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

/** Contract: the app at app.greenacres.test; www.greenacres.test is a sibling subdomain (a CMS, say). */
const APP = "https://app.greenacres.test/api/admin/estimator/v1/admin/settings";
const MATRIX: Array<[Record<string, string>, boolean]> = [
  [{ "sec-fetch-site": "same-origin" }, false],
  [{ "sec-fetch-site": "none" }, false],
  // A sibling subdomain: it carries the SameSite=Lax session cookie, so it is refused.
  [{ "sec-fetch-site": "same-site" }, true],
  [{ "sec-fetch-site": "same-site", origin: "https://app.greenacres.test" }, true],
  [{ "sec-fetch-site": "cross-site" }, true],
  [{ origin: "https://app.greenacres.test" }, false],
  [{ origin: "https://www.greenacres.test" }, true],
  [{ origin: "null" }, true],
  [{ referer: "https://www.greenacres.test/contact" }, true],
  [{ referer: "https://app.greenacres.test/app/estimates" }, false],
  [{ origin: "https://www.greenacres.test", "x-forwarded-host": "www.greenacres.test" }, false],
  [{}, false], // not a browser
  [{ "sec-fetch-mode": "cors" }, true], // a browser we can't vouch for
];

describe("isCrossSiteRequest: only this origin passes (review SEC-04)", () => {
  it("the matrix", () => {
    for (const [headers, refused] of MATRIX) {
      expect([JSON.stringify(headers), isCrossSiteRequest(new Request(APP, { method: "POST", headers }))]).toEqual([JSON.stringify(headers), refused]);
    }
  });

  it("a same-site page can't save the owner's settings, nor send a lead through the unkeyed public route", async () => {
    const tenantId = tenant("sec04");
    let asked = 0;
    const admin = createEstimatorAdminHandlers({ db: t.db, tenantId, authorize: () => ((asked += 1), true) });
    const headers = { "content-type": "application/json", "sec-fetch-site": "same-site", origin: "https://www.greenacres.test" };
    const res = await admin.handle(new Request(APP, { method: "POST", headers, body: JSON.stringify({ leadNotifyEmails: ["leads@attacker.test"] }) }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("forbidden");
    expect(asked).toBe(0);
    const { handle } = createEstimatorHandlers({ db: t.db, tenantId });
    const submit = await handle(new Request("https://app.greenacres.test/api/estimator/v1/submit", { method: "POST", headers, body: "{}" }));
    expect(submit.status).toBe(403);
  });
});
