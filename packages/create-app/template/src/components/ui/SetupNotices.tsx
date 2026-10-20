"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { cx } from "./cx";

/** One thing left to finish on a page. */
export interface SetupItem {
  /** Stable: the card remembers a dismissal by the set of keys it showed. */
  readonly key: string;
  /** What the owner reads: the consequence, in plain words. */
  readonly text: string;
  /** Where the owner fixes it. Never set on an operator item. */
  readonly href?: string;
  readonly linkLabel?: string;
  /**
   * The site OPERATOR's job, not the owner's (the email provider, photo
   * storage, photo reading, Stripe keys). The owner can't fix it, so it gets
   * no link, and is grouped under "Waiting on whoever runs this site".
   */
  readonly operator?: boolean;
  /** The technical detail (which setting, which key): shown to staff only. */
  readonly detail?: string;
}

const DISMISS_KEY = "app-setup-dismissed";

/**
 * THE PAGE'S ONE SETUP CARD. A page used to open with three to five yellow
 * banners — email off, photos can't be kept, tax not saved — and five banners
 * read as "broken" to a new owner. This is one calm card instead: "3 things
 * to finish", collapsed until opened, dismissible until the list changes.
 *
 * WHO READS WHAT. An owner reads one plain sentence per item ("Email isn't
 * switched on for this site yet — your customers won't get emails"). Staff of
 * the site (`staff`) also read the technical detail. Nothing here ever shows
 * an environment variable, a file path or a link to the setup page to anyone
 * else: the caller passes `detail`, and the card prints it only for staff.
 */
export function SetupNotices({
  items,
  staff = false,
  className,
}: {
  readonly items: readonly SetupItem[];
  readonly staff?: boolean;
  readonly className?: string;
}) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const signature = items.map((item) => item.key).join(",");
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    try {
      setDismissed(window.localStorage.getItem(DISMISS_KEY));
    } catch {
      setDismissed(null);
    }
  }, []);
  if (items.length === 0 || dismissed === signature) return null;

  const owner = items.filter((item) => !item.operator);
  const operator = items.filter((item) => item.operator);
  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISS_KEY, signature);
    } catch {
      // Private browsing: dismissed for this view only.
    }
    setDismissed(signature);
  };
  const row = (item: SetupItem) => (
    <li key={item.key} className="relative pl-4" data-setup-item={item.key} data-operator={item.operator ? "" : undefined}>
      <span aria-hidden="true" className="absolute top-[0.6em] left-0 size-1.5 rounded-full bg-line-strong" />
      <span className="text-ink">{item.text}</span>
      {item.href && !item.operator ? (
        <>
          {" "}
          <Link href={item.href} className="font-medium text-accent underline underline-offset-2">
            {item.linkLabel ?? "Fix it"}
          </Link>
        </>
      ) : null}
      {staff && item.detail ? <span className="mt-0.5 block text-xs text-ink-muted">{item.detail}</span> : null}
    </li>
  );

  return (
    <section
      aria-label="Things to finish"
      data-setup-notices=""
      className={cx("rounded-[--radius-card] border border-line bg-surface shadow-card", className)}
    >
      <div className="flex items-center gap-1 py-1 pr-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
          className="group flex min-h-11 flex-1 items-center gap-3 rounded-control px-4 text-left"
        >
          <span
            aria-hidden="true"
            className="inline-flex h-6 min-w-6 items-center justify-center rounded-pill bg-accent-soft px-2 text-xs font-semibold text-accent tabular-nums"
          >
            {items.length}
          </span>
          <span className="text-sm font-semibold text-ink group-hover:underline group-hover:underline-offset-2">
            {items.length === 1 ? "1 thing to finish" : `${items.length} things to finish`}
          </span>
          <svg aria-hidden="true" viewBox="0 0 20 20" className="ml-auto size-5 text-ink-muted" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d={open ? "M5 12.5l5-5 5 5" : "M5 7.5l5 5 5-5"} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          type="button"
          aria-label="Dismiss until something changes"
          onClick={dismiss}
          className="inline-flex size-11 items-center justify-center rounded-control text-ink-muted hover:bg-canvas hover:text-ink"
        >
          <svg aria-hidden="true" viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div id={panelId} hidden={!open} className="border-t border-line px-4 pt-3 pb-4">
        {owner.length > 0 ? <ul className="flex flex-col gap-2 text-sm">{owner.map(row)}</ul> : null}
        {operator.length > 0 ? (
          <>
            <p className={cx("text-[11px] font-semibold tracking-wider text-ink-muted uppercase", owner.length > 0 && "mt-4")}>
              Waiting on whoever runs this site
            </p>
            <ul className="mt-2 flex flex-col gap-2 text-sm">{operator.map(row)}</ul>
          </>
        ) : null}
      </div>
    </section>
  );
}
