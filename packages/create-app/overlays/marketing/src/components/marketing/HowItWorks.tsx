import { Section, SectionHeading } from "@/components/marketing/Section";
import { STEPS } from "@/marketing-copy";

/** How it works, in three steps. Every word: src/marketing-copy.ts. */
export function HowItWorks() {
  return (
    <Section id="how-it-works" label="How it works">
      <SectionHeading title="Up and running in an afternoon" />
      <ol className="grid list-none gap-8 p-0 md:grid-cols-3">
        {STEPS.map((step, index) => (
          <li key={step.title} className="border-t-2 border-accent pt-5">
            <p className="text-sm font-semibold text-accent">Step {index + 1}</p>
            <h3 className="mt-2 text-lg font-semibold tracking-tight text-ink">{step.title}</h3>
            <p className="mt-2 text-[15px] leading-relaxed text-ink-muted">{step.body}</p>
          </li>
        ))}
      </ol>
    </Section>
  );
}
