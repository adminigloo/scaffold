"use client";

import { ErrorScreen } from "@/components/ErrorScreen";
import "./globals.css";

/**
 * The boundary of last resort: the root layout itself threw.
 *
 * NOTHING ELSE CATCHES THAT. `app/error.tsx` renders inside the root layout, so
 * it cannot handle a layout that never produced a tree to render into — and
 * with no boundary at all React unmounts everything and the browser is left
 * showing "Application error: a client-side exception has occurred" on a blank
 * white page, with no navigation, no way back, and nothing recorded anywhere.
 * That was the state of every generated project before this file existed.
 *
 * IT REPLACES THE ROOT LAYOUT, which is why it renders its own `<html>` and
 * `<body>` — React has torn the real ones down, and a fragment here produces a
 * document with no root element. `globals.css` is imported for the same reason:
 * the stylesheet the root layout pulled in went with it, and without this line
 * the apology renders as unstyled black-on-white HTML, which reads as an even
 * deeper failure than the one that got us here.
 *
 * The way out is a plain `<a>`, not a `<Link>`. A client navigation is handled
 * by the router inside the tree that has just collapsed; a document load
 * rebuilds everything from scratch, which is the only recovery available when
 * what failed is the layout that wraps every route.
 */
export default function GlobalError({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}) {
  return (
    // `suppressHydrationWarning` for the same reason the root layout carries it:
    // extensions stamp attributes on <html> before React hydrates.
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-dvh bg-canvas text-ink antialiased">
        <ErrorScreen
          error={error}
          reset={reset}
          boundary="global"
          title="__PROJECT_NAME__ could not start this page"
          // "/" is the one route every configuration of this scaffold has. A
          // link to anything else would be a link to a 404 in the projects that
          // did not install it — on the screen a person reaches when everything
          // else has already gone wrong.
          back={{ href: "/", label: "Reload the site" }}
          hard
        >
          <p>
            Something failed before the page could be laid out. Reloading fixes
            most of these; if it does not, the reference below identifies the
            failure in the server log.
          </p>
        </ErrorScreen>
      </body>
    </html>
  );
}
