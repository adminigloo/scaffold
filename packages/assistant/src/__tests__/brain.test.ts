import { describe, expect, it } from "vitest";
import {
  createSection,
  deactivateSection,
  publishSection,
  rollbackSection,
  SectionBudgetError,
} from "../brain.js";

/**
 * The narrowest fake for the drizzle chains brain.ts runs — house pattern.
 * State is a script per query shape; the fake honors it rather than parsing
 * SQL, so a new query surfaces here as a test change.
 */
function fakeDb(state: {
  section?: Record<string, unknown> | null;
  headVersion?: number | null;
  targetVersionContent?: string | null;
  referencingRules?: number;
  maxOrder?: number;
  conflictOnVersionInsert?: boolean;
}) {
  const inserts: Record<string, Array<Record<string, unknown>>> = {};
  const updates: Array<Record<string, unknown>> = [];
  let lastTable = "";

  const db = {
    select: (fields: Record<string, unknown>) => ({
      from: (table: { [k: symbol]: unknown }) => {
        const name = tableName(table);
        return {
          // createSection's next-sortOrder query goes straight to orderBy().
          orderBy: () => ({
            limit: async () => [{ sortOrder: state.maxOrder ?? 0 }],
          }),
          where: () => ({
            limit: async () => {
              if (name === "assistant_sections") return state.section ? [state.section] : [];
              if (name === "assistant_section_versions") {
                if ("content" in fields) {
                  return state.targetVersionContent == null
                    ? []
                    : [{ content: state.targetVersionContent }];
                }
                return state.headVersion == null ? [] : [{ versionNumber: state.headVersion }];
              }
              return [];
            },
            orderBy: () => ({
              limit: async () => {
                if (name === "assistant_sections") {
                  return [{ sortOrder: state.maxOrder ?? 0 }];
                }
                return state.headVersion == null ? [] : [{ versionNumber: state.headVersion }];
              },
            }),
            // deactivate's referencing-rules scan awaits the where directly.
            then: (resolve: (v: unknown) => void) =>
              resolve(Array.from({ length: state.referencingRules ?? 0 }, (_, i) => ({ id: `r${i}` }))),
          }),
        };
      },
    }),
    insert: (table: { [k: symbol]: unknown }) => {
      lastTable = tableName(table);
      return {
        values: (row: Record<string, unknown>) => {
          (inserts[lastTable] ??= []).push(row);
          return {
            returning: async () => [{ id: "sec_1", ...row }],
            onConflictDoUpdate: async () => undefined,
            then: (resolve: (v: unknown) => void) => resolve(undefined),
          };
        },
      };
    },
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: async () => {
          updates.push(patch);
        },
      }),
    }),
    // publishSection wraps its writes in a transaction; the fake runs the
    // callback against the same accumulating handle so inserts/updates still
    // land where the assertions look. A configured conflict makes the version
    // insert throw 23505, exactly as the real unique index would.
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      if (state.conflictOnVersionInsert) {
        const err = new Error("duplicate key") as Error & { code: string };
        err.code = "23505";
        throw err;
      }
      return fn(db);
    },
  };
  return { db: db as never, inserts, updates };
}

// drizzle tables expose their name via a well-known symbol; read it so the
// fake can branch without the test caring about the exact symbol.
function tableName(table: { [k: symbol]: unknown }): string {
  for (const sym of Object.getOwnPropertySymbols(table)) {
    const v = table[sym];
    if (typeof v === "string" && v.startsWith("assistant_")) return v;
  }
  return "";
}

describe("createSection", () => {
  it("refuses content over the token budget before inserting", async () => {
    const { db, inserts } = fakeDb({});
    await expect(
      createSection(db, { key: "k", label: "K", content: "x".repeat(9000), maxTokens: 100 }),
    ).rejects.toBeInstanceOf(SectionBudgetError);
    expect(inserts["assistant_sections"]).toBeUndefined();
  });

  it("rejects an invalid key at the schema", async () => {
    const { db } = fakeDb({});
    await expect(createSection(db, { key: "Bad Key", label: "K", content: "hi" })).rejects.toThrow();
  });

  it("inserts, logs, and bumps config on a valid section", async () => {
    const { db, inserts } = fakeDb({ maxOrder: 40 });
    const row = await createSection(db, { key: "greeting", label: "Greeting", content: "Hello." }, "dallin");
    expect(row.key).toBe("greeting");
    expect(inserts["assistant_sections"]?.[0]?.sortOrder).toBe(50);
    expect(inserts["assistant_change_log"]?.[0]).toMatchObject({ action: "created", performedBy: "dallin" });
    expect(inserts["assistant_config_version"]).toHaveLength(1);
  });
});

const section = {
  id: "sec_1",
  key: "core_personality",
  label: "Core",
  description: null,
  content: "old",
  sortOrder: 10,
  isCore: false,
  requiredPhrases: ["You are"],
  maxTokens: 500,
  isActive: true,
};

