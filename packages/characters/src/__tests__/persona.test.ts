import { describe, expect, it } from "vitest";
import { checklistFor, personaFor, primerFor } from "../persona.js";
import type { PersonaSections } from "../types.js";

const sections: PersonaSections = {
  persona: "day persona",
  nightPersona: "night persona",
  checklist: "day checklist",
  nightChecklist: "night checklist",
  primer: "timeless primer",
  primerAt: { book: 13, text: "dated primer" },
};

describe("personaFor and checklistFor", () => {
  it("pick the matching half of her", () => {
    expect(personaFor(sections, false)).toBe("day persona");
    expect(personaFor(sections, true)).toBe("night persona");
    expect(checklistFor(sections, false)).toBe("day checklist");
    expect(checklistFor(sections, true)).toBe("night checklist");
  });
});

describe("primerFor (the same book gate as a card)", () => {
  it("carries only the timeless primer below the dated primer's book", () => {
    expect(primerFor(sections, 12)).toBe("timeless primer");
  });

  it("adds the dated primer from its own book on, joined by a line", () => {
    expect(primerFor(sections, 13)).toBe("timeless primer\ndated primer");
    expect(primerFor(sections, Number.POSITIVE_INFINITY)).toBe("timeless primer\ndated primer");
  });

  it("is just the timeless primer for a world with no dated primer at all", () => {
    expect(primerFor({ primer: "only this" }, Number.POSITIVE_INFINITY)).toBe("only this");
  });
});
