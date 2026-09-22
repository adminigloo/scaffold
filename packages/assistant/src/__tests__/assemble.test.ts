import { describe, expect, it } from "vitest";
import { assemblePrompt } from "../assemble.js";

/**
 * Assembly reads three tables (sections, tenant rules, glossary); the fake
 * answers each by the columns the query selects, since assemble.ts branches
 * on nothing else.
 */
function fakeDb(state: {
  sections?: Array<Record<string, unknown>>;
  tenantRules?: Array<Record<string, unknown>>;
  glossary?: Array<Record<string, unknown>>;
  pageDocs?: Array<Record<string, unknown>>;
}) {
  const db = {
    select: (fields: Record<string, unknown>) => ({
      from: () => {
        // listSections selects content+key+sortOrder+isActive; tenant rules
        // select sectionKey+instruction; glossary selects preferred+aliases;
        // retrievePageDocs selects pageKey+title+body+rank.
        if ("content" in fields && "isCore" in fields) {
          return {
            where: () => ({ orderBy: async () => state.sections ?? [] }),
          };
        }
        if ("instruction" in fields) {
          return { where: () => ({ orderBy: async () => state.tenantRules ?? [] }) };
        }
        if ("rank" in fields) {
          // retrievePageDocs keyword phase: where().orderBy().limit()
          return {
            where: () => ({ orderBy: () => ({ limit: async () => state.pageDocs ?? [] }) }),
          };
        }
        if ("body" in fields && "pageKey" in fields) {
          // retrievePageDocs fetch phase: where(inArray(...)) awaited directly.
          return { where: () => Promise.resolve(state.pageDocs ?? []) };
        }
        // glossary: where().then (awaited directly, no orderBy)
        return {
          where: () =>
            Object.assign(Promise.resolve(state.glossary ?? []), {
              orderBy: async () => state.glossary ?? [],
            }),
        };
      },
    }),
  };
  return db as never;
}

const coreSection = {
  id: "s1",
  key: "core",
  label: "Core",
  description: null,
  content: "You are the assistant.",
  sortOrder: 10,
  isCore: true,
  requiredPhrases: [],
  maxTokens: 500,
  isActive: true,
};

describe("assemblePrompt", () => {
  it("builds the static system from global sections in order", async () => {
    const db = fakeDb({
      sections: [
        coreSection,
        { ...coreSection, id: "s2", key: "rules", content: "Never do math.", sortOrder: 20 },
      ],
    });
    const out = await assemblePrompt(db, { tenantId: "t1", turnText: "hello" });
    expect(out.system).toBe("You are the assistant.\n\nNever do math.");
    expect(out.contextBlocks).toEqual([]);
    expect(out.meta.blocks.map((b) => b.name)).toEqual(["section:core", "section:rules"]);
    expect(out.meta.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("puts tenant overlays in context blocks, keyed and standalone, not in system", async () => {
    const db = fakeDb({
      sections: [coreSection],
      tenantRules: [
        { sectionKey: "core", label: "tone", instruction: "Always be brief." },
        { sectionKey: null, label: "extra", instruction: "Mention our 30-day guarantee." },
      ],
    });
    const out = await assemblePrompt(db, { tenantId: "t1", turnText: "hello" });
    expect(out.system).toBe("You are the assistant.");
    expect(out.contextBlocks[0]).toContain('<tenant-rules section="core">');
    expect(out.contextBlocks[0]).toContain("Always be brief.");
    expect(out.contextBlocks[1]).toContain("30-day guarantee");
  });

  it("injects only glossary terms the turn actually used", async () => {
    const db = fakeDb({
      sections: [coreSection],
      glossary: [
        { preferred: "widget", aliases: ["gadget"], definition: "our core product" },
        { preferred: "invoice", aliases: [], definition: "a bill" },
      ],
    });
    const out = await assemblePrompt(db, { tenantId: "t1", turnText: "how do I add a gadget?" });
    const block = out.contextBlocks.find((b) => b.includes("<glossary>"));
    expect(block).toContain("widget: our core product");
    expect(block).not.toContain("invoice");
  });

  it("injects retrieved page docs as a knowledge block, carried in the user message not the fingerprint", async () => {
    const db = fakeDb({
      sections: [coreSection],
      pageDocs: [{ id: "d1", pageKey: "/admin/invoices", title: "Invoices", body: "Create one from an estimate.", rank: 0.1 }],
    });
    const withDocs = await assemblePrompt(db, { tenantId: "t1", turnText: "how do invoices work?" });
    const block = withDocs.contextBlocks.find((b) => b.includes("<knowledge>"));
    expect(block).toContain('pageKey="/admin/invoices"');
    expect(block).toContain("Create one from an estimate.");
    // Retrieval is turn-dependent, so it must not move the config fingerprint.
    const noDocs = await assemblePrompt(fakeDb({ sections: [coreSection] }), {
      tenantId: "t1",
      turnText: "how do invoices work?",
    });
    expect(withDocs.meta.fingerprint).toBe(noDocs.meta.fingerprint);
  });

  it("changes the fingerprint when a section's content changes, but not when the turn does", async () => {
    const a = await assemblePrompt(fakeDb({ sections: [coreSection] }), { tenantId: "t1", turnText: "x" });
    const b = await assemblePrompt(fakeDb({ sections: [coreSection] }), { tenantId: "t1", turnText: "different turn" });
    const c = await assemblePrompt(
      fakeDb({ sections: [{ ...coreSection, content: "You are the assistant, now wordier and changed." }] }),
      { tenantId: "t1", turnText: "x" },
    );
    expect(a.meta.fingerprint).toBe(b.meta.fingerprint);
    expect(a.meta.fingerprint).not.toBe(c.meta.fingerprint);
  });

  it("distinguishes SAME-LENGTH different content — the fingerprint hashes text, not length", async () => {
    // The bug the earlier test missed: a length-based fingerprint would
    // collide two different personalities that happen to estimate the same
    // token count. These two contents are the same length, different words.
    // Same length, different words — a length-based fingerprint would collide.
    const warm = "You are a calm, patient guide.";
    const terse = "You are a terse, abrupt agent.";
    expect(warm.length).toBe(terse.length);
    const a = await assemblePrompt(
      fakeDb({ sections: [{ ...coreSection, content: warm }] }),
      { tenantId: "t1", turnText: "x" },
    );
    const b = await assemblePrompt(
      fakeDb({ sections: [{ ...coreSection, content: terse }] }),
      { tenantId: "t1", turnText: "x" },
    );
    expect(a.system.length).toBe(b.system.length);
    expect(a.meta.fingerprint).not.toBe(b.meta.fingerprint);
  });

  it("distinguishes same-length different tenant-rule wording", async () => {
    const rule = (instruction: string) => ({ sectionKey: "core", label: "tone", instruction });
    const a = await assemblePrompt(
      fakeDb({ sections: [coreSection], tenantRules: [rule("Always be very brief here.")] }),
      { tenantId: "t1", turnText: "x" },
    );
    const b = await assemblePrompt(
      fakeDb({ sections: [coreSection], tenantRules: [rule("Always be more warm here.")] }),
      { tenantId: "t1", turnText: "x" },
    );
    expect(a.meta.fingerprint).not.toBe(b.meta.fingerprint);
  });
});
