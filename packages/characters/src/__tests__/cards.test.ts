import { describe, expect, it } from "vitest";
import { cardsFor, keyPattern, lintCards, mentionedCardIds, opensAt } from "../cards.js";
import type { LoreCard } from "../types.js";

const ALL = Number.POSITIVE_INFINITY;
const card = (id: string, book: number, more: Partial<LoreCard> = {}): LoreCard => ({
  id,
  keys: [id],
  text: `card ${id}`,
  when: "test",
  book,
  ...more,
});

describe("keyPattern", () => {
  it("matches a key possessive or not, whatever the apostrophe (the Mongo bug)", () => {
    const re = keyPattern("mongo");
    expect(re.test("mongo is here")).toBe(true);
    expect(re.test("Mongo's a father")).toBe(true);
    expect(re.test("mongoose")).toBe(false);
    expect(re.test("ringomongo")).toBe(false);
  });

  it("is case-insensitive and matches a whole phrase key", () => {
    const re = keyPattern("Growler Gary");
    expect(re.test("have you met growler gary")).toBe(true);
    expect(re.test("GROWLER GARY's hands")).toBe(true);
  });
});

describe("opensAt", () => {
  it("opens at or after a card's book, and closes past its maxBook", () => {
    expect(opensAt({ book: 5 }, 4)).toBe(false);
    expect(opensAt({ book: 5 }, 5)).toBe(true);
    expect(opensAt({ book: 5, maxBook: 10 }, 11)).toBe(false);
    expect(opensAt({}, 0)).toBe(true);
  });
});

describe("cardsFor", () => {
  const cards: LoreCard[] = [
    card("rand-farm", 1, { keys: ["rand"] }),
    card("rand-tower", 13, { keys: ["rand"] }),
    card("peace", 13, { maxBook: 13 }),
    card("who", 11, { keys: ["hand"], secret: true }),
  ];

  it("puts the latest book they've reached first among equal matches", () => {
    expect(cardsFor(cards, "tell me about rand", { through: 13 })).toEqual(["card rand-tower", "card rand-farm"]);
    expect(cardsFor(cards, "tell me about rand", { through: 5 })).toEqual(["card rand-farm"]);
  });

  it("hides a card past its maxBook, even at Infinity", () => {
    expect(cardsFor(cards, "peace", { through: 13 })).toEqual(["card peace"]);
    expect(cardsFor(cards, "peace", { through: 14 })).toEqual([]);
    expect(cardsFor(cards, "peace", { through: ALL })).toEqual([]);
  });

  it("tells a secret card only at or above the given secret tier", () => {
    expect(cardsFor(cards, "his hand", { through: 13 })).toEqual([]);
    expect(cardsFor(cards, "his hand", { through: 13, tier: 1, secretTier: 2 })).toEqual([]);
    expect(cardsFor(cards, "his hand", { through: 13, tier: 2, secretTier: 2 })).toEqual(["card who"]);
  });

  it("never returns a card from past the reader's book, whatever they ask", () => {
    // Distinct, non-overlapping keys this time: `rand-farm`/`rand-tower` above share a
    // key on purpose, for the tie-break test, which would otherwise muddy this one.
    const gated = [card("b1", 1, { keys: ["alpha"] }), card("b5", 5, { keys: ["beta"] }), card("b13", 13, { keys: ["gamma"] })];
    for (const c of gated) {
      for (const through of [1, 2, 4, 5, 12, 13, ALL]) {
        const found = cardsFor(gated, c.keys[0] as string, { through, max: 50 });
        expect(found.includes(c.text), `${c.id} through ${through}`).toBe((c.book ?? 0) <= through);
      }
    }
  });

  it("respects leaveOut (a hook's own ending, kept out of her notes)", () => {
    expect(cardsFor(cards, "tell me about rand", { through: 13, leaveOut: ["rand-tower"] })).toEqual(["card rand-farm"]);
  });

  it("excludes cards by id up front (a world's always-known cards)", () => {
    expect(cardsFor(cards, "tell me about rand", { through: 13, exclude: ["rand-tower"] })).toEqual(["card rand-farm"]);
  });

  it("uses a card's night text when asked, for a card that has one", () => {
    const withNight = [card("sunset", 1, { night: "night version" })];
    expect(cardsFor(withNight, "sunset", { night: false })).toEqual(["card sunset"]);
    expect(cardsFor(withNight, "sunset", { night: true })).toEqual(["night version"]);
  });

  it("normalizes a curly apostrophe in what was said before matching", () => {
    expect(cardsFor([card("mongo", 1, { keys: ["mongo"] })], "mongo’s a father now")).toEqual(["card mongo"]);
  });

  it("caps at max, best matches first", () => {
    const many = Array.from({ length: 5 }, (_, i) => card(`c${i}`, 1, { keys: ["topic"] }));
    expect(cardsFor(many, "topic", { max: 2 }).length).toBe(2);
  });
});

describe("mentionedCardIds", () => {
  it("finds every card mentioned, gated or not, capped or not", () => {
    const cards = [card("early", 1), card("late", 13)];
    const ids = mentionedCardIds(cards, "I want to know about early and late both");
    expect(ids.has("early")).toBe(true);
    expect(ids.has("late")).toBe(true);
  });

  it("finds nothing when nothing is mentioned", () => {
    expect(mentionedCardIds([card("x", 1)], "something else entirely").size).toBe(0);
  });
});

describe("lintCards", () => {
  it("catches a duplicate id, no keys, and an uppercase key", () => {
    const problems = lintCards([
      { id: "dup", keys: ["ok"], text: "[B1] ok", when: "t", book: 1 },
      { id: "dup", keys: [], text: "[B1] ok", when: "t", book: 1 },
      { id: "shouty", keys: ["Rand"], text: "[B1] ok", when: "t", book: 1 },
    ]);
    expect(problems).toContain("dup: the id is used twice");
    expect(problems).toContain("dup: no keys");
    expect(problems).toContain('shouty: key "Rand" isn\'t lowercase');
  });

  it("catches a text tag that disagrees with the card's own book field", () => {
    const problems = lintCards([{ id: "oops", keys: ["k"], text: "[B5] something", when: "t", book: 6 }]);
    expect(problems).toContain("oops: text says book 5, book field is 6");
  });

  it("is clean for a well-formed card, and silent about the tag when told to skip it", () => {
    expect(lintCards([{ id: "ok", keys: ["k"], text: "[B5] something", when: "t", book: 5 }])).toEqual([]);
    expect(lintCards([{ id: "ok", keys: ["k"], text: "no tag at all", when: "t", book: 5 }], { tag: null })).toEqual([]);
  });
});
