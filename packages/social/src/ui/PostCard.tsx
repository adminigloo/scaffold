"use client";

import { useState } from "react";
import { composeUrl, HOOK_MAX, measure, PLATFORMS } from "../platforms.js";
import type { PostEdit } from "../types.js";
import type { QueuePostView } from "../view.js";

/**
 * What an action answers: nothing when it worked, or a message for the
 * person. A message, not a throw, because a server action's thrown message
 * never reaches the browser in production; a throw still shows as a
 * general failure.
 */
export type ActionResult = void | { readonly error: string };

/**
 * What a card can ask the app to do. Plain async functions, so a tRPC
 * mutation, a server action or a fetch (./client.ts) all fit. The app
 * refreshes the queue after each.
 */
export interface QueueActions {
  readonly save: (id: string, edit: PostEdit) => Promise<ActionResult>;
  readonly approve: (ids: string[]) => Promise<ActionResult>;
  readonly markPosted: (id: string, url: string) => Promise<ActionResult>;
  readonly skip: (id: string) => Promise<ActionResult>;
}

/** An action's message for the person, or null when it worked. */
export function messageOf(result: ActionResult): string | null {
  return typeof result === "object" && result !== null ? result.error : null;
}

/** Run an action for a button: its message, or a general one when it threw. */
export async function attempt(task: () => Promise<ActionResult>): Promise<string | null> {
  try {
    return messageOf(await task());
  } catch {
    return "That didn't work. Try again.";
  }
}

const STATUS_LABEL = { draft: "Draft", approved: "Approved", posted: "Posted", skipped: "Skipped" } as const;
const WRITER_LABEL = { ai: "AI", "ai-aside": "AI hook & aside", template: "Template", person: "Edited" } as const;

/** Copy a text, saying so for two seconds. */
function CopyButton({ text, label = "Copy" }: { readonly text: string; readonly label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="social-button"
      onClick={() =>
        navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          })
          .catch(() => setCopied(false))
      }
    >
      {copied ? "Copied" : label}
    </button>
  );
}

/**
 * One platform's draft: its images in posting order, the hook on them, the
 * text (editable until it's posted or skipped) with the live count, the
 * first comment, the link, and what to do next. `readOnly` (someone who may
 * look but not change) keeps Copy and Open, and nothing that writes.
 */
