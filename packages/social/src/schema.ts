import { randomBytes } from "node:crypto";
import { date, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { DraftImage, Facts, Platform, PostKind, PostStatus, WrittenBy } from "./types.js";

/**
 * THE QUEUE, IN THE APP'S OWN DATABASE (social 0.1): one draft per post per
 * platform, per company. Every row carries its company in a plain-text
 * `tenant_id` (no foreign key: the companies table lives in
 * @adminigloo/tenancy, and an app that installs only this package has its
 * own), and every query in ./store.ts filters on it: one company never reads,
 * refreshes, approves or forgets another's posts. "*" is the site's own
 * posts, in a project where the site posts for itself.
 *
 * A ROW'S LIFE: draft (the builder wrote it) → approved (a person said yes)
 * → posted (with the link to it), or skipped. The builder may refresh a
 * draft nobody has touched; anything a person edited, approved, posted or
 * skipped is theirs, and a rerun never writes over it.
 *
 * THE NAME COMES FROM A PREFIX (`defineSocialTables({ prefix })`), the
 * scaffold's rule since analytics 0.2 and audience 0.2: the default
 * `social_` makes `social_posts`; an app that already has a table of that
 * name picks another prefix (`aig_social_` → `aig_social_posts`) and gets
 * its own, independent table, its index names built from the same prefix.
 * sql/social-0.1.0.sql is the default's DDL, for an app without drizzle-kit.
 *
 * No @adminigloo/db: the id is made here (a UUID v7, the AdminIgloo
 * convention) so an app on any Postgres driver installs nothing else.
 */

/** A UUID v7: time-ordered, so a company's posts sort by when they were written. */
export function newSocialId(): string {
  const bytes = randomBytes(16);
  const ms = Date.now();
  bytes[0] = Math.floor(ms / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ms / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ms / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ms / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The default prefix: `social_posts`. */
export const DEFAULT_SOCIAL_PREFIX = "social_";

export class InvalidSocialPrefixError extends Error {
  readonly name = "InvalidSocialPrefixError";
}

export interface DefineSocialTablesOptions {
  /** Default "social_". Lower-case letters, digits and underscores, at most 32 characters; end it with "_". */
  readonly prefix?: string;
}

const ts = (name: string) => timestamp(name, { withTimezone: true });

/** The queue's table under `prefix`: its name and every index name are built from it. */
export function defineSocialTables(options: DefineSocialTablesOptions = {}) {
  const prefix = options.prefix ?? DEFAULT_SOCIAL_PREFIX;
  if (typeof prefix !== "string" || !/^[a-z_][a-z0-9_]*$/.test(prefix) || prefix.length > 32) {
    throw new InvalidSocialPrefixError(
      `@adminigloo/social: the table prefix must be lower-case letters, digits and underscores, at most 32 characters (got ${JSON.stringify(prefix)}).`,
    );
  }
  const name = (suffix: string) => `${prefix}${suffix}`;

  const posts = pgTable(
    name("posts"),
    {
      id: text("id").primaryKey().$defaultFn(newSocialId),
      /** The company this draft is for: every read and write is inside it. "*" is the site's own. */
      tenantId: text("tenant_id").notNull(),
      /** What it's about: "launch:mz3k1". One row per company, key and platform. */
      key: text("key").notNull(),
      kind: text("kind").$type<PostKind>().notNull(),
      platform: text("platform").$type<Platform>().notNull(),
      /** Who's speaking: the business's name, or a person's. */
      author: text("author").notNull(),
      /** The day it's meant to go out, in the business's own time zone. */
      day: date("day", { mode: "string" }).notNull(),
      /** What gets posted, in the platform's format. */
      text: text("text").notNull(),
      /** The line on the image (and the first line of the text where the platform opens with it). */
      hook: text("hook").notNull(),
      /** The images to attach, in order: one card, or a carousel. */
      images: jsonb("images").$type<readonly DraftImage[]>().notNull(),
      /** What to post as the first reply: the link, where the platform wants it there. */
      firstComment: text("first_comment"),
      /** The app's own draft for this platform, to go back to. */
      templateText: text("template_text").notNull(),
      writtenBy: text("written_by").$type<WrittenBy>().notNull(),
      /** Why the template went in place of the AI's words, when it did. */
      note: text("note"),
      linkUrl: text("link_url"),
      /** The facts the words were written from: the only numbers the AI was allowed. */
      facts: jsonb("facts").$type<Facts>().notNull(),
      status: text("status").$type<PostStatus>().notNull().default("draft"),
      /** The post itself, on the platform, once it's up. */
      postedUrl: text("posted_url"),
      /** Who wrote it (composed it, or the builder: null), who approved it, who marked it posted. */
      createdBy: text("created_by"),
      approvedBy: text("approved_by"),
      postedBy: text("posted_by"),
      createdAt: ts("created_at").notNull().defaultNow(),
      updatedAt: ts("updated_at").notNull().defaultNow(),
      approvedAt: ts("approved_at"),
      postedAt: ts("posted_at"),
    },
    (t) => [
      uniqueIndex(name("posts_tenant_key_platform_uidx")).on(t.tenantId, t.key, t.platform),
      index(name("posts_tenant_status_idx")).on(t.tenantId, t.status),
      index(name("posts_tenant_day_idx")).on(t.tenantId, t.day),
    ],
  );

  return { posts };
}

export type SocialTables = ReturnType<typeof defineSocialTables>;
export type SocialPostTable = SocialTables["posts"];
export type SocialPostRow = SocialPostTable["$inferSelect"];

/** The default set: `social_posts`. */
export const socialTables: SocialTables = defineSocialTables();
export const socialPosts: SocialPostTable = socialTables.posts;
