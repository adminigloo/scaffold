import { timingSafeEqual } from "node:crypto";
import Link from "next/link";
import type { ReactNode } from "react";
import type Stripe from "stripe";
import { formatMinor } from "__SCOPE__/catalog";
import { Card, CardBody, Notice, PageHeader, buttonClass } from "@/components/ui";
import { stripe } from "@/server/stripe";

/** Reads a live PaymentIntent out of Stripe. Never cacheable. */
export const dynamic = "force-dynamic";

interface SuccessParams {
  /** Appended by Stripe to `return_url`. */
  readonly payment_intent?: string;
  readonly payment_intent_client_secret?: string;
  /** Stripe's own summary. Read for nothing — see below. */
  readonly redirect_status?: string;
}

/**
 * Where Stripe returns the customer after `confirmPayment`.
 *
 * IT DOES NOT ASSERT THAT THE ORDER EXISTS. The money question is settled by
 * the PaymentIntent, which this page reads from Stripe directly. The ORDER is
 * written by the webhook, and Stripe's delivery is asynchronous — usually
 * within a second, sometimes not. A page that says "your order is confirmed"
 * before the row exists is a page that sends the customer to an order history
 * that does not list it, and the first thing they do is pay again.
 *
 * So it says what is actually true: the payment succeeded, and the order
 * follows.
 */
export default async function CheckoutSuccessPage({
  searchParams,
}: {
  readonly searchParams: Promise<SuccessParams>;
}) {
  const params = await searchParams;

  if (!stripe) {
    return (
      <Shell>
        <Notice tone="warn" title="Payments are not configured here">
          This page reads a payment from Stripe and{" "}
          <code>STRIPE_SECRET_KEY</code> is not set on this deployment, so there
          is nothing to read. Nobody has been charged.
        </Notice>
      </Shell>
    );
  }

  const intentId = params.payment_intent;
  const clientSecret = params.payment_intent_client_secret;

  if (!intentId || !clientSecret) {
    return (
      <Shell>
        <Notice tone="info" title="There is no payment to show">
          This page is where Stripe returns you after paying, and it was opened
          without a payment attached. If you were mid-checkout, start again from
          the product — nothing has been charged.
        </Notice>
        <BackToProducts />
      </Shell>
    );
  }

  let intent: Stripe.PaymentIntent | null = null;
  try {
    intent = await stripe.stripe.paymentIntents.retrieve(intentId);
  } catch {
    // A bad id, a deleted object, or a key from the other mode. All of them are
    // "we cannot tell you about this payment", and none of them should say
    // WHICH — the difference between "no such intent" and "not yours" is a
    // probe result.
    intent = null;
  }

  // THE CLIENT SECRET IS THE PROOF OF OWNERSHIP. `payment_intent` on its own is
  // a bare id in a URL; without this check, anyone who guesses or scrapes one
  // reads back its amount, its description and its metadata — which carries the
  // tenant and the buyer's user id. The secret is only ever handed to the
  // browser that created the intent, so matching it is what makes this page
  // safe to render without any session at all.
  if (intent === null || !secretMatches(intent.client_secret, clientSecret)) {
    return (
      <Shell>
        <Notice tone="danger" title="That payment could not be found">
          The link is incomplete or has expired. If you were charged, the receipt
          from Stripe is authoritative — contact support with it rather than
          paying again.
        </Notice>
        <BackToProducts />
      </Shell>
    );
  }

  const copy = describe(intent.status);
  const orderRef = intent.metadata["orderRef"];

  return (
    <Shell>
      <Card>
        <CardBody className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-sm font-medium">{copy.title}</p>
            <p className="text-sm font-semibold tabular-nums">
              {/* Stripe reports `amount` in minor units, same as our columns —
                  so it goes through formatMinor rather than a division that
                  would render every JPY total at a hundredth of its value. */}
              {formatMinor(BigInt(intent.amount), intent.currency)}
            </p>
          </div>

          <p className="text-sm text-ink-muted">{copy.body}</p>

          {copy.tone === "settled" && (
            <p className="text-sm text-ink-muted">
              Your order is being recorded now. Stripe notifies this application
              by webhook rather than through your browser, so it can take a
              moment to appear — and it will appear whether or not you keep this
              page open.
            </p>
          )}

          {orderRef && (
            <p className="text-xs text-ink-muted">
              Reference{" "}
              <code className="font-mono">{orderRef}</code> — quote this to
              support and they can find the payment and the order from it.
            </p>
          )}
        </CardBody>
      </Card>

      {copy.retry ? <BackToProducts label="Try again" /> : <BackToProducts />}
    </Shell>
  );
}

