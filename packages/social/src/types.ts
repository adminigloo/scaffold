/**
 * THE POST BUILDER'S WORDS FOR THINGS (README.md says how an app plugs it
 * in). Pure types: no app, no framework, no database.
 *
 * A POST is one thing worth saying ("we opened on Saturdays"), keyed by what
 * it's about ("launch:mz3k1"). It goes out as one DRAFT per platform, each in
 * that platform's own format (./platforms.ts): its text, the hook that goes
 * on its image, its images in order, and the first comment where the link
 * goes there. Each draft is approved and posted by a person (or an agent
 * driving their browser), never by this package. Each post has an author
 * with a voice of its own, or none: an author whose lines are fixed gets the
 * app's template, never the AI. An app with more than one character can sign
 * the author's aside with their name and give the post a short exchange with
 * the others (its banter) under it.
 *
 * A post is worth posting for a while and then it isn't: the app says how
 * long for each kind (a PostLife), and a draft, or an approved post nobody
 * posted, is expired after that (./expiry.ts).
 *
 * Every draft belongs to one company (its `tenantId`, kept by the queue), and
 * nothing here ever reads or writes another company's.
 */

/** Every platform the package knows. Each app turns on the ones it uses. */
export const PLATFORM_IDS = ["x", "threads", "bluesky", "telegram", "discord", "linkedin", "facebook", "instagram", "tiktok", "reddit"] as const;
export type Platform = (typeof PLATFORM_IDS)[number];

/** What a post is about, in the app's own words ("launch", "release", "event"). */
export type PostKind = string;

/**
 * draft (written, waiting for a person) → approved (ready to post) → posted
 * (with its link), or skipped; or expired, a draft or an approved post that
 * outlived its kind's life (./expiry.ts) without being posted.
 */
export const POST_STATUSES = ["draft", "approved", "posted", "skipped", "expired"] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

/**
 * How long a post stays worth posting, by the app's rule for its kind and
 * its day: the moment it stops, and how a screen says so ("Good through Wed
 * Oct 28, Eastern"). Null: a post of this kind never goes stale.
 */
export type PostLife = (post: { readonly kind: PostKind; readonly day: string }) => { readonly until: Date; readonly label: string } | null;

/**
 * Who wrote a draft's current words: the AI (its words around code's facts),
 * the AI's hook and aside only (every fact and the body code's own: the
 * writer's "aside" mode), the app's own template, or a person who edited it.
 */
export type WrittenBy = "ai" | "ai-aside" | "template" | "person";

/** One image of a draft, in posting order (a carousel has several). */
export interface DraftImage {
  readonly url: string;
  /** What it shows, for the platforms that take alt text (Bluesky asks for it). */
  readonly alt: string;
  readonly width: number;
  readonly height: number;
}

/** What a person can change on a draft. */
export interface PostEdit {
  readonly text: string;
  readonly hook: string;
  readonly firstComment: string | null;
}

/**
 * What a post may say. Code works these out (or a person types them); the AI
 * may use the numbers in the title and lines and no others (./guard.ts), so
 * every number a reader sees came from code or a person. `data` is the same
 * facts as plain JSON, for whatever draws the post's images.
 */
export interface Facts {
  /** What the post is about, in a line: "Open on Saturdays from Nov 1". */
  readonly title: string;
  /** One fact per line, every number written the way code (or the person) wrote it. */
  readonly lines: readonly string[];
  readonly data?: Readonly<Record<string, unknown>>;
}

/**
 * One post's worth of work for the writer (./writer.ts): the facts, where it
 * points, which platforms it goes to, and the app's own words, used whenever
 * the AI's don't pass.
 */
