"use client";

import { useState } from "react";
import { PLATFORM_IDS, POST_STATUSES, type PostStatus } from "../types.js";
import type { QueuePostView } from "../view.js";
import { attempt, PostCard, type QueueActions } from "./PostCard.js";
import { SocialStyles } from "./styles.js";

export type { ActionResult, QueueActions } from "./PostCard.js";

const FILTER_LABEL: Readonly<Record<PostStatus | "all", string>> = { all: "All", draft: "Drafts", approved: "Approved", posted: "Posted", skipped: "Skipped" };

export interface PostQueueProps {
  readonly posts: readonly QueuePostView[];
  readonly actions: QueueActions;
  /** Show the status filter (the day's queue); off for a list that's one status already. */
  readonly filter?: boolean;
  /** The label of the button that approves every draft shown ("Approve all for today"); none: no button. */
  readonly approveAllLabel?: string;
  readonly empty?: string;
  /** Someone who may look but not change: no edits, approvals, skips or "Mark posted". */
  readonly readOnly?: boolean;
}

/**
 * THE QUEUE: each post's platforms together under what it's about, one card
 * per platform. The app passes the posts and the actions; nothing here
 * fetches, so it works over a server action, tRPC or plain fetch alike.
 * Each card takes the server's new version when its row changes (its key).
 */
export function PostQueue({ posts, actions, filter = false, approveAllLabel, empty = "Nothing here.", readOnly = false }: PostQueueProps) {
  const [status, setStatus] = useState<PostStatus | "all">("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = status === "all" ? posts : posts.filter((p) => p.status === status);
  const drafts = posts.filter((p) => p.status === "draft");

  const groups: { key: string; posts: QueuePostView[] }[] = [];
  for (const p of shown) {
    const group = groups.find((g) => g.key === p.key);
    if (group) group.posts.push(p);
    else groups.push({ key: p.key, posts: [p] });
  }
  for (const g of groups) g.posts.sort((a, b) => PLATFORM_IDS.indexOf(a.platform) - PLATFORM_IDS.indexOf(b.platform));

  const approveAll = async () => {
    setBusy(true);
    setError(null);
    setError(await attempt(() => actions.approve(drafts.map((d) => d.id))));
    setBusy(false);
  };
  const showApproveAll = Boolean(approveAllLabel && drafts.length && !readOnly);

  return (
    <div className="social social-queue">
      <SocialStyles />
      {filter || showApproveAll ? (
        <div className="social-toolbar">
          {filter ? (
            <div className="social-filter" role="group" aria-label="Show">
              {(["all", ...POST_STATUSES] as const).map((s) => (
                <button key={s} type="button" className="social-button" aria-pressed={status === s} onClick={() => setStatus(s)}>
                  {FILTER_LABEL[s]} ({s === "all" ? posts.length : posts.filter((p) => p.status === s).length})
                </button>
              ))}
            </div>
          ) : null}
          {showApproveAll ? (
            <button type="button" className="social-button social-button-primary" disabled={busy} onClick={approveAll}>
              {busy ? "Approving…" : `${approveAllLabel} (${drafts.length})`}
            </button>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p className="social-error" role="alert">
          {error}
        </p>
      ) : null}
      {groups.length === 0 ? <p className="social-empty">{empty}</p> : null}
      {groups.map((g) => (
        <section key={g.key} className="social-group" aria-label={g.posts[0]!.title}>
          <h3 className="social-group-title">
            {g.posts[0]!.title}
            <span className="social-group-meta">
              {g.posts[0]!.author} · {g.posts[0]!.day}
            </span>
          </h3>
          <div className="social-cards">
            {g.posts.map((p) => (
              <PostCard key={`${p.id}:${p.updatedAt}`} post={p} actions={actions} readOnly={readOnly} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
