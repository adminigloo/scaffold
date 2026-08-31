"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { formatMinor } from "__SCOPE__/catalog";
import { api } from "@/trpc/client";
import { Button, Card, CardBody, CardHeader, Notice } from "@/components/ui";
import { StripeProvider } from "./StripeProvider";

/**
 * Where Stripe sends the customer back to. Relative on purpose — resolved
 * against `window.location.origin` at submit time rather than against
 * NEXT_PUBLIC_APP_URL, because a preview deployment and a laptop have different
 * origins and a return URL pointing at the wrong one strands the customer on
 * another environment's success page after their card has already been charged.
 */
const RETURN_PATH = "/checkout/success";

export interface CheckoutFormProps {
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
 * The whole in-app payment flow, minus the summary the server already rendered.
 *
 * Order of operations, and why it is this way round: the PaymentIntent is
 * created FIRST, on mount, because `<Elements>` cannot be configured without a
 * client secret and Stripe refuses to let one be swapped in after mount. The
 * alternative — Stripe's deferred-intent mode, where the amount is passed to
 * Elements and the intent is created on submit — puts the amount in the browser
 * as a rendering input, and an amount that lives in the browser is an amount
 * somebody edits. Creating it up front costs one API call on a page a customer
 * has already decided to open.
 */
export function CheckoutForm(props: CheckoutFormProps) {
  const totalMinor = props.unitPriceMinor * BigInt(props.quantity);
  const createIntent = api.checkout.createIntent.useMutation();

  // Fired once. React 19 Strict Mode runs effects twice in development, and the
  // server-side idempotency key means the second call returns the same intent
  // rather than a second charge — but it is still a wasted Stripe round trip
  // and a second entry in the API log that looks like a bug during debugging.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    createIntent.mutate({ variantId: props.variantId, quantity: props.quantity });
    // Intentionally mount-only. `createIntent` is a new object identity on every
    // render, so listing it would re-run this effect forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const summary = (
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
              division renders ¥1,000 as ¥10 — a hundredfold error that looks
              like a plausible price. */}
          {formatMinor(totalMinor, props.currency)}
        </span>
      }
    />
  );

  return (
    <Card>
      {summary}
      <CardBody>
        {createIntent.isPending && (
          <p className="text-sm text-ink-muted">Preparing a secure payment…</p>
        )}

        {createIntent.error && (
          <Notice tone="danger" role="alert" title="This cannot be paid for right now">
            {/* The server's own message. It distinguishes "sold out" from "not
                synced to Stripe" from "payments are switched off", and each one
                needs a different person to fix it. */}
            {createIntent.error.message}
          </Notice>
        )}

        {createIntent.data?.status === "no_payment_due" && (
          <Notice tone="info" title="Nothing to pay today">
            This subscription starts on a trial or its first invoice is fully
            discounted, so Stripe has no payment to collect. It is recorded
            against your account and will bill at the end of the period.
          </Notice>
        )}

        {createIntent.data?.status === "requires_payment" && (
          <StripeProvider clientSecret={createIntent.data.clientSecret}>
            <PaymentPanel
              totalLabel={formatMinor(totalMinor, props.currency)}
              recurring={props.interval !== null}
            />
          </StripeProvider>
        )}
      </CardBody>
    </Card>
  );
}

/**
 * The part that must live INSIDE `<Elements>`.
 *
 * `useStripe` and `useElements` read that context and return null until Stripe.js
 * has finished loading, which is why the submit button is disabled on `!stripe`
 * rather than on a loading flag of our own — the flag would be a second source
 * of truth for the same fact and the two would disagree on a slow connection.
 */
function PaymentPanel({
  totalLabel,
  recurring,
}: {
  readonly totalLabel: string;
  readonly recurring: boolean;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!stripe || !elements) return;

    setSubmitting(true);
    setFailure(null);

    const { error } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        // Absolute, and built here rather than baked in at build time — see
        // RETURN_PATH. Stripe rejects a relative return_url outright.
        return_url: new URL(RETURN_PATH, window.location.origin).toString(),
      },
    });

    // ONLY REACHED WHEN THE PAYMENT FAILED IMMEDIATELY. Anything that needs the
    // customer to do something — 3-D Secure, a bank app, a redirect-based
    // method — navigates away instead, and comes back to RETURN_PATH with the
    // outcome in the query string. There is no success branch here on purpose:
    // this code cannot run after a successful confirmation, so a `setState`
    // celebrating one would be dead code that a later edit turns into a lie.
    if (error) {
      setSubmitting(false);
      // THE REAL STRIPE MESSAGE, not our own copy. "Your payment failed" hides
      // the one thing the customer can act on — "insufficient funds", "your
      // card has expired", "the postcode does not match" — and every one of
      // those becomes a support ticket instead of a second attempt.
      setFailure(
        error.message ??
          `The payment could not be completed (${error.code ?? error.type}).`,
      );
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <PaymentElement
        options={{ layout: "tabs" }}
        onLoadError={(event) =>
          setFailure(
            event.error.message ??
              "The payment form could not be loaded. Reload the page to try again.",
          )
        }
      />

      {failure && (
        <Notice tone="danger" role="alert" title="Payment declined">
          {failure}
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
          type="submit"
          variant="primary"
          // `!stripe` covers Stripe.js still loading. Without the `submitting`
          // half, a double-click sends a second `confirmPayment` for the same
          // intent while the first is in flight, and the customer sees a
          // spurious "payment already succeeded" error on the slower one.
          disabled={!stripe || submitting}
        >
          {submitting
            ? "Confirming…"
            : recurring
              ? `Subscribe — ${totalLabel}`
              : `Pay ${totalLabel}`}
        </Button>
      </div>

      <p className="text-xs text-ink-muted">
        Card details go straight to Stripe from your browser. They never reach
        this application&rsquo;s servers.
      </p>
    </form>
  );
}
