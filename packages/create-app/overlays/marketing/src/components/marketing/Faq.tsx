import Link from "next/link";
import { Section, SectionHeading } from "@/components/marketing/Section";
import { FAQ } from "@/marketing-copy";

/**
 * The questions an owner asks before signing up, as a disclosure list. Plus
 * and minus glyphs rather than a rotating chevron: legible at 12px, and never
 * caught half-turned on a slow paint. Every word: src/marketing-copy.ts.
 */
export function Faq() {
  return (
    <Section id="questions" label="Questions">
      <SectionHeading title="Questions owners ask" />
      <div className="max-w-3xl border-b border-line">
        {FAQ.map((item) => (
          <details key={item.q} className="group border-t border-line">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-6 py-4 text-base font-medium text-ink [&::-webkit-details-marker]:hidden">
              {item.q}
              <span aria-hidden="true" className="shrink-0 text-lg text-ink-muted select-none">
                <span className="group-open:hidden">+</span>
                <span className="hidden group-open:inline">&minus;</span>
              </span>
            </summary>
            <div className="max-w-[62ch] pb-5 text-[15px] leading-relaxed text-ink-muted">
              {item.a}
              {item.link ? (
                <>
                  {" "}
                  <Link href={item.link.href} className="font-medium text-accent underline underline-offset-2">
                    {item.link.label}
                  </Link>
                </>
              ) : null}
            </div>
          </details>
        ))}
      </div>
    </Section>
  );
}
