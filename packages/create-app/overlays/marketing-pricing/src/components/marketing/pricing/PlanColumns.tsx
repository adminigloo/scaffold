import Link from "next/link";
import type { PlanInterval, PlanTier } from "__SCOPE__/billing";
import { buttonClass, cx } from "@/components/ui";
import {
  amountLabel,
  annualSavingPercent,
  featureBullet,
  intervalName,
  perLabel,
  priceDisplay,
} from "@/components/marketing/pricing/planPresentation";

/**
 * Where "Talk to us" goes.
 *
 * `example.com` is reserved by RFC 2606 precisely so a placeholder cannot reach
 * a real inbox, which is the only responsible default here. Replace it with the
 * address somebody reads: an enterprise tier whose one action bounces is worse
 * than an enterprise tier with no action at all.
 */
const SALES_CONTACT = "mailto:sales@example.com";

/**
 * One column per tier the record still sells.
 *
 * EVERY WORD IN A COLUMN COMES OUT OF `src/plans.ts`. The name, the sentence
 * under it, the price, and every line in the list — all of it is the same object
 * `grantsForPlan` turns into entitlement rows. That is the point of the whole
 * exercise: a hand-written pricing page and the enforcement code drift within
 * one release, and the way anybody finds out is a customer paying for something
 * they do not get.
 *
 * WHAT IS NOT FROM THE RECORD is the layout and the two verbs on the buttons.
 * Restyle freely; the moment you type a number in here you have made a second
 * copy of the answer.
 *
 * A COLUMN, NOT A CARD. The product's `Card` exists to say "this border is one
 * row of data"; a pricing table is a comparison, and four bordered boxes side by
 * side push the eye around the border instead of down the column it is meant to
 * be reading. A rule across the top does the grouping, and the recommended tier
 * gets a heavier rule in the accent — which is the only place colour appears
 * here, so it means something.
 *
 * `auto-fit` rather than a fixed column count. The number of active tiers is
 * data: a client with two plans and a client with six both get a grid that
 * fits, and neither gets a row of three columns with a lonely fourth beneath it.
 */
export function PlanColumns({
  tiers,
  interval,
  currency,
}: {
  readonly tiers: readonly PlanTier[];
  readonly interval: PlanInterval;
  readonly currency: string;
}) {
  return (
    <ul className="mt-12 grid list-none grid-cols-[repeat(auto-fit,minmax(13.5rem,1fr))] gap-x-8 gap-y-10 p-0">
      {tiers.map((tier) => (
        <li key={tier.key}>
          <PlanColumn tier={tier} interval={interval} currency={currency} />
        </li>
      ))}
    </ul>
  );
}

