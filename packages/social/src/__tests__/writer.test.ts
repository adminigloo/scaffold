import { describe, expect, it } from "vitest";
import { fits, SHORT_ASIDE_MAX } from "../platforms.js";
import type { AsidePart, Platform, PostSource, WordsPart } from "../types.js";
import { ASIDE_CANDIDATES, asideTokens, candidatesRequest, fixedAside, HOOK_ONLY_TOKENS, pickAsides, writePost, type Complete, type CompleteRequest } from "../writer.js";

/**
 * THE AI WRITER (src/social/writer.ts) against a fake model: each platform's
 * draft is put together in that platform's format, in the AI's words where
 * every check passes and the app's own wherever one doesn't, with the reason.
 */
const LINK = "https://example.com/results/2026-10-26";
const platforms: readonly Platform[] = ["x", "bluesky", "discord", "instagram", "linkedin", "reddit"];
const HOOK = "Oct 26: 17 of 24 favorites came in.";

const source: PostSource = {
  key: "results:2026-10-26",
  kind: "results",
  author: "Al",
  voice: "You are Al, a smug old wizard.",
  day: "2026-10-27",
  facts: { title: "How the highs settled on Oct 26", lines: ["The favorite came in for 17 of 24 cities.", "Biggest upset: Denver, a 70¢ favorite."] },
  platforms,
  hook: HOOK,
  linkUrl: LINK,
  linkLabel: "Every city",
  // None here: these tests are about the words, the asides and the banter. Hashtags have their own (./hashtags.test.ts).
  hashtags: [],
  template: (p) => [p === "reddit" ? "Oct 26's results\n\n17 of 24 favorites came in." : "17 of 24 favorites came in."],
  images: (p, hook) => (p === "reddit" ? [] : [{ url: `https://example.com/card/${p}.png?hook=${encodeURIComponent(hook)}`, alt: hook, width: 1080, height: 1080 }]),
};

