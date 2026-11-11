import { describe, expect, it } from "vitest";
import { arrivalNote, formatReading, LONG_ABSENCE_DAYS, relationshipFor } from "../ledger.js";
import type { LedgerView } from "../types.js";

const now = Date.now();
const DAY = 86_400_000;

function entry(over: Partial<LedgerView> = {}): LedgerView {
  return {
    name: null,
    reading: null,
    nickname: null,
    joke: null,
    promised: null,
    firstSeenAt: new Date(now - 30 * DAY),
    lastSeenAt: new Date(now - 1 * DAY),
    visits: 3,
    ...over,
  };
}

describe("relationshipFor", () => {
  it("is 'first' with no ledger at all, or one that's never actually visited", () => {
    expect(relationshipFor(null, now)).toBe("first");
    expect(relationshipFor(entry({ visits: 0 }), now)).toBe("first");
  });

  it("is 'regular' for a ledger seen recently", () => {
    expect(relationshipFor(entry({ lastSeenAt: new Date(now - 1 * DAY) }), now)).toBe("regular");
    expect(relationshipFor(entry({ lastSeenAt: new Date(now) }), now)).toBe("regular");
  });

  it("turns to 'absence' exactly at the long-absence threshold, not a day short", () => {
    expect(LONG_ABSENCE_DAYS).toBe(14);
    expect(relationshipFor(entry({ lastSeenAt: new Date(now - 13 * DAY) }), now)).toBe("regular");
    expect(relationshipFor(entry({ lastSeenAt: new Date(now - 14 * DAY) }), now)).toBe("absence");
    expect(relationshipFor(entry({ lastSeenAt: new Date(now - 90 * DAY) }), now)).toBe("absence");
  });
});

describe("formatReading", () => {
  it("matches the one wording a ledger and a reading-gate note should both use", () => {
    expect(formatReading(6)).toBe("has read through Book 6");
    expect(formatReading(Number.POSITIVE_INFINITY)).toBe("caught up");
  });
});

describe("arrivalNote", () => {
  it("adds nothing for a first visit", () => {
    expect(arrivalNote("first", null)).toBe("");
    expect(arrivalNote("first", entry({ name: "Sam" }))).toBe("");
  });

  it("greets a regular by name, nickname and running joke", () => {
    const note = arrivalNote("regular", entry({ name: "Sam", nickname: "the Dicer", joke: "always asks about the stew" }));
    expect(note).toContain("A regular");
    expect(note).toContain("you know them as Sam");
    expect(note).toContain("you call them the Dicer");
    expect(note).toContain("always asks about the stew");
  });

  it("flags a long absence distinctly from an ordinary regular", () => {
    expect(arrivalNote("absence", entry())).toContain("haven't seen them in weeks");
    expect(arrivalNote("absence", entry())).not.toContain("A regular");
  });

  it("mentions what she promised to tell next time", () => {
    expect(arrivalNote("regular", entry({ promised: "the dicer's wager" }))).toContain("you'd say more about the dicer's wager");
  });

  it("names nothing extra for a regular with a bare ledger", () => {
    expect(arrivalNote("regular", entry())).toBe(" A regular.");
  });
});
