import { inventedNumbers, numbersIn } from "./guard.js";
import { postLinkTags, taggedLink } from "./links.js";
import { ASIDE_MAX, cutToFit, fits, HOOK_MAX, measure, PLATFORMS, SHORT_ASIDE_MAX, textLength } from "./platforms.js";
import type { DraftImage, FixedAside, Platform, PostSource, WordsPart } from "./types.js";

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
 *   "aside"  the AI writes only the hook and a few candidate asides in
 *            the author's voice (six by default, each with the probability
 *            it says it would have written it), with no numbers at all.
 *            Every candidate is checked; of those that pass, the least
 *            likely is the aside, and the least likely that fits a tight
 *            platform is its short one (the playbook's call: a model's
 *            likeliest line is its stalest). Where none passes, or there's
 *            no AI, the source's own fixed aside goes in instead, and the
 *            note says so. Every fact and every platform's body stay the
 *            app's own; the aside goes in after the facts, and is the first
 *            thing dropped when a platform runs out of room.
 *
 * A post's banter (another character's fixed lines, the app's own words)
 * goes after the aside, in either mode, wherever the platform takes an
 * aside; it's dropped before the aside is, and both before any fact. With a
 * speaker, the aside is signed with their name and the banter follows it
 * line by line, so the end of a post reads as a little scene:
 *
 *   Doldrum: My tea has gone cold. It does that.
 *   Mercury: Behold the wizard, who has not left that nest since the thermometer was invented.
 *   Doldrum: Correct.
 *
 * A fixed aside can come in labelled parts that go out together, each signed
 * with the speaker and its label (FixedAside), and the banter follows them:
 *
 *   Mercury, out loud: I am a creature of the night.
 *   Mercury, inside: Find the hall light. You are the terror of this house.
 *   Granny Gale: Mercury takes his blankie everywhere, even up to the attic.
 *   Mercury: It is my cape.
 *
 * The checks: words at all; no link, hashtag or @-mention (code adds those,
 * so a model can't invent one); the numbers (a hook's and a platform's words
 * may only use the facts' numbers, ./guard.ts; an aside may use
 * none); the app's honesty rule and the post's own rule, both injected; and,
 * put together, the platform's length (with the link as that platform
 * carries it: tagged, where the app asks for tags, ./links.ts).
 * Overlong words are refused, not cut:
 * a cut sentence can say something the whole one didn't. Whenever the call
 * fails, the answer isn't the JSON asked for, or there's no AI at all, every
 * platform gets the app's own words (in "aside" mode, with the source's fixed
 * aside where it has one), with the reason.
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

/**
 * Why a text can't go out under the app's rules (banned words, no promises),
 * or null when it can. Told which part of the AI's words it's reading, for a
 * rule that differs by part (./smell.ts reads an aside in full).
 */
export type HonestyCheck = (text: string, part?: WordsPart) => string | null;

export interface WriterOptions {
  /** Null where the app has no AI set up: every post goes out in the app's own words. */
  readonly complete: Complete | null;
  readonly honesty?: HonestyCheck;
  /** What the AI writes: each platform's words ("words", the default), or only the hook and an aside ("aside"). */
  readonly mode?: "words" | "aside";
  /** Overrides the answer's bound, which is otherwise worked out from what's asked for. */
  readonly maxTokens?: number;
  /**
   * "aside" mode: how many candidate asides to ask for in the one call
   * (ASIDE_CANDIDATES, six, when absent). One keeps a single aside, which is
   * the short one too where it fits. Zero asks the AI for the hook alone:
   * every aside is the source's own fixed one (for an app whose people write
   * better asides than its model).
   */
  readonly candidates?: number;
  /**
   * Tag each draft's link for the app's own visit numbers (./links.ts):
   * utm_source the platform, utm_medium "social", utm_campaign the post's kind,
   * utm_content its key. On the link wherever the platform shows it (the first
   * comment, or the text), never on an image; every length is checked with the
   * tagged link in place. Off when absent: the link goes out as the source gave it.
   */
  readonly tagLinks?: boolean;
}

