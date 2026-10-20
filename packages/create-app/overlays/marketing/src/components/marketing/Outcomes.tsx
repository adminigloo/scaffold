import { Section, SectionHeading } from "@/components/marketing/Section";
import { Screenshot } from "@/components/marketing/Screenshot";
import { OUTCOMES, TRADE } from "@/marketing-copy";

/**
 * Three outcomes an owner pays for — not a feature list. Each can carry a
 * screenshot of the screen that delivers it, shown once the file is saved.
 * Every word: src/marketing-copy.ts.
 */
export function Outcomes() {
  return (
    <Section id="what-you-get" label="What you get">
      <SectionHeading title={`Built for how ${TRADE.customers} actually work`}>
        Less time in the office, more time on the {TRADE.job}, and nothing that slips through the cracks.
      </SectionHeading>
      <ul className="grid list-none gap-6 p-0 md:grid-cols-3">
        {OUTCOMES.map((outcome, index) => (
          <li key={outcome.title} className="flex flex-col rounded-[--radius-card] border border-line bg-surface p-6 shadow-card">
            <span
              aria-hidden="true"
              className="inline-flex size-9 items-center justify-center rounded-pill bg-accent-soft text-sm font-semibold text-accent"
            >
              {index + 1}
            </span>
            <h3 className="mt-4 text-lg font-semibold tracking-tight text-ink">{outcome.title}</h3>
            <p className="mt-2 text-[15px] leading-relaxed text-ink-muted">{outcome.body}</p>
            {outcome.screenshot ? <Screenshot slot={outcome.screenshot} className="mt-5" /> : null}
          </li>
        ))}
      </ul>
    </Section>
  );
}
