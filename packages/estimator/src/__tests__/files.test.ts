import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEstimate, estimatorFileRecords, estimatorPhotoPurpose } from "../index.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * Tenancy 2b-1, contract 3.5, 10.4 and 10.5: an estimate as a file record
 * (its permissions decide, D12) and the purpose a customer's estimate photo
 * is stored under. On PGlite, so the tenant filter is the real SQL (IF-21).
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

describe("estimatorFileRecords (contract 10.4)", () => {
  it("one type: an estimate, its permissions, nobody assigned", () => {
    const [type, ...rest] = estimatorFileRecords(t.db, { estimateHref: "/app/estimates/{id}" });
    expect(rest).toEqual([]);
    expect({
      type: type!.type,
      label: type!.label,
      pluralLabel: type!.pluralLabel,
      view: type!.view,
      manage: type!.manage,
      assigned: type!.assigned,
    }).toEqual({
      type: "estimator.estimate",
      label: "Estimate",
      pluralLabel: "Estimates",
      view: ["estimator.view"],
      manage: ["estimator.estimates.manage"],
      assigned: undefined,
    });
  });

  it("finds only this company's estimates, in one query: 'Estimate {number} · {customer}', the link, nobody assigned", async () => {
    const tenantId = tenant("summit");
    const other = tenant("other");
    const named = await createEstimate(t.db, { tenantId, customerName: "Pat Rivera", items: [] });
    const nameless = await createEstimate(t.db, { tenantId, items: [] });
    const theirs = await createEstimate(t.db, { tenantId: other, customerName: "Not yours", items: [] });
    const [type] = estimatorFileRecords(t.db, { estimateHref: "/app/estimates/{id}" });
    t.queries.length = 0;
    const found = await type!.find({ tenantId, ids: [named.id, nameless.id, theirs.id, "no-such-estimate"] });
    expect(t.queries).toHaveLength(1);
    expect([...found.keys()].sort()).toEqual([named.id, nameless.id].sort());
    expect(found.get(named.id)).toEqual({
      label: `Estimate ${named.estimateNumber} · Pat Rivera`,
      href: `/app/estimates/${encodeURIComponent(named.id)}`,
      assignedUserIds: [],
    });
    expect(found.get(nameless.id)!.label).toBe(`Estimate ${nameless.estimateNumber}`);
    expect((await type!.find({ tenantId: other, ids: [named.id] })).size).toBe(0);
    t.queries.length = 0;
    expect((await type!.find({ tenantId, ids: [] })).size).toBe(0);
    expect(t.queries).toHaveLength(0);
  });
});

describe("estimatorPhotoPurpose (contract 10.5)", () => {
  // Storage's StoragePurpose rules (6.4), copied as a check: the estimator
  // never imports storage (2a D4).
  const PURPOSE_KEY = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){0,3}$/;
  const FILE_TYPES = new Set(["jpeg", "png", "webp", "gif", "heic", "pdf"]);

  it("is a valid storage purpose: private, photos only, 4 MB, counted but never refused for a full company, capped at a fifth, hidden until attached", () => {
    const p = estimatorPhotoPurpose;
    expect(PURPOSE_KEY.test(p.key)).toBe(true);
    expect(p.key).toBe("estimator.photo");
    expect(p.label).toBe("Estimate photo");
    expect(p.access).toBe("private");
    expect(p.types.every((type) => FILE_TYPES.has(type))).toBe(true);
    expect([...p.types]).toEqual(["jpeg", "png", "webp"]);
    expect(p.maxBytes).toBe(4 * 1024 * 1024);
    expect(p.exemptFromAllowance).toBe(true);
    expect(p.maxShareOfAllowance).toBe(0.2);
    expect(p.maxShareOfAllowance).toBeGreaterThanOrEqual(0);
    expect(p.maxShareOfAllowance).toBeLessThanOrEqual(1);
    expect([...p.view]).toEqual(["estimator.view"]);
    expect(p.removableFromFiles).toBe(false);
    expect(p.hiddenUntilAttached).toBe(true);
    // SVG and HTML can carry script: never a photo type.
    expect(p.types as readonly string[]).not.toContain("svg");
    expect(Object.isFrozen(p)).toBe(true);
  });
});
