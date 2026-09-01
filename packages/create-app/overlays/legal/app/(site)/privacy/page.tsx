import type { Metadata } from "next";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui";
import {
  Clause,
  LegalDocument,
  PublisherValue,
} from "@/components/legal/LegalDocument";
import { DATA_CATEGORIES, SUBPROCESSORS } from "@/legal";
import { PUBLISHER } from "@/legal-publisher";

/**
 * Its own canonical, and every page that has one sets it here rather than
 * inheriting it. Metadata merges field by field down the tree, so a canonical
 * in the root layout would be inherited by every page that did not override it
 * — a whole site declaring itself canonical to `/`, which asks Google to drop
 * all of it.
 */
export const metadata: Metadata = {
  title: "Privacy",
  description:
    "What __PROJECT_NAME__ holds about you, why, and everyone else who sees it.",
  alternates: { canonical: "/privacy" },
};

/**
 * The privacy policy.
 *
 * THE PART THAT IS GENUINELY ACCURATE IS THE TABLE. `SUBPROCESSORS` and
 * `DATA_CATEGORIES` come from `src/legal.ts`, which the generator wrote from the
 * packages this project installed — so this page names Stripe only in a project
 * that takes money, names Resend only in one that sends mail, and cannot forget
 * either. That paragraph is the one a copied template always gets wrong, because
 * it is a fact about the software and the person adapting the template has no
 * way to know it.
 *
 * STATIC. Nothing here reads a database, a session or a request, so it renders
 * once at build and is served from the edge. That also means it renders
 * perfectly on a project with no credentials at all, which is the state the
 * route sweep exercises.
 *
 * The prose around the table is a starting point and says so at the top. The
 * clauses a lawyer will want to rewrite are marked; the ones derived from the
 * code are not, because rewriting those means changing the code.
 */
export default function PrivacyPage() {
  const optional = SUBPROCESSORS.filter((row) => row.activatedBy !== null);

  return (
    <LegalDocument
      title="Privacy"
      standfirst="What we hold about you, why we hold it, who else sees it, and what you can ask us to do with it."
    >
      <Clause n={1} heading="Who we are">
        <p>
          <PublisherValue value={PUBLISHER.legalName} />, trading as{" "}
          <PublisherValue value={PUBLISHER.tradingName} />, of{" "}
          <PublisherValue value={PUBLISHER.address} />, is the controller of the
          personal data described below.
        </p>
        <p>
          {/* An unfilled address renders as a visible gap rather than as a
              plausible one — see PublisherValue. A privacy policy with no route
              to a human is the single most common reason one fails a review. */}
          Write to <PublisherValue value={PUBLISHER.contactEmail} /> about
          anything on this page, including a request to see, correct or delete
          what we hold.
        </p>
      </Clause>

      <Clause n={2} heading="What we hold">
        <p>
          Only what the service needs in order to work. This list is generated
          from the parts this service is actually built out of, so it does not
          describe features we do not have.
        </p>
        <dl className="mt-1 flex flex-col gap-3">
          {DATA_CATEGORIES.map((category) => (
            <div key={category.heading}>
              <dt className="font-medium text-ink">{category.heading}</dt>
              <dd className="mt-0.5">{category.body}</dd>
            </div>
          ))}
        </dl>
      </Clause>

      <Clause n={3} heading="Why we hold it">
        <p>
          To give you the service you asked for, to keep it secure and working,
          and to meet obligations we cannot contract out of &mdash; tax records
          on a purchase, for instance.
        </p>
        <p>
          <strong>Have a lawyer write this clause.</strong> Which lawful basis
          applies to which category is the question a regulator asks first, and
          it depends on where you and your customers are, not on how the
          software is built.
        </p>
      </Clause>

      <Clause n={4} heading="Who else sees it">
        <p>
          These are the companies that process data on our behalf. The list is
          generated from the services this deployment is built on, so it is
          complete for the software &mdash; add anything you have connected
          since, such as analytics or a support desk.
        </p>

        <Table className="mt-1">
          <THead>
            <TR>
              <TH>Who</TH>
              <TH>What for</TH>
              <TH>What reaches them</TH>
            </TR>
          </THead>
          <TBody>
            {SUBPROCESSORS.map((row) => (
              <TR key={row.name}>
                <TD className="font-medium whitespace-nowrap text-ink">
                  {row.name}
                  {row.activatedBy !== null && (
                    <span className="ml-1.5 align-middle text-[10px] font-normal uppercase tracking-wider text-ink-muted">
                      optional
                    </span>
                  )}
                </TD>
                <TD>{row.purpose}</TD>
                <TD className="text-ink-muted">{row.dataShared}</TD>
              </TR>
            ))}
          </TBody>
        </Table>

        {/*
          THE OPTIONAL ROWS, EXPLAINED ONCE.

          Sentry and Upstash are in every project's environment contract and
          neither receives a byte until its credential is set. Stating them
          flatly would be wrong on every deployment that has not configured
          them; omitting them would be wrong on every deployment that has. So
          they are marked, and this sentence says what the mark means.

          `optional.length` rather than a hardcoded sentence: a configuration
          with no optional rows at all should not print an explanation of a
          badge that never appears.
        */}
        {optional.length > 0 && (
          <p>
            The rows marked <strong>optional</strong> are services this
            deployment can use and only does once they are switched on:{" "}
            {optional.map((row) => row.name).join(", ")}. Check which are
            configured here, and delete the rest of these rows from{" "}
            <code className="font-mono text-xs">src/legal.ts</code>.
          </p>
        )}
      </Clause>

      <Clause n={5} heading="Where it is held">
        <p>
          <strong>Say where, and be specific.</strong> Each company above
          operates in particular regions and several let you choose. Name the
          regions you have actually selected, and say what covers a transfer out
          of them if there is one.
        </p>
      </Clause>

      <Clause n={6} heading="How long we keep it">
        <p>
          <strong>Set real periods here.</strong> &ldquo;As long as
          necessary&rdquo; is not a retention policy and does not survive
          scrutiny. Two things in this service outlive an account on purpose and
          should be named: the audit trail, which exists to answer questions
          after an incident, and any record kept for tax or accounting.
        </p>
      </Clause>

      <Clause n={7} heading="What you can ask for">
        <p>
          Depending on where you live you can ask for a copy of what we hold, ask
          us to correct it, ask us to delete it, or object to some of what we do
          with it. Write to <PublisherValue value={PUBLISHER.contactEmail} /> and
          we will answer.
        </p>
        <p>
          <strong>Check this against your jurisdiction.</strong> The rights, the
          deadline you have to answer in, and the regulator a complaint goes to
          all differ, and this paragraph names none of them.
        </p>
      </Clause>

      <Clause n={8} heading="Changes to this policy">
        <p>
          When this changes we update the date at the top. If a change matters to
          you &mdash; a new company in the table above, a new purpose &mdash; we
          will tell you rather than relying on you re-reading this page.
        </p>
      </Clause>
    </LegalDocument>
  );
}
