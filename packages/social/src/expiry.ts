import type { PostLife, PostStatus } from "./types.js";

/**
 * A POST GOES STALE (Oct 28, 2026: the founder opened the queue on the 28th
 * and every draft was about the 26th). Each app says how long each kind of
 * post stays worth posting (a PostLife: results for a day, a story for a
 * week); past that, a draft, or an approved post nobody posted, is expired.
 * It leaves the queue, a posting session is never handed it, and nothing
 * can approve it again. A posted or skipped post stays what it is.
 *
 * Worked out on every read (effectiveStatus), so a stale post is never
 * offered a minute late, and written down in the table now and then by the
 * app (store.expire), so the table says so too. No cron needed.
 */

/** The statuses a person still acts on: written and waiting, or approved and not posted. */
export const OPEN_STATUSES = ["draft", "approved"] as const satisfies readonly PostStatus[];

export function isOpen(status: PostStatus): boolean {
  return status === "draft" || status === "approved";
}

/** What a status check needs of a post. */
export interface Aging {
  readonly status: PostStatus;
  readonly kind: string;
  readonly day: string;
}

/** A post's status as of `now`: an open one past its life is expired. No life: as stored. */
export function effectiveStatus(post: Aging, life: PostLife | undefined, now: Date): PostStatus {
  if (!life || !isOpen(post.status)) return post.status;
  const until = life(post)?.until;
  return until && now.getTime() >= until.getTime() ? "expired" : post.status;
}

/** Rows with their status as of `now` (the same objects where nothing changed). */
export function asOf<T extends Aging>(rows: readonly T[], life: PostLife | undefined, now: Date): T[] {
  return rows.map((row) => {
    const status = effectiveStatus(row, life, now);
    return status === row.status ? row : { ...row, status };
  });
}