const good: Partial<Record<Platform | "hook", string>> = {
  hook: "I have seen yesterday. 17 of 24.",
  x: "I have seen yesterday. 17 of 24 favorites came in. Denver did not.",
  bluesky: "17 of 24 came in. Denver's 70¢ favorite did not. I saw it all.",
  discord: "Yesterday, as I saw it: 17 of 24 favorites came in.",
  instagram: "Denver's 70¢ favorite, gone.",
  linkedin: "17 of 24 favorites came in.\n\nDenver's did not.",
  reddit: "Oct 26: 17 of 24 favorites came in\n\nDenver's 70¢ favorite was the biggest upset.",
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
    expect(of(written, "x")).toMatchObject({ text: good.x, firstComment: `Every city: ${LINK}`, hook, writtenBy: "ai", note: null });
    // Bluesky's link is a link card (social 0.2): not in its 300, kept on the draft for whoever posts it.
    expect(of(written, "bluesky")).toMatchObject({ text: good.bluesky, firstComment: null, linkUrl: LINK });
    // Instagram: the hook first, the words, "Link in bio." (links don't work there), the hashtags last.
    expect(of(written, "instagram").text).toBe(`${hook}\n\n${good.instagram}\n\nLink in bio.`);
    // LinkedIn: the hook first, short paragraphs; its link in the first comment too.
    expect(of(written, "linkedin")).toMatchObject({ text: `${hook}\n\n${good.linkedin}`, firstComment: `Every city: ${LINK}` });
    expect(of(written, "reddit")).toMatchObject({ text: `${good.reddit}\n\nEvery city: ${LINK}`, images: [] });
    // The images are drawn with the hook the draft carries.
    expect(of(written, "x").images).toEqual([{ url: `https://example.com/card/x.png?hook=${encodeURIComponent(hook)}`, alt: hook, width: 1080, height: 1080 }]);
    for (const w of written) expect(fits(w.platform, w.text)).toBe(true);
  });

  it("asks once, with the voice, the facts, the hook and each platform's length and style, and a bounded answer", async () => {
    const model = fake(json());
    await writePost(source, { complete: model });
    const [ask] = model.calls;
    expect(ask!.system).toContain("You are Al, a smug old wizard.");
    expect(ask!.system).toContain("never use a number the facts don't have");
    expect(ask!.prompt).toContain("- The favorite came in for 17 of 24 cities.");
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
    expect(of(written, "x")).toMatchObject({ text: "17 of 24 favorites came in.", firstComment: `Every city: ${LINK}` });
  });

  it("uses the template everywhere when the call throws", async () => {
    const written = await writePost(source, {
      complete: fake(() => {
        throw new Error("overloaded");
      }),
    });
    expect(written.every((w) => w.writtenBy === "template")).toBe(true);
    expect(written[0]!.note).toBe("Code's words: the AI call failed: overloaded");
  });

  it("falls back for one platform whose words use a number the facts don't have", async () => {
    const written = await writePost(source, { complete: fake(json({ x: "18 of 24 favorites came in." })) });
    const x = of(written, "x");
    expect(x).toMatchObject({ writtenBy: "template", text: x.templateText, hook: HOOK, note: "Code's words: the AI used a number not in the facts (18)" });
    expect(written.filter((w) => w.writtenBy === "ai")).toHaveLength(platforms.length - 1);
  });

  it("falls back where the app's honesty check refuses the words", async () => {
    const honesty = (text: string) => (/\block\b/i.test(text) ? "it used a banned phrase (lock)" : null);
    const written = await writePost(source, { complete: fake(json({ bluesky: "17 of 24. A lock, said nobody." })), honesty });
    expect(of(written, "bluesky")).toMatchObject({ writtenBy: "template", note: "Code's words: it used a banned phrase (lock)" });
    expect(of(written, "x").writtenBy).toBe("ai");
  });

  it("refuses overlong words rather than cutting them", async () => {
    const written = await writePost(source, { complete: fake(json({ x: `17 of 24. ${"Very ".repeat(60)}` })) });
    expect(of(written, "x").note).toMatch(/^Code's words: too long for X \(\d+ of 280\)$/);
  });

  it("refuses a link, a hashtag or nothing at all from the AI", async () => {
    const written = await writePost(source, { complete: fake(json({ x: "17 of 24. See almanac.com", bluesky: "17 of 24. #blessed", discord: "" })) });
    expect(of(written, "x").note).toBe("Code's words: the AI wrote a link");
    expect(of(written, "bluesky").note).toBe("Code's words: the AI wrote a hashtag");
    expect(of(written, "discord").note).toBe("Code's words: the AI wrote nothing for it");
  });

  it("keeps the AI's words with code's hook when only the hook fails", async () => {
    const written = await writePost(source, { complete: fake(json({ hook: "99 favorites, give or take." })) });
    const x = of(written, "x");
    expect(x).toMatchObject({ writtenBy: "ai", text: good.x, hook: HOOK, note: "Code's hook: the AI used a number not in the facts (99)" });
    expect(x.images[0]!.alt).toBe(HOOK);
    expect(of(written, "instagram").text.startsWith(`${HOOK}\n\n`)).toBe(true);
  });

  it("cuts the app's own words to fit when no version does", async () => {
    const written = await writePost({ ...source, template: () => [`17 of 24 came in. ${"And then some more words. ".repeat(20)}`] }, { complete: null });
    expect(fits("x", of(written, "x").text)).toBe(true);
    expect(of(written, "x").text.startsWith("17 of 24 came in.")).toBe(true);
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
 * AI writes only the hook and six candidate asides (the playbook's call),
 * each with the probability it says it would have written it. Every
 * candidate is checked; the least likely survivor is the aside, the least
 * likely that fits SHORT_ASIDE_MAX the short one; where none survives, the
 * source's fixed aside, with a note.
 */
describe("the writer, in aside mode", () => {
  // Over SHORT_ASIDE_MAX (70), so it's the full aside only; SHORT is the short one.
  const ASIDE = "The raccoon has been reading my almanacs again, slowly, and he moves his lips as he goes.";
  const SHORT = "My nest is mostly receipts.";
  const HOOK_AI = "I have seen yesterday. 17 of 24.";
  type Candidate = { readonly text: string; readonly probability: number } | string;
  const answer = (over: { readonly hook?: string; readonly asides?: readonly Candidate[] } = {}) =>
    JSON.stringify({
      hook: HOOK_AI,
      asides: [
        { text: ASIDE, probability: 0.1 },
        { text: SHORT, probability: 0.2 },
      ],
      ...over,
    });
  const write = (complete: Complete | null, s: PostSource = source, candidates?: number) => writePost(s, { complete, mode: "aside", candidates });
  const FIXED = { full: "The ladder is holding up better than the attic.", short: "I have alphabetized the pile by height." };

  it("keeps every fact the app's own, adding the hook and the aside where each platform takes one", async () => {
    const written = await write(fake(answer()));
    // X: code's words, the short aside, the link in the first comment.
    expect(of(written, "x")).toMatchObject({ text: `17 of 24 favorites came in.\n\n${SHORT}`, firstComment: `Every city: ${LINK}`, hook: HOOK_AI, writtenBy: "ai-aside", note: null });
    expect(of(written, "discord").text).toBe(`17 of 24 favorites came in.\n\n${ASIDE}\n\nEvery city: ${LINK}`);
    expect(of(written, "instagram").text).toBe(`${HOOK_AI}\n\n17 of 24 favorites came in.\n\n${ASIDE}\n\nLink in bio.`);
    // No joke under a Reddit data post.
    expect(of(written, "reddit").text).toBe(`Oct 26's results\n\n17 of 24 favorites came in.\n\nEvery city: ${LINK}`);
    // What a person can go back to: code's hook, no aside.
    expect(of(written, "instagram").templateText).toBe(`${HOOK}\n\n17 of 24 favorites came in.\n\nLink in bio.`);
  });

  it("asks once, for the hook and six asides each with its probability, in the playbook's words, with a tight bound", async () => {
    const model = fake(answer());
    await write(model);
    expect(model.calls).toHaveLength(1);
    const [ask] = model.calls;
    expect(ask!.system).toContain("You are Al, a smug old wizard.");
    expect(ask!.system).toContain("Give six different asides, each with the probability you would have written it, different from each other in length and in how they start.");
    expect(ask!.system).toContain('as a JSON object: "hook", and "asides", a list of objects with "text" and "probability".');
    expect(ask!.system).toContain("No numbers in it at all");
    expect(ask!.system).toContain("Make some of them 70 characters or fewer");
    expect(ask!.system).not.toMatch(/\bjokes?\b/i);
    expect(ask!.prompt).toContain("- The favorite came in for 17 of 24 cities.");
    expect(ask!.schema).toEqual({
      type: "object",
      properties: {
        hook: { type: "string" },
        asides: { type: "array", items: { type: "object", properties: { text: { type: "string" }, probability: { type: "number" } }, required: ["text", "probability"], additionalProperties: false } },
      },
      required: ["hook", "asides"],
      additionalProperties: false,
    });
    // About 250 for the six, plus the hook's: a few hundred output tokens a post.
    expect(ask!.maxTokens).toBe(asideTokens(ASIDE_CANDIDATES));
    expect(ask!.maxTokens).toBeGreaterThanOrEqual(250);
    expect(ask!.maxTokens).toBeLessThanOrEqual(320);
    expect(ASIDE_CANDIDATES).toBe(6);
  });

  it("asks for as many as the app wants: one keeps a single aside, the short one too where it fits", async () => {
    const model = fake(answer({ asides: [{ text: SHORT, probability: 0.4 }] }));
    const written = await write(model, source, 1);
    const [ask] = model.calls;
    expect(ask!.system).toContain("Give one aside, with the probability you would have written it.");
    expect(ask!.maxTokens).toBe(asideTokens(1));
    expect(ask!.maxTokens).toBeLessThan(asideTokens(6));
    expect(of(written, "x").text).toBe(`17 of 24 favorites came in.\n\n${SHORT}`);
    expect(of(written, "discord").text).toContain(SHORT);
    expect(candidatesRequest(3)).toBe("Give three different asides, each with the probability you would have written it, different from each other in length and in how they start.");
  });

  it("picks the least likely survivor for the full aside, and the least likely that fits for the short one", async () => {
    const written = await write(
      fake(
        answer({
          asides: [
            { text: "My tea has gone cold in a manner entirely consistent with tea, which I have noted in the ledger.", probability: 0.5 },
            { text: "I have filed Seventeen almanacs.", probability: 0.01 },
            { text: "The bucket under the leak has its own ledger, kept in my own hand, and nobody else may write in it.", probability: 0.2 },
            { text: `A ${"very ".repeat(30)}long aside.`, probability: 0.03 },
            { text: "The nest lost a twig. I reported it missing.", probability: 0.4 },
            { text: "Logged.", probability: 0.3 },
          ],
        }),
      ),
    );
    // The number one is likelier refused than kept; the overlong one too: the least likely of the rest, for the full aside.
    expect(of(written, "discord").text).toContain("The bucket under the leak has its own ledger, kept in my own hand, and nobody else may write in it.");
    // The least likely of those that fit in 70 characters, for the short one.
    expect(of(written, "x").text).toBe("17 of 24 favorites came in.\n\nLogged.");
    expect(of(written, "x").note).toBeNull();
  });

  it("picks by each candidate's stated probability, the earlier on a tie, and a missing one last", () => {
    const ok = () => null;
    expect(pickAsides([{ text: "Second.", probability: 0.2 }, { text: "First.", probability: 0.1 }], ok)).toMatchObject({ full: "First.", short: "First." });
    expect(pickAsides([{ text: "Earlier.", probability: 0.1 }, { text: "Later.", probability: 0.1 }], ok).full).toBe("Earlier.");
    expect(pickAsides([{ text: "Unstated.", probability: Number.POSITIVE_INFINITY }, { text: "Stated.", probability: 0.9 }], ok).full).toBe("Stated.");
    expect(pickAsides([], ok)).toEqual({ full: null, fullWhy: "the AI wrote none", short: null, shortWhy: "the AI wrote none" });
    const long = "x".repeat(SHORT_ASIDE_MAX + 1);
    expect(pickAsides([{ text: long, probability: 0.1 }], ok)).toEqual({ full: long, fullWhy: null, short: null, shortWhy: `it was too long for the short aside (${SHORT_ASIDE_MAX + 1} of ${SHORT_ASIDE_MAX})` });
  });

  it("reads a probability given as a string, and takes a bare string as a candidate picked last", async () => {
    const written = await write(fake(JSON.stringify({ hook: HOOK_AI, asides: ["My nest is mostly twigs.", { text: SHORT, probability: "0.3" }] })));
    expect(of(written, "x").text).toBe(`17 of 24 favorites came in.\n\n${SHORT}`);
  });

  it("refuses an aside with any number in it, a spelled one or a year too", async () => {
    const written = await write(fake(answer({ asides: [{ text: "I have owned this ladder since 1987.", probability: 0.1 }, { text: "Two raccoons live here.", probability: 0.2 }] })));
    const why = "none of the AI's 2 asides passed (it had a number (1987); it had a number (2))";
    expect(of(written, "x")).toMatchObject({ text: "17 of 24 favorites came in.", note: `No aside: ${why}` });
    expect(of(written, "discord").note).toBe(`No aside: ${why}`);
    // The hook still passed: the draft still has the AI's work in it.
    expect(of(written, "discord").writtenBy).toBe("ai-aside");
    // One candidate: its own reason, as it was.
    const one = await write(fake(answer({ asides: [{ text: "Two raccoons live here.", probability: 0.2 }] })), source, 1);
    expect(of(one, "x").note).toBe("No aside: it had a number (2)");
  });

  it("refuses an aside that names something the facts name: it's about the author's own world", async () => {
    const written = await write(fake(answer({ asides: [{ text: "The raccoon thinks Denver is a grocery store. I have stopped correcting him.", probability: 0.01 }, { text: SHORT, probability: 0.2 }] })));
    expect(of(written, "discord").text).toContain(SHORT);
    expect(of(written, "discord").text).not.toContain("grocery store");
    // A month is not a name from the facts: "Oct" is, "October" isn't.
    const fine = await write(fake(answer({ asides: [{ text: "My October almanacs are damp now. The raccoon swims.", probability: 0.1 }] })));
    expect(of(fine, "discord").text).toContain("The raccoon swims.");
  });

  it("gives a full platform the short aside when it's the only one that passed", async () => {
    const written = await write(fake(answer({ asides: [{ text: "Seventeen almanacs fell on me, and I have logged every one of them in the pile by height.", probability: 0.1 }, { text: SHORT, probability: 0.2 }] })));
    expect(of(written, "discord").text).toBe(`17 of 24 favorites came in.\n\n${SHORT}\n\nEvery city: ${LINK}`);
  });

  it("keeps code's hook when the AI's uses a number the facts don't have", async () => {
    const written = await write(fake(answer({ hook: "86 times in 141 results." })));
    expect(of(written, "x")).toMatchObject({ hook: HOOK, writtenBy: "ai-aside", note: "Code's hook: the AI used a number not in the facts (86, 141)" });
    expect(of(written, "x").images[0]!.alt).toBe(HOOK);
  });

  it("holds the hook and the asides to the post's own rule too, told which part it's reading", async () => {
    const parts: (string | undefined)[] = [];
    const oneCity = (text: string, part?: WordsPart) => {
      parts.push(part);
      return /\bcities\b/i.test(text) ? "it made one city into more than one" : null;
    };
    const written = await write(fake(answer({ hook: "Same sky, many cities.", asides: [{ text: "I counted the cities twice.", probability: 0.01 }, { text: SHORT, probability: 0.2 }] })), { ...source, check: oneCity });
    expect(of(written, "discord")).toMatchObject({ hook: HOOK, note: "Code's hook: it made one city into more than one" });
    expect(of(written, "discord").text).toContain(SHORT);
    expect(new Set(parts)).toEqual(new Set(["hook", "aside"]));
  });

  it("drops the aside before it cuts a fact", async () => {
    const facts = `17 of 24 came in. ${"And the facts go on. ".repeat(12)}`.trim();
    const written = await write(fake(answer()), { ...source, template: () => [facts] });
    expect(of(written, "x")).toMatchObject({ text: facts, note: "No aside: no room on X" });
  });

  it("uses the source's fixed asides when none of the AI's passes, and says so", async () => {
    const refused = answer({ asides: [{ text: "Seventeen almanacs.", probability: 0.1 }, { text: "Two raccoons.", probability: 0.2 }] });
    const written = await write(fake(refused), { ...source, fallbackAsides: FIXED });
    const why = "none of the AI's 2 asides passed (it had a number (17); it had a number (2))";
    expect(of(written, "discord")).toMatchObject({ text: `17 of 24 favorites came in.\n\n${FIXED.full}\n\nEvery city: ${LINK}`, hook: HOOK_AI, writtenBy: "ai-aside", note: `Fixed aside: ${why}` });
    expect(of(written, "x")).toMatchObject({ text: `17 of 24 favorites came in.\n\n${FIXED.short}`, note: `Fixed aside: ${why}` });
    // Nothing goes under a Reddit data post, fixed or not.
    expect(of(written, "reddit")).toMatchObject({ text: of(written, "reddit").templateText, note: null });
    // A fixed full aside missing: the short one goes everywhere.
    const shortOnly = await write(fake(refused), { ...source, fallbackAsides: { short: FIXED.short } });
    expect(of(shortOnly, "discord").text).toContain(FIXED.short);
  });

  it("uses the fixed short aside where the AI's that passed are all too long for it", async () => {
    const written = await write(fake(answer({ asides: [{ text: ASIDE, probability: 0.1 }] })), { ...source, fallbackAsides: FIXED });
    expect(of(written, "discord").text).toContain(ASIDE);
    expect(of(written, "x")).toMatchObject({ text: `17 of 24 favorites came in.\n\n${FIXED.short}`, writtenBy: "ai-aside", note: `Fixed aside: it was too long for the short aside (${[...ASIDE].length} of 70)` });
  });

  it("uses the fixed asides when the answer isn't the JSON asked for, the call fails, or there's no AI", async () => {
    const s = { ...source, fallbackAsides: FIXED };
    const nonsense = await write(fake("Here you go!"), s);
    expect(of(nonsense, "discord")).toMatchObject({ text: `17 of 24 favorites came in.\n\n${FIXED.full}\n\nEvery city: ${LINK}`, hook: HOOK, writtenBy: "template", note: "Code's hook, fixed aside: the AI's answer wasn't the JSON asked for" });
    expect(of(nonsense, "x").text).toBe(`17 of 24 favorites came in.\n\n${FIXED.short}`);
    const thrown = await write(
      fake(() => {
        throw new Error("the answer ran out of room");
      }),
      s,
    );
    expect(of(thrown, "discord").note).toBe("Code's hook, fixed aside: the AI call failed: the answer ran out of room");
    const none = await write(null, s);
    expect(none.filter((w) => w.platform !== "reddit").every((w) => w.writtenBy === "template" && w.note === "Code's hook, fixed aside: no AI is set up here")).toBe(true);
    // A post with no AI voice: the fixed aside, and no note (nothing failed).
    const voiceless = await write(fake(answer()), { ...s, voice: null });
    expect(of(voiceless, "discord")).toMatchObject({ text: `17 of 24 favorites came in.\n\n${FIXED.full}\n\nEvery city: ${LINK}`, writtenBy: "template", note: null });
  });

  it("asks for the hook alone when no candidates are wanted, and every aside is the fixed one, with no note", async () => {
    const asked: CompleteRequest[] = [];
    const complete: Complete = async (request) => {
      asked.push(request);
      return JSON.stringify({ hook: HOOK_AI });
    };
    const written = await write(complete, { ...source, fallbackAsides: FIXED }, 0);
    expect(asked[0]!.schema).toMatchObject({ required: ["hook"] });
    expect(asked[0]!.system).not.toMatch(/aside/i);
    expect(of(written, "discord")).toMatchObject({ text: `17 of 24 favorites came in.\n\n${FIXED.full}\n\nEvery city: ${LINK}`, hook: HOOK_AI, writtenBy: "ai-aside", note: null });
    expect(of(written, "x")).toMatchObject({ text: `17 of 24 favorites came in.\n\n${FIXED.short}`, note: null });
    // No fixed aside to give: no aside, and still nothing to note.
    const bare = await write(complete, source, 0);
    expect(of(bare, "discord")).toMatchObject({ text: `17 of 24 favorites came in.\n\nEvery city: ${LINK}`, hook: HOOK_AI, note: null });
  });

  it("gives the hook-only call room to answer: the hook's bare JSON ran out of room live (Oct 30, 2026)", async () => {
    const asked: CompleteRequest[] = [];
    const complete: Complete = async (request) => {
      asked.push(request);
      return JSON.stringify({ hook: HOOK_AI });
    };
    await write(complete, source, 0);
    // asideTokens(0) is the bare JSON, about 50: the live calls stopped at max_tokens there.
    expect(asideTokens(0)).toBeLessThan(100);
    expect(asked[0]!.maxTokens).toBe(HOOK_ONLY_TOKENS);
    expect(HOOK_ONLY_TOKENS).toBeGreaterThanOrEqual(150);
    // Still under what six candidates take, and an app's own bound still wins.
    expect(HOOK_ONLY_TOKENS).toBeLessThan(asideTokens(ASIDE_CANDIDATES));
    await writePost(source, { complete, mode: "aside", candidates: 0, maxTokens: 400 });
    expect(asked[1]!.maxTokens).toBe(400);
  });

  it("gives a caption-only platform (TikTok) the source's caption facts right after the hook, inside its limit", async () => {
    const captionFacts = "On Kalshi: Denver 56° to 57° at 49¢; Miami 84° to 85° at 38¢. Swipe for every city.";
    const banter = "Mercury: My heart is pure EVIL.\nAl: You knit.";
    const tiktok: PostSource = { ...source, platforms: ["tiktok", "instagram"], captionFacts, banter, speaker: "Al", fallbackAsides: FIXED };
    const hookOnly = fake(JSON.stringify({ hook: HOOK_AI }));
    const caption = of(await write(hookOnly, tiktok, 0), "tiktok");
    // The hook, the facts in a line, the scene (TikTok takes the short aside), the link in bio, the hashtags.
    expect(caption.text).toBe(`${HOOK_AI}\n\n${captionFacts}\n\nAl: ${FIXED.short}\n${banter}\n\nLink in bio.`);
    expect(fits("tiktok", caption.text)).toBe(true);
    // Code's own draft has them too; a platform with a body keeps its template, not the caption line.
    expect(caption.templateText).toBe(`${HOOK}\n\n${captionFacts}\n\n${banter}\n\nLink in bio.`);
    expect(of(await write(hookOnly, tiktok, 0), "instagram").text).not.toContain(captionFacts);
    // No caption facts: the caption is the hook, the scene and the rest, as before.
    const bare = of(await write(hookOnly, { ...tiktok, captionFacts: null }, 0), "tiktok");
    expect(bare.text).toBe(`${HOOK_AI}\n\nAl: ${FIXED.short}\n${banter}\n\nLink in bio.`);
  });

  it("falls back to code's hook and no aside when the call fails and there's no fixed aside, with the reason", async () => {
    const thrown = await write(
      fake(() => {
        throw new Error("overloaded");
      }),
    );
    expect(thrown.every((w) => w.writtenBy === "template" && w.hook === HOOK && w.text === w.templateText && w.note === "Code's hook, no aside: the AI call failed: overloaded")).toBe(true);
    const nonsense = await write(fake("Here you go!"));
    expect(nonsense[0]!.note).toBe("Code's hook, no aside: the AI's answer wasn't the JSON asked for");
    // JSON, but no list of asides in it: the AI wrote none.
    const empty = await write(fake(JSON.stringify({ hook: HOOK_AI, aside: ASIDE })));
    expect(of(empty, "discord")).toMatchObject({ hook: HOOK_AI, note: "No aside: the AI wrote none" });
  });
});

/**
 * THE BANTER: fixed lines from the app's other characters, a line each under
 * the aside (signed with the speaker's name, where there is one), wherever a
 * platform takes an aside; dropped before the aside is, and both before any
 * fact.
 */
describe("the writer, with a post's banter", () => {
  const BANTER = "Granny Gale: Al hasn't left that nest since the Eisenhower administration, dearie.\nAl: Correct.";
  const ASIDE = "The raccoon has been reading my almanacs again, slowly, and he moves his lips as he goes.";
  const SHORT = "My nest is mostly receipts.";
  const answer = JSON.stringify({ hook: "I have seen yesterday. 17 of 24.", asides: [{ text: ASIDE, probability: 0.1 }, { text: SHORT, probability: 0.2 }] });
  const refusedAnswer = JSON.stringify({ hook: "I have seen yesterday. 17 of 24.", asides: [{ text: "Seventeen almanacs.", probability: 0.1 }, { text: "Two raccoons.", probability: 0.2 }] });
  const banterSource: PostSource = { ...source, banter: BANTER };

  it("puts it after the aside and before the link, in the template too", async () => {
    const written = await writePost(banterSource, { complete: fake(answer), mode: "aside" });
    // The aside and the banter are one block, a line each: the scene.
    expect(of(written, "discord").text).toBe(`17 of 24 favorites came in.\n\n${ASIDE}\n${BANTER}\n\nEvery city: ${LINK}`);
    expect(of(written, "instagram").text).toBe(`I have seen yesterday. 17 of 24.\n\n17 of 24 favorites came in.\n\n${ASIDE}\n${BANTER}\n\nLink in bio.`);
    // What a person goes back to: code's hook, no aside, the banter (it's code's own words).
    expect(of(written, "discord").templateText).toBe(`17 of 24 favorites came in.\n\n${BANTER}\n\nEvery city: ${LINK}`);
    // Never under a Reddit data post.
    expect(of(written, "reddit").text).not.toContain(BANTER);
  });

  it("drops the banter first, then the aside, and both before a fact", async () => {
    // X: the short aside fits beside the facts, the banter doesn't.
    const written = await writePost(banterSource, { complete: fake(answer), mode: "aside" });
    expect(of(written, "x")).toMatchObject({ text: `17 of 24 favorites came in.\n\n${SHORT}\n${BANTER}` });
    const long = `17 of 24 came in. ${"And the facts go on. ".repeat(9)}`.trim();
    const tight = await writePost({ ...banterSource, template: () => [long] }, { complete: fake(answer), mode: "aside" });
    expect(of(tight, "x").text.startsWith(long)).toBe(true);
    expect(of(tight, "x").text).not.toContain(BANTER);
    expect(of(tight, "x").note).toMatch(/no room on X/);
    const facts = `17 of 24 came in. ${"And the facts go on. ".repeat(12)}`.trim();
    const none = await writePost({ ...banterSource, template: () => [facts] }, { complete: fake(answer), mode: "aside" });
    expect(of(none, "x")).toMatchObject({ text: facts, note: "No aside or banter: no room on X" });
  });

  it("keeps the banter where the aside failed its checks, and on a post the AI doesn't write", async () => {
    const refused = await writePost(banterSource, { complete: fake(refusedAnswer), mode: "aside" });
    expect(of(refused, "discord").text).toBe(`17 of 24 favorites came in.\n\n${BANTER}\n\nEvery city: ${LINK}`);
    const fixed = await writePost({ ...banterSource, voice: null }, { complete: fake(answer), mode: "aside" });
    expect(of(fixed, "discord")).toMatchObject({ writtenBy: "template", note: null, text: `17 of 24 favorites came in.\n\n${BANTER}\n\nEvery city: ${LINK}` });
  });

  it("signs the aside with the speaker's name, so the aside and the banter read as a scene", async () => {
    const written = await writePost({ ...banterSource, speaker: "Al" }, { complete: fake(answer), mode: "aside" });
    expect(of(written, "discord").text).toBe(`17 of 24 favorites came in.\n\nAl: ${ASIDE}\n${BANTER}\n\nEvery city: ${LINK}`);
    // The line on the image stays the hook alone, unsigned.
    expect(of(written, "discord").hook).toBe("I have seen yesterday. 17 of 24.");
    // With no aside, the banter stands alone.
    const refused = await writePost({ ...banterSource, speaker: "Al" }, { complete: fake(refusedAnswer), mode: "aside" });
    expect(of(refused, "discord").text).toBe(`17 of 24 favorites came in.\n\n${BANTER}\n\nEvery city: ${LINK}`);
    // A fixed aside is signed the same way.
    const fixed = await writePost({ ...banterSource, speaker: "Al", fallbackAsides: { full: "The bucket under the leak has its own ledger." } }, { complete: fake(refusedAnswer), mode: "aside" });
    expect(of(fixed, "discord").text).toBe(`17 of 24 favorites came in.\n\nAl: The bucket under the leak has its own ledger.\n${BANTER}\n\nEvery city: ${LINK}`);
  });

  it("adds it after the AI's own words in words mode, where it fits, never cutting them", async () => {
    const written = await writePost(banterSource, { complete: fake(json()) });
    expect(of(written, "discord").text).toBe(`${good.discord}\n\n${BANTER}\n\nEvery city: ${LINK}`);
    // X: room for it beside these words too; its link stays in the first comment.
    expect(of(written, "x").text).toBe(`${good.x}

${BANTER}`);
  });
});

/**
 * A FIXED ASIDE IN PARTS (FixedAside): labelled lines that go out together,
 * each signed with the speaker and its label, the banter under them; one unit
 * that's dropped whole, before any fact, and never split.
 */
describe("the writer, with a fixed aside in parts", () => {
  const BANTER = "Granny Gale: Al hasn't left that nest since the Eisenhower administration, dearie.\nAl: Correct.";
  const parts = (outLoud: string, inside: string): readonly AsidePart[] => [
    { label: "out loud", text: outLoud },
    { label: "inside", text: inside },
  ];
  const FULL = parts("I do not care for soup.", "Another bowl. Do not let her see.");
  const SHORT = parts("Nothing impresses me.", "I saw a rainbow and wrote down wow.");
  const FULL_SAID = "Al, out loud: I do not care for soup.\nAl, inside: Another bowl. Do not let her see.";
  const SHORT_SAID = "Al, out loud: Nothing impresses me.\nAl, inside: I saw a rainbow and wrote down wow.";
  const HOOK_AI = "I have seen yesterday. 17 of 24.";
  const refusedAnswer = JSON.stringify({ hook: HOOK_AI, asides: [{ text: "Seventeen almanacs.", probability: 0.1 }] });
  /** The hook alone from the AI, as Almanac asks: the fixed aside by design, with no note. */
  const hookOnly = () => ({ complete: fake(JSON.stringify({ hook: HOOK_AI })), mode: "aside", candidates: 0 }) as const;
  const paired: PostSource = { ...source, speaker: "Al", banter: BANTER, fallbackAsides: { full: FULL, short: SHORT } };

  it("signs each part with the speaker and its label, a line each, the banter underneath", async () => {
    const written = await writePost(paired, { complete: null, mode: "aside" });
    expect(of(written, "discord").text).toBe(`17 of 24 favorites came in.\n\n${FULL_SAID}\n${BANTER}\n\nEvery city: ${LINK}`);
    expect(of(written, "discord").note).toBe("Code's hook, fixed aside: no AI is set up here");
    const quiet = await writePost(paired, hookOnly());
    expect(of(quiet, "instagram").text).toBe(`${HOOK_AI}\n\n17 of 24 favorites came in.\n\n${FULL_SAID}\n${BANTER}\n\nLink in bio.`);
    expect(of(quiet, "instagram").note).toBeNull();
    // Where the AI's aside failed, the pair goes in and the note says why.
    const refused = await writePost(paired, { complete: fake(refusedAnswer), mode: "aside" });
    expect(of(refused, "discord").text).toContain(FULL_SAID);
    expect(of(refused, "discord").note).toMatch(/^Fixed aside: it had a number/);
  });

  it("puts the short pair on a platform with little room", async () => {
    const written = await writePost(paired, hookOnly());
    expect(of(written, "x")).toMatchObject({ text: `17 of 24 favorites came in.\n\n${SHORT_SAID}\n${BANTER}`, note: null });
    expect(of(written, "bluesky").text).toContain(SHORT_SAID);
  });

  it("labels the parts alone where there's no speaker", async () => {
    const written = await writePost({ ...paired, speaker: null, banter: null }, hookOnly());
    expect(of(written, "discord").text).toBe(`17 of 24 favorites came in.\n\nOut loud: I do not care for soup.\nInside: Another bowl. Do not let her see.\n\nEvery city: ${LINK}`);
  });

  it("drops the banter, then the whole pair, before a fact, and never splits the pair", async () => {
    const long = `17 of 24 came in. ${"And the facts go on. ".repeat(9)}`.trim();
    const tight = of(await writePost({ ...paired, template: () => [long] }, hookOnly()), "x");
    expect(tight.text.startsWith(long)).toBe(true);
    expect(tight.text).not.toContain(BANTER);
    // Both parts or neither, never one.
    expect(tight.text.includes("Al, out loud:")).toBe(tight.text.includes("Al, inside:"));
    const facts = `17 of 24 came in. ${"And the facts go on. ".repeat(12)}`.trim();
    const none = of(await writePost({ ...paired, template: () => [facts] }, hookOnly()), "x");
    expect(none).toMatchObject({ text: facts, note: "No aside or banter: no room on X" });
  });

  it("drops a pair with a part that has no words, and trims the rest", async () => {
    expect(fixedAside(parts("  I fear nothing. ", " Stay close. "))).toEqual(parts("I fear nothing.", "Stay close."));
    expect(fixedAside(parts("I fear nothing.", "   "))).toBeNull();
    expect(fixedAside([])).toBeNull();
    expect(fixedAside("  A line.  ")).toBe("A line.");
    expect(fixedAside(null)).toBeNull();
    // A full pair with an empty half gives way to the short one.
    const halfFull = await writePost({ ...paired, fallbackAsides: { full: parts("I do not care for soup.", " "), short: SHORT } }, hookOnly());
    expect(of(halfFull, "discord").text).toContain(SHORT_SAID);
    expect(of(halfFull, "discord").text).not.toContain("soup");
  });

  it("gives way to the short pair where the full one leaves no room for the banter, before the banter goes", async () => {
    // Threads (500): room for the facts, the short pair and the banter, not the full pair and the banter.
    const LONG = parts("I keep the record in this attic, and nothing that happens here goes unwritten.", "I have also written down that Granny's soup is the best thing that ever happened here.");
    const facts = `17 of 24 came in. ${"And the facts go on. ".repeat(11)}`.trim();
    const threads = of(await writePost({ ...paired, platforms: ["threads"], template: () => [facts], fallbackAsides: { full: LONG, short: SHORT } }, hookOnly()), "threads");
    expect(threads).toMatchObject({ text: `${facts}\n\n${SHORT_SAID}\n${BANTER}\n\nEvery city: ${LINK}`, note: null });
    // With room for it, the full pair goes in.
    const roomy = of(await writePost({ ...paired, platforms: ["threads"], fallbackAsides: { full: LONG, short: SHORT } }, hookOnly()), "threads");
    expect(roomy.text).toContain("Al, out loud: I keep the record in this attic");
    expect(roomy.text).not.toContain(SHORT_SAID);
  });
});
