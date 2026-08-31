import Link from "next/link";
import { FOOTER_LINKS, SITE_LINKS } from "@/nav";

/**
 * The 404 for a URL that matches no route at all.
 *
 * Next uses THIS file for an unmatched URL, not a `not-found.tsx` nested in a
 * route group: there is no matched segment, so there is no nested boundary to
 * choose. Which means it renders inside the root layout with no header and no
 * footer — the very chrome that would normally give a lost reader somewhere to
 * go. So it has to carry its own map.
 *
 * THE MAP IS READ FROM `src/nav.ts`, never written out here. That file is
 * generated from the answers this project was created with, so `/products`
 * appears only in a project that sells something and `/admin` only in one with
 * an admin panel. A hardcoded list would put a second 404 on the 404 page in
 * every configuration that declined the feature — the same defect this page
 * exists to soften, one level in.
 *
 * A server component, deliberately. Nothing here is interactive and nothing
 * needs reporting: a mistyped URL is not a fault, and recording one as an error
 * would fill the log with other people's typing.
 */
export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center px-6 py-12">
      <div className="max-w-[46ch] text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-muted">
          404
        </p>
        <h1 className="mt-2 text-xl font-semibold tracking-tight text-ink">
          That page does not exist
        </h1>
        <p className="mt-2 text-sm text-ink-muted">
          The address may have been mistyped, or the page may have been removed.
          Everywhere this site can take you is below.
        </p>

        <nav
          aria-label="Site"
          className="mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-2"
        >
          {[...SITE_LINKS, ...FOOTER_LINKS].map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-sm text-accent underline underline-offset-2"
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </main>
  );
}
