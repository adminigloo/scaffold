import type { ReactNode } from "react";
import { cx } from "@/components/ui";

/**
 * One band of the marketing site: the same width, gutters and rhythm as every
 * other band, so the page reads as one piece. `label` names the band for a
 * screen reader; it is not drawn. `tone="accent"` is the one tinted band (the
 * closing call to action).
 */
export function Section({
  id,
  label,
  tone = "plain",
  children,
}: {
  readonly id?: string;
  readonly label: string;
  readonly tone?: "plain" | "accent";
  readonly children: ReactNode;
}) {
  return (
    <section id={id} aria-label={label} className={cx("border-t border-line", tone === "accent" ? "bg-accent-soft" : "bg-canvas")}>
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 md:py-24">{children}</div>
    </section>
  );
}

export function SectionHeading({
  title,
  children,
}: {
  readonly title: string;
  readonly children?: ReactNode;
}) {
  return (
    <header className="mb-10 max-w-[40ch]">
      <h2 className="text-[1.75rem] leading-tight font-semibold tracking-[-0.02em] text-balance text-ink sm:text-[2rem]">{title}</h2>
      {children && <p className="mt-3 max-w-[56ch] text-base leading-relaxed text-ink-muted">{children}</p>}
    </header>
  );
}
