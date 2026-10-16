import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStorageLinkHandlers } from "../link-handlers.js";
import { STORAGE_ADMIN_ROUTES, STORAGE_PUBLIC_ROUTES, type StorageRoute } from "../routes.js";
import { createTestDb, PNG, tenant, type TestDb } from "./pglite.js";
import { buildWorld, handlersFor, Members, OWNER_PERMISSIONS, readJson, request, upload, assertNoPrivateKeyLeaked } from "./world.js";

/**
 * The route tables (3.1, 6.7, 6.8) match the router: every row routes to its
 * kind, every example reaches its lookup (the two multipart rows included),
 * and every private row whose permission is null says what the row it reads
 * must grant (`access`), so the emitted proof's role pass can work it out.
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

function fill(text: string, values: Record<string, string>): string {
  return text.replace(/\{([a-z-]+)\}/g, (_m, name: string) => encodeURIComponent(values[name] ?? `missing-${name}`));
}

function routeRequest(tenantId: string, userId: string, route: StorageRoute, values: Record<string, string>): Request {
  const query = Object.fromEntries(Object.entries(route.query ?? {}).map(([k, v]) => [k, decodeURIComponent(fill(v, values))]));
  if (route.method === "POST" && route.body && typeof route.body === "object" && (route.body as { multipart?: string }).multipart === "file") {
    return upload(tenantId, userId, fill(route.path, values), PNG, { query });
  }
  return request(tenantId, userId, fill(route.path, values), { method: route.method, query, ...(route.method === "POST" ? { json: route.body ?? {} } : {}) });
}

describe("STORAGE_ADMIN_ROUTES", () => {
  it("is the contract's table, frozen", () => {
    expect(STORAGE_ADMIN_ROUTES.map((r) => `${r.kind} ${r.method} ${r.path} ${r.permission}`)).toEqual([
      "usage GET v1/admin/usage files.view",
      "files GET v1/admin/files files.view",
      "upload POST v1/admin/files files.manage",
      "file-get GET v1/admin/files/{file} null",
      "file-content GET v1/admin/files/{file}/content null",
      "file-link POST v1/admin/files/{file}/link null",
      "file-remove POST v1/admin/files/{file}/remove null",
      "attachments GET v1/admin/attachments null",
      "attach POST v1/admin/attachments null",
    ]);
    expect(Object.isFrozen(STORAGE_ADMIN_ROUTES)).toBe(true);
    expect(Object.isFrozen(STORAGE_ADMIN_ROUTES[0])).toBe(true);
    expect(Object.isFrozen(STORAGE_PUBLIC_ROUTES)).toBe(true);
  });

  it("every null-permission private row carries `access` (review G14)", () => {
    const access = Object.fromEntries(STORAGE_ADMIN_ROUTES.filter((r) => r.permission === null).map((r) => [r.kind, r.access]));
    expect(access).toEqual({
      "file-get": { scope: "file", needs: "view" },
      "file-content": { scope: "file", needs: "view" },
      "file-link": { scope: "file", needs: "view" },
      "file-remove": { scope: "file", needs: "manage" },
      attachments: { scope: "record", needs: "view" },
      attach: { scope: "record", needs: "add" },
    });
    for (const row of STORAGE_ADMIN_ROUTES) if (row.permission !== null) expect(row.access, row.kind).toBeUndefined();
    expect(STORAGE_ADMIN_ROUTES.filter((r) => (r.body as { multipart?: string } | undefined)?.multipart === "file").map((r) => r.kind)).toEqual(["upload", "attach"]);
  });

  it("every row routes to its kind: a fixed permission is the first and only ask; a null one asks files.manage first", async () => {
    const w = buildWorld(t);
    const a = tenant();
    for (const route of STORAGE_ADMIN_ROUTES) {
      const asked: string[] = [];
      const h = handlersFor(w, new Members(), {
        authorize: (_req, permission) => {
          asked.push(permission);
          return false;
        },
      });
      const res = await h.handle(routeRequest(a, "someone", route, { file: "f-1", "record-type": "scheduling.visit", record: "v-1" }));
      if (route.permission) {
        expect(res.status, route.kind).toBe(403);
        expect(asked, route.kind).toEqual([route.permission]);
      } else {
        expect(res.status, route.kind).toBe(404);
        expect(asked[0], route.kind).toBe("files.manage");
      }
      // The same path with the other method is not this route.
      const wrong = await h.handle(request(a, "someone", fill(route.path, { file: "f-1" }), { method: route.method === "GET" ? "PUT" : "DELETE" }));
      expect(wrong.status, route.kind).toBe(405);
    }
  });

  it("every example reaches its lookup: on an EMPTY company a path placeholder is 404, the rest below 500", async () => {
    const w = buildWorld(t);
    const members = new Members();
    const empty = tenant("empty");
    members.set(empty, "owner", OWNER_PERMISSIONS);
    const h = handlersFor(w, members);
    const made = { file: crypto.randomUUID(), "record-type": "scheduling.visit", record: crypto.randomUUID() };
    for (const route of STORAGE_ADMIN_ROUTES) {
      const res = await h.handle(routeRequest(empty, "owner", route, made));
      if (/\{[a-z-]+\}/.test(route.path) || route.access?.scope === "record") {
        expect(res.status, route.kind).toBe(404);
        expect((await readJson<{ error: { code: string } }>(res)).error.code, route.kind).toBe("not_found");
      } else {
        expect(res.status, route.kind).toBeLessThan(500);
      }
    }
  });

  it("with real rows, every example answers 2xx for the owner (the multipart rows with a 1×1 PNG)", async () => {
    const w = buildWorld(t);
    const members = new Members();
    const a = tenant();
    members.set(a, "owner", OWNER_PERMISSIONS);
    w.records.add("scheduling.visit", a, "v1", { label: "Visit · Pat Rivera" });
    const h = handlersFor(w, members);
    for (const route of STORAGE_ADMIN_ROUTES) {
      const file = await w.storage.store({ tenantId: a, purpose: "library", bytes: PNG });
      const res = await h.handle(routeRequest(a, "owner", route, { file: file.id, "record-type": "scheduling.visit", record: "v1" }));
      expect(res.status, route.kind).toBeGreaterThanOrEqual(200);
      expect(res.status, route.kind).toBeLessThan(300);
    }
  });
});

describe("STORAGE_PUBLIC_ROUTES", () => {
  it("is the contract's table, and each row routes (a made-up token or key is 404)", async () => {
    expect(STORAGE_PUBLIC_ROUTES.map((r) => `${r.kind} ${r.method} ${r.path} ${r.permission}`)).toEqual([
      "link GET v1/f/{file-token} null",
      "public GET v1/p/{public-key} null",
    ]);
    const links = createStorageLinkHandlers({ storage: buildWorld(t).storage });
    const values = { "file-token": `v1.${"a".repeat(40)}.${"b".repeat(43)}`, "public-key": `${"c".repeat(32)}.png` };
    for (const route of STORAGE_PUBLIC_ROUTES) {
      const res = await links.handle(new Request(`https://app.test/api/files/${fill(route.path, values)}`));
      expect(res.status, route.kind).toBe(404);
      expect(res.headers.get("access-control-allow-origin"), route.kind).toBeNull();
    }
    expect((await links.handle(new Request("https://app.test/api/files/v1/elsewhere"))).status).toBe(404);
  });
});
