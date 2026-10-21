"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatMinor } from "__SCOPE__/catalog";
import { Button, Card, CardBody, CardHeader, Notice } from "@/components/ui";
// TYPE ONLY, so nothing from the server module follows this component into the
// browser bundle — the import erases at compile time. The VALUE is computed on
// the server and handed down as a prop, which is the point: this component must
// not be able to form its own opinion about whether simulating is allowed.
import type { CheckoutMode } from "@/server/checkout-mode";
import { api } from "@/trpc/client";

export interface SimulatePurchaseProps {
  /**
   * Which checkout the server decided is live, from `checkoutMode()`.
   *
   * A PROP RATHER THAN A DERIVED CONDITION, and that is the fix. This component
   * used to render whenever the page chose to render it and decide nothing
   * itself, which sounds safe and was the fourth of four places the rule lived:
   * the page said `!stripe`, the storefront notice said `stripe === null`, the
   * procedure said `!stripe && appEnv !== "production"`, and this said nothing
   * at all — so on a deployment where the server refused, a customer was still
   * shown a Simulate button, pressed it, and got an error. Taking the decision
   * as an input means there is one decision.
   */
  readonly mode: CheckoutMode;
  readonly variantId: string;
  readonly quantity: number;
  readonly productName: string;
  readonly variantName: string;
  readonly unitPriceMinor: bigint;
  readonly currency: string;
  /** NULL for a one-time purchase; `"month"` / `"year"` for a subscription. */
  readonly interval: "month" | "year" | null;
  /**
   * Whether this order will have somebody's name on it.
   *
   * `guest` only ever happens on a deployment with no Clerk keys, where nobody
   * can sign in at all — the server applies the same rule. It changes the copy
   * and nothing else, because the difference is real and a buyer who is told
   * their order is saved and then cannot find it later has been misled by one
   * missing sentence.
   */
  readonly buyer: "account" | "guest";
}

/**
 * The checkout, on a deployment that cannot take money yet.
 *
 * SAME SUMMARY, SAME BUTTON POSITION, SAME DESTINATION as `CheckoutForm`. The
 * only thing missing is the Payment Element, because there is nothing to
 * collect. That symmetry is deliberate: this is the surface a founder demos and
 * a developer builds the rest of the funnel against, so it has to behave like
 * the real thing rather than like a debug affordance bolted to the side.
 *
 * IT IS NOT HIDDEN BEHIND A DEV FLAG, AND IT DECIDES NOTHING. It draws itself
 * when — and only when — the server's `checkoutMode()` came back `simulated`,
 * handed down as `mode`. A `NODE_ENV` gate here would be wrong in both
 * directions: it would leave this alive on a live shop that has Stripe
 * configured, and kill it on the laptop where it is the entire point. The
 * refusal below is not a security boundary — a browser cannot enforce one, and
 * `checkout.simulate` calls the same predicate on the same request before it
 * writes anything. It is here so that a future caller who passes the wrong mode
 * gets a visible, explained refusal instead of a button that mints an order.
 */
export function SimulatePurchase(props: SimulatePurchaseProps) {
  const router = useRouter();
  const totalMinor = props.unitPriceMinor * BigInt(props.quantity);
  // Held separately from `isPending`. The mutation flips back to idle the
  // instant it resolves, but the navigation that follows takes another beat —
  // and a button that re-enables itself during that beat invites the second
  // click, which is a second order.
  const [leaving, setLeaving] = useState(false);

  const simulate = api.checkout.simulate.useMutation({
    onSuccess: (result) => {
      setLeaving(true);
      // BY REFERENCE, exactly as Stripe's `return_url` carries a PaymentIntent
      // id. The success page reads an order the same way whichever path made
      // it, and this URL shape is what makes that possible.
      router.push(`/checkout/success?ref=${encodeURIComponent(result.reference)}`);
    },
  });

  const busy = simulate.isPending || leaving;

  // The one predicate, again, on the value the server computed. Nothing here
  // re-derives it from a Stripe key or an environment the browser cannot see.
  if (props.mode.kind !== "simulated") {
    return (
      <Notice tone="warn" title="There is no checkout to show you">
        {props.mode.reason}
      </Notice>
    );
  }

  return (
    <Card>
      <CardHeader
        title={props.productName}
        hint={
          props.interval === null
            ? `${props.variantName} × ${props.quantity}`
            : `${props.variantName} × ${props.quantity} · billed every ${props.interval}`
        }
        actions={
          <span className="text-sm font-semibold tabular-nums">
            {/* formatMinor, never `total / 100`. JPY has no minor unit, so the
                division renders ¥1,000 as ¥10 — a hundredfold error that still
                looks like a plausible price. */}
            {formatMinor(totalMinor, props.currency)}
          </span>
        }
      />
      <CardBody className="flex flex-col gap-4">
        <Notice tone="warn" title="No money will move">
          Stripe is not configured on this deployment, so there is no card form
          to show and nothing to charge. This button records the order and grants
          everything the product grants, through the same code a real payment
          runs — so the rest of the flow can be built and tested now.{" "}
          <strong className="font-medium text-ink">
            It disappears by itself the moment Stripe keys are added
          </strong>{" "}
          — the server allows it only where it can prove it is meant to, which
          is a local environment or a staging deployment that has said so out
          loud, so it can never become a way to get something for free.
        </Notice>

        {props.buyer === "guest" && (
          <Notice tone="info" title="This will be recorded as a guest order">
            Nobody can sign in here yet, because this deployment has no Clerk
            keys — so the order is booked without an account attached, which is
            what a guest checkout does. Keep the page you land on: the order is
            findable by its reference and by nothing else until there are
            accounts to attach it to.
          </Notice>
        )}

        {simulate.error && (
          <Notice
            tone="danger"
            role="alert"
            title="That purchase could not be simulated"
          >
            {/* The server's own message. It distinguishes "sold out" from
                "payments are already live" from "no longer for sale", and each
                one needs a different person to do a different thing. */}
            {simulate.error.message}
          </Notice>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link
            href="/products"
            className="text-sm text-ink-muted underline underline-offset-2"
          >
            Back to products
          </Link>
          <Button
            type="button"
            variant="primary"
            disabled={busy}
            onClick={() =>
              simulate.mutate({
                variantId: props.variantId,
                quantity: props.quantity,
              })
            }
          >
            {busy
              ? "Recording…"
              : `Simulate purchase — ${formatMinor(totalMinor, props.currency)}`}
          </Button>
        </div>

        <p className="text-xs text-ink-muted">
          The order is written as <code className="font-mono">paid</code> and is
          permanently marked as simulated: its reference begins{" "}
          <code className="font-mono">sim_</code>, it carries no Stripe payment
          id, and it writes a <code className="font-mono">
            commerce.order.simulated
          </code>{" "}
          entry to the audit log.
        </p>
      </CardBody>
    </Card>
  );
}
