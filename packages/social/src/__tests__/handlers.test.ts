import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSocialAdminHandlers, dayIn, type CreateSocialAdminHandlersOptions } from "../handlers.js";
import { genericHonesty } from "../honesty.js";
import type { SocialPermission } from "../permissions.js";
import { SOCIAL_ADMIN_ROUTE_PERMISSIONS, SOCIAL_ADMIN_ROUTES, type SocialRoute } from "../routes.js";
import { launchSource } from "../sources.js";
import { postStore } from "../store.js";
import type { ComposeWire, PostingSessionWire, QueueWire } from "../wire.js";
import { createTestDb, type TestDb } from "./pglite.js";

/**
 * THE POSTS HANDLER (../handlers.ts) over a real Postgres: every route of
 * the table answers, each asks for its own key, the company comes from the
 * path on every call (another company's post is "not found"), a POST from
 * another site is refused, and composing writes one draft per platform.
 */
let test: TestDb;

beforeEach(async () => {
  test = await createTestDb();
});

afterEach(async () => {
  await test.close();
});

const NOW = new Date("2026-10-27T15:00:00Z");

interface Asked {
  permission: SocialPermission;
  tenantId: string;
}

/** The company is the path's segment after /api/app/; the caller may hold some keys. */
function handlerFor(options: { readonly can?: readonly SocialPermission[]; readonly asked?: Asked[]; readonly complete?: CreateSocialAdminHandlersOptions["writer"] } = {}) {
  const can = new Set(options.can ?? ["social.view", "social.manage"]);
  return createSocialAdminHandlers({
    db: test.db,
    resolveTenant: (req) => /\/api\/app\/([^/]+)\//.exec(new URL(req.url).pathname)?.[1] ?? null,
    authorize: (_req, permission, tenantId) => {
      options.asked?.push({ permission, tenantId });
      return can.has(permission) ? { userId: `user-of-${tenantId}` } : false;
    },
    compose: (input) =>
      launchSource({
        key: input.key,
        facts: input.facts,
        author: input.tenantId === "alpha" ? "Alpha Lawn Care" : "Bravo Roofing",
        voice: "You write for a small business: plain and brief.",
        day: input.day,
        link: input.link ?? `https://example.com/t/${input.tenantId}`,
        hashtags: input.hashtags,
        images: (platform, hook) => (platform === "reddit" ? [] : [{ url: `https://example.com/card?p=${platform}&h=${encodeURIComponent(hook)}`, alt: hook, width: 1080, height: 1080 }]),
      }),
    writer: options.complete ?? (() => ({ complete: null, honesty: genericHonesty, mode: "aside" })),
    cardFormats: (tenantId) => [{ key: "quote", title: "Quote card", about: `Samples for ${tenantId}`, images: [] }],
    today: () => "2026-10-27",
    now: () => NOW,
  });
}

