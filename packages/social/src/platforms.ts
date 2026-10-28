import type { Platform } from "./types.js";

/**
 * EACH PLATFORM'S FORMAT (Oct 27, 2026: the founder's on-trend list): how
 * long a post may be, counted the way that platform counts; where its link
 * goes; whether it opens with the hook, ends with hashtags, and takes one
 * image, a carousel or none; and how the AI is asked to write for it. Pure.
 *
 * The AI's target is well under the limit on purpose: code adds the hook,
 * the link and the hashtags around the AI's words (./writer.ts),
 * and a person editing a draft should have room for a word or two.
 */

/** The longest hook: one line that reads at a glance, on the image. */
export const HOOK_MAX = 90;
/** The longest aside (./writer.ts, "aside" mode), and the short one for the platforms with little room. */
export const ASIDE_MAX = 140;
export const SHORT_ASIDE_MAX = 70;

export type ImageAspect = "1:1" | "4:5" | "9:16";

/** Each shape's size in pixels, for whatever draws the images. */
export const ASPECT_SIZE: Readonly<Record<ImageAspect, { readonly width: number; readonly height: number }>> = {
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
  "9:16": { width: 1080, height: 1920 },
};

export interface PlatformRule {
  readonly id: Platform;
  readonly name: string;
  /** The most a post may hold, counted the platform's way (Reddit: the body). */
  readonly max: number;
  /** How much the AI is asked for: its words only, before code adds the rest. */
  readonly target: number;
  /**
   * How the platform counts: "x" (X's weights: every link is 23, an emoji 2),
   * "graphemes" (what a reader sees as one character: Bluesky), "chars"
   * (code points, near enough for the rest).
   */
  readonly counting: "x" | "graphemes" | "chars";
  /** Reddit: the text's first line is the title, at most this long, and the AI is asked for `titleTarget`. */
  readonly titleMax?: number;
  readonly titleTarget?: number;
  /**
   * Where the link goes: in the text; in the first comment (X and LinkedIn
   * show posts with a link to fewer people); or nowhere clickable, the
   * caption saying "Link in bio." (Instagram, TikTok).
   */
  readonly linkIn: "text" | "comment" | "bio";
  /**
   * A caption under images that carry the facts (TikTok's photo carousel):
   * the hook, the aside and the hashtags, no fact lines, which the slides show.
   */
  readonly captionOnly?: boolean;
  /** Does the text open with the hook, on a line of its own? */
  readonly hookFirst: boolean;
  /** Does the text end with the post's hashtags? */
  readonly hashtags: boolean;
  /** The images it takes: one card, a carousel, or none. */
  readonly image: { readonly aspect: ImageAspect; readonly carousel: boolean } | null;
  /** How the AI is asked to write for it. */
  readonly style: string;
  /** In "aside" mode: the author's aside, the short one where room is tight, or none where a joke doesn't belong. */
  readonly aside: "full" | "short" | "none";
}

export const PLATFORMS: Readonly<Record<Platform, PlatformRule>> = {
  x: { id: "x", name: "X", max: 280, target: 240, counting: "x", linkIn: "comment", hookFirst: false, hashtags: false, image: { aspect: "1:1", carousel: false }, style: "Punchy: one or two short sentences.", aside: "short" },
  threads: { id: "threads", name: "Threads", max: 500, target: 400, counting: "chars", linkIn: "text", hookFirst: false, hashtags: false, image: { aspect: "1:1", carousel: false }, style: "Conversational: a few short sentences.", aside: "full" },
  bluesky: { id: "bluesky", name: "Bluesky", max: 300, target: 240, counting: "graphemes", linkIn: "text", hookFirst: false, hashtags: false, image: { aspect: "1:1", carousel: false }, style: "A few short sentences.", aside: "short" },
  telegram: { id: "telegram", name: "Telegram", max: 4096, target: 600, counting: "chars", linkIn: "text", hookFirst: false, hashtags: false, image: { aspect: "1:1", carousel: false }, style: "A short update, in a few short lines.", aside: "full" },
  discord: { id: "discord", name: "Discord", max: 2000, target: 600, counting: "chars", linkIn: "text", hookFirst: false, hashtags: false, image: { aspect: "1:1", carousel: false }, style: "A short update, in a few short lines.", aside: "full" },
  linkedin: { id: "linkedin", name: "LinkedIn", max: 3000, target: 900, counting: "chars", linkIn: "comment", hookFirst: true, hashtags: false, image: { aspect: "4:5", carousel: false }, style: "Short paragraphs of one or two sentences each.", aside: "full" },
  facebook: { id: "facebook", name: "Facebook", max: 63_206, target: 500, counting: "chars", linkIn: "text", hookFirst: true, hashtags: false, image: { aspect: "4:5", carousel: true }, style: "A few short lines.", aside: "full" },
  instagram: { id: "instagram", name: "Instagram", max: 2200, target: 400, counting: "chars", linkIn: "bio", hookFirst: true, hashtags: true, image: { aspect: "4:5", carousel: true }, style: "A few short lines: a caption under a carousel.", aside: "full" },
  tiktok: { id: "tiktok", name: "TikTok", max: 2200, target: 150, counting: "chars", linkIn: "bio", hookFirst: true, captionOnly: true, hashtags: true, image: { aspect: "9:16", carousel: true }, style: "One short line: a caption under a photo carousel.", aside: "short" },
  reddit: {
    id: "reddit",
    name: "Reddit",
    max: 40_000,
    target: 1200,
    titleMax: 300,
    titleTarget: 120,
    counting: "chars",
    linkIn: "text",
    hookFirst: false,
    hashtags: false,
    image: null,
    style: "A plain, factual title line, a blank line, then a plain body. No hype.",
    // A data post on Reddit reads as a joke's setup if it ends in one: none there.
    aside: "none",
  },
};

