"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { PlanColumn } from "__SCOPE__/billing";
import { Button, Notice, buttonClass, cx } from "@/components/ui";
import { PlanCard, PlanCardCell, PlanCards } from "@/components/plans/PlanCard";
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
 * THE CARDS ARE THE PRICING PAGE'S (create-app 0.39): `PlanCard`, drawn from
 * `planColumns` — what each plan includes, "Everything in Free, plus:", whole
 * dollar prices, yearly first, "Coming soon" on a plan not sold yet — so the
 * chooser and the pricing page can never describe a plan differently.
 *
 * THE SIMULATE BUTTON DECIDES NOTHING. It draws when — and only when — the
 * server's `checkoutMode()` came back `simulated`, handed down as a prop,
 * exactly as `SimulatePurchase` takes it. `billing.simulateSubscription` calls
 * the same predicate on the same request before it writes, so this is a
 * rendering choice sitting on top of a server guarantee rather than in place of
 * one.
 */

export interface PlanChooserProps {
  readonly tenantId: string;
  /**
   * The line's plan cards for every cadence and currency, keyed
   * `<interval>:<currency>`: `planColumns` from @__SCOPE_NAME__/billing, worked
   * out on the server — the same cards the pricing page draws.
   */
  readonly columns: Readonly<Record<string, readonly PlanColumn[]>>;
  /** Every cadence some plan is sold on, yearly first. */
  readonly intervals: readonly ("month" | "year")[];
  /** No live plan on this line, and the record declares a free tier: the Free card is "Your plan". */
  readonly onFree: boolean;
  /** The plan picked on the pricing page before signing in (?plan=), or null. */
  readonly pickedTierKey: string | null;
  /** Why someone without the permission can't change the plan, in this project's words. */
  readonly ownerOnly: string;
  /** Every currency the catalogue prices in. */
  readonly currencies: readonly string[];
  readonly mode: CheckoutMode;
  /** Does the viewer hold `subscriptions.manage`? */
  readonly canManage: boolean;
  /** The tier they are already on, so it is marked rather than offered again. */
  readonly currentTierKey: string | null;
  /** Where "Talk to us" goes for a plan with no price (a mailto:), or null. */
  readonly contactHref: string | null;
  /** Staff of the site: the only ones told that card payments aren't switched on (the operator's to fix). */
  readonly staff: boolean;
  /**
   * Does this __TENANT_LABEL_LOWER__ already pay through Stripe? Then picking a plan CHANGES
   * that subscription (with a price preview to confirm) instead of starting a
   * second one — the double charge billing 0.3 fixed.
   */
  readonly hasPaidPlan: boolean;
  /**
   * PRODUCT LINES (billing 0.5): this line isn't on the plan yet but another
   * line is, so choosing a tier ADDS it to that subscription (preview, then
   * confirm: prorated, charged now, one bill) — never a second checkout.
   */
  readonly addsToPlan?: boolean;
  /**
   * The cadence and currency everything on the bill shares, when other lines
   * are on it: the toggle is fixed to it (Stripe bills one subscription on
   * one cadence). Null: the person chooses.
   */
  readonly cadence?: { readonly interval: "month" | "year"; readonly currency: string } | null;
}

