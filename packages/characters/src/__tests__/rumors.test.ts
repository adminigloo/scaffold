import { describe, expect, it } from "vitest";
import { DEFAULT_RECORDS_PER_DAY, recordsFor } from "../rumors.js";
import type { RumorRecord } from "../types.js";

const record = (id: string, book: number): RumorRecord => ({
  id,
  book,
  keys: [id],
  topic: id,
  cards: ["c1"],
  truth: `truth of ${id}`,
  versions: [{ text: `telling of ${id}`, source: "a peddler", sureness: "likely", why: "trusted" }],
  verdict: `take on ${id}`,
});

describe("recordsFor", () => {
  const deck = Array.from({ length: 30 }, (_, i) => record(`r${i}`, (i % 15) + 1));

  it("is stable: the same day and deck always pick the same records", () => {
    expect(recordsFor(deck, "2026-11-12")).toEqual(recordsFor(deck, "2026-11-12"));
  });

  it("picks different records on different days, more often than not", () => {
    const days = Array.from({ length: 10 }, (_, i) => `2026-11-${10 + i}`);
    const picks = days.map((d) => recordsFor(deck, d)[0]?.id);
    expect(new Set(picks).size).toBeGreaterThan(1);
  });

  it("never picks a record past the given boundary", () => {
    for (const day of ["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-20"]) {
      for (const r of recordsFor(deck, day, { boundary: 2 })) expect(r.book).toBeLessThanOrEqual(2);
    }
  });

  it("gives DEFAULT_RECORDS_PER_DAY records when the deck has enough", () => {
    expect(DEFAULT_RECORDS_PER_DAY).toBe(3);
    expect(recordsFor(deck, "2026-11-12")).toHaveLength(3);
  });

  it("respects a custom perDay, capped to the deck's own size", () => {
    expect(recordsFor(deck, "2026-11-12", { perDay: 5 })).toHaveLength(5);
    expect(recordsFor(deck.slice(0, 2), "2026-11-12", { perDay: 5 })).toHaveLength(2);
  });

  it("is empty for an empty deck, or one entirely past the boundary", () => {
    expect(recordsFor([], "2026-11-12")).toEqual([]);
    expect(recordsFor(deck, "2026-11-12", { boundary: 0 })).toEqual([]);
  });
});
