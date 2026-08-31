"use client";

import { ErrorScreen } from "@/components/ErrorScreen";

/**
 * The boundary for the admin panel's pages.
 *
 * SEPARATE FROM THE PUBLIC ONE because the two fail for different reasons and
 * recover differently. A public page usually breaks because something is not
 * configured yet, and the reader is a customer who wants to get on with what
 * they were doing. An admin page breaks because a query, a permission lookup or
 * a migration is wrong, and the reader is the person who can actually fix it —
 * so the reference is the useful part of this screen, not the apology.
 *
 * Inside `app/admin`, so `AdminLayout` renders above it and the sidebar stays
 * on screen. That keeps every other admin page one click away, which matters
 * more here than anywhere else: whoever hit this was in the middle of operating
 * the product, and a full-page apology would strand them.
 *
 * `/admin` is the way back rather than the dashboard's own sub-pages, because
 * which of those exist depends on which admin shell this project was generated
 * with. `/admin` is in every shell that has this file at all.
 */
export default function AdminError({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}) {
  return (
    <ErrorScreen
      error={error}
      reset={reset}
      boundary="admin"
      title="This admin page failed"
      back={{ href: "/admin", label: "Back to the dashboard" }}
    >
      <p>
        The failure has been recorded in <code className="font-mono">error_log</code>{" "}
        with the reference below, along with its stack and how many times it has
        happened. Other admin pages are unaffected.
      </p>
    </ErrorScreen>
  );
}
