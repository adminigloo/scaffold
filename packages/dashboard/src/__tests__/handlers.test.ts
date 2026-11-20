import { afterEach, describe, expect, it, vi } from "vitest";
import { createPgliteDb } from "../../../testing/src/pglite.js";
import { createDashboardHandlers, type DashboardViewer } from "../handlers.js";
import * as schema from "../schema.js";
import type { DashboardWidget } from "../widget.js";

const NOW = new Date("2026-11-19T18:00:00Z");
const BASE = "https://app.example/api/admin/dashboard/v1";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function database(withTable = true) {
  const t = await createPgliteDb({ schema: withTable ? { ...schema } : {}, logQueries: false });
  close = () => t.close();
  return t.db;
}

function widget(key: string, permission: string, extra: Partial<DashboardWidget> = {}): DashboardWidget {
  return {
    key,
    title: key,
    section: "Tests",
    description: "A test card.",
    icon: "list",
    href: `/admin/${key}`,
    permission,
    defaultOn: true,
    glance: async () => ({ status: { text: `${key} is fine`, tone: "good" } }),
    ...extra,
  };
}

const viewer = (userId: string, keys: string[]): DashboardViewer => ({ userId, can: (k) => keys.includes(k) });

function handlers(db: Awaited<ReturnType<typeof database>>, who: DashboardViewer | Response, extra: Partial<Parameters<typeof createDashboardHandlers>[0]> = {}) {
  return createDashboardHandlers({
    db,
    now: () => NOW,
    authorize: async () => who,
    widgets: [
      widget("open", "staff.open"),
      widget("secret", "staff.secret"),
      widget("broken", "staff.open", {
        defaultOn: false,
        glance: async () => {
          throw new Error("boom: customer data in here");
        },
      }),
    ],
    ...extra,
  });
}

const get = (path: string) => new Request(`${BASE}/${path}`);
const put = (body: unknown, origin?: string) =>
  new Request(`${BASE}/layout`, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
  });

