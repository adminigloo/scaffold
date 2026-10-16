import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { notificationsPermissions } from "../permissions.js";
import { NOTIFICATIONS_ADMIN_ROUTE_PERMISSIONS, NOTIFICATIONS_ADMIN_ROUTES } from "../routes.js";
import { greenAcres, mount, world } from "./fixtures.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * The route table as data (Tenancy 2b-1, 3.1, 4.7; 2a 13.2's pattern): every
 * row routes to its kind, the table and the permission map agree, and every
 * example reaches its lookup, so the emitted isolation proof (create-app 14.1)
 * really exercises each route instead of bouncing off a schema.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

describe("NOTIFICATIONS_ADMIN_ROUTES", () => {
  it("agrees with the permission map, is frozen, and has one row per kind", () => {
    for (const row of NOTIFICATIONS_ADMIN_ROUTES) expect(row.permission, row.kind).toBe(NOTIFICATIONS_ADMIN_ROUTE_PERMISSIONS[row.kind]);
    expect(new Set(NOTIFICATIONS_ADMIN_ROUTES.map((r) => r.kind)).size).toBe(Object.keys(NOTIFICATIONS_ADMIN_ROUTE_PERMISSIONS).length);
    expect(Object.isFrozen(NOTIFICATIONS_ADMIN_ROUTES)).toBe(true);
    for (const row of NOTIFICATIONS_ADMIN_ROUTES) expect(Object.isFrozen(row), row.kind).toBe(true);
  });

  it("every permission it names is one of the package's own", () => {
    for (const row of NOTIFICATIONS_ADMIN_ROUTES) expect(Object.keys(notificationsPermissions), row.kind).toContain(row.permission);
  });

  it("every private row with no permission carries `access` (3.1): notifications has none", () => {
    for (const row of NOTIFICATIONS_ADMIN_ROUTES) {
      if (row.permission === null) expect(row.access, row.kind).toBeDefined();
    }
    expect(NOTIFICATIONS_ADMIN_ROUTES.filter((r) => r.permission === null)).toEqual([]);
  });

  it("uses only the entities 3.1 names: {alert} in a path, {person} in a body", () => {
    const placeholders = NOTIFICATIONS_ADMIN_ROUTES.flatMap((row) => [...`${row.path} ${JSON.stringify(row.body ?? {})} ${JSON.stringify(row.query ?? {})}`.matchAll(/\{([a-z-]+)\}/g)].map((m) => m[1]));
    expect(new Set(placeholders)).toEqual(new Set(["alert", "person"]));
  });

  it("every row routes to its kind (the first permission asked is the row's)", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    const h = mount(w);
    for (const row of NOTIFICATIONS_ADMIN_ROUTES) {
      h.asked.length = 0;
      await h.call(a, row.path.replace("{alert}", crypto.randomUUID()), { method: row.method, body: row.body, user: p.owner.userId });
      expect(h.asked[0]?.permission, row.kind).toBe(row.permission);
    }
  });

  it("every example reaches its lookup: on an EMPTY company a path placeholder is 404, the rest below 500", async () => {
    const w = world(t);
    const empty = tenant("empty");
    const p = greenAcres(w.directory, empty);
    const h = mount(w);
    const made = { alert: crypto.randomUUID(), person: crypto.randomUUID() };
    const fill = (text: string) => text.replace(/\{([a-z-]+)\}/g, (_m, name: string) => made[name as keyof typeof made] ?? "");
    for (const row of NOTIFICATIONS_ADMIN_ROUTES) {
      const body = row.body === undefined ? undefined : JSON.parse(fill(JSON.stringify(row.body)));
      const query = row.query ? Object.fromEntries(Object.entries(row.query).map(([k, v]) => [k, fill(v)])) : undefined;
      const res = await h.call(empty, fill(row.path), { method: row.method, body, user: p.owner.userId, ...(query ? { query } : {}) });
      if (/\{[a-z-]+\}/.test(row.path)) {
        expect(res.status, row.kind).toBe(404);
        expect((res.body as { error: { code: string } }).error.code, row.kind).toBe("not_found");
      } else {
        expect(res.status, `${row.kind}: ${res.text}`).toBeLessThan(500);
      }
    }
  });
});
