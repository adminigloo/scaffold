import { getTableConfig } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forgetTenant } from "../forget.js";
import { defineSocialTables, InvalidSocialPrefixError, socialPosts } from "../schema.js";
import { postStore, type DraftInput } from "../store.js";
import { createTestDb, SHIPPED_SQL, type TestDb } from "./pglite.js";

/**
 * ONE COMPANY NEVER SEES ANOTHER'S POSTS (social 0.1). Two companies, A and
 * B, with drafts under the SAME key and platform: every call of B's queue
 * — list, get, sections, keys, edit, approve, mark posted, skip, a rebuild —
 * with A's ids in hand finds nothing of A's and changes nothing of A's.
 * Forgetting B takes B's rows and only B's. And the table name comes from a
 * prefix, so two sets live side by side.
 */
let test: TestDb;

beforeEach(async () => {
  test = await createTestDb();
});

afterEach(async () => {
  await test.close();
});

const draft = (over: Partial<DraftInput> = {}): DraftInput => ({
  key: "launch:same-key",
  kind: "launch",
  platform: "x",
  author: "Alpha Lawn Care",
  day: "2026-10-27",
  text: "Alpha's own words.",
  hook: "Alpha's hook.",
  images: [],
  firstComment: null,
  templateText: "Alpha's own words.",
  writtenBy: "ai",
  note: null,
  linkUrl: null,
  facts: { title: "Alpha's news", lines: ["Alpha's news"] },
  ...over,
});

async function twoCompanies() {
  const a = postStore(test.db, { tenantId: "company-a" });
  const b = postStore(test.db, { tenantId: "company-b" });
  await a.upsertDraft(draft());
  await a.upsertDraft(draft({ platform: "threads" }));
  await b.upsertDraft(draft({ author: "Bravo Roofing", text: "Bravo's own words.", hook: "Bravo's hook.", templateText: "Bravo's own words." }));
  const aRows = await a.list();
  return { a, b, aRows, aX: aRows.find((r) => r.platform === "x")! };
}

describe("one company's queue", () => {
  it("lists, gets and splits only its own posts, even under the same key", async () => {
    const { a, b, aX } = await twoCompanies();
    expect((await b.list()).map((r) => r.text)).toEqual(["Bravo's own words."]);
    expect((await a.list()).map((r) => r.text)).toEqual(["Alpha's own words.", "Alpha's own words."]);
    expect(await b.get(aX.id)).toBeNull();
    const sections = await b.sections("2026-10-27");
    expect([...sections.today, ...sections.earlier, ...sections.ready, ...sections.history].every((r) => r.tenantId === "company-b")).toBe(true);
    // The same key is two companies' keys: B's own drafts don't count as A's, and the other way round.
    expect(await postStore(test.db, { tenantId: "company-c" }).keysWithPosts(["launch:same-key"])).toEqual(new Set());
  });

  it("can't edit, approve, post or skip another company's post with its id", async () => {
    const { a, b, aX } = await twoCompanies();
    expect(await b.edit(aX.id, { text: "B's takeover", hook: "B", firstComment: null })).toBe(false);
    expect(await b.approve([aX.id])).toBe(0);
    expect(await b.markPosted(aX.id, "https://x.com/bravo/status/1")).toBe(false);
    expect(await b.skip(aX.id)).toBe(false);
    expect(await a.get(aX.id)).toMatchObject({ status: "draft", text: "Alpha's own words.", writtenBy: "ai", postedUrl: null });
  });

  it("refreshes only its own drafts on a rebuild under the same key", async () => {
    const { a, b } = await twoCompanies();
    expect(await b.upsertDraft(draft({ text: "Bravo rebuilt." }))).toBe("written");
    expect((await a.list()).every((r) => r.text === "Alpha's own words.")).toBe(true);
    expect((await b.list()).map((r) => r.text)).toEqual(["Bravo rebuilt."]);
  });

  it("forgets one company's posts and no one else's; never the site's own", async () => {
    const { a, b } = await twoCompanies();
    const site = postStore(test.db, { tenantId: "*" });
    await site.upsertDraft(draft({ author: "The site", text: "The site's own." }));
    expect(await forgetTenant(test.db, "company-a")).toEqual({ social_posts: 2 });
    expect(await a.list()).toEqual([]);
    expect(await b.list()).toHaveLength(1);
    expect(await site.list()).toHaveLength(1);
    await expect(forgetTenant(test.db, "*")).rejects.toThrow(/never forgotten/);
    await expect(forgetTenant(test.db, "")).rejects.toThrow(/one company's id/);
  });
});

describe("the table's name comes from a prefix", () => {
  it("is social_posts by default, with every index named from it — the names the shipped SQL creates", () => {
    const config = getTableConfig(socialPosts);
    expect(config.name).toBe("social_posts");
    expect(config.indexes.map((i) => i.config.name).sort()).toEqual(["social_posts_tenant_day_idx", "social_posts_tenant_key_platform_uidx", "social_posts_tenant_status_idx"]);
    for (const name of [config.name, ...config.indexes.map((i) => i.config.name)]) expect(SHIPPED_SQL, name).toContain(`"${name}"`);
    // Every column of the table is in the shipped SQL, with its nullability.
    for (const column of config.columns) {
      const line = SHIPPED_SQL.split("\n").find((l) => l.trim().startsWith(`"${column.name}" `));
      expect(line, column.name).toBeDefined();
      expect(/not null|primary key/.test(line!), `${column.name}'s nullability`).toBe(column.notNull);
    }
    expect(SHIPPED_SQL.match(/^\s+"[a-z_]+" /gm)?.length).toBe(config.columns.length);
  });

  it("makes a second, independent set under another prefix", async () => {
    const other = defineSocialTables({ prefix: "aig_social_" });
    expect(getTableConfig(other.posts).name).toBe("aig_social_posts");
    expect(getTableConfig(other.posts).indexes.every((i) => i.config.name!.startsWith("aig_social_posts_"))).toBe(true);
    const both = await createTestDb({ prefix: "aig_social_" });
    await both.client.exec(SHIPPED_SQL);
    try {
      const mine = postStore(both.db, { tenantId: "company-a", table: other.posts });
      const theirs = postStore(both.db, { tenantId: "company-a" });
      await mine.upsertDraft(draft({ text: "In aig_social_posts." }));
      await theirs.upsertDraft(draft({ text: "In social_posts." }));
      expect((await mine.list()).map((r) => r.text)).toEqual(["In aig_social_posts."]);
      expect((await theirs.list()).map((r) => r.text)).toEqual(["In social_posts."]);
      expect(await forgetTenant(both.db, "company-a", { tables: other })).toEqual({ aig_social_posts: 1 });
      expect(await theirs.list()).toHaveLength(1);
    } finally {
      await both.close();
    }
  });

  it("refuses a prefix that isn't a plain identifier", () => {
    for (const prefix of ["Social_", "social-", "1social_", "x".repeat(33), "drop table;"]) {
      expect(() => defineSocialTables({ prefix }), prefix).toThrow(InvalidSocialPrefixError);
    }
  });
});