/** What a plan change costs, as the server worked it out. */
interface ChangePreview {
  /** A change of tier on this line, or a new line added to the plan. */
  readonly kind: "change" | "add";
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
  const fixed = props.cadence ?? null;
  const [interval, setInterval] = useState<"month" | "year">(
    fixed?.interval ?? props.intervals[0] ?? "month",
  );
  // US dollars first when the plans are priced in them (the list is alphabetical).
  const [currency, setCurrency] = useState<string>(
    fixed?.currency ?? (props.currencies.includes("usd") ? "usd" : (props.currencies[0] ?? "usd")),
  );
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
      setPreview({ ...result, kind: "change", tierKey: variables.tierKey, currency: variables.currency });
    },
  });
  // ADDING A LINE (billing 0.5): the same preview-then-confirm, on the one
  // subscription this __TENANT_LABEL_LOWER__ already pays.
  const previewAdd = api.billing.previewAddLine.useMutation({
    onSuccess: (result, variables) => {
      setChangeNote(null);
      setPreview({ ...result, kind: "add", tierKey: variables.tierKey, currency: variables.currency });
    },
  });
  const addLine = api.billing.addLine.useMutation({
    onSuccess: (result) => {
      setPreview(null);
      setChangeNote(
        result.applied
          ? "Done. It's on your plan now, and on the same bill."
          : "The payment didn't go through, so nothing was added. Update your card under Payment methods and try again.",
      );
      router.refresh();
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
    subscribe.isPending ||
    simulate.isPending ||
    leaving ||
    previewChange.isPending ||
    changePlan.isPending ||
    previewAdd.isPending ||
    addLine.isPending;
  const simulated = props.mode.kind === "simulated";
  // No Stripe here and nothing may be given away: nothing can be bought yet.
  const unavailable = props.mode.kind === "unavailable";
  const changing = props.hasPaidPlan && !simulated;
  const adding = props.addsToPlan === true && !props.hasPaidPlan && !simulated;
  const error = subscribe.error ?? simulate.error ?? previewChange.error ?? changePlan.error ?? previewAdd.error ?? addLine.error;

  const columns = props.columns[`${interval}:${currency}`] ?? [];

  /** The button under one card: what this person can do with that plan, right now. */
  function action(column: PlanColumn) {
    const current = column.free ? props.onFree : column.key === props.currentTierKey;
    if (current) return <p className="text-sm text-ink-muted">You&apos;re on this plan.</p>;
    // Free is what an account holds with no plan: there is nothing to buy.
    if (column.free) return <p className="text-sm text-ink-muted">What you have with no plan.</p>;
    if (column.onSale === "coming") {
      return (
        <Button variant="secondary" disabled className="w-full">
          Coming soon
        </Button>
      );
    }
    if (column.price.kind === "enquire" || column.price.kind === "other-interval") {
      // Not sold here on this cadence: a conversation, and the button starts one.
      return props.contactHref ? (
        <a href={props.contactHref} className={buttonClass("secondary", "w-full")}>
          Talk to us
        </a>
      ) : (
        <p className="text-sm text-ink-muted">Talk to us about this plan.</p>
      );
    }
    if (unavailable) {
      return (
        <Button variant="secondary" disabled className="w-full">
          Not available yet
        </Button>
      );
    }
    if (!props.canManage) {
      return (
        <Button variant="secondary" disabled className="w-full">
          Choose {column.name}
        </Button>
      );
    }
    const primary = column.key === props.pickedTierKey || (props.pickedTierKey === null && column.highlight);
    return (
      <Button
        variant={primary ? "primary" : "secondary"}
        disabled={busy}
        className="w-full"
        onClick={() =>
          changing
            ? previewChange.mutate({ tenantId: props.tenantId, tierKey: column.key, interval, currency })
            : adding
              ? previewAdd.mutate({ tenantId: props.tenantId, tierKey: column.key, interval, currency })
              : simulated
                ? simulate.mutate({ tenantId: props.tenantId, tierKey: column.key, interval, currency })
                : subscribe.mutate({ tenantId: props.tenantId, tierKey: column.key, interval, currency })
        }
      >
        {busy ? "Working…" : changing ? `Switch to ${column.name}` : adding ? `Add ${column.name}` : `Choose ${column.name}`}
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        {/* Only rendered when there is a choice. Yearly first: one charge a
            year instead of twelve, and the better deal. */}
        {fixed === null && props.intervals.length > 1 && (
          <div className="flex items-center gap-1 rounded-md border border-line p-1">
            {props.intervals.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={interval === option}
                onClick={() => setInterval(option)}
                className={cx(
                  "min-h-11 rounded px-4 text-sm transition-colors",
                  interval === option ? "bg-accent-soft text-ink" : "text-ink-muted hover:text-ink",
                )}
              >
                {option === "month" ? "Monthly" : "Yearly"}
              </button>
            ))}
          </div>
        )}

        {fixed === null && props.currencies.length > 1 && (
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

      {simulated && props.staff ? (
        // THE OPERATOR'S CHECKLIST, for staff only: a customer is never told how
        // this site is configured. Simulated plans exist only where Stripe isn't
        // set up (a laptop, or ALLOW_SIMULATED_CHECKOUT, never production).
        <p className="max-w-[68ch] text-sm text-ink-muted" data-plans-simulated="">
          Stripe isn&apos;t configured here, so choosing a plan starts it straight away with nothing charged: the plan is
          recorded and everything it grants applied through the same function a real Stripe webhook runs. This goes away
          once the Stripe keys are added.
        </p>
      ) : null}

      {unavailable ? (
        // A customer is told plainly that plans can't be bought yet; only staff
        // read why (the operator's to fix: Stripe's keys, or the opt-in).
        <p className="max-w-[68ch] text-sm text-ink-muted" data-plans-unavailable="">
          {props.staff ? props.mode.reason : "Plans can't be bought on this site just yet. Please check back soon."}
        </p>
      ) : null}

      {error && (
        <Notice
          tone="danger"
          title={changing ? "That plan couldn't be changed" : adding ? "That couldn't be added" : "That plan could not be started"}
          role="alert"
        >
          {error.message}
        </Notice>
      )}

      {changeNote && (
        <Notice tone="info" title="Plan change" role="status">
          {changeNote}
        </Notice>
      )}

      {preview && (
        <Notice tone="info" title={preview.kind === "add" ? `Add ${preview.planName}?` : `Switch to ${preview.planName}?`} role="status">
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
                  (preview.kind === "add" ? addLine : changePlan).mutate({
                    tenantId: props.tenantId,
                    tierKey: preview.tierKey,
                    interval: preview.interval,
                    currency: preview.currency,
                    prorationDate: preview.prorationDate,
                  })
                }
              >
                {preview.kind === "add"
                  ? addLine.isPending
                    ? "Adding…"
                    : `Add ${preview.planName}`
                  : changePlan.isPending
                    ? "Changing…"
                    : `Switch to ${preview.planName}`}
              </Button>
              <Button variant="secondary" disabled={busy} onClick={() => setPreview(null)}>
                Keep my plan
              </Button>
            </span>
          )}
        </Notice>
      )}

      <PlanCards>
        {columns.map((column) => (
          <PlanCardCell key={column.key}>
            <PlanCard
              column={column}
              current={column.free ? props.onFree : column.key === props.currentTierKey}
              picked={column.key === props.pickedTierKey}
              action={action(column)}
            />
          </PlanCardCell>
        ))}
      </PlanCards>

      {!props.canManage && <p className="max-w-[62ch] text-sm text-ink-muted">{props.ownerOnly}</p>}
    </div>
  );
}
