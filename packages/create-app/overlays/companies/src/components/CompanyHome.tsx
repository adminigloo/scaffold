import Link from "next/link";
import type { CSSProperties } from "react";
import type { PublicCompanyWire } from "__SCOPE__/tenancy-widget";
import { buttonClass } from "@/components/ui";
import type { CompanyHome } from "@/server/company-home";
import { PUBLIC_COMPANY_PAGES } from "@/tenancy";

/**
 * The page's buttons: the app's filled button, in the company's colour, and
 * the hero's at a larger size. Written
 * out rather than passed to buttonClass() as extras, because two padding
 * utilities on one element are decided by stylesheet order, not by intent.
 */
const BAR_BUTTON =
  "inline-flex min-h-11 items-center justify-center rounded-control bg-accent px-4 text-sm font-medium text-surface " +
  "no-underline shadow-card transition-colors hover:bg-accent-strong";
const HERO_BUTTON =
  "inline-flex min-h-14 w-full items-center justify-center rounded-control bg-accent px-7 text-base font-semibold text-surface " +
  "no-underline shadow-card transition-colors hover:bg-accent-strong sm:w-auto";

/** One line under each public page's card: what it's for. Read by path; a page this project doesn't have is never listed. */
const PAGE_BLURBS: Readonly<Record<string, string>> = {
  "/estimate": "Answer a few questions and see your price in about a minute.",
  "/book-visit": "Pick a time for us to come out. We confirm it by email.",
  "/book": "Book a call to talk it through, by phone or video.",
  "/store": "Order online and pay by card.",
};

/**
 * A company's home page, drawn from its public details and what this project
 * offers (create-app 0.36, the mini website). Presentational: the route
 * (app/(company)/t/[slug]/page.tsx) reads `home` and hands it in, so the page
 * can be drawn — and checked — without a database behind it.
 */
