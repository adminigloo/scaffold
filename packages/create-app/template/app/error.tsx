"use client";

import { ErrorScreen } from "@/components/ErrorScreen";

/**
 * The boundary for a SEGMENT LAYOUT that threw.
 *
 * Not a catch-all, and the distinction is the reason this file is small. A
 * boundary never catches the layout it sits beside — `app/(site)/error.tsx`
 * cannot handle `app/(site)/layout.tsx` failing, because that layout is what it
 * would have to render inside. Those failures bubble to the parent segment,
 * which is here. So this file exists for exactly one class of event: the site
 * chrome or the admin shell could not be built.
 *
 * That class is not hypothetical. The site layout mounts a header that reads
 * the Clerk session, and the admin layout reads the principal and the staff
 * permission set out of the database before it draws anything. Either can throw
 * on a deployment whose credentials are half configured.
 *
 * It renders inside the ROOT layout, so the providers are still mounted and the
 * page is still styled — but there is no header and no footer, because the
 * thing that draws them is what failed. The way back has to be a route that
 * exists in every configuration, and `/` is the only one this scaffold can
 * promise: the storefront belongs to the stripe overlay and `/admin` to the
 * admin overlay, and a boundary that links to a 404 is worse than one that
 * links nowhere.
 */
export default function AppError({
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
      boundary="root"
      title="This part of the site could not be loaded"
      back={{ href: "/", label: "Back to the start" }}
    >
      <p>
        The page frame itself failed rather than anything on the page. Trying
        again rebuilds it; if it keeps failing, the reference below is the same
        one recorded in the server log.
      </p>
    </ErrorScreen>
  );
}
