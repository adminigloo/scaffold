import type { Metadata } from "next";
import { EstimateTool } from "@/components/estimate/EstimateTool";

export const metadata: Metadata = {
  title: "Instant estimate",
  description:
    "Get a real ballpark in seconds — before anyone drives out. A live estimate from our own price book, not a mockup.",
  alternates: { canonical: "/estimate" },
};

/**
 * The public instant-estimate tool — a free lead magnet and the live proof that
 * __SCOPE__/estimator works. The scores come from the real seeded catalog and
 * the real pricing engine; saving one files a lead into the admin.
 */
export default function EstimatePage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-14 sm:py-20">
      <p className="font-mono text-[12px] font-medium uppercase tracking-[0.16em] text-accent">
        Instant estimate
      </p>
      <h1
        className="mt-3 text-4xl leading-[1.1] tracking-tight text-balance text-ink sm:text-5xl"
        style={{ fontFamily: "var(--font-display)" }}
      >
        A real number, before anyone drives out.
      </h1>
      <p className="mt-5 max-w-[52ch] text-[16px] leading-relaxed text-ink-muted sm:text-[17px]">
        Pick what you need, enter a measurement, and see an honest ballpark from our own price
        book in seconds. No waiting for a call back, no surprise when the truck shows up.
      </p>

      <div className="mt-10 rounded-[--radius-card] border border-line bg-surface p-5 shadow-card sm:p-6">
        <EstimateTool />
      </div>
    </main>
  );
}
