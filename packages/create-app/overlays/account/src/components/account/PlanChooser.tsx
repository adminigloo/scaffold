"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge, Button, Card, CardBody, Notice, buttonClass, cx } from "@/components/ui";
import type { CheckoutMode } from "@/server/checkout-mode";
import { api } from "@/trpc/client";

/**
 * Choosing a plan, on the page where the subscription lives.
 *
 * WHY IT IS HERE AND NOT ONLY ON A PRICING PAGE. `/account/billing` is where
 * somebody arrives having just cancelled, having just lapsed, or having never
 * subscribed at all, and in every one of those states the next thing they want
 * is a plan. Sending them to marketing copy to come back again is two
 * navigations for one decision — and it makes this screen depend on a page a
 * project is free to delete and restyle, which is exactly what copied source
 * is for. The record is the same object either way, so the two never disagree
 * about what Pro costs.
 *
 * EVERY PRICE IS FORMATTED ON THE SERVER, and that is not a style choice.
 * Amounts are `bigint` minor units and `formatMinor` is what renders them —
 * JPY has no minor unit, so a `total / 100` in the browser prints ¥1,000 as
 * ¥10, a hundredfold error that still looks like a plausible price. Handing
 * this component pre-rendered strings also keeps `bigint` off the server/client
 * boundary entirely.
 *
 * THE SIMULATE BUTTON DECIDES NOTHING. It draws when — and only when — the
 * server's `checkoutMode()` came back `simulated`, handed down as a prop,
 * exactly as `SimulatePurchase` takes it. `billing.simulateSubscription` calls
 * the same predicate on the same request before it writes, so this is a
 * rendering choice sitting on top of a server guarantee rather than in place of
 * one.
 */

export interface ChoosableTier {
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly highlight: boolean;
  /**
   * Formatted prices keyed `<interval>:<currency>`. Absent means this tier is
   * not sold on that combination, which is a real answer — "talk to us" is a
   * plan — and is why the button says so rather than showing a zero.
   */
  readonly prices: Readonly<Record<string, string>>;
  /**
   * The 3–4 numbers the plan leads with ("10 team members", "25 GB of photos
   * and files"), from HEADLINE_FEATURES in src/plans.ts.
   */
  readonly headline: readonly string[];
  /** Every allowance, one line each, for "What's included". */
  readonly features: readonly string[];
}

export interface PlanChooserProps {
  readonly tenantId: string;
  readonly tiers: readonly ChoosableTier[];
  /** Every interval some tier is sold on, in the record's order. */
  readonly intervals: readonly ("month" | "year")[];
  /** Every currency the catalogue prices in. */
  readonly currencies: readonly string[];
  readonly mode: CheckoutMode;
  /** Does the viewer hold `subscriptions.manage`? */
  readonly canManage: boolean;
  /** The tier they are already on, so it is marked rather than offered again. */
  readonly currentTierKey: string | null;
  /** Where "Talk to us" goes for a plan with no price (a mailto:), or null. */
  readonly contactHref: string | null;
  /** Staff of the site: the "card payments aren't on" line also says why. */
  readonly staff: boolean;
  /**
   * Does this __TENANT_LABEL_LOWER__ already pay through Stripe? Then picking a plan CHANGES
   * that subscription (with a price preview to confirm) instead of starting a
   * second one — the double charge billing 0.3 fixed.
   */
  readonly hasPaidPlan: boolean;
}

/** What a plan change costs, as the server worked it out. */
interface ChangePreview {
  readonly tierKey: string;
  /** The currency the preview was priced in: the change is confirmed in the same one. */
  readonly currency: string;
  readonly planName: string;
  readonly samePrice: boolean;
  readonly prorationDate: number;
  readonly today: "charge" | "credit" | "none";
  readonly dueNow: string;
  readonly then: string;
  readonly interval: "month" | "year";
}

