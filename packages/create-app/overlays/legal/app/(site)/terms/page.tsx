import type { Metadata } from "next";
import Link from "next/link";
import {
  Clause,
  GeneratedClauses,
  LegalDocument,
  PublisherValue,
} from "@/components/legal/LegalDocument";
import { EXTRA_TERMS } from "@/legal";
import { PUBLISHER } from "@/legal-publisher";

export const metadata: Metadata = {
  title: "Terms",
  description:
    "The agreement between you and __PROJECT_NAME__: your account, what you may do with the service, and what we owe each other.",
  alternates: { canonical: "/terms" },
};

/**
 * The terms of service.
 *
 * `EXTRA_TERMS` is the generated part: the clauses that exist only because of
 * what this project does. A service that takes one-off payments gets a
 * purchases clause and no renewal clause; a subscription service gets renewal
 * and plan changes; a service that answers with a model gets the clause saying
 * its answers are not advice. A project with none of those gets none of the
 * clauses, rather than three paragraphs beginning "where applicable".
 *
 * THE NUMBERING IS CONTINUOUS ACROSS THE JOIN. Hand-written clauses one to
 * three, then however many the record contributes, then the rest — computed
 * from `EXTRA_TERMS.length` rather than typed, because a clause number that
 * silently repeats or skips is exactly the kind of defect nobody reads a legal
 * page carefully enough to notice.
 */
export default function TermsPage() {
  const generatedFrom = 4;
  const afterGenerated = generatedFrom + EXTRA_TERMS.length;

  return (
    <LegalDocument
      title="Terms"
      standfirst="The agreement between you and us: what you may do with this service, what we will do to keep it running, and what happens when either of us stops."
    >
      <Clause n={1} heading="Who you are agreeing with">
        <p>
          These terms are between you and{" "}
          <PublisherValue value={PUBLISHER.legalName} />, of{" "}
          <PublisherValue value={PUBLISHER.address} />. Using the service means
          you accept them.
        </p>
        <p>
          How we handle your data is a separate document:{" "}
          <Link
            href="/privacy"
            className="text-accent underline underline-offset-2"
          >
            our privacy policy
          </Link>
          .
        </p>
      </Clause>

      <Clause n={2} heading="Your account">
        <p>
          You need an account to use the service, and you are responsible for
          what happens under it &mdash; including anything done by people you
          invite. Keep your sign-in details to yourself, and tell us at{" "}
          <PublisherValue value={PUBLISHER.contactEmail} /> if you think somebody
          else has them.
        </p>
        <p>
          You must be old enough to enter into a contract where you live, and the
          details you give us must be accurate.
        </p>
      </Clause>

      <Clause n={3} heading="What you may not do">
        <p>
          Do not break the law with it, do not try to get at other customers&rsquo;
          data, do not attempt to disrupt the service for anybody else, and do
          not resell access to it unless we have agreed that in writing.
        </p>
        <p>
          We may suspend an account that is doing any of those, and we will tell
          you why.
        </p>
      </Clause>

      {/* Everything this project does that the terms have to mention, from
          src/legal.ts. Absent entirely in a service that neither charges nor
          answers with a model, which is the correct number of clauses about
          subscriptions in a service that has none. */}
      <GeneratedClauses clauses={EXTRA_TERMS} from={generatedFrom} />

      <Clause n={afterGenerated} heading="Availability">
        <p>
          We work to keep the service available and we do not promise it never
          goes down. Planned work is announced in advance where we can.
        </p>
        <p>
          <strong>If you have sold an availability commitment, state it here</strong>{" "}
          &mdash; the figure, how it is measured and what happens when it is
          missed. A clause promising nothing is safer than one promising
          something you have not measured.
        </p>
      </Clause>

      <Clause n={afterGenerated + 1} heading="Ending it">
        <p>
          You can stop using the service and close your account whenever you
          like. We can end this agreement if you break these terms, and we will
          give you notice and a chance to put it right unless the breach makes
          that unreasonable.
        </p>
        <p>
          Tell us before you go if you want a copy of your data; we do not keep
          it indefinitely once an account is closed.
        </p>
      </Clause>

      <Clause n={afterGenerated + 2} heading="Liability">
        <p>
          <strong>
            This clause must be written for your business and your jurisdiction.
          </strong>{" "}
          It is the clause that decides what a bad day actually costs, the limits
          that are enforceable differ by country, and nothing that could go in a
          scaffold would be right for yours. Nothing here limits liability that
          cannot lawfully be limited.
        </p>
      </Clause>

      <Clause n={afterGenerated + 3} heading="Changes to these terms">
        <p>
          We may change these terms. When we do, we update the date at the top,
          and if a change materially affects you we will tell you before it takes
          effect rather than relying on you re-reading this page.
        </p>
      </Clause>

      <Clause n={afterGenerated + 4} heading="Governing law">
        <p>
          This agreement is governed by{" "}
          <PublisherValue value={PUBLISHER.governingLaw} />, and the courts there
          have jurisdiction over any dispute.
        </p>
      </Clause>
    </LegalDocument>
  );
}
