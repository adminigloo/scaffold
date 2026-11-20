// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { Glance } from "../glance.js";
import { defaultLayout, type DashboardLayout } from "../layout.js";
import { Dashboard } from "../ui.js";
import type { BoardResponse, CatalogCard } from "../widget.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const card = (key: string, extra: Partial<CatalogCard> = {}): CatalogCard => ({
  key,
  title: key[0]!.toUpperCase() + key.slice(1),
  section: "Things",
  description: `About ${key}.`,
  icon: "list",
  href: `/admin/${key}`,
  defaultOn: true,
  defaultSize: "s",
  defaultMain: false,
  refreshSeconds: 0,
  ...extra,
});

const CATALOG = [card("board", { defaultMain: true, defaultSize: "m" }), card("errors"), card("audit", { defaultOn: false })];

interface Call {
  method: string;
  url: string;
  body?: unknown;
}

function fakeServer(opts: { storage?: "ok" | "unavailable"; failSave?: boolean; glances?: Record<string, Glance | "error"> } = {}) {
  const calls: Call[] = [];
  let layout: DashboardLayout = defaultLayout(CATALOG);
  const glances: Record<string, Glance | "error"> = opts.glances ?? {
    board: { status: { text: "2 tickets are waiting on a reply.", tone: "warn" }, attention: 2, tiles: [{ label: "Open", value: 12345 }] },
    errors: { status: { text: "No unresolved errors.", tone: "good" } },
    audit: { tiles: [{ label: "Last 24 h", value: 4 }] },
  };
  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    if (url.endsWith("/v1/board")) {
      const res: BoardResponse = { catalog: CATALOG, layout, saved: false, storage: opts.storage ?? "ok" };
      return Response.json(res);
    }
    if (url.endsWith("/v1/layout") && method === "PUT") {
      if (opts.failSave) return Response.json({ error: { message: "Couldn't save that change. Try again." } }, { status: 500 });
      layout = body.layout;
      return Response.json({ layout });
    }
    if (url.includes("/v1/glances")) {
      const keys = decodeURIComponent(url.split("keys=")[1] ?? "").split(",");
      const at = "2026-11-19T18:00:00.000Z";
      return Response.json({
        results: keys.map((key) =>
          glances[key] === "error" ? { key, error: "This card couldn't load.", at } : { key, glance: glances[key] ?? {}, at },
        ),
      });
    }
    return new Response("not found", { status: 404 });
  };
  return { calls, fetcher, get layout() { return layout; } };
}

let root: Root | undefined;
let container: HTMLElement | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

async function settle(ms = 0) {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }
}

async function mount(fetcher: (url: string, init?: RequestInit) => Promise<Response>) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<Dashboard api="/api/admin/dashboard" fetcher={fetcher} />));
  await settle();
  return container;
}

async function click(el: Element | null | undefined) {
  if (!el) throw new Error("nothing to click");
  await act(async () => (el as HTMLElement).click());
  await settle();
}

