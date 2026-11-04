import type { QueuedPost } from "../store.js";
import type { Platform, PostLife } from "../types.js";

/** Queue rows and an app's post life, for the view and screen tests: a results post across its platforms. */
const SQUARE = { url: "https://example.com/card/square.png", alt: "The hook", width: 1080, height: 1080 };
const SLIDES = [1, 2, 3].map((n) => ({ url: `https://example.com/card/slide-${n}.png`, alt: `Slide ${n}`, width: 1080, height: 1350 }));
const TALL = [1, 2, 3].map((n) => ({ url: `https://example.com/card/tall-${n}.png`, alt: `Slide ${n}`, width: 1080, height: 1920 }));
const IMAGES: Partial<Record<Platform, typeof SLIDES>> = { x: [SQUARE], threads: [SQUARE], bluesky: [SQUARE], instagram: SLIDES, facebook: SLIDES, tiktok: TALL, reddit: [] };

let n = 0;
export function row(over: Partial<QueuedPost> & { readonly platform: Platform }): QueuedPost {
  const at = new Date("2026-10-28T14:30:00Z");
  n++;
  return {
    id: `row-${n}`,
    tenantId: "tenant-a",
    key: "results:2026-10-27",
    kind: "results",
    author: "Al",
    day: "2026-10-28",
    text: `Text ${n}`,
    hook: "Oct 27: 1 of 3 favorites came in.",
    images: IMAGES[over.platform] ?? [SQUARE],
    firstComment: null,
    templateText: "Text",
    writtenBy: "ai-aside",
    note: null,
    linkUrl: "https://example.com/results",
    facts: { title: "How the daily highs settled on Oct 27", lines: [] },
    status: "draft",
    postedUrl: null,
    createdBy: null,
    approvedBy: null,
    postedBy: null,
    createdAt: at,
    updatedAt: at,
    approvedAt: null,
    postedAt: null,
    ...over,
  };
}

/** The app's rule, as Almanac's: a day for results and boards, a week for stories. */
export const life: PostLife = ({ kind, day }) => {
  const days = kind === "story" ? 7 : 1;
  const until = new Date(Date.parse(`${day}T04:00:00Z`) + days * 86_400_000);
  return { until, label: `Good for ${days === 1 ? "a day" : "a week"}` };
};
export const NOW = new Date("2026-10-28T15:00:00Z");
