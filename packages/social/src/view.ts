import { effectiveStatus, isOpen } from "./expiry.js";
import type { QueuedPost } from "./store.js";
import { PLATFORM_IDS, POST_STATUSES, type DraftImage, type Platform, type PostLife, type PostStatus, type WrittenBy } from "./types.js";

/**
 * A queue row as the screens see it: plain strings, no Dates, so it crosses
 * any wire the app uses (a server component's props, a tRPC answer, JSON).
 * Its status is as of when it was made: a draft past its life reads expired.
 */
export interface QueuePostView {
  readonly id: string;
  readonly key: string;
  readonly kind: string;
  readonly platform: Platform;
  readonly author: string;
  readonly day: string;
  /** What the post is about (its facts' title): the heading its platforms share. */
  readonly title: string;
  readonly text: string;
  readonly hook: string;
  readonly images: readonly DraftImage[];
  readonly firstComment: string | null;
  readonly templateText: string;
  readonly writtenBy: WrittenBy;
  readonly note: string | null;
  readonly linkUrl: string | null;
  readonly status: PostStatus;
  readonly postedUrl: string | null;
  readonly postedAt: string | null;
  /** When it stops being worth posting, and how to say so ("Good through Wed Oct 28, Eastern"); null when it doesn't. */
  readonly expiresAt: string | null;
  readonly expiresLabel: string | null;
  /** Changes whenever the row does: a screen showing it knows when to take the new version. */
  readonly updatedAt: string;
}

/** A row for the screens, its status as of `now` by the app's PostLife (none: as stored). */
export function postView(row: QueuedPost, life?: PostLife, now: Date = new Date()): QueuePostView {
  const lasts = life?.({ kind: row.kind, day: row.day }) ?? null;
  return {
    id: row.id,
    key: row.key,
    kind: row.kind,
    platform: row.platform,
    author: row.author,
    day: row.day,
    title: row.facts.title,
    text: row.text,
    hook: row.hook,
    images: row.images,
    firstComment: row.firstComment,
    templateText: row.templateText,
    writtenBy: row.writtenBy,
    note: row.note,
    linkUrl: row.linkUrl,
    status: effectiveStatus(row, life, now),
    postedUrl: row.postedUrl,
    postedAt: row.postedAt ? row.postedAt.toISOString() : null,
    expiresAt: lasts ? lasts.until.toISOString() : null,
    expiresLabel: lasts ? lasts.label : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** One set of images and the platforms that post it: a 1:1 card, a 4:5 carousel, a 9:16 carousel. */
export interface ImageSet {
  readonly images: readonly DraftImage[];
  readonly platforms: readonly Platform[];
}

/**
 * ONE POST AS THE QUEUE SHOWS IT (the founder, Oct 28, 2026: eight cards a
 * post "seemed like it was repeating different social media platforms"):
 * what it's about once, each different set of images once, and its
 * platforms as tabs, with where each one stands.
 */
export interface PostGroupView {
  readonly key: string;
  readonly kind: string;
  readonly author: string;
  readonly day: string;
  /** What it's about: its facts' title. */
  readonly title: string;
  /** The line on its images: the hook most of its platforms carry (a person may have changed one). */
  readonly hook: string;
  /** Every platform's draft, in the module's platform order. */
  readonly platforms: readonly QueuePostView[];
  /** How many platforms are at each status, in the order a person works through them (only the ones there are). */
  readonly summary: readonly { readonly status: PostStatus; readonly count: number }[];
  /** Each different set of images, once, in platform order, with the platforms that post it. */
  readonly imageSets: readonly ImageSet[];
  /** Its drafts: what "Approve all" approves. */
  readonly draftIds: readonly string[];
  /** Is anything still to do: a draft, or approved and not posted? */
  readonly open: boolean;
  readonly expiresAt: string | null;
  readonly expiresLabel: string | null;
}

/** A calendar day ("2026-10-28") as "Wed Oct 28": the date as written, whatever the reader's zone. */
export function dayText(day: string): string {
  const at = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(at.getTime())) return day;
  const part = (options: Intl.DateTimeFormatOptions) => at.toLocaleDateString("en-US", { ...options, timeZone: "UTC" });
  return `${part({ weekday: "short" })} ${part({ month: "short", day: "numeric" })}`;
}

/** The id of a post's card on a page, for a link straight to it ("post-results-2026-10-26"). */
export function postAnchor(key: string): string {
  return `post-${key.replace(/[^A-Za-z0-9]+/g, "-")}`;
}

/** The commonest value, the first one seen on a tie. */
function commonest(values: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = values[0] ?? "";
  for (const v of values) if ((counts.get(v) ?? 0) > (counts.get(best) ?? 0)) best = v;
  return best;
}

/** The queue's rows as posts: grouped by key, in the order their first rows came, each post's platforms in platform order. */
export function groupPosts(rows: readonly QueuePostView[]): PostGroupView[] {
  const byKey = new Map<string, QueuePostView[]>();
  for (const row of rows) {
    const list = byKey.get(row.key);
    if (!list) byKey.set(row.key, [row]);
    else if (!list.some((r) => r.id === row.id)) list.push(row);
  }
  return [...byKey.values()].map((list) => {
    const platforms = [...list].sort((a, b) => PLATFORM_IDS.indexOf(a.platform) - PLATFORM_IDS.indexOf(b.platform));
    const first = platforms[0]!;
    const imageSets: { images: readonly DraftImage[]; platforms: Platform[] }[] = [];
    for (const p of platforms) {
      if (!p.images.length) continue;
      const same = imageSets.find((set) => set.images.length === p.images.length && set.images.every((image, i) => image.url === p.images[i]!.url));
      if (same) same.platforms.push(p.platform);
      else imageSets.push({ images: p.images, platforms: [p.platform] });
    }
    return {
      key: first.key,
      kind: first.kind,
      author: first.author,
      day: first.day,
      title: first.title,
      hook: commonest(platforms.map((p) => p.hook)),
      platforms,
      summary: POST_STATUSES.map((status) => ({ status, count: platforms.filter((p) => p.status === status).length })).filter((s) => s.count > 0),
      imageSets,
      draftIds: platforms.filter((p) => p.status === "draft").map((p) => p.id),
      open: platforms.some((p) => isOpen(p.status)),
      expiresAt: first.expiresAt,
      expiresLabel: first.expiresLabel,
    };
  });
}
