import { inventedNumbers, numbersIn } from "./guard.js";
import { ASIDE_MAX, cutToFit, fits, HOOK_MAX, measure, PLATFORMS, SHORT_ASIDE_MAX, textLength } from "./platforms.js";
import type { DraftImage, Platform, PostSource } from "./types.js";

/**
 * THE AI WRITER: one model call per post, its answer back as one JSON
 * object, every part of it checked before it's kept. Code puts each
 * platform's draft together in that platform's format (the hook first, the
 * link in the text, the first comment or "Link in bio.", the hashtags, the
 * images: ./platforms.ts). Two modes:
 *
 *   "words"  the AI writes the hook and each platform's words around the
 *            facts. Any platform whose words fail a check gets the app's
 *            own words instead.
 *   "aside"  the AI writes only the hook and one short aside in the
 *            author's voice (and a shorter one where room is tight), with
 *            no numbers at all. Every fact and every platform's body stay
 *            the app's own; the aside goes in after the facts, and is the
 *            first thing dropped when a platform runs out of room.
 *
 * The checks: words at all; no link, hashtag or @-mention (code adds those,
 * so a model can't invent one); the numbers (a hook's and a platform's words
 * may only use the facts' numbers, ./guard.ts; an aside may use
 * none); the app's honesty rule and the post's own rule, both injected; and,
 * put together, the platform's length. Overlong words are refused, not cut:
 * a cut sentence can say something the whole one didn't. Whenever the call
 * fails, the answer isn't the JSON asked for, or there's no AI at all, every
 * platform gets the app's own words, with the reason.
 */

export interface CompleteRequest {
  readonly system: string;
  readonly prompt: string;
  /** The most the model may answer with: the bound on what one post can cost. */
  readonly maxTokens: number;
  /** The JSON shape asked for, for a provider that can hold a model to one. The answer is checked either way. */
  readonly schema: Readonly<Record<string, unknown>>;
}

/** One model call, made and metered by the app. Resolves to the model's text; throws when the call fails. */
export type Complete = (request: CompleteRequest) => Promise<string>;

/** Why a text can't go out under the app's rules (banned words, no promises), or null when it can. */
export type HonestyCheck = (text: string) => string | null;

export interface WriterOptions {
  /** Null where the app has no AI set up: every post goes out in the app's own words. */
  readonly complete: Complete | null;
  readonly honesty?: HonestyCheck;
  /** What the AI writes: each platform's words ("words", the default), or only the hook and an aside ("aside"). */
  readonly mode?: "words" | "aside";
  /** Overrides the answer's bound, which is otherwise worked out from what's asked for. */
  readonly maxTokens?: number;
}

/** One platform's draft, as the queue keeps it. */
export interface WrittenPost {
  readonly platform: Platform;
  /** What gets posted, in the platform's format. */
  readonly text: string;
  /** The app's own draft for this platform, with its own hook and no aside: what a person can go back to. */
  readonly templateText: string;
  /** The line on the image (and the text's first line where the platform opens with it). */
  readonly hook: string;
  /** What to post as the first reply: the link, where the platform wants it there (X, LinkedIn). */
  readonly firstComment: string | null;
  readonly images: readonly DraftImage[];
  readonly writtenBy: "ai" | "ai-aside" | "template";
  /** What came from code instead of the AI, and why (null when nothing did, or the post has no AI by design). */
  readonly note: string | null;
}

/** "Every city: https://…", or the address alone. */
export function linkLine(url: string, label: string | null): string {
  return label ? `${label}: ${url}` : url;
}

/** What code puts around a platform's words. */
export interface Around {
  readonly hook: string;
  readonly linkUrl: string | null;
  readonly linkLabel: string | null;
  readonly hashtags: readonly string[];
}

/**
 * A platform's whole text: the hook first where it opens with one, the
 * words, the aside, the link where it goes in the text ("Link in bio."
 * where links don't work), the hashtags last where it takes them.
 */
export function composeText(platform: Platform, words: string, around: Around, aside: string | null = null): string {
  const rule = PLATFORMS[platform];
  const parts = [rule.hookFirst ? around.hook : "", words.trim(), aside ?? ""];
  if (around.linkUrl && rule.linkIn === "text") parts.push(linkLine(around.linkUrl, around.linkLabel));
  if (around.linkUrl && rule.linkIn === "bio") parts.push("Link in bio.");
  if (rule.hashtags) parts.push(around.hashtags.join(" "));
  return parts.filter((p) => p.trim()).join("\n\n");
}

/** The first comment: the link, on the platforms that put it there. */
export function firstCommentFor(platform: Platform, linkUrl: string | null, linkLabel: string | null): string | null {
  return linkUrl && PLATFORMS[platform].linkIn === "comment" ? linkLine(linkUrl, linkLabel) : null;
}

