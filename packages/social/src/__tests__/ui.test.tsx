// @vitest-environment happy-dom
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSocialAdminHandlers } from "../handlers.js";
import { launchSource } from "../sources.js";
import { createSocialClient } from "../ui/client.js";
import { PostQueue } from "../ui/PostQueue.js";
import { PostsAdmin } from "../ui/PostsAdmin.js";
import { CardFormats } from "../ui/CardFormats.js";
import { lookKey, lookParts } from "../look-choices.js";
import type { LookChoices } from "../wire.js";
import type { QueuePostView } from "../view.js";
import { createTestDb, type TestDb } from "./pglite.js";

/**
 * THE SCREENS (../ui): a post's card (one card a post, a tab a platform,
 * social 0.2) and what it lets a person do, and the
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
  expiresAt: null,
  expiresLabel: null,
  updatedAt: "2026-10-27T15:00:00.000Z",
  ...over,
});
const noActions = { save: async () => undefined, approve: async () => undefined, markPosted: async () => undefined, skip: async () => undefined };
const card = (post: QueuePostView, readOnly = false) => renderToStaticMarkup(<PostQueue posts={[post]} actions={noActions} readOnly={readOnly} />);

describe("a post's card", () => {
  it("shows the images in order, the live count, the first comment, and Approve, Copy, Open X and Skip on a draft", () => {
    const html = card(view());
    expect(html).toContain('aria-label="X post text"');
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
    const posted = card(view({ status: "posted", postedUrl: "https://x.com/maplerye/status/1" }));
    expect(posted).not.toContain("<textarea");
    expect(posted).toContain("Posted:");
    expect(posted).toContain("Correct the post&#x27;s link");
    const looking = card(view(), true);
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
  it("writes a post from the person's facts, approves its drafts, links the posting session, and shows the card formats", async () => {
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
    // One post, one card: a tab for each of its two platforms.
    await settle(() => m.container.querySelectorAll("article.social-post").length === 1 && m.container.querySelectorAll('article.social-post [role="tab"]').length === 2, "one post, two platforms, in today's queue");
    expect(m.container.textContent).toContain("Written. The drafts are in today's queue.");

    // The post's "Approve all": both platforms are ready to post, counted (not shown twice).
    await act(async () => buttonNamed(m.container, "Approve all")!.click());
    await settle(() => m.container.querySelector('[aria-labelledby="social-ready"]')?.textContent?.includes("2 approved, not posted yet") ?? false, "both ready to post");
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

/** The app's looks as two choices (social 0.7): the background, and confetti over it. */
const LOOKS: LookChoices = {
  label: "Background",
  options: [
    { key: "spray", name: "Spray paint" },
    { key: "dark", name: "Dark" },
  ],
  toggle: { suffix: "-confetti", turnOn: "Turn on confetti", turnOff: "Turn off confetti" },
};