const base = (tenantId: string) => `http://localhost/api/app/${tenantId}/posts/`;
const get = (tenantId: string, path: string) => new Request(`${base(tenantId)}${path}`, { headers: { "sec-fetch-site": "same-origin" } });
const post = (tenantId: string, path: string, body: unknown, headers: Record<string, string> = { "sec-fetch-site": "same-origin" }) =>
  new Request(`${base(tenantId)}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

async function compose(handle: (req: Request) => Promise<Response>, tenantId: string, facts: string, extra: Record<string, unknown> = {}): Promise<ComposeWire> {
  const res = await handle(post(tenantId, "v1/admin/compose", { facts, ...extra }));
  expect(res.status).toBe(201);
  return (await res.json()) as ComposeWire;
}

async function queueOf(handle: (req: Request) => Promise<Response>, tenantId: string): Promise<QueueWire> {
  const res = await handle(get(tenantId, "v1/admin/posts"));
  expect(res.status).toBe(200);
  return (await res.json()) as QueueWire;
}

describe("composing a post", () => {
  it("writes one draft per platform from the person's facts, in each platform's format, with the images and hashtags", async () => {
    const { handle } = handlerFor();
    const done = await compose(handle, "alpha", "We now mow on Saturdays, 8 to noon. Book online any time.", { hashtags: "#lawn, mowing #lawn" });
    expect(done).toMatchObject({ written: 10, kept: 0, note: "Code's hook, no aside: no AI is set up here" });
    expect(done.key).toMatch(/^launch:[a-z0-9]+$/);
    const queue = await queueOf(handle, "alpha");
    expect(queue.today).toBe("2026-10-27");
    expect(queue.sections.today).toHaveLength(10);
    const instagram = queue.sections.today.find((p) => p.platform === "instagram")!;
    expect(instagram.text).toBe("We now mow on Saturdays, 8 to noon.\n\nWe now mow on Saturdays, 8 to noon. Book online any time.\n\nLink in bio.\n\n#lawn #mowing");
    expect(instagram.hook).toBe("We now mow on Saturdays, 8 to noon.");
    const x = queue.sections.today.find((p) => p.platform === "x")!;
    expect(x.firstComment).toBe("https://example.com/t/alpha");
    expect(x.images).toHaveLength(1);
    expect(queue.sections.today.find((p) => p.platform === "reddit")!.images).toEqual([]);
    expect(queue.sections.today.every((p) => p.author === "Alpha Lawn Care" && p.status === "draft" && p.writtenBy === "template")).toBe(true);
  });

  it("refuses empty facts, too many words and a link that isn't a web address, writing nothing", async () => {
    const { handle } = handlerFor();
    for (const [body, words] of [
      [{ facts: "   " }, "Write the facts first"],
      [{ facts: "x".repeat(1201) }, "under 1,200 characters"],
      [{ facts: "New hours.", link: "javascript:alert(1)" }, "has to be a web address"],
    ] as const) {
      const res = await handle(post("alpha", "v1/admin/compose", body));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { message: string } }).error.message).toContain(words);
    }
    expect((await queueOf(handle, "alpha")).sections.today).toEqual([]);
  });

  it("asks the app's writer for the company's own AI, and keeps the AI's hook and sign-off where they pass", async () => {
    const asked: string[] = [];
    const { handle } = handlerFor({
      complete: ({ tenantId }) => {
        asked.push(tenantId);
        return {
          complete: async () => JSON.stringify({ hook: "Saturday mowing is here.", aside: "The mowers have been polished, and so have we.", shortAside: "The mowers are ready." }),
          honesty: genericHonesty,
          mode: "aside",
        };
      },
    });
    await compose(handle, "alpha", "We now mow on Saturdays.");
    expect(asked).toEqual(["alpha"]);
    const x = (await queueOf(handle, "alpha")).sections.today.find((p) => p.platform === "x")!;
    expect(x).toMatchObject({ hook: "Saturday mowing is here.", writtenBy: "ai-aside", text: "We now mow on Saturdays.\n\nThe mowers are ready." });
  });
});

describe("the queue's routes", () => {
  it("edits, approves, marks posted and skips, recording who; refuses what can't happen with a sentence", async () => {
    const { handle } = handlerFor();
    await compose(handle, "alpha", "New hours from Nov 1.");
    const today = (await queueOf(handle, "alpha")).sections.today;
    const [x, threads, bluesky] = ["x", "threads", "bluesky"].map((p) => today.find((row) => row.platform === p)!);

    const edited = await handle(post("alpha", `v1/admin/posts/${x!.id}`, { text: "My own words.", hook: "My hook.", firstComment: "" }));
    expect(edited.status).toBe(200);
    expect(((await edited.json()) as { post: { text: string; writtenBy: string } }).post).toMatchObject({ text: "My own words.", writtenBy: "person" });
    expect((await handle(post("alpha", `v1/admin/posts/${x!.id}`, { text: " ", hook: "" }))).status).toBe(409);

    const approved = await handle(post("alpha", "v1/admin/approve", { ids: [x!.id, threads!.id] }));
    expect(await approved.json()).toEqual({ approved: 2 });
    expect((await handle(post("alpha", "v1/admin/approve", { ids: [] }))).status).toBe(400);

    expect((await handle(post("alpha", `v1/admin/posts/${x!.id}/posted`, { url: "not a link" }))).status).toBe(400);
    const posted = await handle(post("alpha", `v1/admin/posts/${x!.id}/posted`, { url: "https://x.com/alpha/status/1" }));
    expect(((await posted.json()) as { post: { status: string; postedUrl: string } }).post).toMatchObject({ status: "posted", postedUrl: "https://x.com/alpha/status/1" });

    expect((await handle(post("alpha", `v1/admin/posts/${bluesky!.id}/skip`, {}))).status).toBe(200);
    expect((await handle(post("alpha", `v1/admin/posts/${bluesky!.id}/skip`, {}))).status).toBe(409);
    expect((await handle(post("alpha", `v1/admin/posts/${bluesky!.id}/posted`, { url: "https://bsky.app/p/1" }))).status).toBe(409);

    const store = postStore(test.db, { tenantId: "alpha" });
    expect(await store.get(x!.id)).toMatchObject({ approvedBy: "user-of-alpha", postedBy: "user-of-alpha" });
    const sections = (await queueOf(handle, "alpha")).sections;
    expect(sections.ready.map((p) => p.platform)).toEqual(["threads"]);
    expect(sections.history.map((p) => p.platform).sort()).toEqual(["bluesky", "x"]);
  });

  it("answers the posting session with every approved post: what to paste, attach and comment, and where to mark it posted", async () => {
    const { handle } = handlerFor();
    await compose(handle, "alpha", "New hours from Nov 1.");
    const rows = (await queueOf(handle, "alpha")).sections.today;
    const x = rows.find((p) => p.platform === "x")!;
    await handle(post("alpha", "v1/admin/approve", { ids: [x.id] }));
    const session = (await (await handle(get("alpha", "v1/admin/approved"))).json()) as PostingSessionWire;
    expect(session.posts).toHaveLength(1);
    expect(session.posts[0]).toMatchObject({ id: x.id, platform: "x", platformName: "X", text: x.text, firstComment: x.firstComment, images: x.images });
    expect(session.posts[0]!.composeUrl).toBe(`https://x.com/intent/post?text=${encodeURIComponent(x.text)}`);
    expect(session.markPosted).toEqual({ method: "POST", url: "/api/app/alpha/posts/v1/admin/posts/{id}/posted", body: { url: "<the post's own link>" } });
  });

  it("shows the app's card formats for the company", async () => {
    const { handle } = handlerFor();
    expect(await (await handle(get("alpha", "v1/admin/card-formats"))).json()).toEqual({ sets: [{ key: "quote", title: "Quote card", about: "Samples for alpha", images: [] }] });
  });

  it("asks for each route's own key, for the company in the path", async () => {
    const asked: Asked[] = [];
    const { handle } = handlerFor({ asked });
    for (const route of SOCIAL_ADMIN_ROUTES) {
      asked.length = 0;
      await handle(requestFor("bravo", route, { post: "no-such-post" }));
      expect(asked, route.kind).toEqual([{ permission: SOCIAL_ADMIN_ROUTE_PERMISSIONS[route.kind], tenantId: "bravo" }]);
    }
  });

  it("refuses a route whose key the person doesn't hold (403), and passes the app's own refusal through", async () => {
    const viewer = handlerFor({ can: ["social.view"] });
    expect((await viewer.handle(get("alpha", "v1/admin/posts"))).status).toBe(200);
    const refused = await viewer.handle(post("alpha", "v1/admin/compose", { facts: "New hours." }));
    expect([refused.status, ((await refused.json()) as { error: { code: string } }).error.code]).toEqual([403, "forbidden"]);
    const signedOut = createSocialAdminHandlers({
      db: test.db,
      tenantId: "*",
      authorize: () => Response.json({ error: { code: "unauthorized", message: "Sign in first." } }, { status: 401 }),
      compose: () => {
        throw new Error("never");
      },
      writer: () => ({ complete: null }),
    });
    expect((await signedOut.handle(new Request("http://localhost/api/admin/posts/v1/admin/posts"))).status).toBe(401);
  });

  it("refuses a POST from another site, an unknown route, and a body too big to read", async () => {
    const { handle } = handlerFor();
    const cross = await handle(post("alpha", "v1/admin/compose", { facts: "New hours." }, { "sec-fetch-site": "cross-site" }));
    expect([cross.status, ((await cross.json()) as { error: { code: string } }).error.code]).toEqual([403, "cross_site"]);
    expect((await handle(get("alpha", "v1/admin/nothing"))).status).toBe(404);
    expect((await handle(post("alpha", "v1/admin/posts", {}))).status).toBe(404);
    expect((await handle(post("alpha", "v1/admin/compose", { facts: "x".repeat(20_000) }))).status).toBe(413);
  });
});

