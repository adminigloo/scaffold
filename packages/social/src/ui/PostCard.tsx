"use client";

import { useId, useRef, useState, type KeyboardEvent } from "react";
import { isOpen } from "../expiry.js";
import { composeUrl, HOOK_MAX, measure, PLATFORMS } from "../platforms.js";
import type { Platform, PostEdit, PostStatus } from "../types.js";
import { dayText, postAnchor, type PostGroupView, type QueuePostView } from "../view.js";
import { ShareImages } from "./share.js";
import { MakeVideo } from "./video.js";
import { useImageViewer, viewOnPlainClick, type ViewerImage } from "./viewer.js";
import type { LookChoices } from "../wire.js";
import { LookControls } from "./LookControls.js";

/**
 * What an action answers: nothing when it worked, or a message for the
 * person. A message, not a throw, because a server action's thrown message
 * never reaches the browser in production; a throw still shows as a
 * general failure.
 */
export type ActionResult = void | { readonly error: string };

/**
 * What a card can ask the app to do. Plain async functions, so a tRPC
 * mutation, a server action or a fetch all fit. The app refreshes the
 * queue after each.
 */
export interface QueueActions {
  readonly save: (id: string, edit: PostEdit) => Promise<ActionResult>;
  readonly approve: (ids: string[]) => Promise<ActionResult>;
  readonly markPosted: (id: string, url: string) => Promise<ActionResult>;
  readonly skip: (id: string) => Promise<ActionResult>;
  /** A post's pictures in another look (social 0.6): `id` is any one of its platforms; all of them change. */
  readonly restyle?: (id: string, look: string) => Promise<ActionResult>;
}

/** The site a picture comes from ("staging.example.com"), or "" when it has none. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** The look a post's cards wear: the `look` in its first card's signed address ("" for none). */
export function lookOf(images: readonly { readonly url: string }[]): string {
  const first = images[0];
  if (!first) return "";
  try {
    return new URL(first.url, "https://card.invalid").searchParams.get("look") ?? "";
  } catch {
    return "";
  }
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

export const STATUS_LABEL: Readonly<Record<PostStatus, string>> = { draft: "Draft", approved: "Approved", posted: "Posted", skipped: "Skipped", expired: "Expired" };
const WRITER_LABEL = { ai: "AI", "ai-aside": "AI hook & aside", template: "Template", person: "Edited" } as const;

/** "3 approved", "1 draft", "5 drafts": a post's status summary, a chip each. */
export function statusCount(status: PostStatus, count: number): string {
  return status === "draft" ? `${count} ${count === 1 ? "draft" : "drafts"}` : `${count} ${STATUS_LABEL[status].toLowerCase()}`;
}

/** What a person has typed on one platform, over the version of the row it started from. */
interface Typed {
  readonly base: string;
  readonly text: string;
  readonly hook: string;
  readonly comment: string;
  readonly url: string;
}

const asStored = (p: QueuePostView): Typed => ({ base: p.updatedAt, text: p.text, hook: p.hook, comment: p.firstComment ?? "", url: p.postedUrl ?? "" });
const edited = (t: Typed, p: QueuePostView) => t.text !== p.text || t.hook !== p.hook || t.comment !== (p.firstComment ?? "");
const editOf = (t: Typed): PostEdit => ({ text: t.text, hook: t.hook, firstComment: t.comment || null });
/**
 * How many rows a text needs, wrapped at about a phone's width (36 characters of the monospace at
 * 16 px): a text box sized by its line breaks alone hid most of a long line on a phone.
 */
const rowsFor = (text: string, most = 16) => Math.min(most, Math.max(4, text.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil([...line].length / 36)), 0) + 1));

/** Can it go out as typed: the text within the platform's limit, the hook short enough? */
const fitsAsTyped = (p: QueuePostView, t: Typed) => measure(p.platform, t.text).fits && [...t.hook.trim()].length <= HOOK_MAX;

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

/** A platform's images as the viewer shows them: the slide number on each of a carousel's. */
function viewerImages(images: QueuePostView["images"], name: string): ViewerImage[] {
  return images.map((image, i) => ({ ...image, label: images.length > 1 ? `${name}, ${i + 1} of ${images.length}` : name }));
}