export function PostCard({ post, actions, readOnly = false }: { readonly post: QueuePostView; readonly actions: QueueActions; readonly readOnly?: boolean }) {
  const rule = PLATFORMS[post.platform];
  const [text, setText] = useState(post.text);
  const [hook, setHook] = useState(post.hook);
  const [comment, setComment] = useState(post.firstComment ?? "");
  const [url, setUrl] = useState(post.postedUrl ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = post.status === "draft" || post.status === "approved";
  const editable = open && !readOnly;
  const dirty = text !== post.text || hook !== post.hook || comment !== (post.firstComment ?? "");
  const m = measure(post.platform, text);
  const hookLength = [...hook.trim()].length;
  const compose = open ? composeUrl(post.platform, text) : null;
  const edit: PostEdit = { text, hook, firstComment: comment || null };

  const run = async (what: string, task: () => Promise<ActionResult>) => {
    setBusy(what);
    setError(null);
    setError(await attempt(task));
    setBusy(null);
  };

  return (
    <article className="social-card" data-status={post.status} aria-label={`${rule.name} post`}>
      <header className="social-card-head">
        <span className="social-platform">{rule.name}</span>
        <span className="social-chip" data-status={post.status}>
          {STATUS_LABEL[post.status]}
        </span>
        <span className="social-chip" data-writer={post.writtenBy}>
          {WRITER_LABEL[post.writtenBy]}
        </span>
      </header>

      {post.images.length ? (
        <ol className="social-images" aria-label={post.images.length > 1 ? `${post.images.length} images, in posting order` : "The image to attach"}>
          {post.images.map((image, i) => (
            <li key={`${i}:${image.url}`} className="social-image">
              {/* The thumbnail opens the full image, as stored: a signed address is used as it was built. */}
              <a href={image.url} target="_blank" rel="noopener noreferrer" title={`Open the full image${post.images.length > 1 ? ` (${i + 1} of ${post.images.length})` : ""}`}>
                {/* A plain <img>: this card drops into any React app, so no framework image component. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={image.url} alt={image.alt} width={image.width} height={image.height} loading="lazy" />
              </a>
              <span>{post.images.length > 1 ? `${i + 1} of ${post.images.length}` : `${image.width} × ${image.height}`}</span>
            </li>
          ))}
        </ol>
      ) : null}

      <label className="social-field">
        <span>
          The hook, on the image ({hookLength} of {HOOK_MAX})
        </span>
        {editable ? <input value={hook} onChange={(e) => setHook(e.target.value)} aria-invalid={hookLength > HOOK_MAX || undefined} /> : <span className="social-hook">{post.hook}</span>}
      </label>

      {editable ? (
        <textarea className="social-text" value={text} rows={Math.min(14, Math.max(4, text.split("\n").length + 1))} aria-label={`${rule.name} post text`} onChange={(e) => setText(e.target.value)} />
      ) : (
        <pre className="social-text">{text}</pre>
      )}
      <p className="social-count" data-over={m.fits ? undefined : "true"}>
        {m.title ? `Title ${m.title.length} of ${m.title.max} · body ` : ""}
        {m.length.toLocaleString("en-US")} of {m.max.toLocaleString("en-US")}
        {rule.counting === "x" ? " (X counts each link as 23)" : ""}
      </p>
      {post.note ? <p className="social-note">{post.note}.</p> : null}

      {post.firstComment !== null || comment ? (
        <div className="social-comment">
          <label className="social-field">
            <span>First comment (post it as the first reply)</span>
            {editable ? <input value={comment} onChange={(e) => setComment(e.target.value)} /> : <span>{post.firstComment}</span>}
          </label>
          <CopyButton text={comment} label="Copy comment" />
        </div>
      ) : null}

      {post.linkUrl ? (
        <p className="social-link">
          Links to{" "}
          <a href={post.linkUrl} target="_blank" rel="noopener noreferrer">
            {post.linkUrl.replace(/^https?:\/\//, "")}
          </a>
          {rule.linkIn === "comment" ? ", in the first comment" : rule.linkIn === "bio" ? ", from the profile's bio" : ""}
        </p>
      ) : null}
      {post.postedUrl ? (
        <p className="social-posted">
          Posted:{" "}
          <a href={post.postedUrl} target="_blank" rel="noopener noreferrer">
            {post.postedUrl.replace(/^https?:\/\//, "")}
          </a>
        </p>
      ) : null}

      <div className="social-actions">
        {editable && dirty ? (
          <button type="button" className="social-button" disabled={busy !== null} onClick={() => run("save", () => actions.save(post.id, edit))}>
            {busy === "save" ? "Saving…" : "Save edits"}
          </button>
        ) : null}
        {post.status === "draft" && !readOnly ? (
          <button
            type="button"
            className="social-button social-button-primary"
            disabled={busy !== null || !m.fits || hookLength > HOOK_MAX}
            onClick={() =>
              run("approve", async () => {
                const refused = dirty ? messageOf(await actions.save(post.id, edit)) : null;
                return refused ? { error: refused } : actions.approve([post.id]);
              })
            }
          >
            {busy === "approve" ? "Approving…" : "Approve"}
          </button>
        ) : null}
        <CopyButton text={text} label="Copy text" />
        {compose ? (
          <a className="social-button" href={compose} target="_blank" rel="noopener noreferrer">
            Open {rule.name}
          </a>
        ) : null}
        {editable ? (
          <button type="button" className="social-button social-button-quiet" disabled={busy !== null} onClick={() => run("skip", () => actions.skip(post.id))}>
            {busy === "skip" ? "Skipping…" : "Skip"}
          </button>
        ) : null}
      </div>

      {!readOnly && (open || post.status === "posted") ? (
        <form
          className="social-posted-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run("posted", () => actions.markPosted(post.id, url));
          }}
        >
          <label className="social-field">
            <span>{post.status === "posted" ? "Correct the post's link" : "Posted? Paste the post's link"}</span>
            <input type="url" required value={url} placeholder={`https://… (the ${rule.name} post)`} onChange={(e) => setUrl(e.target.value)} />
          </label>
          <button type="submit" className="social-button" disabled={busy !== null || !url.trim()}>
            {busy === "posted" ? "Saving…" : "Mark posted"}
          </button>
        </form>
      ) : null}
      {error ? (
        <p className="social-error" role="alert">
          {error}
        </p>
      ) : null}
    </article>
  );
}
