import { describe, expect, it } from "vitest";
import { genericHonesty } from "../honesty.js";
import { fits } from "../platforms.js";
import type { Platform, PostSource } from "../types.js";
import { writePost, type Complete, type CompleteRequest } from "../writer.js";

/**
 * THE AI WRITER (../writer.ts) against a fake model: each platform's draft is
 * put together in that platform's format, in the AI's words where every
 * check passes and the app's own wherever one doesn't, with the reason.
 */
const LINK = "https://example.com/hours";
const platforms: readonly Platform[] = ["x", "bluesky", "discord", "instagram", "linkedin", "reddit"];
const HOOK = "Open on Saturdays from Nov 1, 9 to 1.";
const BODY = "Starting Nov 1 we're open on Saturdays from 9 to 1.";

const source: PostSource = {
  key: "launch:saturdays",
  kind: "launch",
  author: "Maple & Rye",
  voice: "You write for Maple & Rye, a neighbourhood bakery: warm, plain and brief.",
  day: "2026-10-27",
  facts: { title: "Open on Saturdays from Nov 1", lines: [BODY, "17 of our 24 breads are baked that morning."] },
  platforms,
  hook: HOOK,
  linkUrl: LINK,
  linkLabel: "Our hours",
  // None here: hashtags have their own tests (./hashtags.test.ts).
  hashtags: [],
  template: (p) => [p === "reddit" ? `Open on Saturdays\n\n${BODY}` : BODY],
  images: (p, hook) => (p === "reddit" ? [] : [{ url: `https://example.com/card/${p}.png?hook=${encodeURIComponent(hook)}`, alt: hook, width: 1080, height: 1080 }]),
};

const good: Partial<Record<Platform | "hook", string>> = {
  hook: "Saturdays are on now: 9 to 1.",
  x: "Saturdays are on now: 9 to 1, from Nov 1. 17 of 24 breads baked that morning.",
  bluesky: "From Nov 1 we're open Saturdays, 9 to 1. 17 of 24 breads baked fresh.",
  discord: "Saturdays, as of Nov 1: 9 to 1.",
  instagram: "Saturday bread, 9 to 1.",
  linkedin: "We open on Saturdays from Nov 1.\n\nDoors 9 to 1.",
  reddit: "We now open on Saturdays from Nov 1\n\nOpen 9 to 1, and 17 of our 24 breads are baked that morning.",
};

/** A fake model: answers with `answer`, and keeps what it was asked. */
function fake(answer: string | (() => never)): Complete & { readonly calls: CompleteRequest[] } {
  const calls: CompleteRequest[] = [];
  const complete = async (request: CompleteRequest) => {
    calls.push(request);
    return typeof answer === "string" ? answer : answer();
  };
  return Object.assign(complete, { calls });
}

const json = (over: Partial<Record<Platform | "hook", string>> = {}) => JSON.stringify({ ...good, ...over });
const of = (written: Awaited<ReturnType<typeof writePost>>, p: Platform) => written.find((w) => w.platform === p)!;