/** One draft's link as its platform carries it (tagged or as given), or null for none. */
type LinkOf = (platform: Platform) => string | null;

/** How many asides "aside" mode asks for by default (the playbook, section 6: six in one call). */
export const ASIDE_CANDIDATES = 6;

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
  /** This platform's link (tagged where the app asks): the one to attach as a link card where the platform takes one. */
  readonly linkUrl: string | null;
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
  /** Who the aside is signed with ("Doldrum"), or null for an unsigned aside. */
  readonly speaker: string | null;
}

/** "Out loud" from "out loud": a part's label where no speaker signs it. */
const capitalized = (label: string) => label.charAt(0).toUpperCase() + label.slice(1);

/**
 * The aside as it reads, signed where there's a speaker: "Doldrum: …", or a line
 * a part, "Mercury, out loud: …" then "Mercury, inside: …".
 */
function said(around: Around, aside: FixedAside): string {
  if (typeof aside === "string") return around.speaker ? `${around.speaker}: ${aside}` : aside;
  return aside.map(({ label, text }) => `${around.speaker ? `${around.speaker}, ${label}` : capitalized(label)}: ${text}`).join("\n");
}

/** The aside, signed where there's a speaker, and the banter under it: one block, a line each. */
function scene(around: Around, aside: FixedAside | null, banter: string | null): string {
  return [aside ? said(around, aside) : "", banter ?? ""].filter((p) => p.trim()).join("\n");
}

/**
 * A fixed aside as the writer uses it: one line trimmed, or every part
 * trimmed; null where there are no words, or a part has none (the parts go
 * out together or not at all).
 */
export function fixedAside(aside: FixedAside | null | undefined): FixedAside | null {
  if (aside === null || aside === undefined) return null;
  if (typeof aside === "string") return aside.trim() || null;
  const parts = aside.map(({ label, text }) => ({ label: label.trim(), text: text.trim() }));
  return parts.length && parts.every((p) => p.text) ? parts : null;
}

/**
 * A platform's whole text: the hook first where it opens with one, the
 * words (on a caption-only platform, the source's one-line caption facts),
 * the aside and the banter (the scene), the link where it goes in the text
 * ("Link in bio." where links don't work), the hashtags last where it takes
 * them.
 */
export function composeText(platform: Platform, words: string, around: Around, aside: FixedAside | null = null, banter: string | null = null): string {
  const rule = PLATFORMS[platform];
  const parts = [rule.hookFirst ? around.hook : "", words.trim(), scene(around, aside, banter)];
  if (around.linkUrl && rule.linkIn === "text") parts.push(linkLine(around.linkUrl, around.linkLabel));
  if (around.linkUrl && rule.linkIn === "bio") parts.push("Link in bio.");
  if (rule.hashtags > 0 && around.hashtags.length) parts.push(around.hashtags.slice(0, rule.hashtags).join(" "));
  return parts.filter((p) => p.trim()).join("\n\n");
}

/** The first comment: the link, on the platforms that put it there. */
export function firstCommentFor(platform: Platform, linkUrl: string | null, linkLabel: string | null): string | null {
  return linkUrl && PLATFORMS[platform].linkIn === "comment" ? linkLine(linkUrl, linkLabel) : null;
}

const aroundOf = (source: PostSource, hook: string, link: string | null): Around => ({ hook, linkUrl: link, linkLabel: source.linkLabel, hashtags: source.hashtags, speaker: source.speaker ?? null });

/** Each platform's link: the source's, tagged with the platform and the post where the app asks (WriterOptions.tagLinks). */
function linksFor(source: PostSource, tag: boolean): LinkOf {
  return (platform) => (source.linkUrl && tag ? taggedLink(source.linkUrl, postLinkTags(platform, source)) : source.linkUrl);
}

/** The post's banter where this platform takes it: wherever it takes an aside. */
const banterFor = (source: PostSource, platform: Platform): string | null => (PLATFORMS[platform].aside === "none" ? null : source.banter?.trim() || null);

interface Assembled {
  readonly text: string;
  readonly withAside: boolean;
  readonly withBanter: boolean;
}

