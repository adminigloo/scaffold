"use client";

import { groupPosts, type QueuePostView } from "../view.js";
import { PostCard, type QueueActions } from "./PostCard.js";
import { SocialStyles } from "./styles.js";

export type { ActionResult, QueueActions } from "./PostCard.js";

export interface PostQueueProps {
  /** The rows to show (../view.ts postView), any order: they're grouped into posts here. */
  readonly posts: readonly QueuePostView[];
  /** What its buttons do. None: read-only, for someone who may see the posts but not change them. */
  readonly actions?: QueueActions;
  /** Read-only even with actions: the same as passing none (social 0.1's prop, kept). */
  readonly readOnly?: boolean;
  /** The app's words for its kinds of post ({ launch: "Launch" }); the kind, capitalized, otherwise. */
  readonly kinds?: Readonly<Record<string, string>>;
  /** What to say when there's nothing to show. */
  readonly empty?: string;
}

const capitalized = (kind: string) => kind.charAt(0).toUpperCase() + kind.slice(1);

/**
 * THE QUEUE: one card per post (./PostCard.tsx), its platforms as tabs inside
 * it, with "Approve all" on each post. The app passes the rows and the
 * actions; nothing here fetches, so it works over a server action, tRPC or
 * plain fetch alike. Mobile first: the tabs and the images scroll sideways
 * inside their card, every button is a 44 px target, and nothing makes the
 * page scroll sideways.
 */
export function PostQueue({ posts, actions, readOnly = false, kinds, empty = "Nothing here." }: PostQueueProps) {
  const groups = groupPosts(posts);
  const allowed = readOnly ? undefined : actions;
  return (
    <div className="social social-queue">
      <SocialStyles />
      {groups.length === 0 ? <p className="social-empty">{empty}</p> : null}
      {groups.map((g) => (
        <PostCard key={g.key} post={g} actions={allowed} kindLabel={kinds?.[g.kind] ?? capitalized(g.kind)} />
      ))}
    </div>
  );
}
