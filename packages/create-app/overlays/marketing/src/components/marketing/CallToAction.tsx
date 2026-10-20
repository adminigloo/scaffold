import Link from "next/link";
import { buttonClass } from "@/components/ui";
import { Section } from "@/components/marketing/Section";
import { CLOSING, DASHBOARD_HREF } from "@/marketing-copy";

/** The closing band: one sentence and one button — the dashboard, for someone already signed in. */
export function CallToAction({ signedIn }: { readonly signedIn: boolean }) {
  return (
    <Section label="Start" tone="accent">
      <h2 className="max-w-[22ch] text-[1.75rem] leading-tight font-semibold tracking-[-0.02em] text-balance text-ink sm:text-[2rem]">
        {CLOSING.title}
      </h2>
      <p className="mt-3 max-w-[52ch] text-base leading-relaxed text-ink-muted">{CLOSING.body}</p>
      <div className="mt-8">
        {signedIn ? (
          <Link href={DASHBOARD_HREF} className={buttonClass("primary")}>
            Go to your dashboard
          </Link>
        ) : (
          <Link href="/sign-up" className={buttonClass("primary")}>
            Create your account
          </Link>
        )}
      </div>
    </Section>
  );
}