const titles = (c: HTMLElement) => [...c.querySelectorAll(".aid-card .aid-name")].map((n) => n.textContent);
const button = (c: HTMLElement, label: string) =>
  [...c.querySelectorAll("button")].find((b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label);

describe("<Dashboard />", () => {
  it("draws the person's cards, the starred one first, and fills them in", async () => {
    const server = fakeServer();
    const c = await mount(server.fetcher);
    expect(titles(c)).toEqual(["Board", "Errors"]);
    const first = c.querySelector(".aid-card")!;
    expect(first.getAttribute("data-main")).toBe("true");
    expect(first.getAttribute("data-size")).toBe("m");
    expect(first.textContent).toContain("2 tickets are waiting on a reply.");
    // Five digits and up read compact, as a stat tile's figure should.
    expect(first.querySelector(".aid-tile-value")?.textContent).toBe("12.3K");
    expect(first.querySelector(".aid-attn")?.textContent).toContain("2");
    // One request for every card, not one each.
    expect(server.calls.filter((call) => call.url.includes("/v1/glances"))).toHaveLength(1);
  });

  it("adds a card from the catalog and saves the layout once", async () => {
    const server = fakeServer();
    const c = await mount(server.fetcher);
    await click(button(c, "Customize"));
    const audit = c.querySelector<HTMLInputElement>("#aid-cat-audit")!;
    expect(audit.checked).toBe(false);
    await click(audit);
    await settle(120);
    await settle(120);
    await settle(120);
    expect(titles(c)).toEqual(["Board", "Errors", "Audit"]);
    const saves = server.calls.filter((call) => call.method === "PUT");
    expect(saves).toHaveLength(1);
    expect((saves[0]!.body as { layout: DashboardLayout }).layout.items.map((i) => i.key)).toEqual(["board", "errors", "audit"]);
    expect(c.textContent).toContain("Last 24 h");
  });

  it("removes a card with its X, and Undo puts it back", async () => {
    const server = fakeServer();
    const c = await mount(server.fetcher);
    await click(button(c, "Remove Errors from your dashboard"));
    expect(titles(c)).toEqual(["Board"]);
    expect(c.textContent).toContain("Errors is off your dashboard");
    await click(button(c, "Undo"));
    expect(titles(c)).toEqual(["Board", "Errors"]);
  });

  it("puts the saved layout back and says so when a save fails", async () => {
    const server = fakeServer({ failSave: true });
    const c = await mount(server.fetcher);
    await click(button(c, "Remove Errors from your dashboard"));
    expect(titles(c)).toEqual(["Board"]);
    await settle(150);
    await settle(150);
    await settle(150);
    expect(c.querySelector("[role=alert]")?.textContent).toContain("Couldn't save that change");
    expect(titles(c)).toEqual(["Board", "Errors"]);
  });

  it("works without saving before the table exists, and says so", async () => {
    const server = fakeServer({ storage: "unavailable" });
    const c = await mount(server.fetcher);
    expect(c.textContent).toContain("isn't in the database yet");
    await click(button(c, "Remove Errors from your dashboard"));
    await settle(150);
    await settle(150);
    await settle(150);
    expect(titles(c)).toEqual(["Board"]);
    expect(server.calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("shows one card's failure on that card only, with a way to try again", async () => {
    const server = fakeServer({
      glances: { board: { status: { text: "All clear.", tone: "good" } }, errors: "error" },
    });
    const c = await mount(server.fetcher);
    const [board, errors] = [...c.querySelectorAll(".aid-card")];
    expect(board!.textContent).toContain("All clear.");
    expect(errors!.textContent).toContain("This card couldn't load.");
    expect(button(errors as HTMLElement, "Try again")).toBeTruthy();
  });

  it("moves a card by dragging its grip, and with the arrows", async () => {
    const server = fakeServer();
    const c = await mount(server.fetcher);
    await click(button(c, "Customize"));
    await click(c.querySelector<HTMLInputElement>("#aid-cat-audit"));
    expect(titles(c)).toEqual(["Board", "Errors", "Audit"]);

    // The pointer goes down on the Audit card's grip and comes up over the left half of Errors.
    const errors = c.querySelector<HTMLElement>(".aid-card[data-key=errors]")!;
    errors.getBoundingClientRect = () =>
      ({ left: 100, top: 0, width: 200, height: 200, right: 300, bottom: 200, x: 100, y: 0, toJSON: () => ({}) }) as DOMRect;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => errors;
    const grip = c.querySelector<HTMLElement>(".aid-card[data-key=audit] .aid-grip")!;
    const pointer = (type: string, x: number) =>
      act(async () => {
        grip.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, clientX: x, clientY: 50, pointerId: 1 }));
      });
    await pointer("pointerdown", 400);
    await pointer("pointermove", 120);
    expect(errors.getAttribute("data-drop")).toBe("before");
    await pointer("pointerup", 120);
    await settle();
    document.elementFromPoint = original;
    expect(titles(c)).toEqual(["Board", "Audit", "Errors"]);

    // The same from the keyboard: the arrows in the arranging strip.
    await click(button(c, "Move Audit later"));
    expect(titles(c)).toEqual(["Board", "Errors", "Audit"]);
    expect(button(c, "Move Audit later")?.hasAttribute("disabled")).toBe(true);
  });

  it("offers a way back to the catalog when every card is off", async () => {
    const server = fakeServer();
    const c = await mount(server.fetcher);
    await click(button(c, "Remove Board from your dashboard"));
    await click(button(c, "Remove Errors from your dashboard"));
    expect(c.textContent).toContain("Your dashboard is empty");
    await click(button(c, "Choose cards"));
    expect(c.querySelector("#aid-catalog")).toBeTruthy();
  });
});
