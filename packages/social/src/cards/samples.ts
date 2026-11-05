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

/** One of the app's looks, for the samples: its key in the assets' looks, and what to call it. */
export interface CardSampleLook {
  readonly key: string;
  readonly name: string;
  /** A line on what it is ("The homepage's spray paint behind the words"). */
  readonly about?: string;
}

const RATIO: Readonly<Record<CardSize, string>> = { square: "1:1", portrait: "4:5", story: "9:16" };

/**
 * Every sample set, in the brand given (a company's own name and colour), or
 * the app's. With `look` (social 0.7), every card wears that one of the app's
 * looks, for "See every card format" shown a look at a time. With `looks`
 * (social 0.5), a set for each besides: its quote card at 1:1, its
 * announcement at 4:5, and the announcement at 9:16. A company's card wears
 * no look, so a brand gets neither.
 */
export function sampleCardSets(brand?: CardBrandWords, options: { readonly looks?: readonly CardSampleLook[]; readonly look?: string | null } = {}): CardSampleSet[] {
  const look = brand ? null : (options.look ?? null);
  const sets = baseSets(brand, look ? {} : options);
  return look ? sets.map((set) => ({ ...set, specs: set.specs.map((spec) => ({ ...spec, look })) })) : sets;
}

/** The sample sets, and (social 0.5) one for each look given. */
function baseSets(brand: CardBrandWords | undefined, options: { readonly looks?: readonly CardSampleLook[] }): CardSampleSet[] {
  const b = brand ? { brand } : {};
  const launch = {
    hook: "We're open on Saturdays now, 9 to 1.",
    text: "Starting Nov 1 we're open on Saturdays from 9 to 1, for pickups and drop-offs. Weekday hours stay the same.",
    eyebrow: "New hours",
    call: "See our hours",
    ...b,
  };
  const looks = brand ? [] : (options.looks ?? []);
  const worn = (look: string) => (spec: CardSpec): CardSpec => ({ ...spec, look });
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
    ...looks.map(
      (look): CardSampleSet => ({
        key: `look-${look.key}`,
        title: `The ${look.name} look`,
        about: `${look.about ? `${look.about}. ` : ""}Its quote card at 1:1, its announcement at 4:5, and the announcement at 9:16. In a video each piece comes on in turn, then the words.`,
        specs: [
          worn(look.key)(quoteCard("We're open on Saturdays now, 9 to 1.", "square", { date: "Oct 27" })),
          worn(look.key)(alone(launchCarousel(launch, "portrait")[0]!)),
          ...launchCarousel(launch, "story").map(worn(look.key)),
        ],
      }),
    ),
  ];
}

/** A slide shown on its own: no page number. */
function alone(spec: CardSpec): CardSpec {
  const { page: _page, ...rest } = spec;
  return rest as CardSpec;
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
