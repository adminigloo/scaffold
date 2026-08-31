"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatMinor } from "__SCOPE__/catalog";
import { Button, Card, CardBody, CardHeader, Notice } from "@/components/ui";
import { api } from "@/trpc/client";

export interface SimulatePurchaseProps {
  readonly variantId: string;
  readonly quantity: number;
  readonly productName: string;
  readonly variantName: string;
  readonly unitPriceMinor: bigint;
  readonly currency: string;
  /** NULL for a one-time purchase; `"month"` / `"year"` for a subscription. */
  readonly interval: "month" | "year" | null;
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
 * IT IS NOT HIDDEN BEHIND A DEV FLAG. It renders when — and only when — this
 * deployment has no Stripe secret key, which is the honest condition and the one
 * that flips by itself the moment the keys are pasted in. A `NODE_ENV` gate
 * would be wrong in both directions: it would leave this alive on a live shop
 * that has Stripe configured, and kill it on the laptop where it is the entire
 * point. The server enforces the same condition in `checkout.simulate` — this
 * component only decides what is honest to draw.
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
          — the server refuses it once payments are live, so it can never become
          a way to get something for free.
        </Notice>

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
