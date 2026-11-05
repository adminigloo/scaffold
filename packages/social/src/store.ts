import { and, asc, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { socialPosts, type SocialPostRow, type SocialPostTable } from "./schema.js";
import { queueSectionsOf, type QueueSections } from "./sections.js";
import type { DraftImage, Facts, Platform, PostEdit, PostKind, PostLife, PostStatus, WrittenBy } from "./types.js";

/**
 * THE QUEUE, ONE COMPANY AT A TIME (social 0.1). `postStore(db, { tenantId })`
 * is one company's queue: every read, write and count below is filtered by
 * its `tenant_id`, so a call can't reach another company's draft even with
 * its id in hand ("not found", exactly like one that doesn't exist). There is
 * no store over every company: forgetting one is ./forget.ts's.
 *
 * A ROW'S LIFE: draft (the builder wrote it) → approved (a person said yes)
 * → posted (with the link to it), or skipped; or expired, when it outlived
 * its kind's life unposted (./expiry.ts). The builder may refresh a
 * draft nobody has touched; anything a person edited, approved, posted or
 * skipped is theirs, and a rerun never writes over it, nor over an expired
 * one: its key has rows, so it's never built again.
 */

/** Any Drizzle Postgres handle (Neon, node-postgres, PGlite): the store asks nothing of it but SQL. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SocialDb = PgDatabase<any, any, any>;

/** A queue row, as the store returns it. */
export type QueuedPost = SocialPostRow;

/** What the builder writes for one platform. */
export interface DraftInput {
  readonly key: string;
  readonly kind: PostKind;
  readonly platform: Platform;
  readonly author: string;
  readonly day: string;
  readonly text: string;
  readonly hook: string;
  readonly images: readonly DraftImage[];
  readonly firstComment: string | null;
  readonly templateText: string;
  readonly writtenBy: Exclude<WrittenBy, "person">;
  readonly note: string | null;
  readonly linkUrl: string | null;
  readonly facts: Facts;
  /** Who composed it (a person's id), or null for the builder. */
  readonly createdBy?: string | null;
}

export interface ListFilter {
  readonly statuses?: readonly PostStatus[];
  readonly day?: string;
  /** Only these posts (every platform of each). */
  readonly keys?: readonly string[];
  /** Only these rows. */
  readonly ids?: readonly string[];
  readonly limit?: number;
}

/** What the expiry check needs of an open row, and no more. */
export interface OpenPost {
  readonly id: string;
  readonly key: string;
  readonly kind: PostKind;
  readonly day: string;
  readonly status: PostStatus;
}

/** A link the queue will keep (a post on a platform, a page to point at): an http(s) address, nothing else. */
export function isWebAddress(url: string): boolean {
  return url.length <= 2000 && /^https?:\/\/[^\s]+$/.test(url);
}

/** The most rows one list returns. */
export const LIST_MAX = 500;

export class MissingTenantError extends Error {
  readonly name = "MissingTenantError";
}

export interface PostStoreOptions {
  /** The company whose queue this is ("*" for the site's own). Required: there is no queue across companies. */
  readonly tenantId: string;
  /** The table, when the app named its own (`defineSocialTables({ prefix })`). Default `social_posts`. */
  readonly table?: SocialPostTable;
  /**
   * What approving means (social 0.2). "open", the default and Almanac's way:
   * a draft can be marked posted straight away, and an approved post keeps
   * its approval through an edit. "strict", Ask Lou's rule (Nov 2026):
   * approval covers the exact words that go out, so only an approved post
   * can be marked posted, and editing an approved post sends it back to draft.
   */
  readonly approval?: "open" | "strict";
}

export function postStore(db: SocialDb, options: PostStoreOptions) {
  const tenantId = options?.tenantId;
  if (typeof tenantId !== "string" || tenantId.trim() === "") {
    throw new MissingTenantError("postStore needs the company's id (tenantId): every queue is one company's.");
  }
  const t = options.table ?? socialPosts;
  const mine = eq(t.tenantId, tenantId);
  const strict = options.approval === "strict";
  /** What may be marked posted: under "strict", only what a person approved (an approved post that went stale, too). */
  const postable = strict
    ? or(inArray(t.status, ["approved", "posted"]), and(eq(t.status, "expired"), isNotNull(t.approvedAt)))
    : inArray(t.status, ["draft", "approved", "posted", "expired"]);
  /** Nobody has touched it: still a draft, and the words are the builder's. */
  const untouched = sql`${t.status} = 'draft' AND ${t.writtenBy} <> 'person'`;

  /** Posts by status and day, newest day first, each post's platforms together. */
  async function list(filter: ListFilter = {}): Promise<QueuedPost[]> {
    if ((filter.keys && !filter.keys.length) || (filter.ids && !filter.ids.length)) return [];
    const where = and(
      mine,
      filter.statuses ? inArray(t.status, [...filter.statuses]) : undefined,
      filter.day ? eq(t.day, filter.day) : undefined,
      filter.keys ? inArray(t.key, [...filter.keys]) : undefined,
      filter.ids ? inArray(t.id, [...filter.ids]) : undefined,
    );
    return db
      .select()
      .from(t)
      .where(where)
      .orderBy(desc(t.day), asc(t.createdAt), asc(t.key), asc(t.platform))
      .limit(Math.max(1, Math.min(filter.limit ?? 200, LIST_MAX)));
  }

  return {
    tenantId,

    /**
     * One platform's draft, idempotent per (company, key, platform): a new
     * row, or a refresh of a draft nobody has touched. "kept" when a person's
     * edit, approval, post or skip is there: that row stands as it is.
     */
    async upsertDraft(d: DraftInput): Promise<"written" | "kept"> {
      const now = new Date();
      const fields = {
        kind: d.kind,
        author: d.author,
        day: d.day,
        text: d.text,
        hook: d.hook,
        images: d.images,
        firstComment: d.firstComment,
        templateText: d.templateText,
        writtenBy: d.writtenBy,
        note: d.note,
        linkUrl: d.linkUrl,
        facts: d.facts,
        updatedAt: now,
      };
      const rows = await db
        .insert(t)
        .values({ ...fields, tenantId, key: d.key, platform: d.platform, status: "draft", createdBy: d.createdBy ?? null, createdAt: now })
        // The day stays as first built: a post's expiry counts from it, and Build now on a later day must not stretch it.
        .onConflictDoUpdate({ target: [t.tenantId, t.key, t.platform], set: { ...fields, day: sql`${t.day}` }, setWhere: untouched })
        .returning({ id: t.id });
      return rows.length ? "written" : "kept";
    },

    /**
     * Which of these keys have a row already: the builder asks before it
     * spends an AI call. "untouched" counts only drafts nobody has changed,
     * the rows a rebuild would still refresh.
     */
    async keysWithPosts(keys: readonly string[], which: "any" | "untouched" = "any"): Promise<Set<string>> {
      if (!keys.length) return new Set();
      const rows = await db
        .selectDistinct({ key: t.key })
        .from(t)
        .where(and(mine, inArray(t.key, [...keys]), which === "untouched" ? untouched : undefined));
      return new Set(rows.map((r) => r.key));
    },

    list,

    /**
     * The queue as a page shows it (./sections.ts): `today` in the business's
     * own time zone (YYYY-MM-DD), each row's status as of `now` by the app's
     * PostLife, so a stale draft reads expired before anything marks it.
     */
    async sections(today: string, options: { readonly life?: PostLife; readonly now?: Date } = {}): Promise<QueueSections> {
      const [todays, open, past] = await Promise.all([
        list({ day: today }),
        list({ statuses: ["draft", "approved"] }),
        list({ statuses: ["posted", "skipped", "expired"], limit: 200 }),
      ]);
      return queueSectionsOf([...todays, ...open, ...past], { today, life: options.life, now: options.now ?? new Date() });
    },

    /** Every draft and approved row of this company's, light (no words, no images): what the expiry check reads. */
    async openPosts(): Promise<OpenPost[]> {
      return db
        .select({ id: t.id, key: t.key, kind: t.kind, day: t.day, status: t.status })
        .from(t)
        .where(and(mine, inArray(t.status, ["draft", "approved"])));
    },

    /** This company's drafts and approved rows past their life, expired for good: how many changed. A posted or skipped one stays as it is. */
    async expire(ids: readonly string[]): Promise<number> {
      if (!ids.length) return 0;
      const rows = await db
        .update(t)
        .set({ status: "expired", updatedAt: new Date() })
        .where(and(mine, inArray(t.id, [...ids]), inArray(t.status, ["draft", "approved"])))
        .returning({ id: t.id });
      return rows.length;
    },

    /** One of this company's posts, or null (another company's is null too). */
    async get(id: string): Promise<QueuedPost | null> {
      if (typeof id !== "string" || id === "") return null;
      const [row] = await db
        .select()
        .from(t)
        .where(and(mine, eq(t.id, id)))
        .limit(1);
      return row ?? null;
    },

    /** A person's words (the text, the hook, the first comment), while the post is a draft or approved. From then on the builder leaves it alone. */
    async edit(id: string, changes: PostEdit): Promise<boolean> {
      const text = String(changes.text ?? "").trimEnd();
      if (!text.trim()) return false;
      const rows = await db
        .update(t)
        .set({
          text,
          hook: String(changes.hook ?? "").trim(),
          firstComment: changes.firstComment?.trim() || null,
          writtenBy: "person",
          updatedAt: new Date(),
          // "strict": the approval was for the words as they stood; new words wait for a new one.
          ...(strict ? { status: "draft" as const, approvedAt: null, approvedBy: null } : {}),
        })
        .where(and(mine, eq(t.id, id), inArray(t.status, ["draft", "approved"])))
        .returning({ id: t.id });
      return rows.length > 0;
    },

    /**
     * A draft's or an approved post's pictures, swapped for the same cards in
     * another look (social 0.6): false once it's been posted or skipped (what
     * went out stays as it went). Its words and their edit stamp are left as
     * they are, so what a person has typed on the screen isn't lost.
     */
    async setImages(id: string, images: readonly DraftImage[]): Promise<boolean> {
      const rows = await db
        .update(t)
        .set({ images: [...images] })
        .where(and(mine, eq(t.id, id), inArray(t.status, ["draft", "approved"])))
        .returning({ id: t.id });
      return rows.length > 0;
    },

    /** Drafts to approved: how many changed. `by` is who approved them. */
    async approve(ids: readonly string[], by: string | null = null): Promise<number> {
      const wanted = ids.filter((id) => typeof id === "string" && id !== "");
      if (!wanted.length) return 0;
      const now = new Date();
      const rows = await db
        .update(t)
        .set({ status: "approved", approvedAt: now, approvedBy: by, updatedAt: now })
        .where(and(mine, inArray(t.id, wanted), eq(t.status, "draft")))
        .returning({ id: t.id });
      return rows.length;
    },

    /**
     * Posted, with the link to the post. A posted one can be marked again, to
     * correct its link, and an expired one too: it went out after all (a
     * posting session that ran past midnight), and the record should say so.
     */
    async markPosted(id: string, url: string, by: string | null = null): Promise<boolean> {
      const link = String(url ?? "").trim();
      if (!isWebAddress(link)) return false;
      const now = new Date();
      const rows = await db
        .update(t)
        .set({ status: "posted", postedUrl: link, postedAt: now, postedBy: by, updatedAt: now })
        .where(and(mine, eq(t.id, id), postable))
        .returning({ id: t.id });
      return rows.length > 0;
    },

    /** Not going out: kept for the record, never rebuilt. */
    async skip(id: string): Promise<boolean> {
      const rows = await db
        .update(t)
        .set({ status: "skipped", updatedAt: new Date() })
        .where(and(mine, eq(t.id, id), inArray(t.status, ["draft", "approved"])))
        .returning({ id: t.id });
      return rows.length > 0;
    },
  };
}

export type PostStore = ReturnType<typeof postStore>;