describe("publishSection", () => {
  it("rejects when the head moved past the editor's base version", async () => {
    const { db } = fakeDb({ section, headVersion: 5 });
    const result = await publishSection(db, {
      sectionId: "sec_1",
      baseVersion: 3,
      content: "You are the assistant, revised.",
    });
    expect(result).toEqual({ published: false, reason: "conflict", headVersion: 5 });
  });

  it("refuses content that drops a required phrase", async () => {
    const { db } = fakeDb({ section, headVersion: 1 });
    const result = await publishSection(db, {
      sectionId: "sec_1",
      baseVersion: 1,
      content: "brand new text with no identity",
    });
    expect(result).toEqual({ published: false, reason: "missing_phrase", phrase: "You are" });
  });

  it("refuses content over budget", async () => {
    const { db } = fakeDb({ section: { ...section, maxTokens: 50 }, headVersion: 1 });
    const result = await publishSection(db, {
      sectionId: "sec_1",
      baseVersion: 1,
      content: "You are " + "x".repeat(5000),
    });
    expect(result).toEqual({ published: false, reason: "budget", maxTokens: 50 });
  });

  it("publishes as the next version, snapshots content, and logs", async () => {
    const { db, inserts, updates } = fakeDb({ section, headVersion: 2 });
    const result = await publishSection(
      db,
      { sectionId: "sec_1", baseVersion: 2, content: "You are the assistant. Newer.", changeSummary: "tone" },
      "dallin",
    );
    expect(result).toEqual({ published: true, versionNumber: 3 });
    expect(inserts["assistant_section_versions"]?.[0]).toMatchObject({ versionNumber: 3, content: "You are the assistant. Newer." });
    expect(updates[0]?.content).toBe("You are the assistant. Newer.");
    expect(inserts["assistant_change_log"]?.[0]).toMatchObject({ action: "published", versionNumber: 3 });
  });

  it("reports unknown for a missing section", async () => {
    const { db } = fakeDb({ section: null });
    expect(await publishSection(db, { sectionId: "nope", baseVersion: 0, content: "You are x" })).toEqual({
      published: false,
      reason: "unknown",
    });
  });

  it("maps a unique-violation from a raced version insert to conflict, not a throw", async () => {
    // Two publishers at the same base both pass the compare, both compute the
    // same next version; the unique index rejects the loser with 23505. That
    // must surface as the `conflict` the return type promises, never a 500.
    const { db } = fakeDb({ section, headVersion: 2, conflictOnVersionInsert: true });
    const result = await publishSection(db, {
      sectionId: "sec_1",
      baseVersion: 2,
      content: "You are the assistant, racing.",
    });
    expect(result).toEqual({ published: false, reason: "conflict", headVersion: 2 });
  });
});

describe("rollbackSection", () => {
  it("republishes an old version's content at the head, running publish checks", async () => {
    const { db, inserts } = fakeDb({
      section,
      headVersion: 4,
      targetVersionContent: "You are the original.",
    });
    const result = await rollbackSection(db, { sectionId: "sec_1", toVersion: 2 }, "dallin");
    expect(result).toEqual({ published: true, versionNumber: 5 });
    expect(inserts["assistant_section_versions"]?.[0]).toMatchObject({
      versionNumber: 5,
      content: "You are the original.",
      changeSummary: "rolled back to v2",
    });
  });

  it("runs publish checks: a rollback to content that now violates budget is refused", async () => {
    // The invariant the title claimed but the happy-path test never proved —
    // a rollback is a publish of old content, so a lowered budget refuses it
    // rather than resurrecting oversized content past the guard.
    const { db, inserts } = fakeDb({
      section: { ...section, maxTokens: 20 },
      headVersion: 3,
      targetVersionContent: "You are " + "x".repeat(4000),
    });
    const result = await rollbackSection(db, { sectionId: "sec_1", toVersion: 1 });
    expect(result).toEqual({ published: false, reason: "budget", maxTokens: 20 });
    expect(inserts["assistant_section_versions"]).toBeUndefined();
  });

  it("runs publish checks: a rollback that drops a required phrase is refused", async () => {
    const { db } = fakeDb({
      section,
      headVersion: 3,
      targetVersionContent: "an old version with no identity phrase",
    });
    const result = await rollbackSection(db, { sectionId: "sec_1", toVersion: 1 });
    expect(result).toEqual({ published: false, reason: "missing_phrase", phrase: "You are" });
  });

  it("reports unknown for a version that never existed", async () => {
    const { db } = fakeDb({ section, targetVersionContent: null });
    expect(await rollbackSection(db, { sectionId: "sec_1", toVersion: 99 })).toEqual({
      published: false,
      reason: "unknown",
    });
  });
});

describe("deactivateSection", () => {
  it("refuses a core section", async () => {
    const { db } = fakeDb({ section: { ...section, isCore: true } });
    expect(await deactivateSection(db, "sec_1")).toEqual({ deactivated: false, reason: "core" });
  });

  it("refuses while a tenant rule still references the key, with a count", async () => {
    const { db } = fakeDb({ section: { ...section, isCore: false }, referencingRules: 2 });
    expect(await deactivateSection(db, "sec_1")).toEqual({
      deactivated: false,
      reason: "referenced",
      referenceCount: 2,
    });
  });

  it("deactivates a free, non-core section and logs it", async () => {
    const { db, updates, inserts } = fakeDb({ section: { ...section, isCore: false }, referencingRules: 0 });
    expect(await deactivateSection(db, "sec_1", "dallin")).toEqual({ deactivated: true });
    expect(updates[0]).toEqual({ isActive: false });
    expect(inserts["assistant_change_log"]?.[0]).toMatchObject({ action: "deactivated" });
  });
});