/** X counts every link as this many characters, however long it is. */
export const X_LINK_LENGTH = 23;

const LINK = /https?:\/\/\S+/g;
const EMOJI = /\p{Extended_Pictographic}/u;

let segmenter: Intl.Segmenter | null = null;
function graphemes(text: string): string[] {
  segmenter ??= new Intl.Segmenter("en", { granularity: "grapheme" });
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

/** X's light characters (weight 1): Latin and the common punctuation. Everything else weighs 2. */
function xLight(codePoint: number): boolean {
  return codePoint <= 0x10ff || (codePoint >= 0x2000 && codePoint <= 0x200d) || (codePoint >= 0x2010 && codePoint <= 0x201f) || (codePoint >= 0x2032 && codePoint <= 0x2037);
}

/** A text's length the way X counts it: NFC first, every link 23, an emoji 2, CJK and the like 2. */
function xCount(text: string): number {
  const normal = text.normalize("NFC");
  let n = (normal.match(LINK) ?? []).length * X_LINK_LENGTH;
  for (const g of graphemes(normal.replace(LINK, ""))) {
    if (EMOJI.test(g)) n += 2;
    else for (const ch of g) n += xLight(ch.codePointAt(0)!) ? 1 : 2;
  }
  return n;
}

/** A text's length as a platform counts it (Reddit: the whole text; `measure` splits title and body). */
export function textLength(platform: Platform, text: string): number {
  const rule = PLATFORMS[platform];
  if (rule.counting === "x") return xCount(text);
  if (rule.counting === "graphemes") return graphemes(text).length;
  return [...text].length;
}

/** Reddit's text is its title line, then the body. */
export function redditParts(text: string): { readonly title: string; readonly body: string } {
  const at = text.indexOf("\n");
  return at < 0 ? { title: text.trim(), body: "" } : { title: text.slice(0, at).trim(), body: text.slice(at + 1).replace(/^\s*\n/, "").trimEnd() };
}

export interface Measure {
  /** As the platform counts it (Reddit: the body). */
  readonly length: number;
  readonly max: number;
  readonly fits: boolean;
  /** Reddit's title line. */
  readonly title?: { readonly length: number; readonly max: number };
}

/** How long a text is for a platform, and whether it fits: what the queue's live count shows. */
export function measure(platform: Platform, text: string): Measure {
  const rule = PLATFORMS[platform];
  if (rule.titleMax !== undefined) {
    const { title, body } = redditParts(text);
    const t = [...title].length;
    const b = [...body].length;
    return { length: b, max: rule.max, fits: t > 0 && t <= rule.titleMax && b <= rule.max, title: { length: t, max: rule.titleMax } };
  }
  const length = textLength(platform, text);
  return { length, max: rule.max, fits: text.trim().length > 0 && length <= rule.max };
}

export function fits(platform: Platform, text: string): boolean {
  return measure(platform, text).fits;
}

/**
 * The longest start of a text that `ok` accepts: cut after a whole sentence
 * or line if one fits (a post that stops at a full stop reads finished),
 * else after a whole word, with an ellipsis. Empty when nothing fits. For
 * the app's own words; the AI's are never cut, they're refused
 * (./writer.ts).
 */
export function cutToFit(text: string, ok: (cut: string) => boolean): string {
  const whole = text.trimEnd();
  if (ok(whole)) return whole;
  const stops = [...whole.matchAll(/[.!?](?=\s)|\n/g)].map((m) => m.index! + (m[0] === "\n" ? 0 : 1)).reverse();
  for (const at of stops) {
    const cut = whole.slice(0, at).trimEnd();
    if (cut && ok(cut)) return cut;
  }
  const words = whole.split(/(?<=\s)/);
  let lo = 0;
  let hi = words.length;
  // The most words that fit: fitting only gets harder with every word kept.
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ok(`${words.slice(0, mid).join("").trimEnd()}…`)) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? `${words.slice(0, lo).join("").trimEnd()}…` : "";
}

/**
 * The address that opens a platform's composer with the text filled in,
 * for the person (or the agent in their browser) doing the posting. Null
 * where there is none to trust: paste by hand.
 */
export function composeUrl(platform: Platform, text: string): string | null {
  const q = encodeURIComponent(text);
  if (platform === "x") return `https://x.com/intent/post?text=${q}`;
  if (platform === "threads") return `https://www.threads.net/intent/post?text=${q}`;
  if (platform === "bluesky") return `https://bsky.app/intent/compose?text=${q}`;
  if (platform === "linkedin") return `https://www.linkedin.com/feed/?shareActive=true&text=${q}`;
  return null;
}
