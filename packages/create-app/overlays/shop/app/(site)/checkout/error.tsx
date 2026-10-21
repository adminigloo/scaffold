"use client";

import { ErrorScreen } from "@/components/ErrorScreen";

/**
 * The boundary for the payment screen.
 *
 * The storefront gets its own because it fails at a point nothing else in the
 * app reaches: a customer with their card in their hand. The public boundary's
 * "try again" is the right advice everywhere else and is dangerous here — a
 * person who cannot tell whether they have been charged will either pay twice
 * or abandon the order, and the software said nothing either way.
 *
 * So the copy answers the money question first and the software question
 * second. It does NOT claim the payment failed: this boundary sits above the
 * whole checkout segment, and the only honest statement is that this failure
 * did not itself take money.
 *
 * `/products` is safe to name here because this file only exists in a project
 * that installed the stripe overlay, which is the same overlay that owns the
 * storefront. In a project generated with `--model none` neither is emitted.
 */
export default function CheckoutError({
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
      boundary="checkout"
      title="The checkout could not be shown"
      back={{ href: "/products", label: "Back to the shop" }}
    >
      <p>
        <strong className="font-medium text-ink">
          This failure did not take a payment.
        </strong>{" "}
        A card is only charged when a payment is confirmed, and nothing was
        confirmed here.
      </p>
      <p className="mt-2">
        If you had already confirmed one before this screen appeared, it stands —
        check your email for a receipt before paying again.
      </p>
    </ErrorScreen>
  );
}
