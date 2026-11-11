import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSection,
  ensureSection,
  fromCode,
  getSectionByKey,
  listChangeLog,
  listSectionVersions,
  listSectionsForEditor,
  publishSection,
  resetSectionToCode,
  type AssistantDb,
} from "../brain.js";
import { assistantSections } from "../schema.js";
import { DEFAULT_SECTIONS, seedDefaultSections } from "../seed.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * SECTIONS WHOSE DEFAULT LIVES IN CODE (0.11.0), on a real Postgres. A
 * section's first text is its v1; every version says who wrote it, a person or
 * the code; `ensureSection` keeps the code's default in step with the code
 * without ever writing over a person's edit; and the editor can tell the two
 * apart and hand a section back to the code.
 */

let t: TestDb;
let db: AssistantDb;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
});
afterAll(async () => {
  await t.close();
});

const PERSONA = {
  key: "keeper_persona",
  label: "The keeper",
  content: "Hessa keeps the inn.",
  requiredPhrases: ["Hessa"],
  maxTokens: 200,
};

async function versions(tenantId: string, key: string) {
  const section = await getSectionByKey(db, tenantId, key);
  if (!section) throw new Error(`no section ${key}`);
  return (await listSectionVersions(db, tenantId, section.id)).map((v) => [v.versionNumber, v.createdByKind, v.createdBy]);
}

describe("a section's first text is its version 1", () => {
  it("createSection records it, signed by whoever wrote it", async () => {
    const a = tenant();
    await createSection(db, a, { key: "greeting", label: "Greeting", content: "Hello." }, "dallin");
    await createSection(db, a, { key: "farewell", label: "Farewell", content: "Goodbye." }, fromCode("seed"));
    expect(await versions(a, "greeting")).toEqual([[1, "person", "dallin"]]);
    expect(await versions(a, "farewell")).toEqual([[1, "code", "seed"]]);
    const log = await listChangeLog(db, a);
    expect(log.find((line) => line.entityKey === "greeting")).toMatchObject({ action: "created", versionNumber: 1, performedBy: "dallin" });
  });

  it("seedDefaultSections records every default's v1 as the code's", async () => {
    const a = tenant();
    expect(await seedDefaultSections(db, a)).toBe(DEFAULT_SECTIONS.length);
    const rows = await listSectionsForEditor(db, a);
    expect(rows.map((row) => [row.key, row.headVersion, row.headKind])).toEqual(
      expect.arrayContaining(DEFAULT_SECTIONS.map((section) => [section.key, 1, "code"])),
    );
    // A second run adds nothing, and no second version.
    expect(await seedDefaultSections(db, a)).toBe(0);
    expect(await versions(a, "no_math")).toEqual([[1, "code", "seed"]]);
  });
});

describe("ensureSection: the code's default, kept in step with the code", () => {
  it("creates a missing section from the seed, as the code's v1", async () => {
    const a = tenant();
    const result = await ensureSection(db, a, PERSONA, { signer: "seed" });
    expect(result).toMatchObject({ outcome: "created", content: PERSONA.content, differsFromCode: false });
    expect(result.section.key).toBe("keeper_persona");
    expect(await versions(a, "keeper_persona")).toEqual([[1, "code", "seed"]]);
  });

  it("does nothing when the brain already holds the code's text", async () => {
    const a = tenant();
    await ensureSection(db, a, PERSONA);
    expect((await ensureSection(db, a, PERSONA)).outcome).toBe("current");
    expect(await versions(a, "keeper_persona")).toHaveLength(1);
  });

  it("adopts a new default over the code's older one, as the next version", async () => {
    const a = tenant();
    await ensureSection(db, a, PERSONA, { signer: "seed" });
    const next = { ...PERSONA, content: "Hessa keeps the inn, and its secrets." };
    expect(await ensureSection(db, a, next, { signer: "seed" })).toMatchObject({ outcome: "adopted", content: next.content });
    expect((await getSectionByKey(db, a, "keeper_persona"))?.content).toBe(next.content);
    expect(await versions(a, "keeper_persona")).toEqual([
      [2, "code", "seed"],
      [1, "code", "seed"],
    ]);
  });

  it("keeps a person's edit, and says it differs from the code's", async () => {
    const a = tenant();
    const { section } = await ensureSection(db, a, PERSONA);
    await publishSection(db, a, { sectionId: section.id, baseVersion: 1, content: "Hessa, as the owner wrote her." }, "owner");
    const result = await ensureSection(db, a, { ...PERSONA, content: "Hessa, as the code has her now." });
    expect(result).toMatchObject({ outcome: "edited", content: "Hessa, as the owner wrote her.", differsFromCode: true });
    expect((await getSectionByKey(db, a, "keeper_persona"))?.content).toBe("Hessa, as the owner wrote her.");
    expect(await versions(a, "keeper_persona")).toHaveLength(2);
  });

  it("adopts over a section from before 0.11, which has no versions at all", async () => {
    const a = tenant();
    await db.insert(assistantSections).values({ tenantId: a, key: "keeper_persona", label: "The keeper", content: "Hessa, seeded in 0.10." });
    expect((await ensureSection(db, a, PERSONA)).outcome).toBe("adopted");
    expect(await versions(a, "keeper_persona")).toEqual([[1, "code", "code"]]);
  });

  it("two servers at once: one creates or publishes, the other finds it done, and both serve the code's text", async () => {
    const a = tenant();
    const created = await Promise.all([ensureSection(db, a, PERSONA), ensureSection(db, a, PERSONA)]);
    expect(created.map((r) => r.outcome).sort()).toEqual(["created", "current"]);
    const next = { ...PERSONA, content: "Hessa keeps the inn, and its secrets." };
    const adopted = await Promise.all([ensureSection(db, a, next), ensureSection(db, a, next)]);
    expect(adopted.map((r) => r.content)).toEqual([next.content, next.content]);
    expect(adopted.every((r) => r.outcome === "adopted" || r.outcome === "current")).toBe(true);
    expect(await versions(a, "keeper_persona")).toHaveLength(2); // one publish, not two
  });

  it("takes the seed's budget and required phrases with it, so a longer default isn't refused forever", async () => {
    const a = tenant();
    await ensureSection(db, a, PERSONA);
    const longer = { ...PERSONA, content: `Hessa keeps the inn. ${"She remembers every face. ".repeat(40)}`, maxTokens: 800 };
    expect((await ensureSection(db, a, longer)).outcome).toBe("adopted");
    expect((await getSectionByKey(db, a, "keeper_persona"))?.maxTokens).toBe(800);
  });

  it("reports what the brain refused, keeps its text, and still serves the code's", async () => {
    const a = tenant();
    await ensureSection(db, a, PERSONA);
    const overlong = { ...PERSONA, content: `Hessa ${"x".repeat(5000)}`, maxTokens: 50 };
    const result = await ensureSection(db, a, overlong);
    expect(result).toMatchObject({ outcome: "refused", content: overlong.content, refusal: { reason: "budget", maxTokens: 50 } });
    expect((await getSectionByKey(db, a, "keeper_persona"))?.content).toBe(PERSONA.content);
  });
});

