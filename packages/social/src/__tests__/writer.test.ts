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
  hashtags: ["#bakery", "#saturday", "#fresh"],
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
    expect(of(written, "bluesky")).toMatchObject({ text: `${good.bluesky}\n\nOur hours: ${LINK}`, firstComment: null });
    // Instagram: the hook first, the words, "Link in bio." (links don't work there), the hashtags last.
    expect(of(written, "instagram").text).toBe(`${hook}\n\n${good.instagram}\n\nLink in bio.\n\n#bakery #saturday #fresh`);
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

/**
 * "ASIDE" MODE: every fact and every platform's body are the app's own; the
 * AI writes only the hook and a number-free aside (and a short one where
 * room is tight), each checked, each dropped on its own when it fails.
 */
describe("the writer, in aside mode", () => {
  const ASIDE = "The kettle is on, and the flour dust has settled on everything again.";
  const SHORT = "The kettle is always on.";
  const AI_HOOK = "Saturdays are on now: 9 to 1.";
  const answer = (over: Partial<Record<"hook" | "aside" | "shortAside", string>> = {}) => JSON.stringify({ hook: AI_HOOK, aside: ASIDE, shortAside: SHORT, ...over });
  const write = (complete: Complete | null, s: PostSource = source) => writePost(s, { complete, mode: "aside" });

  it("keeps every fact the app's own, adding the hook and the aside where each platform takes one", async () => {
    const written = await write(fake(answer()));
    // X: code's words, the short aside, the link in the first comment.
    expect(of(written, "x")).toMatchObject({ text: `${BODY}\n\n${SHORT}`, firstComment: `Our hours: ${LINK}`, hook: AI_HOOK, writtenBy: "ai-aside", note: null });
    expect(of(written, "discord").text).toBe(`${BODY}\n\n${ASIDE}\n\nOur hours: ${LINK}`);
    expect(of(written, "instagram").text).toBe(`${AI_HOOK}\n\n${BODY}\n\n${ASIDE}\n\nLink in bio.\n\n#bakery #saturday #fresh`);
    // No sign-off under a Reddit post.
    expect(of(written, "reddit").text).toBe(`Open on Saturdays\n\n${BODY}\n\nOur hours: ${LINK}`);
    // What a person can go back to: code's hook, no aside.
    expect(of(written, "instagram").templateText).toBe(`${HOOK}\n\n${BODY}\n\nLink in bio.\n\n#bakery #saturday #fresh`);
  });

  it("asks once, for the hook and the two asides only, with the facts and a small bound", async () => {
    const model = fake(answer());
    await write(model);
    const [ask] = model.calls;
    expect(ask!.system).toContain("You write for Maple & Rye");
    expect(ask!.system).toContain('"hook", "aside" and "shortAside"');
    expect(ask!.system).toContain("No numbers in it at all");
    expect(ask!.prompt).toContain(`- ${BODY}`);
    expect(ask!.schema).toMatchObject({ required: ["hook", "aside", "shortAside"], additionalProperties: false });
    expect(ask!.maxTokens).toBeLessThanOrEqual(500);
  });

  it("refuses an aside with any number in it, a spelled one or a year too", async () => {
    const written = await write(fake(answer({ aside: "We have had this oven since 1987.", shortAside: "Two cats live here." })));
    expect(of(written, "x")).toMatchObject({ text: BODY, note: "No aside: it had a number (2)" });
    expect(of(written, "discord").note).toBe("No aside: it had a number (1987)");
    // The hook still passed: the draft still has the AI's work in it.
    expect(of(written, "discord").writtenBy).toBe("ai-aside");
  });

  it("refuses an aside that names something the facts name: it's about the author's own world", async () => {
    const written = await write(fake(answer({ aside: "Saturdays smell like cinnamon here, and we have stopped apologising for it." })));
    expect(of(written, "discord").text).toContain(SHORT);
    expect(of(written, "discord").text).not.toContain("cinnamon");
    // A month is not a name from the facts: "Nov" is, "October" isn't.
    const fine = await write(fake(answer({ aside: "My October loaves are lopsided. The cat approves." })));
    expect(of(fine, "discord").text).toContain("The cat approves.");
  });

  it("lets a full aside that failed give way to the short one", async () => {
    const written = await write(fake(answer({ aside: "Seventeen loaves fell on me." })));
    expect(of(written, "discord").text).toBe(`${BODY}\n\n${SHORT}\n\nOur hours: ${LINK}`);
  });

  it("keeps code's hook when the AI's uses a number the facts don't have", async () => {
    const written = await write(fake(answer({ hook: "86 loaves in 141 minutes." })));
    expect(of(written, "x")).toMatchObject({ hook: HOOK, writtenBy: "ai-aside", note: "Code's hook: the AI used a number not in the facts (86, 141)" });
    expect(of(written, "x").images[0]!.alt).toBe(HOOK);
  });

  it("holds the hook and the aside to the post's own rule too", async () => {
    const oneShop = (text: string) => (/\bshops\b/i.test(text) ? "it made one shop into more than one" : null);
    const written = await write(fake(answer({ hook: "Same bread, many shops.", aside: "I counted the shops twice." })), { ...source, check: oneShop });
    expect(of(written, "discord")).toMatchObject({ hook: HOOK, note: "Code's hook: it made one shop into more than one" });
    expect(of(written, "discord").text).toContain(SHORT);
  });

  it("drops the aside before it cuts a fact", async () => {
    const facts = `${BODY} ${"And the facts go on. ".repeat(10)}`.trim();
    const written = await write(fake(answer()), { ...source, template: () => [facts] });
    expect(of(written, "x")).toMatchObject({ text: facts, note: "No aside: no room on X" });
  });

  it("falls back to code's hook and no aside when the call fails, with the reason", async () => {
    const thrown = await write(
      fake(() => {
        throw new Error("overloaded");
      }),
    );
    expect(thrown.every((w) => w.writtenBy === "template" && w.hook === HOOK && w.text === w.templateText && w.note === "Code's hook, no aside: the AI call failed: overloaded")).toBe(true);
    const nonsense = await write(fake("Here you go!"));
    expect(nonsense[0]!.note).toBe("Code's hook, no aside: the AI's answer wasn't the JSON asked for");
  });
});
