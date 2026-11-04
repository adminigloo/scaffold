import { asOf, isOpen } from "./expiry.js";
import type { QueuedPost } from "./store.js";
import { PLATFORM_IDS, type PostLife } from "./types.js";

/**
 * THE QUEUE IN SECTIONS, each post in one section only, with every platform
 * of it together (a post that showed up both under today and under "ready"
 * read as the same post twice), each row's status as of `now`: a stale
 * draft reads expired whether or not anyone has marked it yet. Pure: the app
 * reads the rows, this sorts them.
 *
 *   today    the app's today's posts, whatever their status
 *   earlier  earlier days' posts with something still to do
 *   history  earlier days' posts with nothing left to do and something
 *            posted or skipped, newest first
 *   expired  earlier days' posts that went stale with nothing posted
 *   ready    approved and not posted, from any section: a posting
 *            session's list (the same rows as above, not a section of its own)
 */
export interface QueueSections {
  readonly today: readonly QueuedPost[];
  readonly earlier: readonly QueuedPost[];
  readonly ready: readonly QueuedPost[];
  readonly history: readonly QueuedPost[];
  readonly expired: readonly QueuedPost[];
}

export interface SectionOptions {
  /** The app's today ("2026-10-28"), in its own zone. */
  readonly today: string;
  readonly life?: PostLife;
  readonly now: Date;
  /** The most posts history and expired each keep (newest first). */
  readonly pastPosts?: number;
}

/** Rows (any order, duplicates allowed) sorted into sections. */
export function queueSectionsOf(rows: readonly QueuedPost[], { today, life, now, pastPosts = 12 }: SectionOptions): QueueSections {
  const unique = new Map<string, QueuedPost>();
  for (const row of asOf(rows, life, now)) unique.set(row.id, row);
  const sorted = [...unique.values()].sort(
    (a, b) => b.day.localeCompare(a.day) || a.createdAt.getTime() - b.createdAt.getTime() || a.key.localeCompare(b.key) || PLATFORM_IDS.indexOf(a.platform) - PLATFORM_IDS.indexOf(b.platform),
  );
  const posts = new Map<string, QueuedPost[]>();
  for (const row of sorted) {
    const post = posts.get(row.key);
    if (post) post.push(row);
    else posts.set(row.key, [row]);
  }
  const out = { today: [] as QueuedPost[], earlier: [] as QueuedPost[], ready: [] as QueuedPost[], history: [] as QueuedPost[], expired: [] as QueuedPost[] };
  let history = 0;
  let expired = 0;
  for (const post of posts.values()) {
    out.ready.push(...post.filter((r) => r.status === "approved"));
    if (post.some((r) => r.day === today)) out.today.push(...post);
    else if (post.some((r) => isOpen(r.status))) out.earlier.push(...post);
    else if (post.some((r) => r.status === "posted" || r.status === "skipped")) {
      if (history++ < pastPosts) out.history.push(...post);
    } else if (expired++ < pastPosts) out.expired.push(...post);
  }
  return out;
}
