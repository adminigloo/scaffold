import Link from "next/link";
import type { ReactNode } from "react";
import { Notice } from "@/components/ui";
import type { LegalClause } from "@/legal";
import { PUBLISHER } from "@/legal-publisher";

/**
 * The chrome both legal documents share: a heading, when it took effect, the
 * warning that this is a draft, and the shape of a clause.
 *
 * A LEGAL PAGE IS A DOCUMENT, NOT A SCREEN, so it gets a document's typography
 * rather than the product's. One narrow measure, numbered clauses a person can
 * cite in an email, and no cards — a privacy policy chopped into panels is one
 * nobody reads, and the reader who matters here is a lawyer working through it
 * top to bottom or a customer looking for one paragraph.
 *
 * The numbering is real information. These are clauses, they are referred to by
 * number in correspondence, and the number has to be stable — which is why it
 * comes from the position in the list rather than being typed into each heading
 * where an inserted clause would silently renumber nothing.
 */
export function LegalDocument({
  title,
  standfirst,
  children,
}: {
  readonly title: string;
  /** One sentence saying what this document is, in a person's words. */
  readonly standfirst: string;
  readonly children: ReactNode;
}) {
  return (
    <main className="mx-auto max-w-[46rem] px-6 py-14">
      <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-muted">
        __PROJECT_NAME__ &mdash; legal
      </p>

      <h1 className="mt-3 text-3xl font-semibold tracking-[-0.02em] text-balance">
        {title}
      </h1>

      <p className="mt-3 max-w-[58ch] text-[15px] leading-relaxed text-ink-muted">
        {standfirst}
      </p>

      <p className="mt-4 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-muted">
        {/* An empty date renders as this rather than as today's. See
            `effectiveDate` in src/legal-publisher.ts: a generated date is the
            date the project was scaffolded, which is not a date anybody agreed
            to anything on. */}
        {PUBLISHER.effectiveDate === ""
          ? "Draft — not yet published"
          : `In effect from ${PUBLISHER.effectiveDate}`}
      </p>

      {/*
        THE WARNING IS RENDERED, not left in a comment.

        Everything in these two documents that is derived from the code is
        accurate — the subprocessor list in particular is generated from the
        packages this project actually installed, which is the paragraph a
        copied template always gets wrong. None of that makes the document
        lawful advice for any particular business in any particular
        jurisdiction, and a page that looks finished is one that ships.

        Delete this block when a lawyer has been through it. That deletion is
        the point: it is one line, and it is a decision somebody has to make on
        purpose.
      */}
      <div className="mt-8">
        <Notice tone="warn" title="This is a starting point, not legal advice">
          It is accurate about how this software works and says nothing about
          whether what you do with it is lawful where you operate. Fill in{" "}
          <code className="font-mono text-xs">src/legal-publisher.ts</code>, have
          a lawyer read both documents, then delete this notice.
        </Notice>
      </div>

      <div className="mt-10 flex flex-col gap-9">{children}</div>

      <p className="mt-14 border-t border-line pt-5 text-sm text-ink-muted">
        The companion document is{" "}
        <Link
          href={title === "Privacy" ? "/terms" : "/privacy"}
          className="text-accent underline underline-offset-2"
        >
          {title === "Privacy" ? "our terms of service" : "our privacy policy"}
        </Link>
        .
      </p>
    </main>
  );
}

/**
 * One numbered clause.
 *
 * `id` is on the heading so a paragraph can be linked to directly. That is not
 * decoration: the only way a support thread or a security review ever refers to
 * one of these is by sending somebody a link to it, and a document with no
 * anchors forces "scroll down to the bit about retention".
 */
export function Clause({
  n,
  heading,
  children,
}: {
  readonly n: number;
  readonly heading: string;
  readonly children: ReactNode;
}) {
  const id = heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  return (
    <section aria-labelledby={id}>
      <h2
        id={id}
        className="flex gap-3 text-[15px] font-semibold tracking-tight text-ink"
      >
        <span className="font-mono text-ink-muted tabular-nums">{n}.</span>
        <span>{heading}</span>
      </h2>
      <div className="mt-2 flex flex-col gap-3 pl-[1.9rem] text-[15px] leading-relaxed text-ink-muted [&_strong]:font-medium [&_strong]:text-ink">
        {children}
      </div>
    </section>
  );
}

/**
 * A run of clauses that came out of `src/legal.ts`.
 *
 * A GENERATED ARRAY WITH NO ENTRY is how a project that sells nothing has no
 * subscription clause. The alternative — one clause hedged with "if
 * applicable" — is the phrase that makes a policy both unreadable and
 * unverifiable, and it is what every template does because a template cannot
 * know.
 */
export function GeneratedClauses({
  clauses,
  from,
}: {
  readonly clauses: readonly LegalClause[];
  /** The clause number the first of these takes. */
  readonly from: number;
}) {
  return (
    <>
      {clauses.map((clause, index) => (
        <Clause key={clause.heading} n={from + index} heading={clause.heading}>
          <p>{clause.body}</p>
        </Clause>
      ))}
    </>
  );
}

/**
 * A value from `src/legal-publisher.ts`, or a visible gap where one is missing.
 *
 * The gap is the feature. An unfilled placeholder that renders as nothing at
 * all is a page that looks complete and is not; this renders as something a
 * person cannot read past, in a document whose whole job is being read.
 */
export function PublisherValue({ value }: { readonly value: string }) {
  if (value === "") {
    return (
      <span className="border-b border-dashed border-warn text-warn">
        [not filled in]
      </span>
    );
  }
  return <>{value}</>;
}
