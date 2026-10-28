// @vitest-environment happy-dom
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSocialAdminHandlers } from "../handlers.js";
import { launchSource } from "../sources.js";
import { createSocialClient } from "../ui/client.js";
import { PostCard } from "../ui/PostCard.js";
import { PostsAdmin } from "../ui/PostsAdmin.js";
import type { QueuePostView } from "../view.js";
import { createTestDb, type TestDb } from "./pglite.js";

/**
 * THE SCREENS (../ui): a draft's card and what it lets a person do, and the
 * whole posts screen driven in a DOM against the REAL handler over a real
 * Postgres — compose, approve all, the posting session's link, the card
 * formats — with nothing between the two but the screen's own fetches.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let test: TestDb;
beforeEach(async () => {
  test = await createTestDb();
});
afterEach(async () => {
  document.body.innerHTML = "";
  await test.close();
});

const view = (over: Partial<QueuePostView> = {}): QueuePostView => ({
  id: "p1",
  key: "launch:1",
  kind: "launch",
  platform: "x",
  author: "Maple & Rye",
  day: "2026-10-27",
  title: "Open on Saturdays",
  text: "We're open on Saturdays now, 9 to 1.",
  hook: "Saturdays, 9 to 1.",
  images: [{ url: "https://example.com/card.png?sig=x", alt: "The card", width: 1080, height: 1080 }],
  firstComment: "https://example.com/hours",
  templateText: "We're open on Saturdays now, 9 to 1.",
  writtenBy: "ai-aside",
  note: null,
  linkUrl: "https://example.com/hours",
  status: "draft",
  postedUrl: null,
  postedAt: null,
  updatedAt: "2026-10-27T15:00:00.000Z",
  ...over,
});
const noActions = { save: async () => undefined, approve: async () => undefined, markPosted: async () => undefined, skip: async () => undefined };

describe("a draft's card", () => {
  it("shows the images in order, the live count, the first comment, and Approve, Copy, Open X and Skip on a draft", () => {
    const html = renderToStaticMarkup(<PostCard post={view()} actions={noActions} />);
    expect(html).toContain('aria-label="X post"');
    expect(html).toContain('src="https://example.com/card.png?sig=x"');
    expect(html).toContain("<textarea");
    expect(html).toContain("36 of 280");
    expect(html).toContain("First comment (post it as the first reply)");
    // The composer with the text filled in (React escapes the apostrophe in the attribute).
    expect(html).toContain(`href="https://x.com/intent/post?text=${encodeURIComponent("We're open on Saturdays now, 9 to 1.").replace("'", "&#x27;")}"`);
    expect(html).toContain(">Open X<");
    for (const word of [">Approve<", ">Skip<", "Mark posted", "Copy text"]) expect(html).toContain(word);
  });

  it("is read-only once posted (with its link), and for someone who may only look", () => {
    const posted = renderToStaticMarkup(<PostCard post={view({ status: "posted", postedUrl: "https://x.com/maplerye/status/1" })} actions={noActions} />);
    expect(posted).not.toContain("<textarea");
    expect(posted).toContain("Posted:");
    expect(posted).toContain("Correct the post&#x27;s link");
    const looking = renderToStaticMarkup(<PostCard post={view()} actions={noActions} readOnly />);
    expect(looking).not.toContain("<textarea");
    for (const word of [">Approve<", ">Skip<", "Mark posted"]) expect(looking).not.toContain(word);
    expect(looking).toContain("Copy text");
  });
});

async function mount(element: ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  return { container, unmount: () => act(async () => root.unmount()) };
}

/** Let the screen's fetches (to the handler over PGlite) and their renders finish. */
async function settle(until: () => boolean, label: string) {
  for (let i = 0; i < 200 && !until(); i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  expect(until(), label).toBe(true);
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!;
  setter.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

const buttonNamed = (container: HTMLElement, name: string) => [...container.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith(name)) as HTMLButtonElement | undefined;

describe("the posts screen, over the real handler", () => {
  it("writes a post from the person's facts, approves today's drafts, links the posting session, and shows the card formats", async () => {
    const { handle } = createSocialAdminHandlers({
      db: test.db,
      tenantId: "alpha",
      authorize: () => ({ userId: "u1" }),
      compose: (input) => launchSource({ key: input.key, facts: input.facts, author: "Alpha Lawn Care", voice: null, day: input.day, link: input.link ?? "https://example.com/t/alpha", hashtags: input.hashtags, platforms: ["x", "linkedin"], images: () => [] }),
      writer: () => ({ complete: null }),
      cardFormats: () => [{ key: "quote", title: "Quote card", about: "Samples", images: [{ url: "https://example.com/api/social/card?kind=quote&sig=s", alt: "A sample", width: 1080, height: 1080, label: "quote · 1:1 · 1080×1080" }] }],
      today: () => "2026-10-27",
    });
    const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => handle(new Request(new URL(String(input), "http://localhost"), init))) as typeof fetch;
    const m = await mount(<PostsAdmin baseUrl="/api/admin/posts" canManage businessName="Alpha Lawn Care" fetcher={fetcher} />);
    await settle(() => m.container.textContent?.includes("Today, Tuesday, October 27") ?? false, "the queue loaded");
    expect(m.container.textContent).toContain("Nothing for today yet.");

    // A post from the person's own facts.
    const form = m.container.querySelector("form.social-compose") as HTMLFormElement;
    setValue(form.querySelector("textarea")!, "We now mow on Saturdays, 8 to noon.");
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle(() => m.container.querySelectorAll("article.social-card").length === 2, "two drafts in today's queue");
    expect(m.container.textContent).toContain("Written. The drafts are in today's queue.");

    // Approve all for today: both move to Ready to post.
    await act(async () => buttonNamed(m.container, "Approve all for today")!.click());
    await settle(() => (m.container.querySelector('[aria-labelledby="social-ready"]')?.querySelectorAll("article.social-card").length ?? 0) === 2, "both ready to post");
    const session = [...m.container.querySelectorAll("a")].find((a) => a.textContent === "the approved posts")!;
    expect(session.getAttribute("href")).toBe("/api/admin/posts/v1/admin/approved");

    // Every card format, loaded when it's opened.
    const details = m.container.querySelector("details") as HTMLDetailsElement;
    details.open = true;
    await act(async () => {
      details.dispatchEvent(new Event("toggle"));
    });
    await settle(() => m.container.querySelector('[data-sample-set="quote"] img') !== null, "the card formats loaded");
    await m.unmount();
  });

  it("shows a read-only queue, with no compose form, to someone who may only look", async () => {
    const { handle } = createSocialAdminHandlers({ db: test.db, tenantId: "alpha", authorize: () => ({ userId: "u1" }), compose: () => { throw new Error("never"); }, writer: () => ({ complete: null }), today: () => "2026-10-27" });
    const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => handle(new Request(new URL(String(input), "http://localhost"), init))) as typeof fetch;
    const m = await mount(<PostsAdmin baseUrl="/api/admin/posts" canManage={false} fetcher={fetcher} />);
    await settle(() => m.container.textContent?.includes("Today,") ?? false, "the queue loaded");
    expect(m.container.querySelector("form.social-compose")).toBeNull();
    await m.unmount();
  });
});

describe("the screens' client", () => {
  it("returns the handler's own sentence for a refusal, and plain words for what isn't the handler's", async () => {
    const answers: Response[] = [
      Response.json({ error: { code: "invalid", message: "Paste the post's own link (https://…)." } }, { status: 400 }),
      new Response("<html>Bad gateway</html>", { status: 502 }),
    ];
    const client = createSocialClient("/api/app/co1/posts/", (async () => answers.shift()!) as typeof fetch);
    expect(await client.actions.markPosted("p1", "nope")).toEqual({ error: "Paste the post's own link (https://…)." });
    expect(await client.actions.skip("p1")).toEqual({ error: "The site isn't answering right now. Try again in a minute." });
    const offline = createSocialClient("/x", (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch);
    expect(await offline.actions.approve(["p1"])).toEqual({ error: "We couldn't reach the server. Check your internet connection and try again." });
    expect(client.approvedUrl).toBe("/api/app/co1/posts/v1/admin/approved");
  });
});