describe("the Look picker (social 0.6; a background and a switch since 0.7)", () => {
  it("reads a look as its two choices, and puts them back together", () => {
    expect(lookParts(LOOKS, "dark-confetti")).toEqual({ option: "dark", on: true });
    expect(lookParts(LOOKS, "spray")).toEqual({ option: "spray", on: false });
    expect(lookParts(LOOKS, "")).toBeNull();
    expect(lookParts(LOOKS, "retired")).toBeNull();
    expect(lookKey(LOOKS, "spray", true)).toBe("spray-confetti");
    expect(lookKey({ ...LOOKS, toggle: undefined }, "spray", true)).toBe("spray");
  });

  it("shows the post's background and its confetti, and switches every platform's pictures with either", async () => {
    const asked: [string, string][] = [];
    const actions = { ...noActions, restyle: async (id: string, look: string) => void asked.push([id, look]) };
    const post = view({ images: [{ url: "https://example.com/api/social/card?kind=quote&look=dark-confetti&sig=s", alt: "The card", width: 1080, height: 1080 }] });
    const m = await mount(<PostQueue posts={[post, view({ id: "p2", platform: "linkedin" })]} actions={actions} looks={LOOKS} />);
    const select = m.container.querySelector(".social-look select") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["Spray paint", "Dark"]);
    expect(select.value).toBe("dark");
    expect(m.container.querySelector(".social-look label")?.textContent).toBe("Background");
    expect(buttonNamed(m.container, "Turn off confetti")).toBeTruthy();
    await act(async () => {
      select.value = "spray";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => buttonNamed(m.container, "Turn off confetti")!.click());
    expect(asked).toEqual([
      ["p1", "spray-confetti"],
      ["p1", "dark"],
    ]);
    await m.unmount();
  });

  it("offers Plain for a post made before the looks, and no picker once nothing can change or without the app's looks", async () => {
    const actions = { ...noActions, restyle: async () => undefined };
    const looks = LOOKS;
    const before = await mount(<PostQueue posts={[view()]} actions={actions} looks={looks} />);
    const select = before.container.querySelector(".social-look select") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["Plain", "Spray paint", "Dark"]);
    // Confetti goes over a background: none chosen yet, nothing to turn on.
    expect((buttonNamed(before.container, "Turn on confetti") as HTMLButtonElement).disabled).toBe(true);
    await before.unmount();
    // The element, not the stylesheet's rule for it (the styles render with every queue).
    const picker = 'class="social-look"';
    expect(renderToStaticMarkup(<PostQueue posts={[view({ status: "posted", postedUrl: "https://x.com/a/1" })]} actions={actions} looks={looks} />)).not.toContain(picker);
    expect(renderToStaticMarkup(<PostQueue posts={[view()]} actions={actions} />)).not.toContain(picker);
    expect(renderToStaticMarkup(<PostQueue posts={[view()]} actions={actions} looks={looks} readOnly />)).not.toContain(picker);
    expect(renderToStaticMarkup(<PostQueue posts={[view()]} actions={actions} looks={looks} />)).toContain(picker);
  });

  it("switches the controls off, saying where, for pictures another server drew (social 0.7.1)", async () => {
    const actions = { ...noActions, restyle: async () => undefined };
    const made = (over: Partial<QueuePostView>) => view({ canRestyle: false, images: [{ url: "https://staging.example.com/api/social/card?kind=quote&sig=s", alt: "The card", width: 1080, height: 1080 }], ...over });
    const m = await mount(<PostQueue posts={[made({}), made({ id: "p2", platform: "linkedin" })]} actions={actions} looks={LOOKS} />);
    expect((m.container.querySelector(".social-look select") as HTMLSelectElement).disabled).toBe(true);
    expect(m.container.textContent).toContain("Its pictures were drawn by staging.example.com, so its look can be changed there, not here.");
    await m.unmount();
    // One platform this server can redraw is enough to offer it.
    const mixed = await mount(<PostQueue posts={[made({}), made({ id: "p2", platform: "linkedin", canRestyle: true })]} actions={actions} looks={LOOKS} />);
    expect((mixed.container.querySelector(".social-look select") as HTMLSelectElement).disabled).toBe(false);
    expect(mixed.container.textContent).not.toContain("not here.");
    await mixed.unmount();
  });

  it("shows every card format in one look at a time, with the same two controls", async () => {
    const asked: string[] = [];
    const sets = [{ key: "quote", title: "Quote card", about: "Samples", images: [{ url: "https://example.com/api/social/card?kind=quote&look=spray-confetti&sig=s", alt: "A sample", width: 1080, height: 1080, label: "quote · 1:1 · 1080×1080" }] }];
    const m = await mount(<CardFormats sets={sets} looks={LOOKS} look="spray-confetti" onLook={(look) => void asked.push(look)} />);
    expect((m.container.querySelector(".social-look select") as HTMLSelectElement).value).toBe("spray");
    await act(async () => buttonNamed(m.container, "Turn off confetti")!.click());
    expect(asked).toEqual(["spray"]);
    expect(m.container.querySelectorAll("section.social-format-set")).toHaveLength(1);
    await m.unmount();
  });

  it("tells each platform how to post something that moves: the video, in place of the picture", () => {
    expect(card(view())).toContain("Make a video, then upload the video in X in place of the picture.");
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
