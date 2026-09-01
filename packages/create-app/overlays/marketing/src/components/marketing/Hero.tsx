import Link from "next/link";
import { buttonClass } from "@/components/ui";

/**
 * The top of the landing page, and the only element on it that is full width.
 *
 * EVERY STRING IN THIS FILE IS PLACEHOLDER COPY. It is written as real product
 * copy rather than as instructions, because a page carrying "replace this
 * paragraph" is a page that cannot be shown to a client — and this page's whole
 * job is being shown to one. What makes it safe is that none of it makes a
 * claim the software cannot back: the three lines under the rule describe
 * things every project generated from this scaffold genuinely does, so an
 * unedited hero is vague rather than false.
 *
 * THE COMPOSITION. One column, left aligned, at the width the header's wordmark
 * already sits at. Not centred: a centred hero over a left-aligned site is the
 * arrangement every template ships, and it forces the eye back to the middle on
 * every line of a paragraph that is trying to be read. The headline is set
 * tight and large and the supporting line is set at reading size directly under
 * it, so the two are one block rather than a title and a caption.
 *
 * NO HERO IMAGE, and that is a decision rather than an omission. The scaffold
 * has no product screenshot to put there and a stock illustration is worse than
 * white space. When there is a screenshot, it goes to the right of this block at
 * `lg` and the grid becomes two columns — the copy is already the right measure
 * for that.
 */
export function Hero() {
  return (
    <section className="mx-auto max-w-5xl px-6 pt-16 pb-14 sm:pt-24 sm:pb-20">
      <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-muted">
        For __TENANT_LABEL_PLURAL_LOWER__ that have outgrown the spreadsheet
      </p>

      <h1 className="mt-5 max-w-[18ch] text-[clamp(2.25rem,6.5vw,3.5rem)] leading-[1.03] font-semibold tracking-[-0.035em] text-balance">
        One place for the work, the people and the paperwork.
      </h1>

      <p className="mt-6 max-w-[54ch] text-[17px] leading-relaxed text-ink-muted">
        {/* "your" rather than "a", and every string in these files avoids the
            indefinite article in front of a tenant noun for the same reason
            `tenantLabelPlural` exists: the noun is one of five and the generator
            cannot know whether it takes "a" or "an". "a organization" on the
            first line of a client's landing page is the whole impression. */}
        __PROJECT_NAME__ keeps everything your __TENANT_LABEL_LOWER__ runs on in
        one system &mdash; so nothing lives in a spreadsheet somebody forgot to
        share, and nobody spends the last day of the month reconciling three
        tools that disagree.
      </p>

      <div className="mt-9 flex flex-wrap items-center gap-3">
        <Link href="/sign-up" className={buttonClass("primary", "px-4 py-2")}>
          Create an account
        </Link>
        {/*
          An anchor, not a route. It scrolls to the section below, which means
          it is correct in every configuration and cannot become the dead link
          that a hardcoded `/features` would be. The second action on a hero is
          for the reader who is not ready to sign up, and sending them to
          another page loses them.
        */}
        <a
          href="#what-you-get"
          className="text-sm text-ink-muted underline-offset-4 hover:text-ink hover:underline"
        >
          See what is inside
        </a>
      </div>

      {/*
        THREE THINGS THAT ARE ACTUALLY TRUE of anything generated from this
        scaffold: the audit log is written on every administrative action, the
        database is a Postgres you own, and there is no setup call because there
        is nothing to install. Placeholder copy that happens to be accurate is
        the only kind worth shipping unedited.
      */}
      <ul className="mt-14 grid list-none grid-cols-1 gap-x-10 gap-y-4 border-t border-line p-0 pt-6 sm:grid-cols-3">
        {[
          ["Set up in an afternoon", "No installation, no migration project."],
          ["Every change on the record", "Who did what, and when, as it happens."],
          ["Your data in your database", "Postgres you can point at and take with you."],
        ].map(([title, detail]) => (
          <li key={title}>
            <p className="text-sm font-medium text-ink">{title}</p>
            <p className="mt-0.5 text-sm text-ink-muted">{detail}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
