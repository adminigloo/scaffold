import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { postStore, type DraftInput, type PostStore } from "../store.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * THE QUEUE ON A REAL POSTGRES (PGlite, in-process, built from the shipped
 * SQL): a draft is written once per company, key and platform, a rerun
 * refreshes only a draft nobody has touched, and a person's edit, approval,
 * post or skip always stands.
 */
let test: TestDb;
let store: PostStore;

beforeEach(async () => {
  test = await createTestDb();
  store = postStore(test.db, { tenantId: tenant() });
});

afterEach(async () => {
  await test.close();
});

const draft = (over: Partial<DraftInput> = {}): DraftInput => ({
  key: "launch:saturdays",
  kind: "launch",
  platform: "x",
  author: "Maple & Rye",
  day: "2026-10-27",
  text: "Open on Saturdays from Nov 1, 9 to 1.",
  hook: "Saturdays, 9 to 1.",
  images: [{ url: "https://example.com/card.png", alt: "The day's card", width: 1080, height: 1080 }],
  firstComment: "Our hours: https://example.com",
  templateText: "Open on Saturdays from Nov 1, 9 to 1.",
  writtenBy: "ai",
  note: null,
  linkUrl: "https://example.com",
  facts: { title: "Saturdays", lines: ["9 to 1"] },
  ...over,
});

const only = async () => {
  const rows = await store.list();
  expect(rows).toHaveLength(1);
  return rows[0]!;
};

