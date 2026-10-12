import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueClientKey, listClientKeys, normalizeOrigin, originAllowed, updateClientKey, verifyClientKey } from "../keys.js";
import { estimatorClientKeys } from "../schema.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/** Website keys (6.10): the websites each works on, and no write per keystroke. */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

describe("origins", () => {
  it("normalizeOrigin: https (or http on localhost), no path, query or credentials, lowercased", () => {
    expect(normalizeOrigin("https://SummitRamps.com/")).toBe("https://summitramps.com");
    expect(normalizeOrigin("https://summitramps.com:8443")).toBe("https://summitramps.com:8443");
    expect(normalizeOrigin("http://localhost:3200")).toBe("http://localhost:3200");
    expect(normalizeOrigin("http://127.0.0.1")).toBe("http://127.0.0.1");
    for (const bad of ["http://summitramps.com", "https://summitramps.com/estimate", "https://a.com?x=1", "https://u:p@a.com", "summitramps.com", "", "ftp://a.com"]) {
      expect(normalizeOrigin(bad), bad).toBeNull();
    }
  });

  it("originAllowed: an empty list is any website (0.2 keys); a server with no Origin is allowed", () => {
    expect(originAllowed([], "https://anywhere.test")).toBe(true);
    expect(originAllowed(["https://summitramps.com"], "https://summitramps.com")).toBe(true);
    expect(originAllowed(["https://summitramps.com"], "https://SUMMITRAMPS.com")).toBe(true);
    expect(originAllowed(["https://summitramps.com"], "https://evil.test")).toBe(false);
    expect(originAllowed(["https://summitramps.com"], "null")).toBe(false);
    expect(originAllowed(["https://summitramps.com"], null)).toBe(true);
  });
});

describe("keys", () => {
  it("verifyClientKey answers the key's websites and touches last_used_at at most every 10 minutes (ES-08)", async () => {
    const tenantId = tenant("k");
    const issued = await issueClientKey(t.db, { tenantId, label: "Site", allowedOrigins: ["https://summitramps.com"] });
    const now = new Date("2026-11-02T15:00:00Z");
    expect(await verifyClientKey(t.db, issued.key, { now })).toEqual({ keyId: issued.id, tenantId, allowedOrigins: ["https://summitramps.com"] });
    const touched = async () => (await t.db.select().from(estimatorClientKeys).where(eq(estimatorClientKeys.id, issued.id)))[0]!.lastUsedAt;
    expect((await touched())?.toISOString()).toBe(now.toISOString());
    t.queries.length = 0;
    await verifyClientKey(t.db, issued.key, { now: new Date(now.getTime() + 5 * 60_000) });
    expect(t.queries.filter((q) => /^update/.test(q.sql))).toHaveLength(0); // a keystroke later: no write
    expect((await touched())?.toISOString()).toBe(now.toISOString());
    const later = new Date(now.getTime() + 11 * 60_000);
    await verifyClientKey(t.db, issued.key, { now: later });
    expect((await touched())?.toISOString()).toBe(later.toISOString());
    expect(await verifyClientKey(t.db, "not-a-key")).toBeNull();
    expect(await verifyClientKey(t.db, "esk_0000")).toBeNull();
  });

  it("listClientKeys and updateClientKey, tenant-scoped; the hash and plaintext never listed", async () => {
    const tenantId = tenant("k");
    const issued = await issueClientKey(t.db, { tenantId, label: "Site" });
    const [row] = await listClientKeys(t.db, tenantId);
    expect(row).toMatchObject({ id: issued.id, label: "Site", allowedOrigins: [], keyPrefix: issued.key.slice(0, 12) });
    expect(JSON.stringify(row)).not.toContain(issued.key);
    expect(Object.keys(row!)).not.toContain("keyHash");
    expect(await updateClientKey(t.db, tenant("k"), issued.id, { label: "Hijack" })).toBeNull();
    const updated = await updateClientKey(t.db, tenantId, issued.id, { allowedOrigins: ["https://summitramps.com", "https://summitramps.com/"] });
    expect(updated?.allowedOrigins).toEqual(["https://summitramps.com"]);
  });
});