export function PlanChooser(props: PlanChooserProps) {
  const [interval, setInterval] = useState<"month" | "year">(
    props.intervals[0] ?? "month",
  );
  // US dollars first when the plans are priced in them (the list is alphabetical).
  const [currency, setCurrency] = useState<string>(props.currencies.includes("usd") ? "usd" : (props.currencies[0] ?? "usd"));
  // Held separately from `isPending`: the mutation resolves the instant Stripe
  // answers and the navigation to the hosted checkout takes another beat, and a
  // button that re-enables during that beat invites a second session.
  const [leaving, setLeaving] = useState(false);
  const router = useRouter();

  const subscribe = api.billing.subscribeToPlan.useMutation({
    onSuccess: (result) => {
      setLeaving(true);
      // A full document load, not `router.push`. The URL is on Stripe's origin,
      // so Next's client router would try to fetch an RSC payload from a host
      // that does not serve one.
      window.location.assign(result.url);
    },
  });

  const simulate = api.billing.simulateSubscription.useMutation({
    onSuccess: () => {
      // Everything on this page — the banner, the card, the meters, the
      // "current" badge below — is rendered on the SERVER from the rows this
      // mutation just wrote, so the page is re-rendered rather than patched.
      router.refresh();
    },
  });

  // CHANGING PLAN (billing 0.3): preview, confirm, change — on the one
  // subscription this __TENANT_LABEL_LOWER__ already has.
  const [preview, setPreview] = useState<ChangePreview | null>(null);
  const [changeNote, setChangeNote] = useState<string | null>(null);
  const previewChange = api.billing.previewPlanChange.useMutation({
    onSuccess: (result, variables) => {
      setChangeNote(null);
      setPreview({ ...result, tierKey: variables.tierKey, currency: variables.currency });
    },
  });
  const changePlan = api.billing.changePlan.useMutation({
    onSuccess: (result) => {
      setPreview(null);
      setChangeNote(
        result.applied
          ? "Done. The new plan shows here within a few seconds."
          : "The payment for the change didn't go through, so you're still on your current plan. Update your card under Payment methods and try again.",
      );
      router.refresh();
    },
  });

  const busy =
    subscribe.isPending || simulate.isPending || leaving || previewChange.isPending || changePlan.isPending;
  const simulated = props.mode.kind === "simulated";
  const changing = props.hasPaidPlan && !simulated;
  const error = subscribe.error ?? simulate.error ?? previewChange.error ?? changePlan.error;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        {/* Only rendered when there is a choice. A toggle with one option is a
            control that teaches the reader nothing and takes a click to find
            that out. */}
        {props.intervals.length > 1 && (
          <div className="flex items-center gap-1 rounded-md border border-line p-1">
            {props.intervals.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={interval === option}
                onClick={() => setInterval(option)}
                className={cx(
                  "min-h-11 rounded px-4 text-sm transition-colors",
                  interval === option
                    ? "bg-accent-soft text-ink"
                    : "text-ink-muted hover:text-ink",
                )}
              >
                {option === "month" ? "Monthly" : "Yearly"}
              </button>
            ))}
          </div>
        )}

        {props.currencies.length > 1 && (
          <label className="flex items-center gap-2 text-sm text-ink-muted">
            Currency
            <select
              value={currency}
              onChange={(event) => setCurrency(event.target.value)}
              className="min-h-11 rounded-control border border-line bg-surface px-3 text-sm text-ink"
            >
              {props.currencies.map((option) => (
                <option key={option} value={option}>
                  {option.toUpperCase()}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {simulated && (
        // The operator's job (this site's Stripe keys), told to an owner in one
        // plain sentence; staff also read what that means underneath.
        <p className="max-w-[68ch] text-sm text-ink-muted" data-plans-simulated="">
          Card payments for plans aren&apos;t switched on for this site yet, so choosing a plan starts it straight away, with
          nothing charged.
          {props.staff ? (
            <span className="mt-1 block text-xs">
              Stripe isn&apos;t configured here: a plan is recorded and everything it grants applied through the same function a
              real Stripe webhook runs. This disappears once the Stripe keys are added.
            </span>
          ) : null}
        </p>
      )}

      {error && (
        <Notice tone="danger" title={changing ? "That plan couldn't be changed" : "That plan could not be started"} role="alert">
          {error.message}
        </Notice>
      )}

      {changeNote && (
        <Notice tone="info" title="Plan change" role="status">
          {changeNote}
        </Notice>
      )}

      {preview && (
        <Notice tone="info" title={`Switch to ${preview.planName}?`} role="status">
          <span className="block">
            {preview.samePrice
              ? "You're already on this plan."
              : preview.today === "charge"
                ? `You'll pay ${preview.dueNow} today, then ${preview.then} a ${preview.interval}.`
                : preview.today === "credit"
                  ? `${preview.dueNow} comes off your next bills, then it's ${preview.then} a ${preview.interval}.`
                  : `Nothing to pay today, then ${preview.then} a ${preview.interval}.`}
          </span>
          {!preview.samePrice && (
            <span className="mt-2 flex flex-wrap gap-2">
              <Button
                variant="primary"
                disabled={busy}
                onClick={() =>
                  changePlan.mutate({
                    tenantId: props.tenantId,
                    tierKey: preview.tierKey,
                    interval: preview.interval,
                    currency: preview.currency,
                    prorationDate: preview.prorationDate,
                  })
                }
              >
                {changePlan.isPending ? "Changing…" : `Switch to ${preview.planName}`}
              </Button>
              <Button variant="secondary" disabled={busy} onClick={() => setPreview(null)}>
                Keep my plan
              </Button>
            </span>
          )}
        </Notice>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {props.tiers.map((tier) => {
          const price = tier.prices[`${interval}:${currency}`];
          const current = tier.key === props.currentTierKey;

          return (
            <Card key={tier.key} className={cx("flex flex-col", tier.highlight && !current ? "ring-1 ring-accent" : undefined)}>
              <CardBody className="flex flex-1 flex-col gap-4 p-5">
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-lg font-semibold tracking-tight text-ink">{tier.name}</h3>
                  {current ? (
                    <Badge tone="accent">Your plan</Badge>
                  ) : tier.highlight ? (
                    <Badge tone="accent">Most popular</Badge>
                  ) : null}
                </div>
                {/* The plan's one-line promise. */}
                {tier.description ? <p className="-mt-2 text-sm leading-relaxed text-ink-muted">{tier.description}</p> : null}

                <p className="text-ink tabular-nums">
                  {price === undefined ? (
                    <span className="text-2xl font-semibold tracking-tight">Custom pricing</span>
                  ) : (
                    <>
                      <span className="text-3xl font-semibold tracking-tight">{price}</span>
                      <span className="text-sm text-ink-muted"> a {interval}</span>
                    </>
                  )}
                </p>

                <div className="flex flex-col gap-2 text-sm">
                  <p className="flex items-center gap-2 font-medium text-ink">
                    <CheckMark />
                    Everything included
                  </p>
                  <ul className="flex flex-col gap-1.5 text-ink-muted">
                    {tier.headline.map((line) => (
                      <li key={line} className="flex items-start gap-2">
                        <CheckMark />
                        <span>{line}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                {tier.features.length > tier.headline.length ? (
                  <details className="group text-sm">
                    <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1 font-medium text-accent [&::-webkit-details-marker]:hidden">
                      What&apos;s included
                      <span aria-hidden="true" className="text-ink-muted group-open:rotate-180">
                        &#x25BE;
                      </span>
                    </summary>
                    <ul className="mt-1 flex flex-col gap-1.5 text-ink-muted">
                      {tier.features.map((feature) => (
                        <li key={feature}>{feature}</li>
                      ))}
                    </ul>
                  </details>
                ) : null}

                <div className="mt-auto pt-2">
                  {price === undefined ? (
                    // A plan with no price on this cadence isn't sold here: it's
                    // a conversation, and the button starts one.
                    props.contactHref ? (
                      <a href={props.contactHref} className={buttonClass("secondary", "w-full")}>
                        Talk to us
                      </a>
                    ) : (
                      <p className="text-sm text-ink-muted">Talk to us about this plan.</p>
                    )
                  ) : current ? (
                    <p className="text-sm text-ink-muted">You&apos;re on this plan.</p>
                  ) : !props.canManage ? (
                    <Button variant="secondary" disabled className="w-full">
                      Choose {tier.name}
                    </Button>
                  ) : (
                    <Button
                      variant={tier.highlight ? "primary" : "secondary"}
                      disabled={busy}
                      className="w-full"
                      onClick={() =>
                        changing
                          ? previewChange.mutate({ tenantId: props.tenantId, tierKey: tier.key, interval, currency })
                          : simulated
                          ? simulate.mutate({
                              tenantId: props.tenantId,
                              tierKey: tier.key,
                              interval,
                              currency,
                            })
                          : subscribe.mutate({
                              tenantId: props.tenantId,
                              tierKey: tier.key,
                              interval,
                              currency,
                            })
                      }
                    >
                      {busy ? "Working…" : changing ? `Switch to ${tier.name}` : `Choose ${tier.name}`}
                    </Button>
                  )}
                </div>
              </CardBody>
            </Card>
          );
        })}
      </div>

      {!props.canManage && (
        <p className="max-w-[62ch] text-sm text-ink-muted">
          Only the owner of this __TENANT_LABEL_LOWER__ can change its plan.
        </p>
      )}
    </div>
  );
}

/** A small tick in the accent, for "Everything included" and the plan's numbers. */
function CheckMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="mt-0.5 size-4 shrink-0 text-accent" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4.5 10.5l3.5 3.5 7.5-8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
