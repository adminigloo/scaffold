import Link from "next/link";
import type { ReactNode } from "react";
import type { PlanInterval } from "__SCOPE__/billing";
import { cx } from "@/components/ui";
import { intervalName } from "@/components/marketing/pricing/planPresentation";

/**
 * The cadence switch and the currency switch, as LINKS.
 *
 * NOT A CLIENT COMPONENT, and that is the whole design. The selection lives in
 * the query string, which buys four things a `useState` toggle does not: the
 * page a customer sends a colleague shows the same prices they were looking at,
 * a refresh does not reset it, a reader with JavaScript off can still switch,
 * and — the one that matters structurally — the page stays a server component,
 * so the same render that decides the price can also ask the database whether
 * anything is purchasable yet.
 *
 * BOTH SWITCHES PRESERVE THE OTHER. A currency link that dropped the interval
 * would send somebody comparing annual prices back to monthly halfway through
 * the comparison, which reads as the page having changed its mind about the
 * numbers.
 *
 * NEITHER RENDERS WHEN THERE IS NOTHING TO CHOOSE. The record decides: a
 * catalog priced only monthly offers no cadence switch, and one priced in a
 * single currency offers no currency switch. A control with one position is a
 * control that does nothing, and a reader who clicks it and sees no change
 * concludes the page is broken.
 */
export function PricingControls({
  intervals,
  currencies,
  interval,
  currency,
}: {
  readonly intervals: readonly PlanInterval[];
  readonly currencies: readonly string[];
  readonly interval: PlanInterval;
  readonly currency: string;
}) {
  if (intervals.length < 2 && currencies.length < 2) return null;

  return (
    <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
      {intervals.length > 1 && (
        <Switch label="Billing period">
          {intervals.map((candidate) => (
            <Option
              key={candidate}
              href={hrefFor(candidate, currency)}
              current={candidate === interval}
            >
              {intervalName(candidate)}
            </Option>
          ))}
        </Switch>
      )}

      {currencies.length > 1 && (
        <Switch label="Currency">
          {currencies.map((candidate) => (
            <Option
              key={candidate}
              href={hrefFor(interval, candidate)}
              current={candidate === currency}
            >
              {candidate.toUpperCase()}
            </Option>
          ))}
        </Switch>
      )}
    </div>
  );
}

function hrefFor(interval: PlanInterval, currency: string): string {
  return `/pricing?interval=${interval}&currency=${currency}`;
}

/**
 * A hairline-bordered group with a hidden label.
 *
 * The label is for a screen reader rather than for the page: sighted readers
 * know what "Monthly / Annual" is, and a visible "Billing period:" caption in
 * front of a two-word control is noise. `aria-label` on the group is what makes
 * the two switches distinguishable when they are read out one after the other.
 */
function Switch({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div
      aria-label={label}
      className="inline-flex items-center gap-px rounded-[--radius-card] border border-line bg-surface p-px"
    >
      {children}
    </div>
  );
}

/**
 * `aria-current="page"` rather than a disabled link.
 *
 * The selected option is still a link to a real URL — that is what makes the
 * control work with no JavaScript, and it is what a middle-click or a bookmark
 * needs. What changes is how it is announced and how it looks.
 */
function Option({
  href,
  current,
  children,
}: {
  readonly href: string;
  readonly current: boolean;
  readonly children: ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      className={cx(
        "rounded-[3px] px-3 py-1 text-[13px] font-medium no-underline transition-colors",
        current
          ? "bg-accent text-surface"
          : "text-ink-muted hover:bg-canvas hover:text-ink",
      )}
    >
      {children}
    </Link>
  );
}
