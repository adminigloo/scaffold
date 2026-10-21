import type { ReactNode } from "react";
import type { PlanColumn, PlanColumnPrice } from "__SCOPE__/billing";
import { cx } from "@/components/ui";

/**
 * ONE PLAN, DRAWN ONE WAY (create-app 0.39) — the pricing page, the landing
 * page's plans and the plan chooser on /account/billing all draw this, from
 * the same `planColumns(plans, …)` answer (@__SCOPE_NAME__/billing), so the
 * three can never describe a plan differently.
 *
 * What it shows is decided by the record and nothing else:
 *   - the plan's name, its one-line description, its price in whole units
 *     when there is nothing after the point ("$100/yr", "2 months free");
 *   - what it INCLUDES — never "No pro tools" — and, for the next tier up,
 *     "Everything in Basic, plus:" with only what it adds;
 *   - a badge only when there is something true to say: "Your plan",
 *     "Coming soon" (onSale: "coming"), or "Most popular" where the record
 *     set `highlight` (it is never added on its own).
 *
 * No hooks and no server imports, so a server page and the client chooser
 * both render it. The ACTION is the caller's: a link on the plans pages, the
 * chooser's button on the billing page.
 */
export interface PlanCardProps {
  readonly column: PlanColumn;
  /** The button under the price. */
  readonly action?: ReactNode;
  /** The plan this account is on. */
  readonly current?: boolean;
  /** Ringed, and badged as picked: the plan someone chose on the pricing page before signing in. */
  readonly picked?: boolean;
  /** A "What's included" detail listing everything, when it says more than the list above it. */
  readonly detail?: boolean;
}

export function PlanCard({ column, action, current = false, picked = false, detail = true }: PlanCardProps) {
  const badge = current
    ? "Your plan"
    : column.onSale === "coming"
      ? "Coming soon"
      : picked
        ? "The plan you picked"
        : column.highlight
          ? "Most popular"
          : null;
  const ringed = !current && (picked || column.highlight);

  return (
    <div className="flex w-full flex-col">
      {/* Above the card, a fixed height, so every card's top lines up whether
          or not it has a badge. */}
      <p className="h-5 text-xs leading-5 font-semibold text-accent">{badge}</p>
      <div
        className={cx(
          "mt-1.5 flex flex-1 flex-col rounded-[--radius-card] border bg-surface p-6 shadow-card",
          ringed ? "border-accent" : "border-line",
        )}
      >
        <h3 className="text-lg font-semibold tracking-tight text-ink">{column.name}</h3>
        {column.description !== null ? (
          <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">{column.description}</p>
        ) : null}

        <div className="mt-5 min-h-[3.75rem]">
          <Price price={column.price} />
        </div>

        {action ? <div className="mt-5">{action}</div> : null}

        {column.includes.length > 0 ? (
          <>
            <p className="mt-6 text-sm font-medium text-ink">
              {column.buildsOn !== null ? `Everything in ${column.buildsOn}, plus:` : "What's included:"}
            </p>
            <ul className="mt-2 flex list-none flex-col gap-2 p-0">
              {column.includes.map((bullet) => (
                <li key={bullet.feature} className="flex gap-2 text-sm leading-snug text-ink-muted">
                  <Tick />
                  <span>{bullet.text}</span>
                </li>
              ))}
            </ul>
          </>
        ) : null}

        {detail && column.everything.length > column.includes.length ? (
          <details className="group mt-3 text-sm">
            <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1 font-medium text-accent [&::-webkit-details-marker]:hidden">
              Everything {column.name} includes
              <span aria-hidden="true" className="text-ink-muted group-open:rotate-180">
                &#x25BE;
              </span>
            </summary>
            <ul className="mt-1 flex list-none flex-col gap-1.5 p-0 text-[13px] leading-snug text-ink-muted">
              {column.everything.map((bullet) => (
                <li key={bullet.feature}>{bullet.text}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </div>
  );
}

/** A row of plan cards: as many columns as fit, never a lonely fourth under three. */
export function PlanCards({ children }: { readonly children: ReactNode }) {
  return (
    <ul className="grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))] gap-6 p-0">{children}</ul>
  );
}

/** One cell of `PlanCards`. */
export function PlanCardCell({ children }: { readonly children: ReactNode }) {
  return <li className="flex">{children}</li>;
}

function Price({ price }: { readonly price: PlanColumnPrice }) {
  if (price.kind === "free") {
    return <p className="text-[1.75rem] leading-none font-semibold tracking-[-0.03em] text-ink">{price.label}</p>;
  }
  if (price.kind === "enquire") {
    return <p className="text-[1.4rem] leading-none font-semibold tracking-[-0.02em] text-ink">Custom pricing</p>;
  }
  if (price.kind === "other-interval") {
    return (
      <p className="text-sm text-ink-muted">
        Sold {price.available.map((each) => (each === "year" ? "yearly" : each === "month" ? "monthly" : "once")).join(" and ")} only.
      </p>
    );
  }
  return (
    <p>
      <span className="text-[1.75rem] leading-none font-semibold tracking-[-0.03em] tabular-nums text-ink">{price.label}</span>
      {price.per ? <span className="text-sm text-ink-muted">{price.per}</span> : null}
      {price.note !== null ? <span className="mt-1 block text-[13px] text-accent">{price.note}</span> : null}
    </p>
  );
}

function Tick() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="mt-0.5 size-4 shrink-0 text-accent" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4.5 10.5l3.5 3.5 7.5-8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
