"use client";

import { ErrorScreen } from "@/components/ErrorScreen";

/**
 * The one screen where the wrong apology costs money.
 *
 * A customer only reaches `/checkout/success` after Stripe has taken the
 * payment. The boundary one level up says a failure took no money, which is
 * true there and FALSE here — and a person who has paid, is told nothing
 * happened, and pays again has been charged twice by an error message.
 *
 * That is the entire reason this file exists as a separate boundary rather than
 * inheriting `checkout/error.tsx`: not different styling, a different fact. The
 * page reads a live PaymentIntent and a just-written order, either of which can
 * fail while the payment behind them is perfectly fine, so the first sentence
 * has to be that the payment stands.
 *
 * Retrying is genuinely useful here. The order row is written by the webhook
 * and Stripe delivers asynchronously, so a re-render moments later often finds
 * what the first one could not.
 */
export default function CheckoutSuccessError({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}) {
  return (
    <ErrorScreen
      error={error}
      reset={reset}
      boundary="checkout-success"
      title="Your payment went through"
      back={{ href: "/products", label: "Back to the shop" }}
    >
      <p>
        <strong className="font-medium text-ink">Do not pay again.</strong> The
        payment succeeded; this page could not load the receipt for it.
      </p>
      <p className="mt-2">
        Trying again usually works — the order is written moments after the
        payment. Your emailed receipt is unaffected either way.
      </p>
    </ErrorScreen>
  );
}
