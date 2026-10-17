import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createGlossaryTerm,
  createSection,
  createTenantRule,
  deactivateGlossaryTerm,
  deactivateSection,
  deactivateTenantRule,
  getBusinessProfile,
  listChangeLog,
  listGlossary,
  listSectionVersions,
  listSections,
  listSectionsForEditor,
  listTenantRules,
  publishSection,
  rollbackSection,
  saveBusinessProfile,
  SectionBudgetError,
  termKeyFor,
  type AssistantDb,
} from "../brain.js";
import { DEFAULT_SECTIONS, seedDefaultSections } from "../seed.js";
import { ASSISTANT_PLATFORM } from "../schema.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * THE BRAIN, PER COMPANY (0.9.0), on a real Postgres: each company's
 * sections, house rules, glossary, profile and change log are its own, and an
 * id from another company is "unknown" — it neither reads nor changes a thing.
 * The 0.1 guards (budget, required phrases, optimistic concurrency, rollback
 * as a checked publish, core and referenced sections) hold per company.
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

async function seeded(): Promise<string> {
  const id = tenant();
  await seedDefaultSections(db, id);
  return id;
}

describe("the guardrails each company starts with", () => {
  it("ships them as core, the no-math and boundaries rules among them", () => {
    const keys = DEFAULT_SECTIONS.map((s) => s.key);
    expect(keys).toContain("no_math");
    expect(keys).toContain("boundaries");
    expect(DEFAULT_SECTIONS.every((s) => s.isCore)).toBe(true);
    const core = DEFAULT_SECTIONS.find((s) => s.key === "core_personality");
    for (const phrase of core?.requiredPhrases ?? []) expect(core?.content).toContain(phrase);
    const noMath = DEFAULT_SECTIONS.find((s) => s.key === "no_math");
    expect(noMath?.content).toMatch(/Never compute a number/);
  });

  it("seeds each company its own copy, once, and the site's own too", async () => {
    const a = tenant();
    const b = tenant();
    expect(await seedDefaultSections(db, a)).toBe(DEFAULT_SECTIONS.length);
    expect(await seedDefaultSections(db, a)).toBe(0);
    expect(await seedDefaultSections(db, b)).toBe(DEFAULT_SECTIONS.length);
    expect(await seedDefaultSections(db, ASSISTANT_PLATFORM)).toBe(DEFAULT_SECTIONS.length);
    expect((await listSections(db, a)).map((s) => s.key)).toEqual(DEFAULT_SECTIONS.map((s) => s.key));
    // Two seeds racing for one company: the unique (company, key) index makes the loser a no-op.
    const c = tenant();
    const [x, y] = await Promise.all([seedDefaultSections(db, c), seedDefaultSections(db, c)]);
    expect(x + y).toBe(DEFAULT_SECTIONS.length);
    expect(await listSections(db, c)).toHaveLength(DEFAULT_SECTIONS.length);
  });

  it("needs the company", async () => {
    await expect(seedDefaultSections(db, "")).rejects.toThrow(/company/);
    await expect(listSections(db, "")).rejects.toThrow();
  });
});

