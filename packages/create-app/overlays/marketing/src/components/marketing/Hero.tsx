import Link from "next/link";
import { buttonClass } from "@/components/ui";
import { Screenshot } from "@/components/marketing/Screenshot";
import { DASHBOARD_HREF, HERO } from "@/marketing-copy";

/**
 * The first screen: who it's for, what it does for them in one sentence, and
 * one button. Someone already signed in gets "Go to your dashboard" instead —
 * a returning owner should never be invited to make a second account. The
 * hero screenshot (public/screenshots/dashboard.png) shows only once it's
 * there. Every word: src/marketing-copy.ts.
 */
export function Hero({ signedIn }: { readonly signedIn: boolean }) {
  return (
    <section className="bg-canvas">
      <div className="mx-auto max-w-6xl px-4 pt-16 pb-16 sm:px-6 sm:pt-24 sm:pb-20">
        <p className="text-sm font-semibold text-accent">{HERO.eyebrow}</p>
        <h1 className="mt-4 max-w-[18ch] text-[clamp(2.25rem,6vw,3.75rem)] leading-[1.04] font-semibold tracking-[-0.035em] text-balance text-ink">
          {HERO.title}
        </h1>
        <p className="mt-6 max-w-[56ch] text-lg leading-relaxed text-ink-muted">{HERO.lead}</p>
        <div className="mt-9 flex flex-wrap items-center gap-3">
          {signedIn ? (
            <Link href={DASHBOARD_HREF} className={buttonClass("primary")} data-hero-action="dashboard">
              Go to your dashboard
            </Link>
          ) : (
            <>
              <Link href="/sign-up" className={buttonClass("primary")} data-hero-action="sign-up">
                {HERO.cta}
              </Link>
              {/* An anchor, not a route: it scrolls to the steps below, so it
                  can't become a dead link in any configuration. */}
              <a href="#how-it-works" className={buttonClass("secondary")}>
                {HERO.secondary}
              </a>
            </>
          )}
        </div>
        <Screenshot slot="hero" className="mt-14" />
      </div>
    </section>
  );
}
