import { describe, expect, it } from "vitest";
import {
  defaultLayout,
  drawOrder,
  moveCard,
  normalizeLayout,
  resizeCard,
  starCard,
  toggleCard,
  type LayoutCatalogEntry,
} from "../layout.js";

const CATALOG: LayoutCatalogEntry[] = [
  { key: "feedback.board", defaultOn: true, defaultSize: "m", defaultMain: true },
  { key: "site.visits", defaultOn: true },
  { key: "errors", defaultOn: true },
  { key: "audit" },
];

describe("defaultLayout", () => {
  it("is the default-on cards in catalog order, the default main starred, every card known", () => {
    expect(defaultLayout(CATALOG)).toEqual({
      v: 1,
      main: "feedback.board",
      items: [
        { key: "feedback.board", size: "m" },
        { key: "site.visits", size: "s" },
        { key: "errors", size: "s" },
      ],
      known: ["feedback.board", "site.visits", "errors", "audit"],
    });
  });

  it("stars the first card on when none is marked main, and nothing when nothing is on", () => {
    expect(defaultLayout([{ key: "a", defaultOn: true }, { key: "b", defaultOn: true }]).main).toBe("a");
    expect(defaultLayout([{ key: "a" }]).main).toBeNull();
  });
});

describe("normalizeLayout", () => {
  it("treats anything that isn't a layout as the default dashboard", () => {
    for (const raw of [null, 7, "x", {}, { v: 2, items: [] }, { v: 1, items: "no" }]) {
      expect(normalizeLayout(raw, CATALOG)).toEqual(defaultLayout(CATALOG));
    }
  });

  it("drops cards this person can't open, repeats, junk and bad sizes", () => {
    const raw = {
      v: 1,
      main: "secret",
      items: [
        { key: "secret", size: "l" },
        { key: "errors", size: "huge" },
        { key: "errors", size: "l" },
        null,
        { size: "s" },
        { key: "audit", size: "l" },
      ],
      known: CATALOG.map((c) => c.key),
    };
    expect(normalizeLayout(raw, CATALOG)).toEqual({
      v: 1,
      main: null,
      items: [
        { key: "errors", size: "s" },
        { key: "audit", size: "l" },
      ],
      known: ["feedback.board", "site.visits", "errors", "audit"],
    });
  });

  it("adds a default card that's new since the person saved, but never one they turned off", () => {
    const saved = { v: 1, main: null, items: [{ key: "errors", size: "s" }], known: ["errors", "site.visits", "audit"] };
    // feedback.board isn't in `known`: new to them, so it joins. site.visits
    // is known and not on: they turned it off, so it stays off.
    const out = normalizeLayout(saved, CATALOG);
    expect(out.items.map((i) => i.key)).toEqual(["errors", "feedback.board"]);
  });
});

describe("the changes", () => {
  const start = defaultLayout(CATALOG);

  it("turns a card on at the end and off again, and turning off the starred card clears the star", () => {
    const on = toggleCard(start, "audit", true, CATALOG);
    expect(on.items.at(-1)).toEqual({ key: "audit", size: "s" });
    expect(toggleCard(on, "audit", true, CATALOG)).toBe(on);
    const off = toggleCard(on, "feedback.board", false, CATALOG);
    expect(off.main).toBeNull();
    expect(off.items.map((i) => i.key)).toEqual(["site.visits", "errors", "audit"]);
    expect(toggleCard(start, "not-offered", true, CATALOG)).toBe(start);
  });

  it("stars a card, turning it on first if it was off, and clears the star with null", () => {
    const starred = starCard(start, "audit", CATALOG);
    expect(starred.main).toBe("audit");
    expect(starred.items.some((i) => i.key === "audit")).toBe(true);
    expect(starCard(starred, null, CATALOG).main).toBeNull();
  });

  it("resizes and moves", () => {
    expect(resizeCard(start, "errors", "l").items.find((i) => i.key === "errors")?.size).toBe("l");
    expect(moveCard(start, "errors", 0).items.map((i) => i.key)).toEqual(["errors", "feedback.board", "site.visits"]);
    expect(moveCard(start, "errors", 99).items.map((i) => i.key)).toEqual(["feedback.board", "site.visits", "errors"]);
  });

  it("draws the starred card first and at least two columns wide", () => {
    const layout = { ...start, main: "errors", items: start.items.map((i) => ({ ...i })) };
    expect(drawOrder(layout)).toEqual([
      { key: "errors", size: "m" },
      { key: "feedback.board", size: "m" },
      { key: "site.visits", size: "s" },
    ]);
  });
});