/**
 * The app's words for a platform, put together: the first version that fits,
 * with an aside and the banter when they fit too, else the last version cut
 * to fit. `asides` are the platform's, most wanted first (the full one, then
 * the short one): a shorter aside is tried before the banter goes, the
 * banter goes before the aside, and both before a fact does.
 */
function assemble(source: PostSource, platform: Platform, hook: string, asides: readonly FixedAside[], linkOf: LinkOf): Assembled {
  const around = aroundOf(source, hook, linkOf(platform));
  const banter = banterFor(source, platform);
  // A caption-only platform (TikTok) shows the facts on its slides: the caption is the hook, the source's
  // one-line caption facts ("Denver 56° to 57° at 49¢; … Swipe for every city."), the aside and the banter.
  const versions = PLATFORMS[platform].captionOnly ? [source.captionFacts?.trim() || ""] : source.template(platform);
  // Most to least: an aside with the banter (the full aside, then the short), an aside alone, the banter alone, neither.
  const extras: (readonly [FixedAside | null, string | null])[] = [];
  if (banter) for (const aside of asides) extras.push([aside, banter]);
  for (const aside of asides) extras.push([aside, null]);
  if (banter) extras.push([null, banter]);
  extras.push([null, null]);
  // The hashtags it takes, then one fewer at a time (social 0.2): a hashtag goes before a fact does, after the aside and the banter.
  const most = Math.min(PLATFORMS[platform].hashtags, source.hashtags.length);
  const withTags = (n: number): Around => ({ ...around, hashtags: source.hashtags.slice(0, n) });
  const tagCounts = Array.from({ length: most + 1 }, (_, i) => most - i);
  for (const words of versions) {
    for (const n of tagCounts) {
      for (const [a, b] of extras) {
        const text = composeText(platform, words, withTags(n), a, b);
        if (fits(platform, text)) return { text, withAside: a !== null, withBanter: b !== null };
      }
    }
  }
  const last = versions.at(-1) ?? source.facts.title;
  const bare = withTags(0);
  const cut = cutToFit(last, (w) => fits(platform, composeText(platform, w, bare))) || last;
  return { text: composeText(platform, cut, bare), withAside: false, withBanter: false };
}

/** How many characters the AI may write for a platform ("words" mode): its target, less what code adds around the words (with the longest hook). */
function budget(source: PostSource, platform: Platform, linkOf: LinkOf): number {
  const rule = PLATFORMS[platform];
  const added = textLength(platform, composeText(platform, "w", aroundOf(source, "h".repeat(HOOK_MAX), linkOf(platform)))) - 1;
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

const COUNT_WORDS = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"] as const;

/**
 * The request for the candidates (the playbook, section 6: verbalized
 * sampling, each with the probability the model says it would have written
 * it, so code can take an unlikely one). Six by default, word for word.
 */
export function candidatesRequest(n: number): string {
  if (n === 1) return "Give one aside, with the probability you would have written it.";
  return `Give ${COUNT_WORDS[n] ?? String(n)} different asides, each with the probability you would have written it, different from each other in length and in how they start.`;
}

// Live samples (Oct 27, 2026): every hook came back 113 to 161 characters long against "at most 90", so
// the hook gets a word count and code's own hook to measure against; told only "no longer", the model
// copied code's hook word for word; and an aside slipped in a year ("1987").
/** The rules when the AI writes the hook alone (no candidates asked for). */
const hookOnlyRules = () =>
  [
    'Code writes the post itself, every fact in it. You write the line on its image, as a JSON object: "hook".',
    `"hook": the line on the post's image, in your voice: the fact code's hook says, said your way, not copied. One short sentence of about ${Math.round(HOOK_MAX / 8)} words, never more than ${HOOK_MAX} characters. ${USE_THE_FACTS}`,
    `${NO_PROMISES} Never ask what will happen. No links, hashtags or @-mentions.`,
  ].join("\n");

const asideRules = (n: number) =>
  [
    `Code writes the post itself, every fact in it. You write the line on its image and ${n === 1 ? "an aside" : "some asides"} for it, as a JSON object: "hook", and "asides", a list of objects with "text" and "probability".`,
    `"hook": the line on the post's image, in your voice: the fact code's hook says, said your way, not copied. One short sentence of about ${Math.round(HOOK_MAX / 8)} words, never more than ${HOOK_MAX} characters. ${USE_THE_FACTS}`,
    `Each aside is one line in your voice, at most ${ASIDE_MAX} characters, about you and your own world, never about the facts or what could happen, and naming nothing the facts name. No numbers in it at all, in digits or in words, not even a year. An aside with a number or a name from the facts is thrown away.`,
    `${candidatesRequest(n)} ${n === 1 ? `Keep it to ${SHORT_ASIDE_MAX} characters where you can` : `Make some of them ${SHORT_ASIDE_MAX} characters or fewer`}, for the platforms with little room. "probability" is a number from 0 to 1.`,
    `${NO_PROMISES} Never ask what will happen. No links, hashtags or @-mentions.`,
  ].join("\n");

/** The JSON asked for in "aside" mode: the hook, and the candidates, each with its stated probability. */
const ASIDE_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  properties: {
    hook: { type: "string" },
    asides: { type: "array", items: { type: "object", properties: { text: { type: "string" }, probability: { type: "number" } }, required: ["text", "probability"], additionalProperties: false } },
  },
  required: ["hook", "asides"],
  additionalProperties: false,
};

