"use client";

import { useState } from "react";
import { attempt, type ActionResult } from "./PostCard.js";
import { SocialStyles } from "./styles.js";

export interface ComposeInput {
  /** The facts, in a sentence or two, numbers and all: the only numbers the AI may use. */
  readonly facts: string;
  /** The page it points to; empty for the app's default. */
  readonly link: string;
  /** Hashtags as typed ("#bakery new-menu"); empty for none. */
  readonly hashtags: string;
}

/**
 * A post from a person's own facts (a launch, an announcement, new hours):
 * they type what's true, the app's writer turns it into every platform's
 * draft, and the drafts land in the queue like any other.
 */
export function ComposeForm({
  onCompose,
  heading = "Write a post from your own facts",
  hint,
  hashtags = true,
}: {
  readonly onCompose: (input: ComposeInput) => Promise<ActionResult>;
  readonly heading?: string;
  readonly hint?: string;
  /** Offer the hashtags field (Instagram and TikTok end with them). */
  readonly hashtags?: boolean;
}) {
  const [facts, setFacts] = useState("");
  const [link, setLink] = useState("");
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ readonly ok: boolean; readonly text: string } | null>(null);
  return (
    <form
      className="social social-compose"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setMessage(null);
        const refused = await attempt(() => onCompose({ facts, link, hashtags: tags }));
        if (refused) setMessage({ ok: false, text: refused });
        else {
          setFacts("");
          setLink("");
          setTags("");
          setMessage({ ok: true, text: "Written. The drafts are in today's queue." });
        }
        setBusy(false);
      }}
    >
      <SocialStyles />
      <h3 className="social-group-title">{heading}</h3>
      {hint ? <p className="social-note">{hint}</p> : null}
      <label className="social-field">
        <span>The facts, in a sentence or two</span>
        <textarea className="social-text" required rows={3} maxLength={1200} value={facts} onChange={(e) => setFacts(e.target.value)} />
      </label>
      <label className="social-field">
        <span>The page it links to (optional)</span>
        <input type="url" value={link} placeholder="https://…" onChange={(e) => setLink(e.target.value)} />
      </label>
      {hashtags ? (
        <label className="social-field">
          <span>Hashtags for Instagram and TikTok (optional, up to five)</span>
          <input value={tags} placeholder="#yourtown #yourtrade" onChange={(e) => setTags(e.target.value)} />
        </label>
      ) : null}
      <div className="social-actions">
        <button type="submit" className="social-button social-button-primary" disabled={busy || !facts.trim()}>
          {busy ? "Writing…" : "Write the posts"}
        </button>
      </div>
      {message ? (
        <p className={message.ok ? "social-note" : "social-error"} role={message.ok ? "status" : "alert"}>
          {message.text}
        </p>
      ) : null}
    </form>
  );
}
