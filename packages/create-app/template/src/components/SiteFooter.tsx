import Link from "next/link";
import { FOOTER_LINKS, SITE_LINKS } from "@/nav";

/**
 * Everywhere a visitor can go, on every page.
 *
 * The header is deliberately short — a customer-facing nav with a diagnostics
 * page in it is a nav that reads as unfinished software — so this is where the
 * rest of the site actually becomes reachable. `/setup` is the case that forced
 * it: it is the page that explains why sign-in or the database is off, it was
 * linked from the landing page alone, and the person who needs it most is
 * whoever just hit a broken page somewhere else entirely.
 *
 * Both lists come from `src/nav.ts`, which is generated from the answers the
 * project was created with, so a route that was never installed contributes no
 * entry and there is no test here for whether a shop exists. The primary links
 * are repeated rather than skipped: a footer that omits them is a footer that
 * stops being the complete map the moment somebody scrolls past the header.
 *
 * `SITE_LINKS` and `FOOTER_LINKS` are disjoint by construction — a test in the
 * generator asserts it — which is why concatenating them cannot produce two
 * children with the same key.
 *
 * `APP_LINKS` is NOT here. This renders for signed-out visitors too, and the
 * admin panel is not a destination to advertise to people who have no account.
 * The header carries it, in the branch that already knows there is a user.
 */
export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-line">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-3 px-6 py-6">
        <p className="mr-auto font-mono text-[11px] uppercase tracking-[0.14em] text-ink-muted">
          __PROJECT_NAME__
        </p>

        <nav aria-label="Footer" className="flex flex-wrap gap-x-5 gap-y-2">
          {[...SITE_LINKS, ...FOOTER_LINKS].map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-sm text-ink-muted no-underline hover:text-ink"
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </footer>
  );
}
