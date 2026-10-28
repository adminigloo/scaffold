"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CardFormatSet, QueueWire } from "../wire.js";
import { CardFormats } from "./CardFormats.js";
import { createSocialClient } from "./client.js";
import { ComposeForm } from "./ComposeForm.js";
import { PostQueue } from "./PostQueue.js";
import { SocialStyles } from "./styles.js";

export interface PostsAdminProps {
  /** Where the app mounted @adminigloo/social/server's handler: "/api/app/{company id}/posts", "/api/admin/posts". */
  readonly baseUrl: string;
  /** May this person write, edit, approve, skip and mark posted (social.manage)? Without it the queue is read-only. */
  readonly canManage: boolean;
  /** The business's name, for the hint under the compose form. */
  readonly businessName?: string;
  /** A fetch to use (tests). */
  readonly fetcher?: typeof fetch;
}

function dayWords(day: string): string {
  const at = new Date(`${day}T12:00:00Z`);
  return Number.isNaN(at.getTime()) ? day : at.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
}

/**
 * THE POSTS SCREEN, WHOLE (social 0.1): today's posts with the status filter
 * and "Approve all for today", drafts still waiting from earlier days, what's
 * ready to post (with the posting session's list as JSON), a post from your
 * own facts, the history, and "See every card format". Every button goes to
 * the handler at `baseUrl`, which checks the person's permission on every
 * call; the queue reloads after each.
 *
 * NOTHING ON THIS SCREEN POSTS ANYTHING. Approved posts are posted by hand
 * (Copy text, Open X, the images) and marked posted with their link.
 */
export function PostsAdmin({ baseUrl, canManage, businessName, fetcher }: PostsAdminProps) {
  const client = useMemo(() => createSocialClient(baseUrl, fetcher), [baseUrl, fetcher]);
  const [queue, setQueue] = useState<QueueWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formats, setFormats] = useState<readonly CardFormatSet[] | null>(null);
  const [formatsError, setFormatsError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setQueue(await client.queue());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The posts couldn't be read. Try again.");
    }
  }, [client]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const actions = useMemo(
    () => ({
      save: async (id: string, edit: Parameters<typeof client.actions.save>[1]) => {
        const result = await client.actions.save(id, edit);
        await reload();
        return result;
      },
      approve: async (ids: string[]) => {
        const result = await client.actions.approve(ids);
        await reload();
        return result;
      },
      markPosted: async (id: string, url: string) => {
        const result = await client.actions.markPosted(id, url);
        await reload();
        return result;
      },
      skip: async (id: string) => {
        const result = await client.actions.skip(id);
        await reload();
        return result;
      },
    }),
    [client, reload],
  );

  const loadFormats = async () => {
    if (formats) return;
    try {
      setFormats(await client.cardFormats());
      setFormatsError(null);
    } catch (e) {
      setFormatsError(e instanceof Error ? e.message : "The card formats couldn't be read.");
    }
  };

  const readOnly = !canManage;
  return (
    <div className="social social-admin">
      <SocialStyles />
      {error ? (
        <p className="social-error" role="alert">
          {error}{" "}
          <button type="button" className="social-button" onClick={() => void reload()}>
            Try again
          </button>
        </p>
      ) : null}
      {!queue && !error ? <p className="social-empty">Loading the posts…</p> : null}
      {queue ? (
        <>
          <section className="social-section" aria-labelledby="social-today">
            <div className="social-section-head">
              <h2 id="social-today" className="social-section-title">
                Today, {dayWords(queue.today)}
              </h2>
            </div>
            <PostQueue
              posts={queue.sections.today}
              actions={actions}
              filter
              approveAllLabel="Approve all for today"
              readOnly={readOnly}
              empty={canManage ? "Nothing for today yet. Write a post from your own facts below, and a draft for each platform lands here." : "Nothing for today yet."}
            />
          </section>

          {queue.sections.earlier.length ? (
            <section className="social-section" aria-labelledby="social-earlier">
              <h2 id="social-earlier" className="social-section-title">
                Still waiting from earlier days
              </h2>
              <PostQueue posts={queue.sections.earlier} actions={actions} readOnly={readOnly} />
            </section>
          ) : null}

          <section className="social-section" aria-labelledby="social-ready">
            <div className="social-section-head">
              <h2 id="social-ready" className="social-section-title">
                Ready to post
              </h2>
              <p className="social-section-hint">
                Approved, not posted yet. Post each by hand, then paste its link. For a posting session in the browser, the same list as JSON:{" "}
                <a href={client.approvedUrl} target="_blank" rel="noopener noreferrer">
                  the approved posts
                </a>
                .
              </p>
            </div>
            <PostQueue posts={queue.sections.ready} actions={actions} readOnly={readOnly} empty="Nothing approved and waiting." />
          </section>

          {canManage ? (
            <section className="social-section" aria-label="A post from your own facts">
              <ComposeForm
                heading="A launch or announcement, from your own facts"
                hint={`Type what's true in a sentence or two, numbers and all. ${businessName ? `${businessName}'s` : "Your"} posts keep your words for every fact; the AI adds only the line on the images and a short sign-off, using only your numbers, and every draft waits here for you to approve.`}
                onCompose={async (input) => {
                  const result = await client.compose(input);
                  await reload();
                  return result && "error" in result ? { error: result.error } : undefined;
                }}
              />
            </section>
          ) : null}

          <section className="social-section" aria-labelledby="social-history">
            <h2 id="social-history" className="social-section-title">
              History
            </h2>
            <PostQueue posts={queue.sections.history} actions={actions} readOnly={readOnly} empty="Nothing posted yet." />
          </section>
        </>
      ) : null}

      <details
        className="social-section social-formats"
        onToggle={(e) => {
          if ((e.currentTarget as HTMLDetailsElement).open) void loadFormats();
        }}
      >
        <summary>See every card format</summary>
        {formatsError ? (
          <p className="social-error" role="alert">
            {formatsError}
          </p>
        ) : formats ? (
          <CardFormats sets={formats} />
        ) : (
          <p className="social-empty">Loading the card formats…</p>
        )}
      </details>
    </div>
  );
}
