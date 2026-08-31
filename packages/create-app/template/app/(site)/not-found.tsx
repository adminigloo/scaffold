import Link from "next/link";
import { buttonClass } from "@/components/ui";

/**
 * `notFound()` was called by a page in the public site.
 *
 * A DIFFERENT EVENT from the root 404, which is why it is a different file. The
 * root one answers "no route matches this URL"; this one answers "the route
 * matched, ran, and the thing it was asked for is not there" — an unpublished
 * product, a slug that has been renamed. The reader is somewhere real and only
 * one record is missing, so they keep the header and the footer and can carry
 * on from here rather than starting over.
 *
 * Without this file that case falls through to `app/not-found.tsx`, which
 * renders outside the site chrome — the nav disappears because a single product
 * could not be found, which reads as the whole shop having gone down.
 */
export default function SiteNotFound() {
  return (
    <main className="grid min-h-[60dvh] place-items-center px-6 py-12">
      <div className="max-w-[44ch] text-center">
        <h1 className="text-xl font-semibold tracking-tight text-ink">
          We could not find that
        </h1>
        <p className="mt-2 text-sm text-ink-muted">
          It may have been removed, renamed, or never published. The rest of the
          site is where you left it.
        </p>
        {/* "/" and nothing more specific. Returning somebody to the list they
            came from would mean naming a route — and which lists exist depends
            on what this project was generated with. The header above already
            carries every route that does exist, from `src/nav.ts`. */}
        <Link href="/" className={buttonClass("secondary", "mt-5")}>
          Back to the start
        </Link>
      </div>
    </main>
  );
}