/**
 * Constant-time comparison, because the value being compared is a secret that
 * grants read access to this page. Length is checked first and separately:
 * `timingSafeEqual` THROWS on mismatched buffer lengths rather than returning
 * false, which would turn a truncated URL into a 500.
 */
function secretMatches(actual: string | null, provided: string): boolean {
  if (actual === null) return false;
  const a = Buffer.from(actual, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

interface StatusCopy {
  readonly title: string;
  readonly body: string;
  /** `settled` gets the "the order follows by webhook" paragraph. */
  readonly tone: "settled" | "pending" | "failed";
  readonly retry: boolean;
}

/**
 * The PaymentIntent's OWN status, never `redirect_status` from the query
 * string.
 *
 * `redirect_status` is a value in a URL the customer can edit. Appending
 * `&redirect_status=succeeded` to this page's address must not produce a page
 * that says the payment worked — and if a screenshot of that page is ever
 * accepted as proof by a human, it is fraud with one query parameter.
 */
function describe(status: Stripe.PaymentIntent.Status): StatusCopy {
  switch (status) {
    case "succeeded":
      return {
        title: "Payment received",
        body: "Stripe has taken the payment and it has settled.",
        tone: "settled",
        retry: false,
      };
    case "processing":
      return {
        title: "Payment is processing",
        body:
          "Bank debits and transfers take a few days to clear. Stripe will " +
          "confirm or reject it, and the order is recorded when it does — " +
          "there is nothing further for you to do.",
        tone: "pending",
        retry: false,
      };
    case "requires_action":
    case "requires_confirmation":
      return {
        title: "One more step is needed",
        body:
          "Your bank asked for confirmation and it has not come back yet. " +
          "Finish it in your banking app, or start the payment again.",
        tone: "pending",
        retry: true,
      };
    case "requires_payment_method":
      return {
        title: "The payment did not go through",
        body:
          "Your payment method was declined or abandoned, and nothing has been " +
          "charged. A different card usually works.",
        tone: "failed",
        retry: true,
      };
    case "canceled":
      return {
        title: "This payment was cancelled",
        body: "Nothing has been charged.",
        tone: "failed",
        retry: true,
      };
    // `requires_capture` only appears on a manual-capture integration, which
    // this checkout does not create. Handled anyway rather than left to a
    // default branch that would tell an authorised customer their payment
    // failed.
    case "requires_capture":
      return {
        title: "Payment authorised",
        body:
          "The amount is held on your card and will be taken when the order is " +
          "prepared.",
        tone: "settled",
        retry: false,
      };
    default:
      return {
        title: "Payment status unclear",
        body:
          "Stripe reported a state this page does not recognise. Do not pay " +
          "again — contact support and quote the reference below.",
        tone: "pending",
        retry: false,
      };
  }
}

function Shell({ children }: { readonly children: ReactNode }) {
  return (
    <main className="mx-auto max-w-xl px-6 py-10">
      <PageHeader
        title="Order"
        description="What Stripe says about the payment you just made."
      />
      <div className="flex flex-col gap-4">{children}</div>
    </main>
  );
}

function BackToProducts({ label = "Browse products" }: { readonly label?: string }) {
  return (
    <p>
      <Link href="/products" className={buttonClass("secondary")}>
        {label}
      </Link>
    </p>
  );
}