describe("the writer", () => {
  it("puts each platform's draft together in its own format, in the AI's words", async () => {
    const model = fake(json());
    const written = await writePost(source, { complete: model });
    expect(model.calls).toHaveLength(1);
    const hook = good.hook!;
    // X: punchy text, no link in the post; the link goes in the first comment.
    expect(of(written, "x")).toMatchObject({ text: good.x, firstComment: `Our hours: ${LINK}`, hook, writtenBy: "ai", note: null });
    expect(of(written, "bluesky")).toMatchObject({ text: `${good.bluesky}`, firstComment: null, linkUrl: LINK });
    // Instagram: the hook first, the words, "Link in bio." (links don't work there), the hashtags last.
    expect(of(written, "instagram").text).toBe(`${hook}\n\n${good.instagram}\n\nLink in bio.`);
    // LinkedIn: the hook first, short paragraphs; its link in the first comment too.
    expect(of(written, "linkedin")).toMatchObject({ text: `${hook}\n\n${good.linkedin}`, firstComment: `Our hours: ${LINK}` });
    expect(of(written, "reddit")).toMatchObject({ text: `${good.reddit}\n\nOur hours: ${LINK}`, images: [] });
    // The images are drawn with the hook the draft carries.
    expect(of(written, "x").images).toEqual([{ url: `https://example.com/card/x.png?hook=${encodeURIComponent(hook)}`, alt: hook, width: 1080, height: 1080 }]);
    for (const w of written) expect(fits(w.platform, w.text)).toBe(true);
  });

  it("asks once, with the voice, the facts, the hook and each platform's length and style, and a bounded answer", async () => {
    const model = fake(json());
    await writePost(source, { complete: model });
    const [ask] = model.calls;
    expect(ask!.system).toContain("You write for Maple & Rye");
    expect(ask!.system).toContain("never use a number the facts don't have");
    expect(ask!.system).toContain("Never promise anything");
    expect(ask!.prompt).toContain(`- ${BODY}`);
    expect(ask!.prompt).toContain("Hook: one line of at most 90 characters");
    expect(ask!.prompt).toContain("- x: at most 240 characters. Punchy: one or two short sentences.");
    expect(ask!.prompt).toContain("- reddit: a title line of at most 120 characters");
    expect(ask!.prompt).toContain("Code opens the instagram, linkedin posts with the hook");
    expect(ask!.maxTokens).toBeLessThanOrEqual(4000);
    expect(ask!.schema).toMatchObject({ type: "object", required: ["hook", ...platforms], additionalProperties: false });
  });

  it("uses the template everywhere when the answer isn't JSON", async () => {
    const written = await writePost(source, { complete: fake("Sure! Here are your posts: x: hello") });
    expect(written.every((w) => w.writtenBy === "template" && w.text === w.templateText && w.hook === HOOK)).toBe(true);
    expect(written[0]!.note).toBe("Code's words: the AI's answer wasn't the JSON asked for");
    // The template is put together the same way: X's link still goes in the first comment.
    expect(of(written, "x")).toMatchObject({ text: BODY, firstComment: `Our hours: ${LINK}` });
  });

  it("uses the template everywhere when the call throws (an allowance used up, too)", async () => {
    const written = await writePost(source, {
      complete: fake(() => {
        throw new Error("This month's AI posts are used up.");
      }),
    });
    expect(written.every((w) => w.writtenBy === "template")).toBe(true);
    expect(written[0]!.note).toBe("Code's words: the AI call failed: This month's AI posts are used up.");
  });

  it("falls back for one platform whose words use a number the facts don't have", async () => {
    const written = await writePost(source, { complete: fake(json({ x: "18 of 24 breads baked fresh." })) });
    const x = of(written, "x");
    expect(x).toMatchObject({ writtenBy: "template", text: x.templateText, hook: HOOK, note: "Code's words: the AI used a number not in the facts (18)" });
    expect(written.filter((w) => w.writtenBy === "ai")).toHaveLength(platforms.length - 1);
  });

  it("falls back where the honesty check refuses the words (the generic list)", async () => {
    const written = await writePost(source, { complete: fake(json({ bluesky: "Open Saturdays, 9 to 1. Guaranteed fresh." })), honesty: genericHonesty });
    expect(of(written, "bluesky")).toMatchObject({ writtenBy: "template", note: "Code's words: it read as a guarantee" });
    expect(of(written, "x").writtenBy).toBe("ai");
  });

  it("refuses overlong words rather than cutting them", async () => {
    const written = await writePost(source, { complete: fake(json({ x: `9 to 1. ${"Very ".repeat(60)}` })) });
    expect(of(written, "x").note).toMatch(/^Code's words: too long for X \(\d+ of 280\)$/);
  });

  it("refuses a link, a hashtag or nothing at all from the AI", async () => {
    const written = await writePost(source, { complete: fake(json({ x: "9 to 1. See maplerye.com", bluesky: "9 to 1. #blessed", discord: "" })) });
    expect(of(written, "x").note).toBe("Code's words: the AI wrote a link");
    expect(of(written, "bluesky").note).toBe("Code's words: the AI wrote a hashtag");
    expect(of(written, "discord").note).toBe("Code's words: the AI wrote nothing for it");
  });

  it("keeps the AI's words with code's hook when only the hook fails", async () => {
    const written = await writePost(source, { complete: fake(json({ hook: "99 loaves, give or take." })) });
    const x = of(written, "x");
    expect(x).toMatchObject({ writtenBy: "ai", text: good.x, hook: HOOK, note: "Code's hook: the AI used a number not in the facts (99)" });
    expect(x.images[0]!.alt).toBe(HOOK);
    expect(of(written, "instagram").text.startsWith(`${HOOK}\n\n`)).toBe(true);
  });

  it("cuts the app's own words to fit when no version does", async () => {
    const written = await writePost({ ...source, template: () => [`${BODY} ${"And then some more words. ".repeat(20)}`] }, { complete: null });
    expect(fits("x", of(written, "x").text)).toBe(true);
    expect(of(written, "x").text.startsWith(BODY)).toBe(true);
  });

  it("asks nothing for a post with no AI voice, and says nothing failed", async () => {
    const model = fake(json());
    const written = await writePost({ ...source, voice: null }, { complete: model });
    expect(model.calls).toHaveLength(0);
    expect(written.every((w) => w.writtenBy === "template" && w.note === null && w.hook === HOOK)).toBe(true);
  });

  it("uses the template, with the reason, when no AI is set up", async () => {
    const written = await writePost(source, { complete: null });
    expect(written.every((w) => w.writtenBy === "template" && w.note === "Code's words: no AI is set up here")).toBe(true);
  });
});