describe("sections: publish, rollback, deactivate — inside one company", () => {
  it("creates with its budget enforced, after the company's last section", async () => {
    const a = await seeded();
    await expect(createSection(db, a, { key: "k", label: "K", content: "x".repeat(9000), maxTokens: 100 })).rejects.toBeInstanceOf(
      SectionBudgetError,
    );
    await expect(createSection(db, a, { key: "Bad Key", label: "K", content: "hi" })).rejects.toThrow();
    const row = await createSection(db, a, { key: "greeting", label: "Greeting", content: "Hello." }, "dallin");
    expect(row.sortOrder).toBe(60);
    const log = await listChangeLog(db, a);
    expect(log[0]).toMatchObject({ entityType: "section", entityKey: "greeting", action: "created", performedBy: "dallin" });
  });

  it("publishes as the next version, refuses a stale base, a lost phrase and an overlong edit", async () => {
    const a = await seeded();
    const core = (await listSectionsForEditor(db, a)).find((s) => s.key === "core_personality");
    if (!core) throw new Error("no core section");
    expect(core.headVersion).toBe(0);
    expect(await publishSection(db, a, { sectionId: core.id, baseVersion: 0, content: "No identity here." })).toEqual({
      published: false,
      reason: "missing_phrase",
      phrase: "assistant",
    });
    expect(
      await publishSection(db, a, { sectionId: core.id, baseVersion: 0, content: `You are the assistant. ${"x".repeat(5000)}` }),
    ).toEqual({ published: false, reason: "budget", maxTokens: 500 });
    expect(await publishSection(db, a, { sectionId: core.id, baseVersion: 0, content: "You are the assistant, v1." }, "dallin")).toEqual({
      published: true,
      versionNumber: 1,
    });
    expect(await publishSection(db, a, { sectionId: core.id, baseVersion: 0, content: "You are the assistant, stale." })).toEqual({
      published: false,
      reason: "conflict",
      headVersion: 1,
    });
    expect((await listSections(db, a)).find((s) => s.id === core.id)?.content).toBe("You are the assistant, v1.");
  });

  it("two publishes at the same base: one wins, the other is a conflict — never a 500", async () => {
    const a = await seeded();
    const core = (await listSections(db, a)).find((s) => s.key === "core_personality")!;
    const results = await Promise.all([
      publishSection(db, a, { sectionId: core.id, baseVersion: 0, content: "You are the assistant, first." }),
      publishSection(db, a, { sectionId: core.id, baseVersion: 0, content: "You are the assistant, second." }),
    ]);
    expect(results.filter((r) => r.published)).toHaveLength(1);
    expect(results.filter((r) => !r.published && r.reason === "conflict")).toHaveLength(1);
  });

  it("rolls back as a checked publish at the head", async () => {
    const a = await seeded();
    const core = (await listSections(db, a)).find((s) => s.key === "core_personality")!;
    await publishSection(db, a, { sectionId: core.id, baseVersion: 0, content: "You are the assistant, one." });
    await publishSection(db, a, { sectionId: core.id, baseVersion: 1, content: "You are the assistant, two." });
    expect(await rollbackSection(db, a, { sectionId: core.id, toVersion: 1 }, "dallin")).toEqual({ published: true, versionNumber: 3 });
    expect((await listSectionVersions(db, a, core.id)).map((v) => v.versionNumber)).toEqual([3, 2, 1]);
    expect(await rollbackSection(db, a, { sectionId: core.id, toVersion: 99 })).toEqual({ published: false, reason: "unknown" });
  });

  it("refuses to turn off a core section, or one a house rule still extends", async () => {
    const a = await seeded();
    const core = (await listSections(db, a)).find((s) => s.isCore)!;
    expect(await deactivateSection(db, a, core.id)).toEqual({ deactivated: false, reason: "core" });
    const extra = await createSection(db, a, { key: "tone", label: "Tone", content: "Be warm." });
    await createTenantRule(db, { tenantId: a, sectionKey: "tone", label: "Warmer", instruction: "Even warmer." });
    expect(await deactivateSection(db, a, extra.id)).toEqual({ deactivated: false, reason: "referenced", referenceCount: 1 });
  });

  it("CROSS-COMPANY: B naming A's section changes nothing and learns nothing", async () => {
    const a = await seeded();
    const b = await seeded();
    const aCore = (await listSections(db, a)).find((s) => s.key === "core_personality")!;
    const before = JSON.stringify(await listSections(db, a));
    expect(await publishSection(db, b, { sectionId: aCore.id, baseVersion: 0, content: "You are the assistant, hijacked." })).toEqual({
      published: false,
      reason: "unknown",
    });
    expect(await rollbackSection(db, b, { sectionId: aCore.id, toVersion: 1 })).toEqual({ published: false, reason: "unknown" });
    expect(await deactivateSection(db, b, aCore.id)).toEqual({ deactivated: false, reason: "unknown" });
    await publishSection(db, a, { sectionId: aCore.id, baseVersion: 0, content: "You are the assistant, A's own." });
    expect(await listSectionVersions(db, b, aCore.id)).toEqual([]);
    expect(JSON.stringify(await listSections(db, a))).not.toBe(before); // A's own publish landed…
    expect((await listSections(db, b)).every((s) => !s.content.includes("A's own"))).toBe(true); // …and B never sees it.
  });
});