/** A platform's images in posting order, each opening the viewer (social 0.5): a strip that scrolls sideways for a carousel. */
function Images({ images, label, onView }: { readonly images: QueuePostView["images"]; readonly label: string; readonly onView: (start: number) => void }) {
  return (
    <ol className="social-images" aria-label={label}>
      {images.map((image, i) => (
        <li key={`${i}:${image.url}`} className="social-image">
          {/* The thumbnail opens the viewer; its address is the full image as stored, for a Ctrl/Cmd-click. */}
          <a href={image.url} target="_blank" rel="noreferrer" title={`View the image${images.length > 1 ? ` (${i + 1} of ${images.length})` : ""}`} onClick={viewOnPlainClick(() => onView(i))}>
            {/* A plain <img>: this card drops into any React app, so no framework image component. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={image.url} alt={image.alt} width={image.width} height={image.height} loading="lazy" />
          </a>
          {images.length > 1 ? <span>{`${i + 1} of ${images.length}`}</span> : null}
        </li>
      ))}
    </ol>
  );
}

/**
 * ONE POST, ONE CARD (the founder, Oct 28, 2026: a card per platform read
 * as the same post over and over). What it's about, once: its kind, day and
 * host, the hook, where each platform stands, and each different set of
 * images. Then a tab per platform with that platform's text (editable), its
 * images in posting order, its first comment and what to do next. "Approve
 * all" approves every draft of the post, saving what's been typed first.
 * What's typed stays while you move between tabs; a row the server changes
 * comes back as the server has it.
 *
 * READ-ONLY WITHOUT ACTIONS: for someone who may see the posts but not
 * change them, the card is the same post to read and copy, with no box to
 * type in and none of the buttons that change it (each would only come back
 * refused).
 */
export function PostCard({ post, actions, kindLabel, looks }: { readonly post: PostGroupView; readonly actions?: QueueActions; readonly kindLabel: string; readonly looks?: LookChoices }) {
  const uid = useId();
  const firstToDo = post.platforms.find((p) => p.status === "draft") ?? post.platforms.find((p) => p.status === "approved") ?? post.platforms[0]!;
  const [chosen, setChosen] = useState<Platform>(firstToDo.platform);
  const [typed, setTyped] = useState<Readonly<Record<string, Typed>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ readonly where: string; readonly message: string } | null>(null);
  const tabs = useRef(new Map<Platform, HTMLButtonElement>());
  const { open: openViewer, viewer } = useImageViewer();
  /* The overview opens every image the post has, each set once, so they can be stepped through or set side by side. */
  const allImages: ViewerImage[] = post.imageSets.flatMap((set) => {
    const name = set.platforms.map((p) => PLATFORMS[p].name).join(" · ");
    return set.images.map((image, i) => ({ ...image, label: set.images.length > 1 ? `${name}, ${i + 1} of ${set.images.length}` : name }));
  });

  const selected = post.platforms.find((p) => p.platform === chosen) ?? post.platforms[0]!;
  const typedOn = (p: QueuePostView): Typed => {
    const t = typed[p.id];
    return t && t.base === p.updatedAt ? t : asStored(p);
  };
  const type = (p: QueuePostView, change: Partial<Omit<Typed, "base">>) => setTyped((all) => ({ ...all, [p.id]: { ...typedOn(p), ...change } }));

  const run = async (where: string, what: string, task: () => Promise<ActionResult>) => {
    setBusy(`${where}:${what}`);
    setError(null);
    const message = await attempt(task);
    if (message) setError({ where, message });
    setBusy(null);
  };

  const waiting = post.platforms.filter((p) => p.status === "draft");
  const over = waiting.filter((p) => !fitsAsTyped(p, typedOn(p)));
  const approveAll = (can: QueueActions) =>
    run("all", "approve", async () => {
      // What's typed is saved first, so what's approved is what's on screen.
      for (const p of waiting) {
        const t = typedOn(p);
        if (!edited(t, p)) continue;
        const refused = messageOf(await can.save(p.id, editOf(t)));
        if (refused) return { error: `${PLATFORMS[p.platform].name}: ${refused}` };
      }
      return can.approve(waiting.map((p) => p.id));
    });

  const choose = (platform: Platform, focus: boolean) => {
    setChosen(platform);
    if (!focus) return;
    const tab = tabs.current.get(platform);
    tab?.focus();
    tab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const last = post.platforms.length - 1;
    const to = e.key === "ArrowRight" ? (i === last ? 0 : i + 1) : e.key === "ArrowLeft" ? (i === 0 ? last : i - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : null;
    if (to === null) return;
    e.preventDefault();
    choose(post.platforms[to]!.platform, true);
  };

  const panel = `${uid}-panel`;
  const tabId = (p: Platform) => `${uid}-tab-${p}`;

  /* The Look picker (social 0.6): the app's looks, for a post with pictures still to post; it redraws every platform's. */
  const currentLook = lookOf(post.imageSets[0]?.images ?? []);
  const changeable = post.platforms.find((p) => (p.status === "draft" || p.status === "approved") && p.images.length > 0);
  // Pictures another server made can't be redrawn here (social 0.7.1): the controls stay, switched off, saying where.
  const redrawable = post.platforms.filter((p) => (p.status === "draft" || p.status === "approved") && p.images.length > 0);
  const elsewhere = redrawable.length > 0 && redrawable.every((p) => p.canRestyle === false) ? hostOf(redrawable[0]!.images[0]!.url) : null;
  const lookPicker = looks?.options.length && actions?.restyle && changeable ? { id: changeable.id, restyle: actions.restyle, choices: looks, elsewhere } : null;

  return (
    <article className="social-post" id={postAnchor(post.key)} data-open={post.open || undefined} aria-label={`${kindLabel}, ${dayText(post.day)}`}>
      <header className="social-post-head">
        <p className="social-post-meta">
          <span className="social-post-kind">{kindLabel}</span> · {dayText(post.day)} · {post.author}
        </p>
        <h3 className="social-post-hook">{post.hook}</h3>
        {post.title !== post.hook ? <p className="social-post-title">{post.title}</p> : null}
        <ul className="social-summary" aria-label="Where its platforms stand">
          {post.summary.map((s) => (
            <li key={s.status} className="social-chip" data-status={s.status}>
              {statusCount(s.status, s.count)}
            </li>
          ))}
        </ul>
        {post.open && post.expiresLabel ? <p className="social-note">{post.expiresLabel}.</p> : null}
      </header>

      {post.imageSets.length ? (
        <ul className="social-sets" aria-label="Its images, each set once">
          {post.imageSets.map((set, setIndex) => {
            const lead = set.images[0]!;
            const start = post.imageSets.slice(0, setIndex).reduce((n, earlier) => n + earlier.images.length, 0);
            return (
              <li key={lead.url} className="social-set">
                <a href={lead.url} target="_blank" rel="noreferrer" title="View the images" onClick={viewOnPlainClick(() => openViewer(allImages, start))}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={lead.url} alt={lead.alt} width={lead.width} height={lead.height} loading="lazy" />
                </a>
                <span>
                  {set.platforms.map((p) => PLATFORMS[p].name).join(" · ")}
                  {set.images.length > 1 ? ` · ${set.images.length} slides` : ""}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}

      {lookPicker ? (
        <div className="social-look-row">
          <LookControls
            id={`${uid}-look`}
            choices={lookPicker.choices}
            value={currentLook}
            disabled={busy !== null || lookPicker.elsewhere !== null}
            onChange={(next) => {
              if (next !== currentLook) void run("look", "restyle", () => lookPicker.restyle(lookPicker.id, next));
            }}
          />
          {busy === "look:restyle" ? (
            <span className="social-note" role="status">
              Redrawing the pictures…
            </span>
          ) : null}
          {lookPicker.elsewhere !== null ? (
            <p className="social-note">
              {lookPicker.elsewhere
                ? `Its pictures were drawn by ${lookPicker.elsewhere}, so its look can be changed there, not here.`
                : "Its pictures were drawn somewhere else, so its look can be changed there, not here."}
            </p>
          ) : null}
        </div>
      ) : null}
      {error?.where === "look" ? (
        <p className="social-error" role="alert">
          {error.message}
        </p>
      ) : null}

      {waiting.length && actions ? (
        <div className="social-post-actions">
          <button type="button" className="social-button social-button-primary" disabled={busy !== null || over.length > 0} onClick={() => approveAll(actions)}>
            {busy === "all:approve" ? "Approving…" : `Approve all (${waiting.length})`}
          </button>
          {over.length ? <p className="social-note">Shorten {over.map((p) => PLATFORMS[p.platform].name).join(" and ")} first: over the limit.</p> : null}
        </div>
      ) : null}
      {error?.where === "all" ? (
        <p className="social-error" role="alert">
          {error.message}
        </p>
      ) : null}

      <div className="social-tabs" role="tablist" aria-label="Platforms">
        {post.platforms.map((p, i) => {
          const on = p.platform === selected.platform;
          return (
            <button
              key={p.id}
              ref={(el) => {
                if (el) tabs.current.set(p.platform, el);
                else tabs.current.delete(p.platform);
              }}
              id={tabId(p.platform)}
              type="button"
              role="tab"
              className="social-tab"
              aria-selected={on}
              aria-controls={panel}
              tabIndex={on ? 0 : -1}
              data-status={p.status}
              onClick={() => choose(p.platform, false)}
              onKeyDown={(e) => onTabKey(e, i)}
            >
              <span className="social-tab-mark" aria-hidden="true" />
              {PLATFORMS[p.platform].name}
              <span className="social-sr">{`, ${STATUS_LABEL[p.status].toLowerCase()}`}</span>
            </button>
          );
        })}
      </div>

      <div className="social-panel" role="tabpanel" id={panel} aria-labelledby={tabId(selected.platform)}>
        <PlatformPanel
          post={selected}
          typed={typedOn(selected)}
          onType={(change) => type(selected, change)}
          busy={busy}
          error={error?.where === selected.id ? error.message : null}
          run={(what, task) => run(selected.id, what, task)}
          actions={actions}
          onViewImages={(start) => openViewer(viewerImages(selected.images, PLATFORMS[selected.platform].name), start)}
        />
      </div>
      {viewer}
    </article>
  );
}

/** One platform of a post: what goes out there and what to do next. */
function PlatformPanel({
  post,
  typed,
  onType,
  busy,
  error,
  run,
  actions,
  onViewImages,
}: {
  readonly post: QueuePostView;
  readonly typed: Typed;
  readonly onType: (change: Partial<Omit<Typed, "base">>) => void;
  readonly busy: string | null;
  readonly error: string | null;
  readonly run: (what: string, task: () => Promise<ActionResult>) => Promise<void>;
  /** None for someone who may only read the posts: nothing to type in, no button that changes one. */
  readonly actions?: QueueActions;
  /** Opens the viewer on this platform's images, at one of them. */
  readonly onViewImages: (start: number) => void;
}) {
  const rule = PLATFORMS[post.platform];
  const open = isOpen(post.status);
  const editing = open && actions !== undefined;
  const dirty = editing && edited(typed, post);
  const m = measure(post.platform, typed.text);
  const hookLength = [...typed.hook.trim()].length;
  const compose = editing ? composeUrl(post.platform, typed.text) : null;
  const working = (what: string) => busy === `${post.id}:${what}`;
  const anyBusy = busy !== null;
  const markLabel = post.status === "posted" ? "Correct the post's link" : post.status === "expired" ? "Posted after all? Paste the post's link" : "Posted? Paste the post's link";

  return (
    <>
      <div className="social-panel-head">
        <span className="social-chip" data-status={post.status}>
          {STATUS_LABEL[post.status]}
        </span>
        <span className="social-chip" data-writer={post.writtenBy}>
          {WRITER_LABEL[post.writtenBy]}
        </span>
      </div>

      {post.images.length ? (
        <Images
          images={post.images}
          label={post.images.length > 1 ? `${rule.name}: ${post.images.length} images, in posting order` : `${rule.name}: the image to attach`}
          onView={onViewImages}
        />
      ) : null}

      <label className="social-field">
        <span>The hook, on the image ({hookLength} of {HOOK_MAX})</span>
        {editing ? (
          // Two rows, not one: a 90-character hook shows whole on a phone. One line all the same: a line break typed is a space.
          <textarea className="social-hook-input" rows={2} value={typed.hook} onChange={(e) => onType({ hook: e.target.value.replace(/\s*\n\s*/g, " ") })} aria-invalid={hookLength > HOOK_MAX || undefined} />
        ) : (
          <span className="social-hook">{post.hook}</span>
        )}
      </label>

      {editing ? (
        <textarea className="social-text" value={typed.text} rows={rowsFor(typed.text)} aria-label={`${rule.name} post text`} onChange={(e) => onType({ text: e.target.value })} />
      ) : (
        <pre className="social-text social-text-done">{post.text}</pre>
      )}
      <p className="social-count" data-over={m.fits ? undefined : "true"}>
        {m.title ? `Title ${m.title.length} of ${m.title.max} · body ` : ""}
        {m.length.toLocaleString("en-US")} of {m.max.toLocaleString("en-US")}
        {rule.counting === "x" ? " (X counts each link as 23)" : ""}
      </p>
      {post.note ? <p className="social-note">{post.note}.</p> : null}

      {post.firstComment !== null || typed.comment ? (
        <div className="social-comment">
          <label className="social-field">
            <span>First comment (post it as the first reply)</span>
            {editing ? <input value={typed.comment} onChange={(e) => onType({ comment: e.target.value })} /> : <span>{post.firstComment}</span>}
          </label>
          <CopyButton text={typed.comment} label="Copy comment" />
        </div>
      ) : null}

      {post.linkUrl ? (
        <p className="social-link">
          Links to{" "}
          <a href={post.linkUrl} target="_blank" rel="noreferrer">
            {post.linkUrl.replace(/^https?:\/\//, "").replace(/\?.*$/, "")}
          </a>
          {rule.linkIn === "comment"
            ? ", in the first comment"
            : rule.linkIn === "bio"
              ? ", from the profile's bio"
              : rule.linkIn === "card"
                ? `, as a link card: paste the link in ${rule.name}'s composer, wait for the card, then delete the address`
                : ""}
        </p>
      ) : null}
      {post.linkUrl && rule.linkIn === "card" ? <CopyButton text={post.linkUrl} label="Copy link" /> : null}
      {post.postedUrl ? (
        <p className="social-posted">
          Posted:{" "}
          <a href={post.postedUrl} target="_blank" rel="noreferrer">
            {post.postedUrl.replace(/^https?:\/\//, "")}
          </a>
        </p>
      ) : null}
      {post.status === "expired" ? <p className="social-note">Expired{post.expiresLabel ? ` (it was ${post.expiresLabel.charAt(0).toLowerCase()}${post.expiresLabel.slice(1)})` : ""}: it&rsquo;s no longer offered for posting.</p> : null}

      {rule.captionOnly ? (
        <p className="social-note">
          In {rule.name}: the pictures open as a slideshow, or make them a video (videos get more engagement there). If {rule.name} isn&rsquo;t in the share list, save them to your photos and pick them in {rule.name}. Add a sound from {rule.name}&rsquo;s library, paste the caption, then post.
        </p>
      ) : post.images.length ? (
        <p className="social-note">
          For a post that moves: Make a video, then upload the video in {rule.name} in place of the {post.images.length > 1 ? "pictures" : "picture"}. A pasted or uploaded picture stays still.
        </p>
      ) : null}
      <div className="social-actions">
        {post.status === "draft" && actions ? (
          <button
            type="button"
            className="social-button social-button-primary"
            disabled={anyBusy || !fitsAsTyped(post, typed)}
            onClick={() =>
              run("approve", async () => {
                const refused = dirty ? messageOf(await actions.save(post.id, editOf(typed))) : null;
                return refused ? { error: refused } : actions.approve([post.id]);
              })
            }
          >
            {working("approve") ? "Approving…" : "Approve"}
          </button>
        ) : null}
        {dirty && actions ? (
          <button type="button" className="social-button" disabled={anyBusy} onClick={() => run("save", () => actions.save(post.id, editOf(typed)))}>
            {working("save") ? "Saving…" : "Save edits"}
          </button>
        ) : null}
        <CopyButton text={typed.text} label="Copy text" />
        <ShareImages postKey={post.key} platform={post.platform} images={post.images} text={typed.text} />
        {post.images.length ? <MakeVideo postKey={post.key} platform={post.platform} images={post.images} text={typed.text} /> : null}
        {compose ? (
          <a className="social-button" href={compose} target="_blank" rel="noreferrer">
            Open {rule.name}
          </a>
        ) : null}
        {editing && actions ? (
          <button type="button" className="social-button social-button-quiet" disabled={anyBusy} onClick={() => run("skip", () => actions.skip(post.id))}>
            {working("skip") ? "Skipping…" : "Skip"}
          </button>
        ) : null}
      </div>

      {actions && (open || post.status === "posted" || post.status === "expired") ? (
        <form
          className="social-posted-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run("posted", () => actions.markPosted(post.id, typed.url));
          }}
        >
          <label className="social-field">
            <span>{markLabel}</span>
            <input type="url" inputMode="url" required value={typed.url} placeholder={`https://… (the ${rule.name} post)`} onChange={(e) => onType({ url: e.target.value })} />
          </label>
          <button type="submit" className="social-button" disabled={anyBusy || !typed.url.trim()}>
            {working("posted") ? "Saving…" : "Mark posted"}
          </button>
        </form>
      ) : null}
      {error ? (
        <p className="social-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