describe("the board", () => {
  it("passes the app's refusal through untouched", async () => {
    const db = await database();
    const refusal = Response.json({ error: { code: "forbidden" } }, { status: 401 });
    const res = await handlers(db, refusal).handle(get("board"));
    expect(res.status).toBe(401);
  });

  it("offers only the cards this person may open, with the default layout until they save one", async () => {
    const db = await database();
    const res = await handlers(db, viewer("u1", ["staff.open"])).handle(get("board"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.catalog.map((c: { key: string }) => c.key)).toEqual(["open", "broken"]);
    expect(body.layout.items.map((i: { key: string }) => i.key)).toEqual(["open"]);
    expect(body.saved).toBe(false);
    expect(body.storage).toBe("ok");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("saves a layout per person, dropping any card they can't open", async () => {
    const db = await database();
    const h = handlers(db, viewer("u1", ["staff.open"]));
    const res = await h.handle(
      put({ layout: { v: 1, main: "secret", items: [{ key: "secret", size: "l" }, { key: "broken", size: "m" }], known: ["open", "broken", "secret"] } }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).layout.items).toEqual([{ key: "broken", size: "m" }]);

    const after = await (await h.handle(get("board"))).json();
    expect(after.saved).toBe(true);
    expect(after.layout.main).toBeNull();
    expect(after.layout.items).toEqual([{ key: "broken", size: "m" }]);

    // Someone else's dashboard is untouched.
    const other = await (await handlers(db, viewer("u2", ["staff.open"])).handle(get("board"))).json();
    expect(other.saved).toBe(false);
  });

  it("refuses a change sent from another site, and junk", async () => {
    const db = await database();
    const h = handlers(db, viewer("u1", ["staff.open"]));
    expect((await h.handle(put({ layout: { v: 1, items: [] } }, "https://evil.example"))).status).toBe(403);
    expect((await h.handle(new Request(`${BASE}/layout`, { method: "PUT", body: "{" }))).status).toBe(400);
    expect((await h.handle(put({ nope: true }))).status).toBe(400);
    expect((await h.handle(new Request(`${BASE}/layout`, { method: "PUT", body: "x".repeat(40_000) }))).status).toBe(413);
  });

  it("goes back to the default on reset", async () => {
    const db = await database();
    const h = handlers(db, viewer("u1", ["staff.open"]));
    await h.handle(put({ layout: { v: 1, main: null, items: [], known: ["open", "broken"] } }));
    const res = await h.handle(new Request(`${BASE}/layout`, { method: "DELETE" }));
    expect((await res.json()).layout.items.map((i: { key: string }) => i.key)).toEqual(["open"]);
    expect((await (await h.handle(get("board"))).json()).saved).toBe(false);
  });

  it("still shows the default dashboard before the table exists, and says saving is unavailable", async () => {
    const db = await database(false);
    const h = handlers(db, viewer("u1", ["staff.open"]));
    const body = await (await h.handle(get("board"))).json();
    expect(body.storage).toBe("unavailable");
    expect(body.layout.items.map((i: { key: string }) => i.key)).toEqual(["open"]);
    expect((await h.handle(put({ layout: { v: 1, items: [] } }))).status).toBe(503);
  });
});

describe("the glances", () => {
  it("runs each card the person may open; a card they can't reads the same as one that doesn't exist", async () => {
    const db = await database();
    const res = await handlers(db, viewer("u1", ["staff.open"])).handle(get("glances?keys=open,secret,nope"));
    const { results } = await res.json();
    expect(results[0]).toEqual({ key: "open", glance: { status: { text: "open is fine", tone: "good" } }, at: NOW.toISOString() });
    expect(results[1].error).toBe("This card isn't available to you.");
    expect(results[2].error).toBe(results[1].error);
  });

  it("never runs a glance the person may not see", async () => {
    const db = await database();
    const spy = vi.fn(async () => ({}));
    const h = createDashboardHandlers({
      db,
      authorize: async () => viewer("u1", []),
      widgets: [widget("secret", "staff.secret", { glance: spy })],
    });
    await h.handle(get("glances?keys=secret"));
    expect(spy).not.toHaveBeenCalled();
  });

  it("reports a failing card without showing its error, and the other cards still load", async () => {
    const db = await database();
    const onError = vi.fn();
    const res = await handlers(db, viewer("u1", ["staff.open"]), { onError }).handle(get("glances?keys=broken,open"));
    const { results } = await res.json();
    expect(results[0].error).toBe("This card couldn't load.");
    expect(JSON.stringify(results)).not.toContain("customer data");
    expect(results[1].glance).toBeTruthy();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { route: "glances", widget: "broken" });
  });

  it("gives up on a slow card after the timeout", async () => {
    const db = await database();
    const h = createDashboardHandlers({
      db,
      glanceTimeoutMs: 20,
      authorize: async () => viewer("u1", ["k"]),
      widgets: [widget("slow", "k", { glance: () => new Promise(() => {}) })],
    });
    const { results } = await (await h.handle(get("glances?keys=slow"))).json();
    expect(results[0].error).toBe("This card took too long to load.");
  });

  it("asks for the cards by name", async () => {
    const db = await database();
    expect((await handlers(db, viewer("u1", ["staff.open"])).handle(get("glances"))).status).toBe(400);
  });

  it("trims what a glance sends to what a card shows", async () => {
    const db = await database();
    const h = createDashboardHandlers({
      db,
      authorize: async () => viewer("u1", ["k"]),
      widgets: [
        widget("big", "k", {
          glance: async () => ({
            tiles: Array.from({ length: 9 }, (_, i) => ({ label: `t${i}`, value: i })),
            list: { rows: Array.from({ length: 20 }, (_, i) => ({ title: `r${i}`, href: i === 0 ? "https://elsewhere.example" : "/ok" })) },
            attention: -3,
          }),
        }),
      ],
    });
    const { results } = await (await h.handle(get("glances?keys=big"))).json();
    expect(results[0].glance.tiles).toHaveLength(4);
    expect(results[0].glance.list.rows).toHaveLength(6);
    expect(results[0].glance.list.rows[0].href).toBeUndefined();
    expect(results[0].glance.attention).toBeUndefined();
  });
});

describe("the app's list of cards", () => {
  it("is checked when the handlers are built", async () => {
    const db = await database();
    const build = (widgets: DashboardWidget[]) => () => createDashboardHandlers({ db, authorize: async () => viewer("u", []), widgets });
    expect(build([widget("a", "k"), widget("a", "k")])).toThrow(/listed twice/);
    expect(build([widget("Bad Key", "k")])).toThrow(/lower case/);
    expect(build([widget("a", "k", { href: "https://x.example" })])).toThrow(/path on this site/);
    expect(build([widget("a", "")])).toThrow(/permission/);
  });
});
