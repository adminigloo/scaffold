"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge, Button, Card, CardBody, CardHeader, Notice, cx } from "@/components/ui";
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
  /** Rendered from the record's own vocabulary, one line per declared feature. */
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
}

export function PlanChooser(props: PlanChooserProps) {
  const [interval, setInterval] = useState<"month" | "year">(
    props.intervals[0] ?? "month",
  );
  const [currency, setCurrency] = useState<string>(props.currencies[0] ?? "usd");
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

  const busy = subscribe.isPending || simulate.isPending || leaving;
  const simulated = props.mode.kind === "simulated";
  const error = subscribe.error ?? simulate.error;

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
                  "rounded px-3 py-1 text-sm transition-colors",
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
              className="rounded-md border border-line bg-transparent px-2 py-1 text-sm text-ink"
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
        <Notice tone="warn" title="No money will move">
          Stripe is not configured on this deployment, so there is no checkout to
          send you to. Subscribing here records the subscription and applies
          everything the plan grants, through the same function a real Stripe
          webhook runs — so the banner, the cancel button, the renewal date and
          the entitlements can all be built and tested now.{" "}
          <strong className="font-medium text-ink">
            It disappears by itself the moment Stripe keys are added.
          </strong>
        </Notice>
      )}

      {error && (
        <Notice tone="danger" title="That plan could not be started" role="alert">
          {error.message}
        </Notice>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {props.tiers.map((tier) => {
          const price = tier.prices[`${interval}:${currency}`];
          const current = tier.key === props.currentTierKey;

          return (
            <Card key={tier.key}>
              <CardHeader
                title={tier.name}
                hint={tier.description ?? undefined}
                actions={
                  current ? (
                    <Badge tone="accent">Current</Badge>
                  ) : tier.highlight ? (
                    <Badge tone="accent">Most popular</Badge>
                  ) : undefined
                }
              />
              <CardBody className="flex flex-col gap-3">
                <p className="text-lg font-semibold tabular-nums">
                  {price === undefined ? (
                    <span className="text-base font-normal text-ink-muted">
                      Talk to us
                    </span>
                  ) : (
                    <>
                      {price}
                      <span className="text-sm font-normal text-ink-muted">
                        {" "}
                        per {interval}
                      </span>
                    </>
                  )}
                </p>

                <ul className="flex flex-col gap-1 text-sm text-ink-muted">
                  {tier.features.map((feature) => (
                    <li key={feature}>{feature}</li>
                  ))}
                </ul>

                {price === undefined ? (
                  // A tier with no price on this combination is not for sale
                  // here, and a disabled button saying "Subscribe" would read
                  // as a fault. The record calls this a real tier; the page
                  // says what to do about it.
                  <p className="text-sm text-ink-muted">
                    This plan is not sold {interval}ly in {currency.toUpperCase()}.
                  </p>
                ) : current ? (
                  <p className="text-sm text-ink-muted">
                    This is the plan this __TENANT_LABEL_LOWER__ is on.
                  </p>
                ) : !props.canManage ? (
                  <Button variant="secondary" disabled className="self-start">
                    Subscribe
                  </Button>
                ) : (
                  <Button
                    variant={tier.highlight ? "primary" : "secondary"}
                    disabled={busy}
                    className="self-start"
                    onClick={() =>
                      simulated
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
                    {busy
                      ? "Working…"
                      : simulated
                        ? `Simulate ${tier.name}`
                        : `Subscribe to ${tier.name}`}
                  </Button>
                )}
              </CardBody>
            </Card>
          );
        })}
      </div>

      {!props.canManage && (
        <p className="max-w-[62ch] text-sm text-ink-muted">
          Committing this __TENANT_LABEL_LOWER__ to a recurring charge needs{" "}
          <code className="font-mono">subscriptions.manage</code>, which normally
          only its owner holds — it is the same permission as cancelling one.
        </p>
      )}
    </div>
  );
}