const aroundOf = (source: PostSource, hook: string): Around => ({ hook, linkUrl: source.linkUrl, linkLabel: source.linkLabel, hashtags: source.hashtags });

/**
 * The app's words for a platform, put together: the first version that fits,
 * with the aside when that fits too (the aside goes before a fact does),
 * else the last version cut to fit.
 */
function assemble(source: PostSource, platform: Platform, hook: string, aside: string | null): { readonly text: string; readonly withAside: boolean } {
  const around = aroundOf(source, hook);
  // A caption-only platform (TikTok) shows the facts on its slides: the caption is the hook and the aside.
  const versions = PLATFORMS[platform].captionOnly ? [""] : source.template(platform);
  for (const words of versions) {
    if (aside) {
      const text = composeText(platform, words, around, aside);
      if (fits(platform, text)) return { text, withAside: true };
    }
    const text = composeText(platform, words, around);
    if (fits(platform, text)) return { text, withAside: false };
  }
  const last = versions.at(-1) ?? source.facts.title;
  const cut = cutToFit(last, (w) => fits(platform, composeText(platform, w, around))) || last;
  return { text: composeText(platform, cut, around), withAside: false };
}

/** How many characters the AI may write for a platform ("words" mode): its target, less what code adds around the words (with the longest hook). */
function budget(source: PostSource, platform: Platform): number {
  const rule = PLATFORMS[platform];
  const added = textLength(platform, composeText(platform, "w", aroundOf(source, "h".repeat(HOOK_MAX)))) - 1;
  return Math.max(40, Math.min(rule.target, rule.max - added - 2));
}

/**
 * The honesty every post's words keep, whatever the business: the AI may not
 * promise, predict or claim more than the facts say. A business's own rules
 * (and the generic word list, ./honesty.ts) are checked on top, in code.
 */
const NO_PROMISES = "Never promise anything, never say what will happen, and never claim more than the facts say: no superlatives, no hype, no pressure to buy.";
const USE_THE_FACTS = "Write every number in digits, exactly as the facts write it. Never calculate, round, convert, compare or add up a number, and never use a number the facts don't have.";

const WORDS_RULES = [
  'Write a hook and one post for each platform listed, from the facts given. Answer with only a JSON object: "hook", then one string per platform.',
  `Use only the facts. ${USE_THE_FACTS}`,
  NO_PROMISES,
  "No links, web addresses, hashtags or @-mentions: code adds the link and the hashtags where each platform wants them.",
  "Keep each post under its length.",
].join("\n");

// Live samples (the post builder's first run, Oct 27, 2026): every hook came back 113 to 161 characters
// long against "at most 90", so the hook gets a word count and code's own hook to measure against; told
// only "no longer", the model copied code's hook word for word; and an aside slipped in a year.
const ASIDE_RULES = [
  'Code writes the post itself, every fact in it. You write three short lines for it, as a JSON object: "hook", "aside" and "shortAside".',
  `"hook": the line on the post's image, in your voice: the fact code's hook says, said your way, not copied. One short sentence of about ${Math.round(HOOK_MAX / 8)} words, never more than ${HOOK_MAX} characters. ${USE_THE_FACTS}`,
  `"aside": one line in your voice, at most ${ASIDE_MAX} characters, about you and your own world: never about the facts, a price, a place or what could happen, and naming nothing the facts name. No numbers in it at all: not as digits, not as words, not a year. An aside with a number or a name from the facts is thrown away.`,
  `"shortAside": another line like it, at most ${SHORT_ASIDE_MAX} characters, for the platforms with little room.`,
  `${NO_PROMISES} Never ask what will happen. No links, hashtags or @-mentions.`,
].join("\n");

const factsLines = (source: PostSource) => [`Post: ${source.facts.title}`, "Facts:", ...source.facts.lines.map((l) => `- ${l}`)];

/** "aside" mode: the facts, and code's own hook to write a hook against. */
const asidePrompt = (source: PostSource) => [...factsLines(source), `Code's hook (the fact yours says, and as long as yours may be): ${source.hook}`].join("\n");

function wordsPrompt(source: PostSource): string {
  const lengths = source.platforms.map((p) => {
    const rule = PLATFORMS[p];
    const most = rule.titleTarget !== undefined ? `a title line of at most ${rule.titleTarget} characters, a blank line, then the body, at most ${budget(source, p)} characters` : `at most ${budget(source, p)} characters`;
    return `- ${p}: ${most}. ${rule.style}`;
  });
  const opening = source.platforms.filter((p) => PLATFORMS[p].hookFirst);
  return [
    ...factsLines(source),
    `Hook: one line of at most ${HOOK_MAX} characters, the line on the post's image.`,
    "Platforms, the most characters for your words on each, and how to write them:",
    ...lengths,
    ...(opening.length ? [`Code opens the ${opening.join(", ")} posts with the hook: don't repeat it there.`] : []),
  ].join("\n");
}

