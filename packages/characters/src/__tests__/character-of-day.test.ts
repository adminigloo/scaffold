import { describe, expect, it } from "vitest";
import { characterOfDay } from "../character-of-day.js";
import type { LoreCard } from "../types.js";

const card = (id: string, book: number, more: Partial<LoreCard> = {}): LoreCard => ({
  id,
  keys: [id],
  text: `card ${id}`,
  when: "test",
  book,
  ...more,
});

const cards: LoreCard[] = [card("best", 1), card("early", 1), card("mid", 5), card("late", 13), card("hush", 1, { secret: true })];
const seed = (visitorId: string, day = "2026-11-12") => ({ venueId: "venue", visitorId, day });

describe("characterOfDay", () => {
  it("is stable: the same visitor, venue and day always get the same pick", () => {
    const a = characterOfDay(cards, seed("traveler-1"), 13);
    const b = characterOfDay(cards, seed("traveler-1"), 13);
    expect(a).toEqual(b);
  });

  it("never picks a card past the visitor's reading gate", () => {
    for (let i = 0; i < 20; i++) {
      const pick = characterOfDay(cards, seed(`traveler-${i}`), 4);
      expect(pick?.book ?? 0).toBeLessThanOrEqual(4);
    }
  });

  it("never picks an excluded card, or a secret one", () => {
    for (let i = 0; i < 20; i++) {
      const pick = characterOfDay(cards, seed(`traveler-${i}`), 13, new Set(), ["best"]);
      expect(pick?.id).not.toBe("best");
      expect(pick?.id).not.toBe("hush");
    }
  });

  it("picks different visitors different cards, more often than not", () => {
    const picks = Array.from({ length: 10 }, (_, i) => characterOfDay(cards, seed(`traveler-${i}`), 13, new Set(), ["best"])?.id);
    expect(new Set(picks).size).toBeGreaterThan(1);
  });

  it("namespaces by venue: the same visitor and day can differ between two venues", () => {
    const picks = new Set(
      ["a", "b", "c", "d", "e"].map((venueId) => characterOfDay(cards, { venueId, visitorId: "same-traveler", day: "2026-11-12" }, 13, new Set(), ["best"])?.id),
    );
    expect(picks.size).toBeGreaterThan(1);
  });

  it("steers away from a card whose keys they've already mentioned, when another is open", () => {
    const pick = characterOfDay(cards, seed("traveler-1"), 13, new Set(), ["best"]);
    expect(pick).not.toBeNull();
    const mentioned = new Set([pick!.id]);
    const next = characterOfDay(cards, seed("traveler-1"), 13, mentioned, ["best"]);
    expect(next?.id).not.toBe(pick!.id);
  });

  it("falls back to the full pool once every open card has been mentioned", () => {
    const all = new Set(["early", "mid", "late"]);
    const pick = characterOfDay(cards, seed("traveler-1"), 13, all, ["best"]);
    expect(pick).not.toBeNull();
    expect(all.has(pick!.id)).toBe(true);
  });

  it("is null when nothing is eligible at all", () => {
    expect(characterOfDay([card("best", 1)], seed("traveler-1"), 13, new Set(), ["best"])).toBeNull();
    expect(characterOfDay([card("hush", 1, { secret: true })], seed("traveler-1"), 13)).toBeNull();
  });
});
