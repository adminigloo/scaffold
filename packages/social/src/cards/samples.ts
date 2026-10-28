import type { DraftImage } from "../types.js";
import type { CardFormatImage, CardFormatSet } from "../wire.js";
import { launchCarousel, quoteCard, releaseCarousel, storyCarousel } from "./carousels.js";
import { CARD_SIZES, type CardBrandWords, type CardSize, type CardSpec } from "./types.js";

/**
 * SAMPLES, for "See every card format": every shape and size, with made-up
 * but ordinary words for a small business. Clearly samples: nothing here is
 * ever posted, and the numbers are examples, not anybody's results.
 */

export interface CardSampleSet {
  readonly key: string;
  readonly title: string;
  readonly about: string;
  readonly specs: readonly CardSpec[];
}

const RATIO: Readonly<Record<CardSize, string>> = { square: "1:1", portrait: "4:5", story: "9:16" };

/** Every sample set, in the brand given (a company's own name and colour), or the app's. */
export function sampleCardSets(brand?: CardBrandWords): CardSampleSet[] {
  const b = brand ? { brand } : {};
  const launch = {
    hook: "We're open on Saturdays now, 9 to 1.",
    text: "Starting Nov 1 we're open on Saturdays from 9 to 1, for pickups and drop-offs. Weekday hours stay the same.",
    eyebrow: "New hours",
    call: "See our hours",
    ...b,
  };
  return [
    {
      key: "quote",
      title: "Quote card",
      about: "A post's words as a post: the mark, the name, the handle, the words in the big serif. 1:1 for X, Threads, Bluesky, Telegram and Discord; 4:5 for LinkedIn. Longer words step down in size and never run off.",
      specs: [
        quoteCard("We're open on Saturdays now, 9 to 1.", "square", { date: "Oct 27", ...b }),
        quoteCard("Starting Nov 1 we're open on Saturdays from 9 to 1, for pickups and drop-offs. Weekday hours stay the same, and you can still book online any time.", "portrait", b),
      ],
    },
    { key: "launch", title: "An announcement, 4:5", about: "The hook, the details in your own words, the call. Instagram and Facebook carousels.", specs: launchCarousel(launch, "portrait") },
    {
      key: "launch-story",
      title: "An announcement, 9:16",
      about: "The same carousel for TikTok photo mode and Stories: everything inside TikTok's safe zone (clear of the top 10%, the bottom 22% and the right 15%).",
      specs: launchCarousel(launch, "story"),
    },
    {
      key: "release",
      title: "What's new, 4:5",
      about: "A release from a changelog: its title, its items as a list, the call.",
      specs: releaseCarousel({ version: "2.4", title: "Online booking and text reminders", items: ["Book online any time", "A text reminder the day before", "Move or cancel from the text"], call: "See what's new", ...b }, "portrait"),
    },
    {
      key: "numbers",
      title: "A post with numbers, 4:5",
      about: "A hook, then one number per slide with its plain line, the call. Every number is one the post's facts already have.",
      specs: storyCarousel({ hook: "Our first year, in two numbers.", stats: [{ value: "312", line: "Homes we cleaned this year." }, { value: "4.9", line: "Our average review, from 96 reviews." }], call: "Book a cleaning", ...b }, "portrait"),
    },
  ];
}

export type { CardFormatImage, CardFormatSet } from "../wire.js";

/** The sample sets as images, each through the app's signer (./images.ts `cardImage`). */
export function cardFormatSets(sets: readonly CardSampleSet[], sign: (spec: CardSpec) => DraftImage): CardFormatSet[] {
  return sets.map((set) => ({
    key: set.key,
    title: set.title,
    about: set.about,
    images: set.specs.map((spec) => {
      const { width, height } = CARD_SIZES[spec.size];
      return {
        ...sign(spec),
        label: `${spec.page ? `${spec.page.index} of ${spec.page.count} · ` : ""}${spec.kind} · ${RATIO[spec.size]} · ${width}×${height}`,
      };
    }),
  }));
}
