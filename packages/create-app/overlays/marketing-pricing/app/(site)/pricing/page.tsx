import type { Metadata } from "next";
import Link from "next/link";
import { plans as planTable } from "__SCOPE__/billing/schema";
import { isDbConfigured } from "__SCOPE__/db";
import { Notice } from "@/components/ui";
import { currentPrincipal } from "@/server/auth";
import { loadStaffPermissions } from "@/server/permissions";
import { db } from "@/db";
import { plans } from "@/plans";
import { PRICING } from "@/marketing-copy";
import { metadataFor } from "@/seo";
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

export const metadata: Metadata = metadataFor({ path: "/pricing", title: "Pricing", description: PRICING.description });

/**
 * NOT STATIC, and the reason is not the prices.
 *
 * The prices come from `src/plans.ts`, which is source: a cached page would be
 * correct about them. What is not fixed is whether the `plans` table has caught
 * up with that record yet — a fact about the database at this moment — and
 * whether the reader is signed in (their button goes straight to the plan
 * chooser).
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
 * it comes out of `src/plans.ts`, the same object the plan check enforces and
 * `pnpm db:seed:plans` projects into the `plans` table. There is no number
 * typed into this file. The cards are `PlanCard`s from `planColumns`
 * (@__SCOPE_NAME__/billing) — the same cards the plan chooser on
 * /account/billing and the landing page's plans draw — so a plan reads the same
 * everywhere: what it includes (never "No …"), "Everything in Free, plus:" for
 * the next one up, whole-dollar prices, yearly first.
 *
 * WHAT IS SHOWN: a line's free tier when the record declares one, every tier
 * on sale, and every tier `onSale: "coming"` (its price, and "Coming soon").
 * Retired tiers and plans sold by hand (`onSale: false`) are not.
 *
 * IT RENDERS WITH NO DATABASE AND NO STRIPE KEY. What needs a database is a
 * `plans` row to subscribe to, and only this site's staff are told when that is
 * missing; a visitor reads the prices.
 */
export default async function PricingPage({
  searchParams,
}: {
  readonly searchParams: Promise<PricingParams>;
}) {
  const params = await searchParams;
  const interval = resolveInterval(params.interval, plans);
  const currency = resolveCurrency(params.currency, plans);

  // Every tier somebody can see here: on sale, or coming.
  const shown = plans.tiers.filter((tier) => tier.isActive && tier.onSale !== false);

  // ASKED BEFORE ANYTHING QUERIES, the same way every other page here asks it:
  // on a fresh clone this page must not be the thing that 500s.
  const purchasable: ReadonlySet<string> | null = isDbConfigured(db)
    ? new Set(
        (await db.select({ key: planTable.key }).from(planTable)).map(
          (row) => row.key,
        ),
      )
    : null;

  // Every row the record projects for a tier shown here.
  const expected = plans.rows.filter((row) => shown.some((tier) => tier.key === row.tierKey));
  const missing =
    purchasable === null
      ? []
      : expected.filter((row) => !purchasable.has(row.key));

  // The "what isn't wired up yet" notes below are the OPERATOR's: they name a
  // file, a setting and a script, so only the site's staff ever read them.
  const principal = await currentPrincipal().catch(() => null);
  const staff = principal ? (await loadStaffPermissions({ principal }).catch(() => null)) !== null : false;
  const signedIn = principal !== null;

  return (
    <>
      <section className="mx-auto max-w-6xl px-4 pt-16 pb-4 sm:px-6 sm:pt-20">
        <p className="text-sm font-semibold text-accent">{PRICING.eyebrow}</p>

        <h1 className="mt-4 max-w-[22ch] text-[clamp(2rem,5.5vw,3rem)] leading-[1.05] font-semibold tracking-[-0.035em] text-balance">
          {PRICING.title}
        </h1>

        <p className="mt-5 max-w-[56ch] text-[17px] leading-relaxed text-ink-muted">{PRICING.intro}</p>

        <PricingControls
          intervals={toggleableIntervals(plans)}
          currencies={plans.currencies}
          interval={interval}
          currency={currency}
        />

        {!staff ? null : purchasable === null ? (
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
              <code className="font-mono text-xs">src/plans.ts</code> into it.
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

        {plans.lines.length > 1 ? (
          // PRODUCT LINES (billing 0.5): each sold on its own, so each gets its
          // own row of plans. They stack — one of each, on one bill.
          plans.lines.map((line) => (
            <div key={line.key} className="mt-12">
              <h2 className="text-2xl font-semibold tracking-tight text-ink">{line.name}</h2>
              {line.description ? <p className="mt-2 max-w-[56ch] text-ink-muted">{line.description}</p> : null}
              <div className="mt-6">
                <PlanColumns line={line.key} interval={interval} currency={currency} signedIn={signedIn} />
              </div>
            </div>
          ))
        ) : (
          <div className="mt-12">
            <PlanColumns interval={interval} currency={currency} signedIn={signedIn} />
          </div>
        )}
      </section>

      {plans.lines.map((line) => (
        <div key={line.key} className="mt-16">
          <Section label="Side by side">
            <SectionHeading title={plans.lines.length > 1 ? `Compare ${line.name}` : "Compare the plans"}>
              Every feature, side by side.
            </SectionHeading>
            <ComparisonTable
              features={line.features}
              columns={[
                ...(line.free ? [{ key: "free", name: line.free.name, features: line.free.features }] : []),
                ...shown.filter((tier) => tier.line === line.key),
              ]}
            />
          </Section>
        </div>
      ))}

      <Section label="Questions">
        <SectionHeading title="About plans and billing" />
        <dl className="flex flex-col gap-6">
          {PRICING.faq.map((item) => (
            <div key={item.q}>
              <dt className="text-[15px] font-medium text-ink">{item.q}</dt>
              <dd className="mt-1.5 max-w-[58ch] text-[15px] leading-relaxed text-ink-muted">{item.a}</dd>
            </div>
          ))}
        </dl>
      </Section>
    </>
  );
}
