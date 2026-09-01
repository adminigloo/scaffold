import type { Metadata } from "next";
import Link from "next/link";
import { plans as planTable } from "__SCOPE__/billing/schema";
import { isDbConfigured } from "__SCOPE__/db";
import { Notice } from "@/components/ui";
import { db } from "@/db";
import { plans } from "@/plans";
// From the `marketing` overlay, which is selected whenever this one is — the
// pricing page needs both a marketing site to belong to and plans to price. It
// borrows the landing page's section shell on purpose: a pricing page set in the
// product's tool typography, one click from a landing page set in the marketing
// typography, reads as two different websites.
import { Section, SectionHeading } from "@/components/marketing/Section";
import { ComparisonTable } from "@/components/marketing/pricing/ComparisonTable";
import { PlanColumns } from "@/components/marketing/pricing/PlanColumns";
import { PricingControls } from "@/components/marketing/pricing/PricingControls";
import {
  resolveCurrency,
  resolveInterval,
  toggleableIntervals,
} from "@/components/marketing/pricing/planPresentation";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "What each plan includes and what it costs. Every line comes from the same record the software enforces.",
  alternates: { canonical: "/pricing" },
};

/**
 * NOT STATIC, and the reason is not the prices.
 *
 * The prices come from `src/plans.ts`, which is source: they are fixed at build
 * time and a cached page would be perfectly correct about them. What is not
 * fixed is whether the `plans` table has caught up with that record yet — which
 * is a fact about the database at this moment, and a page cached at build time
 * would serve one afternoon's answer to that question for the life of the
 * deployment, including the wrong one from before the seed was run.
 *
 * Reading `searchParams` for the cadence would force this anyway. Both are
 * stated because either one alone would look removable.
 */
export const dynamic = "force-dynamic";

interface PricingParams {
  readonly interval?: string;
  readonly currency?: string;
}

/**
 * The pricing page, rendered from the plan record.
 *
 * THE ONE RULE THIS PAGE EXISTS TO HOLD: every number and every feature line on
 * it comes out of `src/plans.ts`, which is the same object `grantsForPlan` turns
 * into entitlement rows and the same object `pnpm db:seed:plans` projects into
 * the `plans` table. A pricing page written as prose drifts from what the code
 * honours inside one release, and the person who finds out is a customer who
 * paid for something they do not get. There is no number typed into this file.
 *
 * RETIRED TIERS ARE ABSENT. `isActive: false` is how a tier is taken off sale
 * without stranding the people on it — the record still describes it so
 * `planGrantDiff` can reason about their entitlements, and this page does not
 * advertise it. That filter is the whole of the difference between "on the
 * pricing page" and "in the record".
 *
 * IT RENDERS WITH NO DATABASE AND NO STRIPE KEY. On a fresh clone the prices are
 * right and nothing is purchasable, and the page says exactly that rather than
 * rendering four empty cards. The alternative — reading prices out of the table
 * or out of Stripe — is a pricing page that shows nothing at all until somebody
 * has run a script, which is the failure the record was written to end.
 */