describe("the queue", () => {
  it("writes a draft once per key and platform, and a rerun refreshes it", async () => {
    expect(await store.upsertDraft(draft())).toBe("written");
    expect(await store.upsertDraft(draft({ text: "Fresher words." }))).toBe("written");
    expect(await only()).toMatchObject({ text: "Fresher words.", status: "draft", writtenBy: "ai", images: draft().images, firstComment: "Our hours: https://example.com", tenantId: store.tenantId });
    await store.upsertDraft(draft({ platform: "bluesky" }));
    expect(await store.list()).toHaveLength(2);
  });

  it("keeps a draft's day when a later Build now refreshes it, so its expiry doesn't move", async () => {
    await store.upsertDraft(draft({ day: "2026-10-26" }));
    expect(await store.upsertDraft(draft({ day: "2026-11-01", text: "Refreshed on a later day." }))).toBe("written");
    expect(await only()).toMatchObject({ day: "2026-10-26", text: "Refreshed on a later day." });
  });

  it("never writes over a draft a person edited", async () => {
    await store.upsertDraft(draft());
    const { id } = await only();
    expect(await store.edit(id, { text: "My own words.", hook: "My own hook.", firstComment: " " })).toBe(true);
    expect(await store.upsertDraft(draft({ text: "The builder's words." }))).toBe("kept");
    expect(await only()).toMatchObject({ text: "My own words.", hook: "My own hook.", firstComment: null, writtenBy: "person", status: "draft" });
    expect(await store.edit(id, { text: "  ", hook: "", firstComment: null })).toBe(false);
  });

  it("never writes over an approved, posted or skipped post", async () => {
    for (const [platform, act] of [
      ["x", (id: string) => store.approve([id])],
      ["threads", (id: string) => store.markPosted(id, "https://x.com/maplerye/status/1")],
      ["bluesky", (id: string) => store.skip(id)],
    ] as const) {
      await store.upsertDraft(draft({ platform }));
      const row = (await store.list()).find((r) => r.platform === platform)!;
      await act(row.id);
      expect(await store.upsertDraft(draft({ platform, text: "Rebuilt." }))).toBe("kept");
      expect((await store.get(row.id))!.text).toBe(draft().text);
    }
  });

  it("says which keys have rows, and which still have drafts nobody touched", async () => {
    await store.upsertDraft(draft());
    await store.upsertDraft(draft({ key: "release:2.4" }));
    const release = (await store.list()).find((r) => r.key === "release:2.4")!;
    await store.approve([release.id]);
    const keys = ["launch:saturdays", "release:2.4", "launch:never"];
    expect(await store.keysWithPosts(keys)).toEqual(new Set(["launch:saturdays", "release:2.4"]));
    expect(await store.keysWithPosts(keys, "untouched")).toEqual(new Set(["launch:saturdays"]));
  });

  it("approves drafts only, marks posted with a real link, skips, and lists by status and day — and records who", async () => {
    await store.upsertDraft(draft({ createdBy: "user-1" }));
    await store.upsertDraft(draft({ platform: "threads", day: "2026-10-26" }));
    const [x, threads] = [(await store.list()).find((r) => r.platform === "x")!, (await store.list()).find((r) => r.platform === "threads")!];
    expect(x.createdBy).toBe("user-1");
    expect(await store.approve([x.id, threads.id], "user-2")).toBe(2);
    expect(await store.approve([x.id])).toBe(0);
    expect(await store.markPosted(x.id, "not a link")).toBe(false);
    expect(await store.markPosted(x.id, " https://x.com/maplerye/status/9 ", "user-3")).toBe(true);
    expect(await store.get(x.id)).toMatchObject({ status: "posted", postedUrl: "https://x.com/maplerye/status/9", approvedBy: "user-2", postedBy: "user-3" });
    expect(await store.skip(x.id)).toBe(false);
    expect(await store.skip(threads.id)).toBe(true);
    expect(await store.markPosted(threads.id, "https://threads.net/p/1")).toBe(false);
    expect(await store.edit(threads.id, { text: "too late", hook: "", firstComment: null })).toBe(false);
    expect((await store.list({ statuses: ["posted"] })).map((r) => r.platform)).toEqual(["x"]);
    expect((await store.list({ day: "2026-10-26" })).map((r) => r.platform)).toEqual(["threads"]);
  });

  it("splits the queue into today, earlier, ready and history, each post in one section", async () => {
    await store.upsertDraft(draft({ key: "a", day: "2026-10-27" }));
    await store.upsertDraft(draft({ key: "b", day: "2026-10-25" }));
    await store.upsertDraft(draft({ key: "c", day: "2026-10-25", platform: "threads" }));
    await store.upsertDraft(draft({ key: "d", day: "2026-10-24" }));
    const rows = await store.list();
    const id = (key: string) => rows.find((r) => r.key === key)!.id;
    await store.approve([id("c")]);
    await store.markPosted(id("d"), "https://x.com/maplerye/status/4");
    const sections = await store.sections("2026-10-27");
    expect(sections.today.map((r) => r.key)).toEqual(["a"]);
    // Earlier: every earlier post with something still to do, an approved one too (social 0.2).
    expect(sections.earlier.map((r) => r.key)).toEqual(["b", "c"]);
    expect(sections.ready.map((r) => r.key)).toEqual(["c"]);
    expect(sections.history.map((r) => r.key)).toEqual(["d"]);
  });

  it("refuses a queue with no company", () => {
    expect(() => postStore(test.db, { tenantId: "" })).toThrow(/tenantId/);
    expect(() => postStore(test.db, { tenantId: "  " })).toThrow(/every queue is one company's/);
  });
});

describe("a post going stale, in the table", () => {
  it("marks drafts and approved rows expired, never a posted or skipped one, and lists the open ones lightly", async () => {
    for (const platform of ["x", "threads", "bluesky", "telegram"] as const) await store.upsertDraft(draft({ platform }));
    const rows = await store.list();
    const by = (p: string) => rows.find((r) => r.platform === p)!;
    await store.approve([by("threads").id]);
    await store.markPosted(by("bluesky").id, "https://bsky.app/post/1");
    await store.skip(by("telegram").id);
    const open = await store.openPosts();
    expect(open.map((r) => r.status).sort()).toEqual(["approved", "draft"]);
    expect(Object.keys(open[0]!).sort()).toEqual(["day", "id", "key", "kind", "status"]);
    expect(await store.expire(rows.map((r) => r.id))).toBe(2);
    expect((await store.list()).map((r) => r.status).sort()).toEqual(["expired", "expired", "posted", "skipped"]);
    expect(await store.openPosts()).toEqual([]);
    expect(await store.expire([])).toBe(0);
  });

  it("never rebuilds an expired post, nor approves, edits or skips it; it can still be marked posted", async () => {
    await store.upsertDraft(draft());
    const { id } = await only();
    await store.expire([id]);
    expect(await store.upsertDraft(draft({ text: "Fresher words." }))).toBe("kept");
    expect(await store.keysWithPosts([draft().key])).toEqual(new Set([draft().key]));
    expect(await store.keysWithPosts([draft().key], "untouched")).toEqual(new Set());
    expect(await store.approve([id])).toBe(0);
    expect(await store.edit(id, { text: "Too late.", hook: "", firstComment: null })).toBe(false);
    expect(await store.skip(id)).toBe(false);
    // It went out after all (a posting session past midnight): the record says so.
    expect(await store.markPosted(id, "https://x.com/almanac/status/7")).toBe(true);
    expect(await store.get(id)).toMatchObject({ status: "posted", postedUrl: "https://x.com/almanac/status/7" });
  });

  it("lists by post and by row", async () => {
    await store.upsertDraft(draft());
    await store.upsertDraft(draft({ platform: "threads" }));
    await store.upsertDraft(draft({ key: "board:2026-10-27", kind: "board" }));
    expect((await store.list({ keys: [draft().key] })).map((r) => r.platform).sort()).toEqual(["threads", "x"]);
    const [one] = await store.list({ keys: ["board:2026-10-27"] });
    expect((await store.list({ ids: [one!.id] })).map((r) => r.key)).toEqual(["board:2026-10-27"]);
    expect(await store.list({ keys: [] })).toEqual([]);
    expect(await store.list({ ids: [] })).toEqual([]);
  });
});

describe("strict approval (Ask Lou's rule, social 0.2)", () => {
  it("marks posted only what a person approved, and an edit sends an approved post back to draft", async () => {
    const strict = postStore(test.db, { tenantId: tenant(), approval: "strict" });
    await strict.upsertDraft(draft());
    const [row] = await strict.list();
    const id = row!.id;
    // A draft can't go straight to posted.
    expect(await strict.markPosted(id, "https://x.com/maplerye/status/9")).toBe(false);
    expect(await strict.approve([id])).toBe(1);
    // New words after the approval: back to draft, the approval gone.
    expect(await strict.edit(id, { text: "Open Saturdays, 9 to 1, from Nov 1.", hook: "Saturdays.", firstComment: null })).toBe(true);
    expect(await strict.get(id)).toMatchObject({ status: "draft", approvedAt: null });
    expect(await strict.markPosted(id, "https://x.com/maplerye/status/9")).toBe(false);
    // Approved again, it can be marked posted.
    expect(await strict.approve([id])).toBe(1);
    expect(await strict.markPosted(id, "https://x.com/maplerye/status/9")).toBe(true);
    expect(await strict.get(id)).toMatchObject({ status: "posted", postedUrl: "https://x.com/maplerye/status/9" });
  });

  it("leaves the open rule as it was: a draft can be marked posted, and an edit keeps the approval", async () => {
    await store.upsertDraft(draft());
    const [row] = await store.list();
    expect(await store.approve([row!.id])).toBe(1);
    expect(await store.edit(row!.id, { text: "Open Saturdays.", hook: "Saturdays.", firstComment: null })).toBe(true);
    expect((await store.get(row!.id))!.status).toBe("approved");
    await store.upsertDraft(draft({ key: "launch:sundays" }));
    const sunday = (await store.list({ keys: ["launch:sundays"] }))[0]!;
    expect(await store.markPosted(sunday.id, "https://x.com/maplerye/status/10")).toBe(true);
  });
});
