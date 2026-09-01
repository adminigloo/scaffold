import Link from "next/link";
import type { ReactNode } from "react";
import { Section, SectionHeading } from "@/components/marketing/Section";

/**
 * The questions somebody asks before they sign up.
 *
 * NATIVE `<details>`, NO JAVASCRIPT. An accordion is the one interaction the
 * platform already implements correctly — keyboard, screen reader, find-in-page
 * (browsers open a closed `<details>` to reveal a match) and deep links all
 * work with no state, no hydration and no client component. A React accordion
 * gets three of those four wrong on the first attempt and ships a bundle to do
 * it.
 *
 * WHAT MAKES AN FAQ WORTH HAVING is that each answer is the honest one rather
 * than a second pitch. Two of these link somewhere the reader can check: the
 * privacy question goes to the policy, which exists in every project that has
 * this page, and the data question describes something the software genuinely
 * does. Rewrite the rest as the client's real answers, and delete any question
 * nobody actually asks — an FAQ padded to six is an FAQ that gets skimmed.
 */
function Question({
  q,
  children,
}: {
  readonly q: string;
  readonly children: ReactNode;
}) {
  return (
    <details className="group border-t border-line">
      <summary className="flex cursor-pointer list-none items-baseline justify-between gap-6 py-4 text-[15px] font-medium text-ink [&::-webkit-details-marker]:hidden">
        {q}
        {/* Two glyphs rather than a rotating one: a plus that becomes a minus
            is legible at 12px, and a chevron rotated by CSS is a chevron that
            looks broken for the length of the transition on a slow paint. */}
        <span
          aria-hidden="true"
          className="shrink-0 font-mono text-ink-muted select-none"
        >
          <span className="group-open:hidden">+</span>
          <span className="hidden group-open:inline">&minus;</span>
        </span>
      </summary>
      <div className="max-w-[58ch] pb-5 text-[15px] leading-relaxed text-ink-muted">
        {children}
      </div>
    </details>
  );
}

export function Faq() {
  return (
    <Section label="Questions">
      <SectionHeading title="Before you sign up" />

      <div>
        <Question q="How long does it take to get started?">
          Minutes. Create an account, invite the people who need one, and you are
          running &mdash; there is nothing to install, nothing to configure on
          your side, and no migration project in front of the first useful day.
        </Question>

        <Question q="Who can see our data?">
          Only people you have invited into your __TENANT_LABEL_LOWER__, and the
          companies that run the infrastructure underneath. Every one of those is
          named in{" "}
          <Link
            href="/privacy"
            className="text-accent underline underline-offset-2"
          >
            our privacy policy
          </Link>
          , with what reaches them and why.
        </Question>

        <Question q="What happens to our data if we leave?">
          It stays yours. Everything is in a standard Postgres database, so an
          export is a database dump rather than a support ticket and a queue.
        </Question>

        <Question q="Can I control what each person is allowed to do?">
          Yes, per person and per __TENANT_LABEL_LOWER__. Permissions are checked
          on the server on every request, so removing somebody&rsquo;s access
          takes effect immediately rather than hiding a button from them.
        </Question>

        <Question q="How do we get help?">
          <strong className="font-medium text-ink">
            Answer this one honestly.
          </strong>{" "}
          Say where support goes, who reads it and how long a reply takes. A
          vague answer here is read as no answer, and it is the question that
          decides the sale more often than the feature list does.
        </Question>
      </div>
    </Section>
  );
}