/** The JSON asked for when the AI writes the hook alone. */
const HOOK_SCHEMA: Readonly<Record<string, unknown>> = { type: "object", properties: { hook: { type: "string" } }, required: ["hook"], additionalProperties: false };

/**
 * "aside" mode's bound on the answer: the hook, and each candidate at about
 * a token per five characters of the longest aside, with its JSON around it.
 * About 250 for six candidates, 300 in all: a few hundred output tokens a post.
 */
export const asideTokens = (n: number) => 20 + Math.ceil(HOOK_MAX / 3) + n * (13 + Math.ceil(ASIDE_MAX / 5));

/**
 * The bound when the AI writes the hook alone (no candidates). asideTokens(0)
 * is about 50, the hook's bare JSON, and live calls (Oct 30, 2026) ran out
 * of room there ("the answer ran out of room": a model that opens with a
 * word or a code fence needs more than the JSON). 150 is the floor: room
 * to answer, and still half what six candidates take.
 */
export const HOOK_ONLY_TOKENS = Math.max(150, asideTokens(0));

const factsLines = (source: PostSource) => [`Post: ${source.facts.title}`, "Facts:", ...source.facts.lines.map((l) => `- ${l}`)];

/** "aside" mode: the facts, and code's own hook to write a hook against. */
const asidePrompt = (source: PostSource) => [...factsLines(source), `Code's hook (the fact yours says, and as long as yours may be): ${source.hook}`].join("\n");