function PlanColumn({
  tier,
  interval,
  currency,
}: {
  readonly tier: PlanTier;
  readonly interval: PlanInterval;
  readonly currency: string;
}) {
  const price = priceDisplay(tier, interval, currency);
  const saving =
    interval === "year" ? annualSavingPercent(tier, currency) : null;

  // A generated array with no entry: a tier that withholds single sign-on
  // contributes no line rather than a line saying it does not have it. The
  // comparison table below is where a withheld feature is stated.
  //
  // Keyed on the FEATURE NAME rather than on the rendered line, because two
  // features can legitimately render the same words — a flag labelled "Priority
  // support" beside an option whose best value is "priority" — and duplicate
  // React keys drop one of them from the list with no error anywhere. The
  // iteration order is the order `definePlans` declared the vocabulary in, which
  // is the order the comparison table uses too.
  const bullets = Object.entries(tier.features)
    .map(([name, feature]) => ({ name, line: featureBullet(feature) }))
    .filter((entry): entry is { name: string; line: string } => entry.line !== null);

  return (
    <div className="flex h-full flex-col">
      {/*
        The badge sits ABOVE the rule rather than floating over the column, so
        the rule stays an unbroken line across the whole grid. A badge that
        notches the border is the detail that makes a pricing table look
        assembled rather than drawn.

        A FIXED HEIGHT rather than a transparent copy of the text or a
        non-breaking space. Both of those keep the rules aligned and both put an
        invisible character into the markup: one a screen reader may announce,
        and one nobody grepping this file would ever find. An empty box of a
        stated height says the same thing to the layout and nothing at all to
        anybody else.

        `highlight` is capped at one tier by `definePlans`, so this cannot
        appear twice and mean nothing.
      */}
      <p className="h-4 font-mono text-[10px] leading-4 uppercase tracking-[0.14em] text-accent">
        {tier.highlight ? "Most popular" : null}
      </p>

      <div
        className={cx(
          "mt-1.5 border-t-2 pt-5",
          tier.highlight ? "border-accent" : "border-line",
        )}
      >
        <h2 className="text-[15px] font-semibold tracking-tight text-ink">
          {tier.name}
        </h2>

        {tier.description !== null && (
          <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">
            {tier.description}
          </p>
        )}

        <div className="mt-5 min-h-[3.75rem]">
          <Price display={price} currency={currency} />
        </div>

        {saving !== null && (
          <p className="mt-1 text-[13px] text-accent">
            Save {saving}% against paying monthly
          </p>
        )}

        <div className="mt-5">
          <Action tier={tier} enquire={price.kind === "enquire"} />
        </div>

        <ul className="mt-6 flex list-none flex-col gap-2 p-0">
          {bullets.map((entry) => (
            <li
              key={entry.name}
              className="flex gap-2 text-[13px] leading-snug text-ink-muted"
            >
              <span aria-hidden="true" className="text-accent">
                &bull;
              </span>
              <span>{entry.line}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * The amount, or the honest reason there is not one.
 *
 * `min-h` on the container above rather than a fallback string here, so a
 * column with no price does not sit two lines higher than the ones beside it and
 * pull its button out of the row.
 */
function Price({
  display,
  currency,
}: {
  readonly display: ReturnType<typeof priceDisplay>;
  readonly currency: string;
}) {
  if (display.kind === "enquire") {
    return (
      <p className="text-[1.4rem] leading-none font-semibold tracking-[-0.02em] text-ink">
        Let&rsquo;s talk
      </p>
    );
  }

  if (display.kind === "other-interval") {
    return (
      <p className="text-sm text-ink-muted">
        Sold{" "}
        {display.available
          .map((candidate) => intervalName(candidate).toLowerCase())
          .join(" and ")}{" "}
        only.
      </p>
    );
  }

  const label = amountLabel(display.amountMinor, currency);

  return (
    <p>
      <span className="text-[1.75rem] leading-none font-semibold tracking-[-0.03em] tabular-nums text-ink">
        {label}
      </span>
      {/* No cadence under a free plan: "Free per month" is not a thing anybody
          says, and the record deliberately prices a free tier at 0 on every
          cadence so this is the only place the distinction has to be made. */}
      {display.amountMinor > 0n && (
        <span className="mt-1 block text-[13px] text-ink-muted">
          {perLabel(display.interval)}
        </span>
      )}
    </p>
  );
}

/**
 * What the button does.
 *
 * TWO DESTINATIONS AND NO THIRD. A published price means somebody can sign up,
 * so the button goes to the route every project has. No published price means
 * there is nothing to self-serve, so it goes to a person — and it must be a
 * different affordance rather than the same button with different words, or the
 * reader who clicks it expecting a checkout gets their mail client instead.
 *
 * `/sign-up` carries no plan in the URL. It would be easy to add `?plan=pro` and
 * nothing in this scaffold reads it, so it would be a contract with no other
 * side: the click would be recorded in an analytics tool and honoured by
 * nothing. Wire it up first, then put it here.
 */
function Action({
  tier,
  enquire,
}: {
  readonly tier: PlanTier;
  readonly enquire: boolean;
}) {
  if (enquire) {
    return (
      <a href={SALES_CONTACT} className={buttonClass("secondary", "w-full")}>
        Talk to us
      </a>
    );
  }

  return (
    <Link
      href="/sign-up"
      className={buttonClass(tier.highlight ? "primary" : "secondary", "w-full")}
    >
      Choose {tier.name}
    </Link>
  );
}
