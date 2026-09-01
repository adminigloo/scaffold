import type { ReactNode } from "react";
import { cx } from "@/components/ui";

/**
 * The landing page's one structural device: a full-width band, ruled off from
 * the one above it, with a mono label hanging in the left margin.
 *
 * WHY A RAIL AND NOT CARDS. Everything else in this product is a card, because
 * everything else in this product is data — a card's border is what says "this
 * row is one thing". A landing page has no rows. Wrapping paragraphs in
 * bordered panels there produces the look every generated marketing page has:
 * six rounded boxes on a tinted background, each with a coloured stripe,
 * carrying no information the boxes do not invent. Rules and space cost nothing
 * and read as deliberate.
 *
 * THE LABEL IS INFORMATION, not decoration. It names what the section is FOR —
 * what it is, what you get, who uses it, questions, start — so a reader
 * skimming the left margin gets the argument of the page in five words. That is
 * also why they are not numbered: these sections are not a sequence, a client
 * will delete half of them, and `01 / 02 / 03` down a page whose order carries
 * no meaning is a pattern pretending to be structure.
 *
 * `tone="accent"` is the page's ONE tinted band, and it belongs to the closing
 * call to action. Spend it twice and neither is emphasis.
 *
 * The grid collapses to one column below `md`, where a 9rem margin would leave
 * the text about twenty characters wide.
 */
export function Section({
  id,
  label,
  tone = "plain",
  children,
}: {
  /** Anchor target, so the hero can link to a section without a route. */
  readonly id?: string;
  readonly label: string;
  readonly tone?: "plain" | "accent";
  readonly children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-label={label}
      className={cx(
        "border-t border-line",
        tone === "accent" && "bg-accent-soft",
      )}
    >
      <div className="mx-auto grid max-w-5xl gap-x-10 gap-y-5 px-6 py-16 md:grid-cols-[9rem_1fr] md:py-20">
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-muted md:pt-1.5">
          {label}
        </p>
        <div className="min-w-0">{children}</div>
      </div>
    </section>
  );
}

/**
 * A section's own heading and its one supporting line.
 *
 * Separate from `Section` so a section can have none. The FAQ does not want a
 * paragraph of preamble above eleven words of question, and a heading component
 * that forced one is a heading component people stop using.
 */
export function SectionHeading({
  title,
  children,
}: {
  readonly title: string;
  readonly children?: ReactNode;
}) {
  return (
    <header className="mb-8 max-w-[34ch]">
      <h2 className="text-2xl font-semibold tracking-[-0.02em] text-balance sm:text-[1.75rem]">
        {title}
      </h2>
      {children && (
        <p className="mt-2.5 max-w-[52ch] text-[15px] leading-relaxed text-ink-muted">
          {children}
        </p>
      )}
    </header>
  );
}