export function CompanyHomeView({ company, home }: { readonly company: PublicCompanyWire; readonly home: CompanyHome | null }) {
  const brand: CSSProperties | undefined =
    company.brandColor && company.onBrandColor
      ? { backgroundColor: company.brandColor, color: company.onBrandColor, borderColor: company.brandColor }
      : undefined;
  const primary = home?.primary ?? null;
  // Every other public page, as a card: not the hero's own button, and
  // never feedback (that's a small link in the footer).
  const others = PUBLIC_COMPANY_PAGES.filter((page) => page.path !== primary?.path && page.path !== "/feedback");
  const feedback = PUBLIC_COMPANY_PAGES.find((page) => page.path === "/feedback");
  const tel = home?.phone ? `tel:${home.phone.replace(/[^\d+]/g, "")}` : null;
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            {company.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={company.logoUrl} alt="" className="h-10 w-auto max-w-[140px] object-contain" />
            ) : null}
            <span className="truncate text-base font-semibold tracking-tight text-ink">{company.name}</span>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {home?.phone && tel ? (
              <a href={tel} className="hidden text-sm font-medium text-ink no-underline hover:underline sm:inline">
                {home.phone}
              </a>
            ) : null}
            {primary ? (
              // The hero carries the big button on a phone; the bar carries it from sm up.
              <span className="hidden sm:block">
                <Link href={`${company.publicPath}${primary.path}`} className={BAR_BUTTON} style={brand}>
                  {primary.label}
                </Link>
              </span>
            ) : tel ? (
              <a href={tel} className={buttonClass("secondary", "sm:hidden")}>
                Call
              </a>
            ) : null}
          </div>
        </div>
      </header>

      <section aria-label={company.name} className="border-b border-line bg-surface">
        <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-20">
          <h1 className="max-w-[20ch] text-[clamp(2rem,5vw,3.25rem)] leading-[1.08] font-semibold tracking-[-0.03em] text-balance text-ink">
            {company.name}
          </h1>
          {home?.tagline ? <p className="mt-4 max-w-[52ch] text-lg leading-relaxed text-ink-muted">{home.tagline}</p> : null}
          {primary ? (
            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-5">
              <Link
                href={`${company.publicPath}${primary.path}`}
                className={HERO_BUTTON}
                style={brand}
                data-home-primary=""
              >
                {primary.label}
              </Link>
              <p className="text-sm text-ink-muted">{primary.hint}</p>
            </div>
          ) : null}
          <ul className="mt-10 flex list-none flex-col gap-2 p-0 text-sm text-ink-muted sm:flex-row sm:flex-wrap sm:gap-x-8">
            {home?.serviceArea ? (
              <li>
                <span className="font-medium text-ink">Serving</span> {home.serviceArea}
              </li>
            ) : null}
            {home?.phone && tel ? (
              <li>
                <span className="font-medium text-ink">Call</span>{" "}
                <a href={tel} className="text-accent underline underline-offset-2">
                  {home.phone}
                </a>
              </li>
            ) : null}
            {home && home.hours.length > 0 ? (
              <li>
                <span className="font-medium text-ink">Open</span> {home.hours[0]}
                {home.hours.length > 1 ? " and more below" : ""}
              </li>
            ) : null}
          </ul>
        </div>
      </section>

      {home && home.services.length > 0 ? (
        <section aria-labelledby="services" className="border-b border-line">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
            <h2 id="services" className="text-2xl font-semibold tracking-tight text-ink">
              What we do
            </h2>
            <ul className="mt-6 grid list-none gap-4 p-0 sm:grid-cols-2 lg:grid-cols-3" data-home-services="">
              {home.services.map((service) => (
                <li key={service.name} className="flex flex-col rounded-[--radius-card] border border-line bg-surface p-5 shadow-card">
                  <h3 className="text-base font-semibold text-ink">{service.name}</h3>
                  {service.description ? <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">{service.description}</p> : null}
                  <p className="mt-auto pt-4 text-sm text-ink-muted">
                    {service.from ? (
                      <>
                        From <span className="text-lg font-semibold text-ink tabular-nums">{service.from}</span>
                      </>
                    ) : (
                      "Priced by quote"
                    )}
                  </p>
                </li>
              ))}
            </ul>
            {primary ? (
              <p className="mt-6 text-sm text-ink-muted">
                Every job is different.{" "}
                <Link href={`${company.publicPath}${primary.path}`} className="font-medium text-accent underline underline-offset-2">
                  {primary.label}
                </Link>{" "}
                for yours.
              </p>
            ) : null}
          </div>
        </section>
      ) : null}

      {others.length > 0 ? (
        <section aria-labelledby="more" className="border-b border-line">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
            <h2 id="more" className="text-2xl font-semibold tracking-tight text-ink">
              Book or buy online
            </h2>
            <ul className="mt-6 grid list-none gap-4 p-0 sm:grid-cols-2 lg:grid-cols-3">
              {others.map((page) => (
                <li key={page.path}>
                  <Link
                    href={`${company.publicPath}${page.path}`}
                    className="flex h-full flex-col rounded-[--radius-card] border border-line bg-surface p-5 no-underline shadow-card transition-colors hover:border-line-strong"
                  >
                    <span className="text-base font-semibold text-ink">{page.label}</span>
                    {PAGE_BLURBS[page.path] ? <span className="mt-1.5 text-sm leading-relaxed text-ink-muted">{PAGE_BLURBS[page.path]}</span> : null}
                    <span className="mt-auto pt-4 text-sm font-medium text-accent" aria-hidden="true">
                      Open &rarr;
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      {home && (home.phone || home.email || home.address || home.hours.length > 0) ? (
        <section aria-labelledby="contact">
          <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:grid-cols-2 sm:px-6">
            <div>
              <h2 id="contact" className="text-2xl font-semibold tracking-tight text-ink">
                Get in touch
              </h2>
              <dl className="mt-5 flex flex-col gap-3 text-sm">
                {home.phone && tel ? (
                  <div className="flex gap-3">
                    <dt className="w-20 shrink-0 text-ink-muted">Phone</dt>
                    <dd className="m-0">
                      <a href={tel} className="text-accent underline underline-offset-2">
                        {home.phone}
                      </a>
                    </dd>
                  </div>
                ) : null}
                {home.email ? (
                  <div className="flex gap-3">
                    <dt className="w-20 shrink-0 text-ink-muted">Email</dt>
                    <dd className="m-0 min-w-0 break-words">
                      <a href={`mailto:${home.email}`} className="text-accent underline underline-offset-2">
                        {home.email}
                      </a>
                    </dd>
                  </div>
                ) : null}
                {home.address ? (
                  <div className="flex gap-3">
                    <dt className="w-20 shrink-0 text-ink-muted">Address</dt>
                    <dd className="m-0 text-ink">{home.address}</dd>
                  </div>
                ) : null}
                {home.serviceArea ? (
                  <div className="flex gap-3">
                    <dt className="w-20 shrink-0 text-ink-muted">Serving</dt>
                    <dd className="m-0 text-ink">{home.serviceArea}</dd>
                  </div>
                ) : null}
              </dl>
            </div>
            {home.hours.length > 0 ? (
              <div>
                <h2 className="text-2xl font-semibold tracking-tight text-ink">Hours</h2>
                <ul className="mt-5 flex list-none flex-col gap-1.5 p-0 text-sm text-ink">
                  {home.hours.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      <footer className="mt-auto border-t border-line bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-sm text-ink-muted sm:px-6">
          <span>
            &copy; {new Date().getFullYear()} {company.name}
          </span>
          {feedback ? (
            <Link href={`${company.publicPath}${feedback.path}`} className="text-ink-muted underline underline-offset-2 hover:text-ink">
              {feedback.label}
            </Link>
          ) : null}
        </div>
      </footer>
    </div>
  );
}