function wordsPrompt(source: PostSource, linkOf: LinkOf): string {
  const lengths = source.platforms.map((p) => {
    const rule = PLATFORMS[p];
    const most = rule.titleTarget !== undefined ? `a title line of at most ${rule.titleTarget} characters, a blank line, then the body, at most ${budget(source, p, linkOf)} characters` : `at most ${budget(source, p, linkOf)} characters`;
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

/** The model's answer as a JSON object, or null when it isn't one. */
function parseObject(raw: string): Readonly<Record<string, unknown>> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The model's answer as one string per key, or null when it isn't the JSON object asked for. */
function parse(raw: string, keys: readonly string[]): Partial<Record<string, string>> | null {
  const value = parseObject(raw);
  if (!value) return null;
  const out: Partial<Record<string, string>> = {};
  for (const k of keys) {
    const v = value[k];
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/** One of the AI's candidate asides, with the probability it said it would have written it. */
export interface AsideCandidate {
  readonly text: string;
  /** As the model stated it; a missing or unreadable one is Infinity, so it's picked last. */
  readonly probability: number;
}

/** The candidates in an answer's "asides" (a bare string counts, picked last); none when it isn't a list. */
function candidatesOf(value: unknown): AsideCandidate[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    const fields = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
    const text = typeof item === "string" ? item : fields?.text;
    if (typeof text !== "string") return [];
    const raw = fields?.probability;
    const p = typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseFloat(raw) : Number.NaN;
    return [{ text, probability: Number.isFinite(p) ? p : Number.POSITIVE_INFINITY }];
  });
}

/** The AI's asides as picked: the full one and the short one, each the AI's words or null with why. */
export interface AsidePick {
  readonly full: string | null;
  readonly fullWhy: string | null;
  readonly short: string | null;
  readonly shortWhy: string | null;
}

/**
 * THE PICK (the playbook, section 6): every candidate through `problem`
 * (the writer's checks, ASIDE_MAX included); of those that pass, the one the
 * model said it was least likely to write is the full aside, and the least
 * likely of those that fit SHORT_ASIDE_MAX is the short one. Ties go to the
 * earlier candidate. Where none passes, why: the one candidate's reason, or
 * every candidate's, once each.
 */
export function pickAsides(candidates: readonly AsideCandidate[], problem: (text: string) => string | null): AsidePick {
  if (!candidates.length) return { full: null, fullWhy: "the AI wrote none", short: null, shortWhy: "the AI wrote none" };
  const checked = candidates.map((c, i) => ({ text: c.text.trim(), probability: c.probability, i, why: problem(c.text) }));
  const passed = checked.filter((c) => c.why === null).sort((a, b) => a.probability - b.probability || a.i - b.i);
  const failed = checked.length === 1 ? checked[0]!.why : `none of the AI's ${checked.length} asides passed (${[...new Set(checked.map((c) => c.why))].join("; ")})`;
  const full = passed[0]?.text ?? null;
  const short = passed.find((c) => [...c.text].length <= SHORT_ASIDE_MAX)?.text ?? null;
  const tooLong = checked.length === 1 ? `it was too long for the short aside (${[...checked[0]!.text].length} of ${SHORT_ASIDE_MAX})` : `none of the AI's asides that passed fit in ${SHORT_ASIDE_MAX} characters`;
  return { full, fullWhy: full ? null : failed, short, shortWhy: short ? null : passed.length ? tooLong : failed };
}

const A_LINK = /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|io|app|co|ai|dev|shop|store|biz|us|uk|ca|markets?)\b/i;

/** What's wrong with some of the AI's words, whatever they're for, or null. `numbers`: the facts' only, or none at all. */
function wordsProblem(source: PostSource, words: string, honesty: HonestyCheck | undefined, numbers: "facts" | "none", part: WordsPart): string | null {
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
  return honesty?.(words, part) ?? source.check?.(words, part) ?? null;
}

function hookProblem(source: PostSource, hook: string | undefined, honesty: HonestyCheck | undefined): string | null {
  const h = hook?.trim() ?? "";
  if (!h) return "the AI wrote no hook";
  if (h.includes("\n")) return "the AI's hook was more than one line";
  if ([...h].length > HOOK_MAX) return `the AI's hook was too long (${[...h].length} of ${HOOK_MAX})`;
  return wordsProblem(source, h, honesty, "facts", "hook");
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
  return wordsProblem(source, a, honesty, "none", "aside");
}

function platformProblem(source: PostSource, platform: Platform, words: string | undefined, around: Around, honesty: HonestyCheck | undefined): string | null {
  const w = words?.trim() ?? "";
  if (!w) return "the AI wrote nothing for it";
  const wrong = wordsProblem(source, w, honesty, "facts", "words");
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
  const linkOf = linksFor(source, options.tagLinks === true);
  const templates = new Map(source.platforms.map((p) => [p, assemble(source, p, source.hook, [], linkOf).text]));
  const draft: Draft = (p, text, hook, writtenBy, note) => ({
    platform: p,
    text,
    templateText: templates.get(p)!,
    hook,
    firstComment: firstCommentFor(p, linkOf(p), source.linkLabel),
    linkUrl: linkOf(p),
    images: source.images(p, hook),
    writtenBy,
    note,
  });
  if (options.mode === "aside") {
    // A post with no AI voice is the app's words by design: nothing failed, so no note.
    if (source.voice === null) return placeAsides(source, draft, codeOnly(source, null), linkOf);
    if (!options.complete) return placeAsides(source, draft, codeOnly(source, "no AI is set up here"), linkOf);
    return placeAsides(source, draft, await askAsides(source, options, options.complete), linkOf);
  }
  const plain = (why: string | null) => source.platforms.map((p) => draft(p, templates.get(p)!, source.hook, "template", why && `Code's words: ${why}`));
  if (source.voice === null) return plain(null);
  if (!options.complete) return plain("no AI is set up here");
  return writeWords(source, options, options.complete, draft, templates, plain, linkOf);
}

/** "words" mode: the hook and every platform's words from the AI. */
async function writeWords(source: PostSource, options: WriterOptions, complete: Complete, draft: Draft, templates: ReadonlyMap<Platform, string>, plain: (why: string) => WrittenPost[], linkOf: LinkOf): Promise<WrittenPost[]> {
  const platforms = source.platforms;
  const keys = ["hook", ...platforms];
  const maxTokens = options.maxTokens ?? Math.min(4000, 200 + Math.ceil((HOOK_MAX + platforms.reduce((sum, p) => sum + budget(source, p, linkOf) + (PLATFORMS[p].titleTarget ?? 0), 0)) / 3));
  let raw: string;
  try {
    raw = await complete({ system: `${source.voice}\n\n${WORDS_RULES}`, prompt: wordsPrompt(source, linkOf), maxTokens, schema: schema(keys) });
  } catch (error) {
    return plain(failure(error));
  }
  const answer = parse(raw, keys);
  if (!answer) return plain("the AI's answer wasn't the JSON asked for");
  const hookWhy = hookProblem(source, answer.hook, options.honesty);
  const hook = hookWhy ? source.hook : answer.hook!.trim();
  const hookNote = hookWhy ? `Code's hook: ${hookWhy}` : null;
  return platforms.map((p) => {
    const around = aroundOf(source, hook, linkOf(p));
    const why = platformProblem(source, p, answer[p], around, options.honesty);
    if (why) return draft(p, templates.get(p)!, source.hook, "template", joinNotes(`Code's words: ${why}`, hookNote));
    // The banter after the AI's words where it fits; the AI's words are never cut for it.
    const words = answer[p]!.trim();
    const banter = banterFor(source, p);
    const withBanter = banter ? composeText(p, words, around, null, banter) : null;
    return draft(p, withBanter && fits(p, withBanter) ? withBanter : composeText(p, words, around), hook, "ai", hookNote);
  });
}

/** What "aside" mode puts in a post's drafts: the hook, the AI's asides as picked, and why for whatever isn't the AI's. */
interface AsidePlan {
  /** The hook every draft carries: the AI's where it passed, else code's. */
  readonly hook: string;
  /** Whether that hook is the AI's. */
  readonly aiHook: boolean;
  /** Why code's hook, where the AI answered and its hook failed. */
  readonly hookWhy: string | null;
  /** Why nothing of the AI's is in any draft (no AI here, the call failed, no JSON); null where it answered, or where the post has no AI voice by design. */
  readonly whole: string | null;
  readonly pick: AsidePick;
}

/** A plan with nothing of the AI's in it, and why (null: by design). */
const codeOnly = (source: PostSource, why: string | null): AsidePlan => ({ hook: source.hook, aiHook: false, hookWhy: null, whole: why, pick: { full: null, fullWhy: why, short: null, shortWhy: why } });

/** "aside" mode's one call: the hook and the candidates from the AI, each checked, and the asides picked. */
async function askAsides(source: PostSource, options: WriterOptions, complete: Complete): Promise<AsidePlan> {
  const n = Math.max(0, Math.floor(options.candidates ?? ASIDE_CANDIDATES));
  const maxTokens = options.maxTokens ?? (n === 0 ? HOOK_ONLY_TOKENS : asideTokens(n));
  let raw: string;
  try {
    raw = await complete({ system: `${source.voice}\n\n${n === 0 ? hookOnlyRules() : asideRules(n)}`, prompt: asidePrompt(source), maxTokens, schema: n === 0 ? HOOK_SCHEMA : ASIDE_SCHEMA });
  } catch (error) {
    return codeOnly(source, failure(error));
  }
  const answer = parseObject(raw);
  if (!answer) return codeOnly(source, "the AI's answer wasn't the JSON asked for");
  const hook = typeof answer.hook === "string" ? answer.hook : undefined;
  const hookWhy = hookProblem(source, hook, options.honesty);
  // None asked for: the asides are the source's fixed ones by design, with no reason to give.
  const pick = n === 0 ? { full: null, fullWhy: null, short: null, shortWhy: null } : pickAsides(candidatesOf(answer.asides), (text) => asideProblem(source, text, ASIDE_MAX, options.honesty));
  return { hook: hookWhy ? source.hook : hook!.trim(), aiHook: !hookWhy, hookWhy, whole: null, pick };
}

/** The asides given, without the missing ones or a repeat (a short aside the same as the full one). */
const distinct = (asides: readonly (FixedAside | null)[]): FixedAside[] =>
  asides.filter((a, i): a is FixedAside => a !== null && asides.findIndex((b) => JSON.stringify(b) === JSON.stringify(a)) === i);

/**
 * Every platform's draft in "aside" mode: the plan's hook, and the aside the
 * platform takes (full, short, or none). The AI's where one passed; else the
 * source's fixed one, with a note saying so; else none. A full aside that
 * failed gives way to the short one: it fits wherever a full one would. So
 * does a full one with no room beside the facts and the banter.
 */
function placeAsides(source: PostSource, draft: Draft, plan: AsidePlan, linkOf: LinkOf): WrittenPost[] {
  const fixedFull = fixedAside(source.fallbackAsides?.full);
  const fixedShort = fixedAside(source.fallbackAsides?.short);
  return source.platforms.map((p) => {
    const want = PLATFORMS[p].aside;
    const name = PLATFORMS[p].name;
    // The platform's asides, most wanted first: where it takes a full one, the short one is next, for when the full one has no room.
    const ai = want === "none" ? [] : distinct(want === "short" ? [plan.pick.short] : [plan.pick.full, plan.pick.short]);
    const why = (want === "short" ? plan.pick.shortWhy : plan.pick.fullWhy) ?? "";
    const fixed = want === "none" || ai.length ? [] : distinct(want === "short" ? [fixedShort] : [fixedFull, fixedShort]);
    const asides = ai.length ? ai : fixed;
    const { text, withAside, withBanter } = assemble(source, p, plan.hook, asides, linkOf);
    // The AI's work is in this draft when its hook is (on the image, and first where the platform opens with it) or its aside is.
    const writtenBy = plan.aiHook || (ai.length > 0 && withAside) ? "ai-aside" : "template";
    // No AI voice by design: nothing failed, so no note.
    if (source.voice === null) return draft(p, text, plan.hook, writtenBy, null);
    if (plan.whole !== null) return draft(p, text, plan.hook, writtenBy, `Code's hook, ${fixed.length && withAside ? "fixed aside" : "no aside"}: ${plan.whole}`);
    const banterLeft = banterFor(source, p) !== null && !withBanter;
    const asideRoom = asides.length > 0 && !withAside;
    const room = asideRoom && banterLeft ? `No aside or banter: no room on ${name}` : asideRoom ? `No aside: no room on ${name}` : banterLeft ? `No banter: no room on ${name}` : null;
    // No reason (the fixed aside by design): nothing to note.
    const asideNote = want === "none" ? null : !asides.length ? (why ? `No aside: ${why}` : null) : fixed.length && why ? (withAside ? `Fixed aside: ${why}` : `No AI aside: ${why}`) : null;
    return draft(p, text, plan.hook, writtenBy, joinNotes(plan.hookWhy && `Code's hook: ${plan.hookWhy}`, asideNote, room));
  });
}
