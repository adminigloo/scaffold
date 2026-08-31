"use client";

import Link from "next/link";
import { useEffect, type ReactNode } from "react";
import { reportClientError } from "@/report-error";
import { Button, buttonClass } from "@/components/ui";

/**
 * What every error boundary in this app renders, and the only thing that
 * reports one.
 *
 * THE REPORTING IS WHY THIS IS SHARED. Each boundary needs different words —
 * the storefront and the admin panel fail for different reasons and recover
 * differently — but every one of them must record what it caught, and a
 * boundary that forgets is invisible: it renders a perfectly polite apology and
 * nobody ever learns the page is broken. Folding the effect in here means the
 * next boundary somebody adds cannot forget, because there is no version of
 * this screen that does not report.
 *
 * The copy is deliberately not apologetic filler. A reader in front of a broken
 * page needs three things: that it was the software and not them, a reference
 * they can quote, and a way out that is not the back button.
 */
export interface ErrorScreenProps {
  /** Exactly what the boundary was handed, digest included. */
  readonly error: Error & { digest?: string };
  /** Next's re-render. Absent where re-rendering cannot help. */
  readonly reset?: () => void;
  /** Which boundary this is, recorded with the report: "site", "admin", … */
  readonly boundary: string;
  readonly title: string;
  readonly children: ReactNode;
  readonly back: { readonly href: string; readonly label: string };
  /**
   * Leave by a full document load rather than a client navigation.
   *
   * For `global-error`, where the router itself is part of what fell over and a
   * soft navigation would be handled by the tree that is already broken.
   */
  readonly hard?: boolean;
}

export function ErrorScreen({
  error,
  reset,
  boundary,
  title,
  children,
  back,
  hard = false,
}: ErrorScreenProps) {
  // `error` in the dependency list, not `[]`. A boundary can be handed a second
  // failure without unmounting — the reset re-renders, the same page throws
  // something else — and an effect that runs once would report the first and
  // silently drop every one after it.
  useEffect(() => {
    reportClientError(error, boundary);
  }, [error, boundary]);

  return (
    <main className="grid min-h-[60dvh] place-items-center px-6 py-12">
      <div className="max-w-[46ch] text-center">
        <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
        <div className="mt-2 text-sm text-ink-muted">{children}</div>

        {/* The digest is the whole reason a support conversation can end. It is
            the same value the server logged the real stack against, so quoting
            it turns "a page broke yesterday" into one line in a log. React only
            produces one for a server render, so this is absent as often as it
            is present, and inventing a placeholder would mean somebody quoting
            an id that matches nothing. */}
        {error.digest !== undefined && (
          <p className="mt-4 font-mono text-xs text-ink-muted">
            Reference {error.digest}
          </p>
        )}

        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {reset !== undefined && (
            <Button variant="primary" onClick={reset}>
              Try again
            </Button>
          )}
          {hard ? (
            <a href={back.href} className={buttonClass("secondary")}>
              {back.label}
            </a>
          ) : (
            <Link href={back.href} className={buttonClass("secondary")}>
              {back.label}
            </Link>
          )}
        </div>
      </div>
    </main>
  );
}
