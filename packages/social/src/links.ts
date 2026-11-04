import type { Platform, PostKind } from "./types.js";

/**
 * EVERY POST'S LINK, TAGGED (Oct 31, 2026: the marketer review, change 2).
 * A tag is a label on a link that says where the click came from, and it
 * can't be added after the post is out: so the writer (./writer.ts,
 * `tagLinks`) puts one on the link of every draft it builds, in the place
 * the platform shows it (the first comment on X and LinkedIn, the text
 * elsewhere), and never on an image. An app whose own visit numbers read
 * the standard tags then knows which platform, which kind of post and which
 * post brought each visit:
 *
 *   utm_source    the platform's id ("x", "threads", "bluesky", ...)
 *   utm_medium    "social"
 *   utm_campaign  the post's kind ("results", "board", "launch")
 *   utm_content   the post's key ("results:2026-10-26")
 *
 * Pure: no app, no framework.
 */

/** What every post's link says it is: a social post. */
export const SOCIAL_MEDIUM = "social";

/** The four standard tags a link carries. */
export interface LinkTags {
  readonly source: string;
  readonly medium: string;
  readonly campaign: string;
  readonly content: string;
}

/** The tags for one post on one platform. */
export function postLinkTags(platform: Platform, post: { readonly kind: PostKind; readonly key: string }): LinkTags {
  return { source: platform, medium: SOCIAL_MEDIUM, campaign: post.kind, content: post.key };
}

/**
 * The address with its tags: any tag it already had replaced (never two
 * utm_source on one link), every other part kept as it was (the path, its
 * own query, the #part after the tags). An address that can't be read as
 * one (a relative path) comes back as it was: an untagged link still works.
 */
export function taggedLink(url: string, tags: LinkTags): string {
  let address: URL;
  try {
    address = new URL(url);
  } catch {
    return url;
  }
  if (address.protocol !== "http:" && address.protocol !== "https:") return url;
  for (const name of [...address.searchParams.keys()]) if (name.toLowerCase().startsWith("utm_")) address.searchParams.delete(name);
  address.searchParams.set("utm_source", tags.source);
  address.searchParams.set("utm_medium", tags.medium);
  address.searchParams.set("utm_campaign", tags.campaign);
  address.searchParams.set("utm_content", tags.content);
  return address.toString();
}

/** The tags a link carries, or null where it has no utm_source: for the tests, and for a screen that shows them. */
export function linkTagsOf(url: string): LinkTags | null {
  try {
    const q = new URL(url).searchParams;
    const source = q.get("utm_source");
    return source === null ? null : { source, medium: q.get("utm_medium") ?? "", campaign: q.get("utm_campaign") ?? "", content: q.get("utm_content") ?? "" };
  } catch {
    return null;
  }
}
