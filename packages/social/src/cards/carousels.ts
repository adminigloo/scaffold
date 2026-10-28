import { cutToFit, PLATFORMS, type ImageAspect } from "../platforms.js";
import type { Platform } from "../types.js";
import type { CardBrandWords, CardRow, CardSize, CardSpec, QuoteCardSpec } from "./types.js";

/**
 * THE SHAPES A POST'S IMAGES COME IN (social 0.1), from plain words: the
 * quote card (a post's screenshot) and the carousels. Every number and word
 * on them comes in with the post's facts or hook, never from anywhere else.
 * The app signs each spec into an address (./images.ts); the card route
 * draws it (./render.tsx).
 *
 *   quoteCard        the hook as a post: 1:1 for X, Threads, Bluesky,
 *                    Telegram and Discord; 4:5 for LinkedIn
 *   launchCarousel   an announcement: the hook, the details, the call —
 *                    4:5 for Instagram and Facebook, 9:16 for TikTok
 *   releaseCarousel  what's new: the release, its items as a list, the call
 *   storyCarousel    a hook, then one big number per slide, then the call
 */

/** Each image shape's canvas. */
export const ASPECT_CARD_SIZE: Readonly<Record<ImageAspect, CardSize>> = { "1:1": "square", "4:5": "portrait", "9:16": "story" };

/** Number the slides "1 / n". */
export function paged(specs: readonly CardSpec[]): CardSpec[] {
  return specs.map((spec, i) => ({ ...spec, page: { index: i + 1, count: specs.length } }));
}

/** A text cut to `max` characters at a whole sentence or word (with an ellipsis), for a card's field. */
export function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if ([...clean].length <= max) return clean;
  return cutToFit(clean, (t) => [...t].length <= max) || `${[...clean].slice(0, Math.max(1, max - 1)).join("")}…`;
}

const withBrand = (brand: CardBrandWords | undefined) => (brand ? { brand } : {});

/** The quote card: the words as a post, by the business. */
export function quoteCard(text: string, size: "square" | "portrait" = "square", options: { readonly date?: string; readonly brand?: CardBrandWords } = {}): QuoteCardSpec {
  return { kind: "quote", size, text: clip(text, 400), ...(options.date ? { date: clip(options.date, 24) } : {}), ...withBrand(options.brand) };
}

export interface LaunchCarouselInput {
  /** The line on the first slide: the post's hook. */
  readonly hook: string;
  /** The announcement as the person typed it: the second slide (cut to fit at a sentence or word). */
  readonly text: string;
  /** Small capitals above the hook ("New · Oct 27"). */
  readonly eyebrow?: string;
  /** The last slide's button ("See what's new"). */
  readonly call: string;
  readonly note?: string;
  readonly brand?: CardBrandWords;
}

/**
 * An announcement: the hook (with "Swipe"), the details (the person's own
 * words: the slide the facts are on, TikTok's caption being only a line),
 * and the call with the address. Two slides when the details are the hook.
 */
export function launchCarousel(input: LaunchCarouselInput, size: CardSize = "portrait"): CardSpec[] {
  const hook = clip(input.hook, 200);
  const details = clip(input.text, 200);
  const same = details.replace(/[.!?…]+$/, "") === hook.replace(/[.!?…]+$/, "");
  return paged([
    { kind: "cover", size, text: hook, ...(input.eyebrow ? { eyebrow: clip(input.eyebrow, 60) } : {}), ...withBrand(input.brand) },
    ...(same ? [] : [{ kind: "cover" as const, size, text: details, eyebrow: "The details", cue: "Swipe", ...withBrand(input.brand) }]),
    { kind: "cta", size, text: clip(input.call, 60), ...(input.note ? { note: clip(input.note, 200) } : {}), ...withBrand(input.brand) },
  ]);
}

export interface ReleaseCarouselInput {
  readonly version: string;
  readonly title: string;
  readonly items: readonly string[];
  readonly call: string;
  readonly brand?: CardBrandWords;
}

/** What's new: the release on the cover, its first five items as a list, the call. */
export function releaseCarousel(input: ReleaseCarouselInput, size: CardSize = "portrait"): CardSpec[] {
  const rows: CardRow[] = input.items
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 5)
    .map((item) => ({ label: clip(item, 60) }));
  const eyebrow = clip(`What's new · ${input.version}`, 60);
  return paged([
    { kind: "cover", size, eyebrow, text: clip(input.title, 200), ...withBrand(input.brand) },
    ...(rows.length ? [{ kind: "list" as const, size, eyebrow, text: clip(input.title, 120), rows, ...withBrand(input.brand) }] : []),
    { kind: "cta", size, text: clip(input.call, 60), ...withBrand(input.brand) },
  ]);
}

export interface StoryCarouselInput {
  readonly hook: string;
  readonly eyebrow?: string;
  /** One big number per slide (five at most), each with its one plain line. */
  readonly stats: readonly { readonly value: string; readonly line: string; readonly eyebrow?: string; readonly note?: string }[];
  readonly call: string;
  readonly brand?: CardBrandWords;
}

/** A hook, then one big number per slide, then the call. */
export function storyCarousel(input: StoryCarouselInput, size: CardSize = "portrait"): CardSpec[] {
  return paged([
    { kind: "cover", size, text: clip(input.hook, 200), ...(input.eyebrow ? { eyebrow: clip(input.eyebrow, 60) } : {}), ...withBrand(input.brand) },
    ...input.stats.slice(0, 5).map(
      (s): CardSpec => ({
        kind: "stat",
        size,
        value: clip(s.value, 24),
        text: clip(s.line, 200),
        ...(s.eyebrow ? { eyebrow: clip(s.eyebrow, 60) } : {}),
        ...(s.note ? { note: clip(s.note, 200) } : {}),
        ...withBrand(input.brand),
      }),
    ),
    { kind: "cta", size, text: clip(input.call, 60), ...withBrand(input.brand) },
  ]);
}

/**
 * A DRAFT'S CARDS FOR ONE PLATFORM, in its own shape (./platforms.ts): one
 * 1:1 quote card for X, Threads, Bluesky, Telegram and Discord, one 4:5 quote
 * card for LinkedIn, the 4:5 carousel for Instagram and Facebook, the 9:16
 * carousel for TikTok, nothing for Reddit.
 */
export function draftCards(
  platform: Platform,
  build: { readonly quote: (size: "square" | "portrait") => CardSpec; readonly carousel: (size: CardSize) => readonly CardSpec[] },
): CardSpec[] {
  const shape = PLATFORMS[platform].image;
  if (!shape) return [];
  const size = ASPECT_CARD_SIZE[shape.aspect];
  if (shape.carousel) return [...build.carousel(size)];
  return [build.quote(size === "square" ? "square" : "portrait")];
}
