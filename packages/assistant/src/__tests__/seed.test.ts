import { describe, expect, it } from "vitest";
import { DEFAULT_SECTIONS, seedDefaultSections } from "../seed.js";

function fakeDb(state: { existing?: boolean; conflictKeys?: string[] }) {
  const inserted: Array<Record<string, unknown>> = [];
  const db = {
    select: () => ({ from: () => ({ limit: async () => (state.existing ? [{ id: "x" }] : []) }) }),
    insert: () => ({
      values: (row: Record<string, unknown>) => ({
        then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
          if ((state.conflictKeys ?? []).includes(row.key as string)) {
            reject({ code: "23505" });
            return;
          }
          inserted.push(row);
          resolve(undefined);
        },
      }),
    }),
  };
  return { db: db as never, inserted };
}

describe("seedDefaultSections", () => {
  it("ships the guardrails as core with the no-math and boundaries rules present", () => {
    const keys = DEFAULT_SECTIONS.map((s) => s.key);
    expect(keys).toContain("no_math");
    expect(keys).toContain("boundaries");
    expect(DEFAULT_SECTIONS.every((s) => s.isCore)).toBe(true);
    // core_personality must keep an identity phrase publish will guard.
    const core = DEFAULT_SECTIONS.find((s) => s.key === "core_personality");
    expect(core?.requiredPhrases.length).toBeGreaterThan(0);
    for (const phrase of core?.requiredPhrases ?? []) {
      expect(core?.content).toContain(phrase);
    }
  });

  it("seeds nothing when the table already has rows", async () => {
    const { db, inserted } = fakeDb({ existing: true });
    expect(await seedDefaultSections(db)).toBe(0);
    expect(inserted).toHaveLength(0);
  });

  it("inserts every default into an empty table", async () => {
    const { db, inserted } = fakeDb({ existing: false });
    expect(await seedDefaultSections(db)).toBe(DEFAULT_SECTIONS.length);
    expect(inserted).toHaveLength(DEFAULT_SECTIONS.length);
  });

  it("treats a raced duplicate key as a no-op, not a failure", async () => {
    const { db } = fakeDb({ existing: false, conflictKeys: ["no_math"] });
    // The loser of a concurrent seed inserts everything but the raced key.
    expect(await seedDefaultSections(db)).toBe(DEFAULT_SECTIONS.length - 1);
  });
});