function schema(keys: readonly string[]): Record<string, unknown> {
  return { type: "object", properties: Object.fromEntries(keys.map((k) => [k, { type: "string" }])), required: [...keys], additionalProperties: false };
}

/** The model's answer as one string per key, or null when it isn't the JSON object asked for. */
function parse(raw: string, keys: readonly string[]): Partial<Record<string, string>> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Partial<Record<string, string>> = {};
  for (const k of keys) {
    const v = (value as Record<string, unknown>)[k];
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

const A_LINK = /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|io|app|co|ai|dev|shop|store|biz|us|uk|ca)\b/i;

/** What's wrong with some of the AI's words, whatever they're for, or null. `numbers`: the facts' only, or none at all. */
function wordsProblem(source: PostSource, words: string, honesty: HonestyCheck | undefined, numbers: "facts" | "none"): string | null {
  if (A_LINK.test(words)) return "the AI wrote a link";
  if (/(^|\s)#\w/.test(words)) return "the AI wrote a hashtag";
  if (/@(?:everyone|here)\b/i.test(words)) return "the AI wrote an @-mention";
  if (numbers === "none") {
    const found = [...new Set(numbersIn(words))];
    if (found.length) return `it had a number (${found.join(", ")})`;
  } else {
    const invented = inventedNumbers(words, source.facts);
    if (invented.length) return `the AI used a number not in the facts (${invented.join(", ")})`;
  }
  return honesty?.(words) ?? source.check?.(words) ?? null;
}

function hookProblem(source: PostSource, hook: string | undefined, honesty: HonestyCheck | undefined): string | null {
  const h = hook?.trim() ?? "";
  if (!h) return "the AI wrote no hook";
  if (h.includes("\n")) return "the AI's hook was more than one line";
  if ([...h].length > HOOK_MAX) return `the AI's hook was too long (${[...h].length} of ${HOOK_MAX})`;
  return wordsProblem(source, h, honesty, "facts");
}

/**
 * The names the facts use (products, places, people): every capitalized word
 * after a sentence's first, "Denver", "Saturday", "Maple". An aside is about
 * its author's own world, so it names none of them (a live sample from the
 * first run named the facts' subject in a joke about it).
 */
function namesIn(source: PostSource): Set<string> {
  const names = new Set<string>();
  for (const sentence of [source.facts.title, ...source.facts.lines].join(". ").split(/(?<=[.!?])\s+/)) {
    for (const word of sentence.split(/\s+/).slice(1)) {
      const bare = word.replace(/^[^\p{L}]+|(?:'s)?[^\p{L}]*$/gu, "");
      if (/^\p{Lu}/u.test(bare)) names.add(bare);
    }
  }
  return names;
}

function asideProblem(source: PostSource, aside: string | undefined, max: number, honesty: HonestyCheck | undefined): string | null {
  const a = aside?.trim() ?? "";
  if (!a) return "the AI wrote none";
  if (a.includes("\n")) return "it was more than one line";
  if ([...a].length > max) return `it was too long (${[...a].length} of ${max})`;
  const named = [...namesIn(source)].filter((name) => new RegExp(`(^|[^\\p{L}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}])`, "u").test(a));
  if (named.length) return `it named something from the facts (${named.join(", ")})`;
  return wordsProblem(source, a, honesty, "none");
}

function platformProblem(source: PostSource, platform: Platform, words: string | undefined, around: Around, honesty: HonestyCheck | undefined): string | null {
  const w = words?.trim() ?? "";
  if (!w) return "the AI wrote nothing for it";
  const wrong = wordsProblem(source, w, honesty, "facts");
  if (wrong) return wrong;
  const m = measure(platform, composeText(platform, w, around));
  if (!m.fits) return m.title && m.title.length > m.title.max ? `the AI's title was too long (${m.title.length} of ${m.title.max})` : `too long for ${PLATFORMS[platform].name} (${m.length} of ${m.max})`;
  return null;
}

type Draft = (platform: Platform, text: string, hook: string, writtenBy: WrittenPost["writtenBy"], note: string | null) => WrittenPost;
const joinNotes = (...notes: readonly (string | null)[]) => notes.filter(Boolean).join("; ") || null;
const failure = (error: unknown) => `the AI call failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`;

/**
 * Every platform's draft for one post. Never throws: a failure anywhere is
 * a platform (or every platform) in the app's own words, with the reason.
 */
export async function writePost(source: PostSource, options: WriterOptions): Promise<WrittenPost[]> {
  const templates = new Map(source.platforms.map((p) => [p, assemble(source, p, source.hook, null).text]));
  const draft: Draft = (p, text, hook, writtenBy, note) => ({
    platform: p,
    text,
    templateText: templates.get(p)!,
    hook,
    firstComment: firstCommentFor(p, source.linkUrl, source.linkLabel),
    images: source.images(p, hook),
    writtenBy,
    note,
  });
  const asides = options.mode === "aside";
  const plain = (why: string | null) => source.platforms.map((p) => draft(p, templates.get(p)!, source.hook, "template", why && (asides ? `Code's hook, no aside: ${why}` : `Code's words: ${why}`)));
  // A post with no AI voice is the app's words by design: nothing failed, so no note.
  if (source.voice === null) return plain(null);
  if (!options.complete) return plain("no AI is set up here");
  return asides ? writeAside(source, options, options.complete, draft, plain) : writeWords(source, options, options.complete, draft, templates, plain);
}

/** "words" mode: the hook and every platform's words from the AI. */
async function writeWords(source: PostSource, options: WriterOptions, complete: Complete, draft: Draft, templates: ReadonlyMap<Platform, string>, plain: (why: string) => WrittenPost[]): Promise<WrittenPost[]> {
  const platforms = source.platforms;
  const keys = ["hook", ...platforms];
  const maxTokens = options.maxTokens ?? Math.min(4000, 200 + Math.ceil((HOOK_MAX + platforms.reduce((sum, p) => sum + budget(source, p) + (PLATFORMS[p].titleTarget ?? 0), 0)) / 3));
  let raw: string;
  try {
    raw = await complete({ system: `${source.voice}\n\n${WORDS_RULES}`, prompt: wordsPrompt(source), maxTokens, schema: schema(keys) });
  } catch (error) {
    return plain(failure(error));
  }
  const answer = parse(raw, keys);
  if (!answer) return plain("the AI's answer wasn't the JSON asked for");
  const hookWhy = hookProblem(source, answer.hook, options.honesty);
  const hook = hookWhy ? source.hook : answer.hook!.trim();
  const hookNote = hookWhy ? `Code's hook: ${hookWhy}` : null;
  const around = aroundOf(source, hook);
  return platforms.map((p) => {
    const why = platformProblem(source, p, answer[p], around, options.honesty);
    if (why) return draft(p, templates.get(p)!, source.hook, "template", joinNotes(`Code's words: ${why}`, hookNote));
    return draft(p, composeText(p, answer[p]!.trim(), around), hook, "ai", hookNote);
  });
}

/** "aside" mode: the hook and the asides from the AI, every fact and every body from the app. */
async function writeAside(source: PostSource, options: WriterOptions, complete: Complete, draft: Draft, plain: (why: string) => WrittenPost[]): Promise<WrittenPost[]> {
  const keys = ["hook", "aside", "shortAside"];
  const maxTokens = options.maxTokens ?? 200 + Math.ceil((HOOK_MAX + ASIDE_MAX + SHORT_ASIDE_MAX) / 2);
  let raw: string;
  try {
    raw = await complete({ system: `${source.voice}\n\n${ASIDE_RULES}`, prompt: asidePrompt(source), maxTokens, schema: schema(keys) });
  } catch (error) {
    return plain(failure(error));
  }
  const answer = parse(raw, keys);
  if (!answer) return plain("the AI's answer wasn't the JSON asked for");
  const hookWhy = hookProblem(source, answer.hook, options.honesty);
  const hook = hookWhy ? source.hook : answer.hook!.trim();
  const fullWhy = asideProblem(source, answer.aside, ASIDE_MAX, options.honesty);
  const shortWhy = asideProblem(source, answer.shortAside, SHORT_ASIDE_MAX, options.honesty);
  const full = fullWhy ? null : answer.aside!.trim();
  const short = shortWhy ? null : answer.shortAside!.trim();
  return source.platforms.map((p) => {
    const want = PLATFORMS[p].aside;
    // A full aside that failed gives way to the short one: it fits wherever a full one would.
    const aside = want === "none" ? null : want === "short" ? short : (full ?? short);
    const { text, withAside } = assemble(source, p, hook, aside);
    const asideNote = want === "none" ? null : !aside ? `No aside: ${want === "short" ? shortWhy : fullWhy}` : withAside ? null : `No aside: no room on ${PLATFORMS[p].name}`;
    // The AI's work is in this draft when its hook is (on the image, and first where the platform opens with it) or its aside is.
    return draft(p, text, hook, hookWhy && !withAside ? "template" : "ai-aside", joinNotes(hookWhy && `Code's hook: ${hookWhy}`, asideNote));
  });
}
