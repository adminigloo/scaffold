import { cutToFit, HOOK_MAX } from "./platforms.js";
import { PLATFORM_IDS, type DraftImage, type Platform, type PostSource } from "./types.js";

/**
 * THE POSTS A BUSINESS USUALLY HAS (social 0.1): two generic sources an app
 * can build without writing its own. Each is pure: the facts and every
 * platform's body are the business's own words, laid out by code; the AI
 * (the writer's "aside" mode) adds only the hook on the image and a short
 * line in the business's voice.
 *
 *   launchSource   an announcement typed by a person: "We now open on
 *                  Saturdays, 9 to 1." Their sentence or two are the facts
 *                  and the body; the first sentence is the hook.
 *   releaseSource  what's new in a release, from a changelog: its version,
 *                  its title and its items.
 *
 * Any other post (an app's own numbers, a weekly summary) is a PostSource the
 * app writes itself (README.md, "Your own posts").
 */

/** The hook: one line that fits on the image, cut after a whole word if it has to be. */
export function hookOf(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return cutToFit(line, (h) => [...h].length <= HOOK_MAX) || [...line].slice(0, HOOK_MAX).join("");
}

/** A text's first sentence (all of it when there's no full stop). */
export function firstSentence(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return /^.*?[.!?](?=\s|$)/.exec(line)?.[0] ?? line;
}

/** The most hashtags a post carries (the platforms that take them reward three to five). */
export const MAX_HASHTAGS = 5;

/**
 * Hashtags as a person typed them ("#bakery, new menu  #Saturday"): each word
 * becomes one tag, letters, digits and underscores only, "#" in front, no
 * repeats (in any case), five at most. Code's, never the AI's.
 */
export function parseHashtags(input: string | readonly string[]): string[] {
  const words = (typeof input === "string" ? input.split(/[\s,]+/) : input.flatMap((s) => s.split(/[\s,]+/))).map((w) => w.replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, ""));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const word of words) {
    if (!word || /^\d+$/.test(word) || seen.has(word.toLowerCase())) continue;
    seen.add(word.toLowerCase());
    out.push(`#${word}`);
    if (out.length === MAX_HASHTAGS) break;
  }
  return out;
}

/** What every generic source is handed by the app. */
export interface SourceTarget {
  /** Who's speaking, as the queue shows it: the business's name. */
  readonly author: string;
  /** The voice the AI writes the hook and the aside in; null for no AI on this post. */
  readonly voice: string | null;
  /** The day it's meant to go out (YYYY-MM-DD), in the business's own time zone. */
  readonly day: string;
  /** The page it points to, absolute, or null for none. */
  readonly link: string | null;
  readonly linkLabel?: string | null;
  readonly hashtags?: readonly string[];
  /** Where it goes; every platform the package knows when left out. */
  readonly platforms?: readonly Platform[];
  /** A draft's images for one platform (./cards draws them; the app signs their addresses). */
  readonly images: (platform: Platform, hook: string) => readonly DraftImage[];
}

/** The longest announcement a person may type: a sentence or two, not an article. */
export const LAUNCH_FACTS_MAX = 1200;

/** An announcement from a person's own words (key "launch:<id>"). */
export function launchSource(input: SourceTarget & { readonly key: string; readonly facts: string; readonly kind?: string }): PostSource {
  const text = input.facts.replace(/\s+/g, " ").trim();
  const hook = hookOf(firstSentence(text));
  return {
    key: input.key,
    kind: input.kind ?? "launch",
    author: input.author,
    voice: input.voice,
    day: input.day,
    facts: { title: hook, lines: [text], data: { text } },
    platforms: input.platforms ?? PLATFORM_IDS,
    hook,
    linkUrl: input.link,
    linkLabel: input.linkLabel ?? null,
    hashtags: input.hashtags ?? [],
    // Reddit's first line is its title: the hook, then the whole announcement.
    template: (platform) => (platform === "reddit" ? [`${hook}\n\n${text}`] : [text]),
    images: input.images,
  };
}

/** One release, as a changelog has it. */
export interface ReleaseFacts {
  /** "2.4.0". */
  readonly version: string;
  /** "Faster search and a new export". */
  readonly title: string;
  /** What changed, one plain line each, most important first. */
  readonly items: readonly string[];
}

/**
 * What's new in a release (key "release:<version>"): the title, then the
 * items as a list. The longest version has every item; shorter ones keep the
 * first few, then the first alone, so a platform with little room (X) still
 * gets whole lines, never half of one.
 */
export function releaseSource(input: SourceTarget & { readonly release: ReleaseFacts }): PostSource {
  const { version, title, items } = input.release;
  const heading = `${title.trim()} (${version.trim()})`;
  const lines = items.map((item) => item.replace(/\s+/g, " ").trim()).filter(Boolean);
  const list = (n: number) => [heading, ...lines.slice(0, n).map((l) => `- ${l}`)].join("\n");
  const versions = [...new Set([lines.length, 3, 1].filter((n) => n <= lines.length && n > 0))].sort((a, b) => b - a).map(list);
  const hook = hookOf(`What's new in ${version.trim()}: ${title.trim()}`);
  return {
    key: `release:${version.trim()}`,
    kind: "release",
    author: input.author,
    voice: input.voice,
    day: input.day,
    facts: { title: heading, lines, data: { version, title, items: lines } },
    platforms: input.platforms ?? PLATFORM_IDS,
    hook,
    linkUrl: input.link,
    linkLabel: input.linkLabel ?? null,
    hashtags: input.hashtags ?? [],
    template: (platform) => (platform === "reddit" ? [`${heading}\n\n${lines.map((l) => `- ${l}`).join("\n")}`] : versions.length ? versions : [heading]),
    images: input.images,
  };
}