describe("the business profile", () => {
  it("is written, versioned, cleared, and the company's own", async () => {
    const a = tenant();
    const b = tenant();
    expect(await getBusinessProfile(db, a)).toBe("");
    expect(await saveBusinessProfile(db, a, { content: "Green Acres mows lawns in Boise, Monday to Saturday." }, "owner")).toEqual({ saved: true });
    expect(await getBusinessProfile(db, a)).toBe("Green Acres mows lawns in Boise, Monday to Saturday.");
    expect(await getBusinessProfile(db, b)).toBe("");
    expect(await saveBusinessProfile(db, a, { content: "Green Acres mows and edges lawns in Boise." })).toEqual({ saved: true });
    const profile = (await listSections(db, a)).find((s) => s.key === "business_profile");
    expect(profile?.content).toContain("Green Acres mows and edges lawns in Boise.");
    expect(await saveBusinessProfile(db, a, { content: "x ".repeat(1_190) })).toEqual({ saved: false, reason: "budget", maxTokens: 700 });
    expect(await saveBusinessProfile(db, a, { content: "" })).toEqual({ saved: true });
    expect(await getBusinessProfile(db, a)).toBe("");
    const words = (await listChangeLog(db, a)).map((row) => row.action);
    expect(words).toEqual(expect.arrayContaining(["created", "published", "deactivated"]));
  });
});

describe("house rules, the glossary and the change log, per company", () => {
  it("keeps each company's rules and terms to itself; B can't remove A's", async () => {
    const a = tenant();
    const b = tenant();
    const rule = await createTenantRule(db, { tenantId: a, label: "Weekends", instruction: "We don't work Sundays." }, "owner");
    if (!("id" in rule)) throw new Error("rule refused");
    expect(await createTenantRule(db, { tenantId: a, label: "Long", instruction: "x".repeat(1900) })).toEqual({ error: "budget", maxTokens: 200 });
    const term = await createGlossaryTerm(db, a, { termKey: termKeyFor("The Yard!"), preferred: "the yard", definition: "Our depot." });
    expect(termKeyFor("The Yard!")).toBe("the_yard");
    expect(termKeyFor("4x4 truck")).toBe("t_4x4_truck");
    await createGlossaryTerm(db, b, { termKey: "the_yard", preferred: "the lot", definition: "Bravo's depot." });

    expect((await listTenantRules(db, a)).map((r) => r.instruction)).toEqual(["We don't work Sundays."]);
    expect(await listTenantRules(db, b)).toEqual([]);
    expect((await listGlossary(db, a)).map((g) => g.preferred)).toEqual(["the yard"]);
    expect((await listGlossary(db, b)).map((g) => g.preferred)).toEqual(["the lot"]);

    expect(await deactivateTenantRule(db, b, rule.id)).toBe(false);
    expect(await deactivateGlossaryTerm(db, b, term.id)).toBe(false);
    expect(await listTenantRules(db, a)).toHaveLength(1);
    expect(await listGlossary(db, a)).toHaveLength(1);

    expect(await deactivateTenantRule(db, a, rule.id)).toBe(true);
    expect(await deactivateTenantRule(db, a, rule.id)).toBe(false);
    // Re-adding a removed term brings it back rather than colliding.
    expect(await deactivateGlossaryTerm(db, a, term.id)).toBe(true);
    const again = await createGlossaryTerm(db, a, { termKey: "the_yard", preferred: "the yard" });
    expect(again.id).toBe(term.id);

    const aLog = await listChangeLog(db, a);
    const bLog = await listChangeLog(db, b);
    expect(aLog.map((row) => row.changeSummary)).toEqual(expect.arrayContaining(["Weekends", "the yard"]));
    expect(bLog.map((row) => row.changeSummary)).toEqual(["the lot"]);
  });
});