describe("the editor: what differs from the code, and going back to it", () => {
  it("lists who wrote each head and whether the live text is the code's", async () => {
    const a = tenant();
    await seedDefaultSections(db, a);
    const core = (await getSectionByKey(db, a, "core_personality"))!;
    await publishSection(db, a, { sectionId: core.id, baseVersion: 1, content: "You are our assistant, briefer." }, "owner");

    const rows = await listSectionsForEditor(db, a, { seeds: DEFAULT_SECTIONS });
    const coreRow = rows.find((row) => row.key === "core_personality")!;
    expect(coreRow).toMatchObject({
      headVersion: 2,
      headKind: "person",
      differsFromCode: true,
      codeDefault: DEFAULT_SECTIONS.find((s) => s.key === "core_personality")?.content,
    });
    expect(rows.filter((row) => row.key !== "core_personality").every((row) => row.headKind === "code" && !row.differsFromCode)).toBe(true);
    // Without seeds the editor still lists everything, and claims nothing.
    expect((await listSectionsForEditor(db, a)).every((row) => row.codeDefault === null && !row.differsFromCode)).toBe(true);
  });

  it("goes back to the code's text as the code's, so it follows the code again", async () => {
    const a = tenant();
    const { section } = await ensureSection(db, a, PERSONA);
    await publishSection(db, a, { sectionId: section.id, baseVersion: 1, content: "Hessa, as the owner wrote her." }, "owner");

    expect(await resetSectionToCode(db, a, { sectionId: section.id, baseVersion: 2 }, [PERSONA], "owner")).toEqual({
      published: true,
      versionNumber: 3,
    });
    expect((await getSectionByKey(db, a, "keeper_persona"))?.content).toBe(PERSONA.content);
    const [head] = await listSectionVersions(db, a, section.id);
    expect(head).toMatchObject({ versionNumber: 3, createdByKind: "code", createdBy: "owner", changeSummary: "back to the code's text" });
    // From here the code's next default lands again.
    expect((await ensureSection(db, a, { ...PERSONA, content: "Hessa keeps the inn, and its secrets." })).outcome).toBe("adopted");
  });

  it("refuses a section the code has no default for, a stale base, and another company's section", async () => {
    const a = tenant();
    const b = tenant();
    const custom = await createSection(db, a, { key: "tone", label: "Tone", content: "Be warm." }, "owner");
    expect(await resetSectionToCode(db, a, { sectionId: custom.id, baseVersion: 1 }, [PERSONA], "owner")).toEqual({
      published: false,
      reason: "no_default",
    });
    const { section } = await ensureSection(db, a, PERSONA);
    await publishSection(db, a, { sectionId: section.id, baseVersion: 1, content: "Hessa, edited." }, "owner");
    expect(await resetSectionToCode(db, a, { sectionId: section.id, baseVersion: 1 }, [PERSONA], "owner")).toEqual({
      published: false,
      reason: "conflict",
      headVersion: 2,
    });
    expect(await resetSectionToCode(db, b, { sectionId: section.id, baseVersion: 2 }, [PERSONA], "intruder")).toEqual({
      published: false,
      reason: "unknown",
    });
    expect((await getSectionByKey(db, a, "keeper_persona"))?.content).toBe("Hessa, edited.");
  });
});
