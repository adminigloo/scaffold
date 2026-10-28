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
 * app's template, never the AI.
 *
 * Every draft belongs to one company (its `tenantId`, kept by the queue), and
 * nothing here ever reads or writes another company's.
 */

/** Every platform the package knows. Each app turns on the ones it uses. */
export const PLATFORM_IDS = ["x", "threads", "bluesky", "telegram", "discord", "linkedin", "facebook", "instagram", "tiktok", "reddit"] as const;
export type Platform = (typeof PLATFORM_IDS)[number];

/** What a post is about, in the app's own words ("launch", "release", "event"). */
export type PostKind = string;

/** draft (written, waiting for a person) → approved (ready to post) → posted (with its link), or skipped. */
export const POST_STATUSES = ["draft", "approved", "posted", "skipped"] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

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
  /** Who's speaking, as the queue shows it: the business's name, or a person's. */
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
  /** A draft's images for one platform, in order (none for Reddit). Given the hook, for images that show it. */
  readonly images: (platform: Platform, hook: string) => readonly DraftImage[];
  /**
   * This post's own rule for the AI's words, beside the app's honesty check:
   * why a hook or an aside can't go out, or null. A post about one shop may
   * not say "every shop"; a post about a trial may not say "free forever".
   */
  readonly check?: (text: string) => string | null;
}
