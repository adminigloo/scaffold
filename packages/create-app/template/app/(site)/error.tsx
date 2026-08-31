"use client";

import Link from "next/link";
import { ErrorScreen } from "@/components/ErrorScreen";

/**
 * The boundary for every public page: the landing page, `/setup`, the Clerk
 * pages and the storefront the stripe overlay adds beneath this group.
 *
 * INSIDE THE ROUTE GROUP RATHER THAN AT THE ROOT, and that placement is the
 * whole point. `app/(site)/layout.tsx` renders above this file, so the header
 * and the footer survive: a visitor who hits a broken product page still has
 * the full nav, and can get to the rest of the shop without touching the back
 * button. A boundary at the root would replace the chrome as well as the page,
 * leaving a person on a bare apology with whatever links the apology happened
 * to hardcode.
 *
 * The extra pointer is `/setup`, and only `/setup`, because on a freshly
 * generated project the most likely reason a public page threw is a credential
 * that has not been pasted in yet — that page says which one. It exists in
 * every configuration, which is what makes it safe to name here.
 */
export default function SiteError({
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
      boundary="site"
      title="This page did not load"
      back={{ href: "/", label: "Back to the start" }}
    >
      <p>
        Something on this page failed while it was being built. The rest of the
        site is unaffected — the links above still work.
      </p>
      <p className="mt-2">
        On a new project this is usually a credential that has not been added
        yet.{" "}
        <Link href="/setup" className="text-accent underline underline-offset-2">
          See what is configured
        </Link>
        .
      </p>
    </ErrorScreen>
  );
}
