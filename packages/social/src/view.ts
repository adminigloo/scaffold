import type { SocialPostRow } from "./schema.js";
import type { DraftImage, Platform, PostStatus, WrittenBy } from "./types.js";

/**
 * A queue row as the screens see it: plain strings, no Dates, so it crosses
 * any wire the app uses (a server component's props, a tRPC answer, JSON).
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
  /** Changes whenever the row does: a screen showing it knows when to take the new version. */
  readonly updatedAt: string;
}

export function postView(row: SocialPostRow): QueuePostView {
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
    status: row.status,
    postedUrl: row.postedUrl,
    postedAt: row.postedAt ? row.postedAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}
