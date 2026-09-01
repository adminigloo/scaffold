import { Section } from "@/components/marketing/Section";

/**
 * Social proof, built as a slot rather than as a fiction.
 *
 * THE ATTRIBUTION SAYS WHAT IT IS ON PURPOSE. A scaffold cannot ship a
 * testimonial: an invented customer with an invented job title is a fabricated
 * endorsement, it is the single easiest thing in a template to forget to
 * replace, and the version that reaches production is a lie with somebody's
 * name on it. So the quote is written as the kind of sentence a real customer
 * says — which is what makes the layout worth looking at — and the line under
 * it is unmistakably an editorial note. Nobody can mistake this for shipped
 * copy, and nobody has to guess what goes here.
 *
 * Replace both, or delete the whole section. An empty proof section is more
 * persuasive than a fake one, and every reader of a landing page has learnt to
 * read a wall of unfamiliar logos as decoration.
 *
 * ONE QUOTE, NOT THREE. A carousel of testimonials is read as a carousel of
 * testimonials; a single one set large enough to be unavoidable is read.
 */
const QUOTE = {
  text:
    "We moved three spreadsheets and a shared inbox into one place. The end " +
    "of the month stopped being a whole day's work, and nobody has asked me " +
    "for the latest version of anything since.",
  /** Replace with a real person who has agreed to be quoted. */
  attribution: "Replace with a real customer — never ship an invented one",
} as const;

/**
 * The logo row, as words.
 *
 * Text rather than image placeholders, because a grey box that says nothing is
 * indistinguishable from a broken image and because these strings say what they
 * are. Swap each for an inline SVG at the same optical size: a logo row is the
 * one place on a landing page where an image is genuinely the content.
 */
const CUSTOMERS: readonly string[] = [
  "Your client",
  "Another client",
  "A third",
  "And a fourth",
];

export function SocialProof() {
  return (
    <Section label="In use">
      <figure className="m-0">
        <blockquote className="m-0">
          <p className="max-w-[38ch] text-[1.55rem] leading-[1.3] font-medium tracking-[-0.02em] text-balance text-ink sm:text-[1.75rem]">
            &ldquo;{QUOTE.text}&rdquo;
          </p>
        </blockquote>
        <figcaption className="mt-6 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-muted">
          {QUOTE.attribution}
        </figcaption>
      </figure>

      <ul className="mt-12 flex list-none flex-wrap items-center gap-x-10 gap-y-4 border-t border-line p-0 pt-6">
        {CUSTOMERS.map((customer) => (
          <li
            key={customer}
            className="font-mono text-[13px] font-medium uppercase tracking-[0.12em] text-ink-muted"
          >
            {customer}
          </li>
        ))}
      </ul>
    </Section>
  );
}
