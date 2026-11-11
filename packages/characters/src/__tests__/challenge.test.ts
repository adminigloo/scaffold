import { describe, expect, it } from "vitest";
import { challengedNote, challengedRecord, isChallenge } from "../challenge.js";
import type { HistoryLine, RumorRecord } from "../types.js";

const record = (id: string, book: number, more: Partial<RumorRecord> = {}): RumorRecord => ({
  id,
  book,
  keys: [id],
  topic: id,
  cards: ["c1"],
  truth: `the truth about ${id}`,
  versions: [{ text: `garbled ${id}`, source: "a peddler", sureness: "likely", why: "she trusts peddlers" }],
  verdict: `my take on ${id}`,
  ...more,
});

describe("isChallenge", () => {
  it("spots pushback", () => {
    expect(isChallenge("who told you that?")).toBe(true);
    expect(isChallenge("that's wrong")).toBe(true);
    expect(isChallenge("I heard different")).toBe(true);
    expect(isChallenge("tell me more")).toBe(false);
    expect(isChallenge(undefined)).toBe(false);
  });
});

describe("challengedRecord", () => {
  const deck = [record("far-off-war", 1), record("dragon-sighting", 5)];

  it("finds the record from her own last line first", () => {
    const history: HistoryLine[] = [{ role: "character", content: "there's a far-off-war brewing, so they say" }];
    expect(challengedRecord(deck, history, "who told you that?", 10)?.id).toBe("far-off-war");
  });

  it("finds it from what the visitor just said when her last line doesn't name it", () => {
    expect(challengedRecord(deck, [], "that dragon-sighting is wrong", 10)?.id).toBe("dragon-sighting");
  });

  it("never hands over a record past the visitor's reading gate", () => {
    expect(challengedRecord(deck, [], "that dragon-sighting is wrong", 4)).toBeNull();
    expect(challengedRecord(deck, [], "that dragon-sighting is wrong", 5)?.id).toBe("dragon-sighting");
  });

  it("is null when nothing matches", () => {
    expect(challengedRecord(deck, [], "that's wrong", 10)).toBeNull();
  });
});

describe("challengedNote", () => {
  it("stands firm on a 'sure' telling", () => {
    const r = record("x", 1, { versions: [{ text: "the garbled one", source: "a guard", sureness: "sure", why: "never wrong yet" }] });
    const note = challengedNote(r, [], "that's wrong", false);
    expect(note).toContain("<challenged>");
    expect(note).toContain("You had it from a guard");
    expect(note).toContain("Stand firm");
    expect(note).toContain(r.truth);
    expect(note).toContain(r.verdict);
  });

  it("concedes with style on a 'doubtful' telling, and names the other version", () => {
    const r = record("y", 1, {
      versions: [
        { text: "telling one", source: "Mardry", sureness: "doubtful", why: "never once had a fact straight" },
        { text: "telling two", source: "a traveler from Tear", sureness: "sure", why: "seen it herself" },
      ],
    });
    const note = challengedNote(r, [], "", false);
    expect(note).toContain("Concede with style");
    expect(note).toContain("Another telling going around");
  });

  it("uses her other self's verdict at night, when the record has one", () => {
    const r = record("z", 1, { nightVerdict: "the Great Lord's own take" });
    expect(challengedNote(r, [], "", true)).toContain("the Great Lord's own take");
    expect(challengedNote(r, [], "", false)).toContain(r.verdict);
  });
});