export default async function PricingPage({
  searchParams,
}: {
  readonly searchParams: Promise<PricingParams>;
}) {
  const params = await searchParams;
  const interval = resolveInterval(params.interval, plans);
  const currency = resolveCurrency(params.currency, plans);

  const onSale = plans.tiers.filter((tier) => tier.isActive);

  // ASKED BEFORE ANYTHING QUERIES, the same way every other page in this project
  // asks it. `db` is a stand-in that throws a typed error on the first query
  // when DATABASE_URL is unset, and this page is linked from the header of every
  // other page — so on a fresh clone it is among the first things anybody
  // clicks, and it must not be the thing that 500s.
  const purchasable: ReadonlySet<string> | null = isDbConfigured(db)
    ? new Set(
        (await db.select({ key: planTable.key }).from(planTable)).map(
          (row) => row.key,
        ),
      )
    : null;

  // Every row the record projects for a tier that is still on sale. A retired
  // tier's rows are deliberately not counted: they SHOULD be in the table and
  // are not advertised here, so counting them would report a project as
  // under-seeded for doing exactly the right thing.
  const expected = plans.rows.filter(
    (row) => plans.tier(row.tierKey)?.isActive === true,
  );
  const missing =
    purchasable === null
      ? []
      : expected.filter((row) => !purchasable.has(row.key));

  return (
    <>
      <section className="mx-auto max-w-5xl px-6 pt-16 pb-4 sm:pt-20">
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-muted">
          Pricing
        </p>

        <h1 className="mt-5 max-w-[16ch] text-[clamp(2rem,5.5vw,3rem)] leading-[1.05] font-semibold tracking-[-0.035em] text-balance">
          Pick a plan. Change it whenever.
        </h1>

        <p className="mt-5 max-w-[52ch] text-[17px] leading-relaxed text-ink-muted">
          Every allowance below is the one the software actually enforces &mdash;
          the page and the code read the same record, so a plan cannot advertise
          something your account does not get.
        </p>

        <PricingControls
          intervals={toggleableIntervals(plans)}
          currencies={plans.currencies}
          interval={interval}
          currency={currency}
        />

        {/*
          THE ZERO STATE, AND IT IS NOT AN EMPTY PAGE.

          The prices above are correct on a machine with nothing configured,
          because they are source. What needs a database is a `plans` ROW: it is
          what `subscriptions.plan_id` points at and where the Stripe price id is
          cached, so with an empty table there is a published price and nothing
          anybody can actually subscribe to.

          Said out loud rather than hidden, on the same principle the storefront
          follows. This only appears in a state that is genuinely broken, and a
          broken state nobody can see is the one that reaches production.
        */}
        {purchasable === null ? (
          <div className="mt-10">
            <Notice tone="info" title="Prices are real; subscribing is not wired up yet">
              These come from <code className="font-mono text-xs">src/plans.ts</code>,
              so they are correct with no database at all. Subscribing needs a{" "}
              <code className="font-mono text-xs">plans</code> row, which needs{" "}
              <code className="font-mono text-xs">DATABASE_URL</code> &mdash;{" "}
              <Link href="/setup" className="text-accent underline underline-offset-2">
                /setup
              </Link>{" "}
              lists what else is outstanding.
            </Notice>
          </div>
        ) : purchasable.size === 0 ? (
          <div className="mt-10">
            <Notice tone="warn" title="No plan has been published yet">
              The <code className="font-mono text-xs">plans</code> table is empty,
              so nothing on this page can be bought. Run{" "}
              <code className="font-mono text-xs">pnpm db:seed:plans</code> to
              write the projection of{" "}
              <code className="font-mono text-xs">src/plans.ts</code> into it. It
              writes no fiction and is safe to run against any environment.
            </Notice>
          </div>
        ) : missing.length > 0 ? (
          <div className="mt-10">
            <Notice tone="warn" title={`${missing.length} of these prices cannot be bought yet`}>
              The record has moved on from the table:{" "}
              <code className="font-mono text-xs">
                {missing
                  .slice(0, 4)
                  .map((row) => row.key)
                  .join(", ")}
                {missing.length > 4 ? ", …" : ""}
              </code>{" "}
              {missing.length === 1 ? "is" : "are"} advertised here and absent
              from <code className="font-mono text-xs">plans</code>. Run{" "}
              <code className="font-mono text-xs">pnpm db:seed:plans</code>.
            </Notice>
          </div>
        ) : null}

        <PlanColumns tiers={onSale} interval={interval} currency={currency} />
      </section>

      <div className="mt-16">
        <Section label="Side by side">
          <SectionHeading title="What each plan includes">
            The same allowances, in one table. Every row is a feature the record
            declares, so no plan can be missing one.
          </SectionHeading>
          <ComparisonTable catalog={plans} tiers={onSale} />
        </Section>
      </div>

      <Section label="Questions">
        <SectionHeading title="About billing" />
        <dl className="flex flex-col gap-6">
          <div>
            <dt className="text-[15px] font-medium text-ink">
              Can I change plan later?
            </dt>
            <dd className="mt-1.5 max-w-[58ch] text-[15px] leading-relaxed text-ink-muted">
              Yes, either way. What you have already used in the current period
              stays used &mdash; moving from 500 exports to 5,000 having spent
              400 leaves you with 400 spent, not with a reset counter.
            </dd>
          </div>
          <div>
            <dt className="text-[15px] font-medium text-ink">
              What happens when I reach a limit?
            </dt>
            <dd className="mt-1.5 max-w-[58ch] text-[15px] leading-relaxed text-ink-muted">
              You are told which allowance you have reached and what it is on
              your plan. Nothing is deleted and nothing is charged
              automatically.
            </dd>
          </div>
          <div>
            <dt className="text-[15px] font-medium text-ink">
              Do prices include tax?
            </dt>
            <dd className="mt-1.5 max-w-[58ch] text-[15px] leading-relaxed text-ink-muted">
              <strong className="font-medium text-ink">Answer this one.</strong>{" "}
              Whether the amounts above are inclusive of VAT or sales tax depends
              on where you and your customer are, and getting it wrong is a
              refund and a correction rather than an argument.
            </dd>
          </div>
        </dl>
      </Section>
    </>
  );
}