/** A route as a request, its placeholders filled from `rows` (the isolation proof's way). */
function requestFor(tenantId: string, route: SocialRoute, rows: Readonly<Record<string, string>>): Request {
  const fill = (text: string) => text.replace(/\{([a-z-]+)\}/g, (_w, entity: string) => rows[entity] ?? "");
  const fillDeep = (value: unknown): unknown =>
    typeof value === "string" ? fill(value) : Array.isArray(value) ? value.map(fillDeep) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillDeep(v)])) : value;
  const url = `${base(tenantId)}${route.path.replace(/\{([a-z-]+)\}/g, (_w, entity: string) => encodeURIComponent(rows[entity] ?? ""))}`;
  if (route.method === "GET") return new Request(url, { headers: { "sec-fetch-site": "same-origin" } });
  return new Request(url, { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" }, body: JSON.stringify(fillDeep(route.body ?? {})) });
}

describe("one company never reaches another's posts through any route (the isolation proof, in miniature)", () => {
  it("answers B's every route, with A's post in the path or body, with nothing of A's — and changes nothing of A's", async () => {
    const { handle } = handlerFor();
    await compose(handle, "alpha", "Alpha Lawn Care now mows on Saturdays, 8 to noon.");
    await compose(handle, "bravo", "Bravo Roofing now inspects roofs on Sundays.");
    const alpha = postStore(test.db, { tenantId: "alpha" });
    const before = JSON.stringify(await alpha.list({ limit: 500 }));
    const aPost = (await alpha.list())[0]!;
    for (const route of SOCIAL_ADMIN_ROUTES) {
      const res = await handle(requestFor("bravo", route, { post: aPost.id }));
      const text = await res.text();
      expect(text.includes("Alpha") || text.includes(aPost.id), `${route.kind} answered with A's data: ${text.slice(0, 200)}`).toBe(false);
      if (route.path.includes("{post}")) expect([res.status, JSON.parse(text).error?.code], route.kind).toEqual([404, "not_found"]);
      else expect(res.status, `${route.kind}: ${text.slice(0, 200)}`).toBeLessThan(500);
    }
    expect(JSON.stringify(await alpha.list({ limit: 500 }))).toBe(before);
  });

  it("drives every route the table lists (none is a dead entry)", async () => {
    const { handle } = handlerFor();
    await compose(handle, "alpha", "New hours.");
    // A draft of its own for each route: marking one posted mustn't stop the next being skipped.
    const own = await postStore(test.db, { tenantId: "alpha" }).list();
    for (const [i, route] of SOCIAL_ADMIN_ROUTES.entries()) {
      const res = await handle(requestFor("alpha", route, { post: own[i % own.length]!.id }));
      expect(res.status, `${route.kind}: ${await res.clone().text()}`).toBeLessThan(300);
    }
  });
});

describe("the business's own day", () => {
  it("is the date in its time zone, and UTC for one this runtime doesn't know", () => {
    const at = new Date("2026-10-27T03:30:00Z");
    expect(dayIn("America/Denver", at)).toBe("2026-10-26");
    expect(dayIn("Asia/Tokyo", at)).toBe("2026-10-27");
    expect(dayIn("Not/AZone", at)).toBe("2026-10-27");
    expect(dayIn(null, at)).toBe("2026-10-27");
  });
});
