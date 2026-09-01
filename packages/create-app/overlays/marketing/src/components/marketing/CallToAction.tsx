import Link from "next/link";
import { buttonClass } from "@/components/ui";
import { Section } from "@/components/marketing/Section";

/**
 * The end of the page, and the only tinted band on it.
 *
 * ONE PLACE FOR THE COLOUR. `bg-accent-soft` appears exactly here, so it means
 * "this is the thing to do next" rather than "this is another section". A page
 * that tints three bands has emphasised nothing, and the version of that page
 * everybody has seen — alternating white and pale panels down the whole
 * document — is what a template looks like.
 *
 * ONE ACTION, and it is the same action the hero opened with. A closing block
 * offering three routes is a closing block that asks the reader to choose
 * again, at the point they have finished deciding. The quiet line under the
 * button is for the reader who is not signing up today; it points at the
 * pricing page through the site nav rather than through a hardcoded link,
 * because `/pricing` exists only in a project that has plans to price.
 */
export function CallToAction() {
  return (
    <Section label="Start" tone="accent">
      <h2 className="max-w-[20ch] text-2xl font-semibold tracking-[-0.02em] text-balance sm:text-[1.75rem]">
        Start with one __TENANT_LABEL_LOWER__ and see how it goes.
      </h2>

      <p className="mt-3 max-w-[48ch] text-[15px] leading-relaxed text-ink-muted">
        Create an account, invite the people who need one, and move your first
        piece of work across. Nothing to install, and nothing to undo if it is
        not for you.
      </p>

      <div className="mt-7">
        <Link href="/sign-up" className={buttonClass("primary", "px-4 py-2")}>
          Create an account
        </Link>
      </div>

      <p className="mt-5 text-sm text-ink-muted">
        Everything else &mdash; what each plan includes, how we handle your data
        &mdash; is linked at the bottom of every page.
      </p>
    </Section>
  );
}