export interface PostSource {
  /** What it's about, unique within the company: one draft per key per platform. "launch:mz3k1". */
  readonly key: string;
  readonly kind: PostKind;
  /** Who's speaking, as the queue shows it: the business's name, a person's, or a character's ("Doldrum"). */
  readonly author: string;
  /**
   * The voice the AI writes this post in, a few plain lines. Null: the AI
   * doesn't write this post at all, and the template goes out as it is (a
   * post that must read the same way every time).
   */
  readonly voice: string | null;
  /** The day it's meant to go out (YYYY-MM-DD), for the queue's "today". */
  readonly day: string;
  readonly facts: Facts;
  readonly platforms: readonly Platform[];
  /** The app's own hook: the short line on the image (./platforms.ts HOOK_MAX). The AI may write a better one. */
  readonly hook: string;
  /**
   * The line a platform that opens with the hook opens with instead (LinkedIn,
   * Facebook, Instagram, TikTok), when the words would otherwise say it twice:
   * a typed post opens with the person's own first sentence and its words are
   * the rest. The images still carry the hook. None: the hook.
   */
  readonly openingLine?: string;
  /** The page it points to, absolute. Code places it (in the text, the first comment, or "link in bio"); the AI never writes a link. */
  readonly linkUrl: string | null;
  /** The words before the link where it's shown: "The new menu" makes "The new menu: https://…". */
  readonly linkLabel: string | null;
  /** Up to five, for the platforms that take them (Instagram, TikTok). Code's (or the person's), never the AI's. */
  readonly hashtags: readonly string[];
  /**
   * The app's own words for one platform: what goes between the hook and the
   * link, longest version first. The writer takes the first that fits once
   * the platform's hook, link and hashtags are around it, and cuts the last
   * if none does.
   */
  readonly template: (platform: Platform) => readonly string[];
  /**
   * The facts in one short line, for a caption-only platform (TikTok), whose
   * slides carry the rest: the top two or three, or the headline result, and
   * where the rest are ("Denver 56° to 57° at 49¢; Miami 84° to 85° at 38¢.
   * Swipe for every city."). Code's words, right after the hook, so a caption
   * that says "today's favorites" names some. Absent or null: the caption is
   * the hook, the aside and the banter.
   */
  readonly captionFacts?: string | null;
  /** A draft's images for one platform, in order (none for Reddit). Given the hook, for images that show it. */
  readonly images: (platform: Platform, hook: string) => readonly DraftImage[];
  /**
   * The name the author's aside is signed with ("Doldrum"), so it reads as a line
   * in a scene with the banter under it. Null or absent: the aside goes out
   * unsigned (an app with one voice).
   */
  readonly speaker?: string | null;
  /**
   * Fixed lines from the app's other characters, each signed and on its own
   * line ("Mercury: Behold the wizard, who has not left that nest.
Al:
   * Correct."): code's words, never the AI's. They go after the aside
   * wherever a platform takes an aside, and like the aside they're dropped
   * before any fact when a platform runs out of room.
   */
  readonly banter?: string | null;
  /**
   * This post's own rule for the AI's words, beside the app's honesty check:
   * why a hook or an aside can't go out, or null. A post about one shop may
   * not say "every shop"; a post about a trial may not say "free forever".
   * Told which part it's reading, so a rule can differ by part (the AI-smell
   * check, ./smell.ts, reads an aside in full, and a hook without the parts
   * that carry the facts' numbers and names).
   */
  readonly check?: (text: string, part?: WordsPart) => string | null;
  /**
   * The author's own fixed asides, written by a person: the full one and the
   * short one for the platforms with little room. In "aside" mode the writer
   * uses them wherever no aside of the AI's passes, or there's no AI, or its
   * call failed, and says so in the draft's note ("Fixed aside: …"). Never
   * checked by the writer: they're the app's own words, tested where they're
   * written. Absent or null: no aside then. Each is one line, or a few
   * labelled lines that go out together (FixedAside).
   */
  readonly fallbackAsides?: { readonly full?: FixedAside | null; readonly short?: FixedAside | null } | null;
}

/**
 * One labelled line of a fixed aside in parts. With a speaker it's signed
 * with their name and its label: { label: "out loud", text: "I fear nothing." }
 * from "Mercury" reads "Mercury, out loud: I fear nothing.", and without one
 * "Out loud: I fear nothing.".
 */
export interface AsidePart {
  readonly label: string;
  readonly text: string;
}

/**
 * A fixed aside: one line ("Doldrum: …" where there's a speaker), or labelled
 * lines that go out together, in order, a line each (a character's public
 * face and their inner voice). The parts are one unit: all of them go in or
 * none does, and a part with no words drops the whole aside.
 */
export type FixedAside = string | readonly AsidePart[];

/**
 * Which of the AI's words a check is reading: the hook (on the image; the
 * facts' numbers allowed), an aside (no numbers at all), or a platform's
 * words ("words" mode).
 */
export type WordsPart = "hook" | "aside" | "words";
