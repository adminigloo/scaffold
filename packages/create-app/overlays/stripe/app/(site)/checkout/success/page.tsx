import { timingSafeEqual } from "node:crypto";
import Link from "next/link";
import type { ReactNode } from "react";
import type Stripe from "stripe";
import { isDbConfigured } from "__SCOPE__/db";
import { formatMinor } from "__SCOPE__/catalog";
import { accountOrderHref } from "@/account";
import { Card, CardBody, Notice, PageHeader, buttonClass } from "@/components/ui";
import { db } from "@/db";
import { currentPrincipal, isSignInConfigured } from "@/server/auth";
import {
  readOrderByReference,
  type FulfilledOrderView,
} from "@/server/fulfilment";
import { STOREFRONT_TENANT_ID } from "@/server/routers/checkout";
import { stripe } from "@/server/stripe";

/** Reads a live PaymentIntent and a just-written order. Never cacheable. */
export const dynamic = "force-dynamic";

interface SuccessParams {
  /** Appended by Stripe to `return_url`. */
  readonly payment_intent?: string;
  readonly payment_intent_client_secret?: string;
  /** Stripe's own summary. Read for nothing — see `describe` below. */
  readonly redirect_status?: string;
  /**
   * The simulated checkout's return handle: a `sim_…` fulfilment reference.
   *
   * A SEPARATE PARAMETER from `payment_intent` rather than one overloaded
   * `ref`, because the two are authenticated differently and collapsing them
   * would put that difference inside an `if` on a value the caller controls.
   */
  readonly ref?: string;
}

/**
 * Where a completed checkout lands — from EITHER path.
 *
 * THE ONE THING THIS PAGE PROVES. Both the Stripe path and the simulated path
 * arrive here, both resolve a `reference`, and both then call the same
 * `readOrderByReference`. There is no branch below that reads an order two
 * different ways, and there must never be one: the moment the simulated
 * checkout gets its own success page, it stops testing the real one, and the
 * whole design collapses into a demo that happens to sit next to production
 * code.
 *
 * WHAT IT DOES NOT DO on the Stripe path is assert the order exists. The money
 * question is settled by the PaymentIntent, which this page reads from Stripe
 * directly. The ORDER is written by the webhook, and Stripe's delivery is
 * asynchronous — usually within a second, sometimes not. A page that says "your
 * order is confirmed" before the row exists sends the customer to an order
 * history that does not list it, and the first thing they do is pay again. So
 * it says what is true: the payment succeeded, and the order is on its way.
 *
 * On the simulated path the order is always there, because it was written
 * synchronously by the button that navigated here.
 */
export default async function CheckoutSuccessPage({
  searchParams,
}: {
  readonly searchParams: Promise<SuccessParams>;
}) {
  const params = await searchParams;

  if (params.ref) return <SimulatedReturn reference={params.ref} />;
  return <StripeReturn params={params} />;
}

// ---------------------------------------------------------------------------
// The simulated path
// ---------------------------------------------------------------------------

/**
 * PROOF OF OWNERSHIP IS THE SIGNED-IN USER, not the reference in the URL.
 *
 * The Stripe path can authenticate a stranger — the client secret is a bearer
 * proof Stripe hands only to the browser that created the intent, which is why
 * that path works signed out. A `sim_` reference has no such property: it is
 * just an id, and an id in a URL gets pasted into chat logs and bug reports. So
 * this path checks the thing it actually can, which is stronger anyway: the
 * order must belong to the person asking.
 *
 * THE ONE EXCEPTION IS A DEPLOYMENT WHERE NOBODY CAN SIGN IN. With no Clerk
 * keys `checkout.simulate` books a guest order — `orders.user_id` is nullable
 * exactly so it can — and there is then no account boundary for this check to
 * enforce: every visitor is the same anonymous person, and refusing to show a
 * guest order to the browser that just created it would be theatre that hides
 * the receipt from its only reader. The condition is `isSignInConfigured()`,
 * the same predicate the procedure used to decide whether to demand a buyer, so
 * the two cannot disagree — and it closes by itself the moment Clerk is
 * configured, after which a guest order stops being readable this way at all.
 */
async function SimulatedReturn({ reference }: { readonly reference: string }) {
  // The same guard the storefront and the checkout use, asked before the read
  // rather than around it. One pattern for "there is no database yet" across
  // every page in this project is the point: the alternative was inspecting a
  // thrown error's name, which broke the moment a read went through tRPC.
  if (!isDbConfigured(db)) {
    return (
      <Shell>
        <Notice tone="warn" title="DATABASE_URL is not set">
          Orders live in Postgres and this deployment has no connection to one,
          so there is nothing to read back.
        </Notice>
      </Shell>
    );
  }

  const order: FulfilledOrderView | null = await readOrderByReference({
    tenantId: STOREFRONT_TENANT_ID,
    reference,
  });
  const principalId: string | null = (await currentPrincipal())?.userId ?? null;

  // One answer for "no such order" and "not yours". Distinguishing them turns
  // this page into an oracle for whether a given reference exists.
  //
  // `order.userId === null` is a guest purchase, readable only while this
  // deployment has no accounts at all. Note the ordering: with Clerk configured
  // the second clause is false, and a guest order left over from before the
  // keys were added is refused like anybody else's.
  const isOwnOrder =
    order !== null &&
    (order.userId === null
      ? !isSignInConfigured()
      : order.userId === principalId);

  if (!order || !isOwnOrder) {
    return (
      <Shell>
        <Notice tone="danger" title="That order could not be found">
          The link is incomplete, or it belongs to a different account. Sign in
          as the account that made the purchase, or start again from the product.
        </Notice>
        <BackToProducts />
      </Shell>
    );
  }

  return (
    <Shell>
      <Notice tone="warn" title="This was a simulated purchase">
        No money moved and Stripe was never contacted. The order below is a real
        row written by the same function a real payment writes, so everything
        downstream of it behaves exactly as it will once payments are live.
      </Notice>
      <OrderCard order={order} />
      <WhereToFindThis orderNumber={order.orderNumber} />
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// The Stripe path
// ---------------------------------------------------------------------------

async function StripeReturn({ params }: { readonly params: SuccessParams }) {
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

  // THE SAME READER THE SIMULATED PATH USES, keyed on the same kind of value.
  // The webhook books the order under the PaymentIntent id, so that id is the
  // reference here — no metadata round trip, no second source of truth for
  // which order this payment produced.
  //
  // NULL is expected and normal: the webhook may not have landed yet. It is not
  // an error state and is not rendered as one.
  //
  // NO DATABASE reads as the same null, and that is right here rather than a
  // "not configured" screen: the payment above is real and already taken, and
  // the copy below says the order is on its way. Telling somebody who has just
  // been charged that the site is misconfigured invites them to pay again.
  const order: FulfilledOrderView | null = isDbConfigured(db)
    ? await readOrderByReference({
        tenantId: STOREFRONT_TENANT_ID,
        reference: intent.id,
      })
    : null;

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

          {copy.tone === "settled" && order === null && (
            <p className="text-sm text-ink-muted">
              Your order is being recorded now. Stripe notifies this application
              by webhook rather than through your browser, so it can take a
              moment to appear — and it will appear whether or not you keep this
              page open.
            </p>
          )}

          <p className="text-xs text-ink-muted">
            Reference <code className="font-mono">{intent.id}</code> — quote this
            to support and they can find the payment and the order from it.
          </p>
        </CardBody>
      </Card>

      {order && <OrderCard order={order} />}

      {copy.retry ? (
        <BackToProducts label="Try again" />
      ) : (
        // No order number when the webhook has not landed yet, which is the
        // common case here and not an error. The block falls back to the order
        // list, which will contain it a second from now.
        <WhereToFindThis {...(order ? { orderNumber: order.orderNumber } : {})} />
      )}
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// Where the buyer goes next
// ---------------------------------------------------------------------------

/**
 * THE ONE SCREEN A BUYER IS CERTAINLY LOOKING AT, pointed at the one place
 * their purchase can be found again.
 *
 * This page is a RETURN URL. Nothing in the application links to it, its
 * address carries a client secret or a fulfilment reference that stops
 * resolving, and the customer closes the tab a minute after arriving. Until
 * this block the only way out of it was "Browse products", and the account
 * area — which exists precisely because a buyer had nowhere to see what they
 * had bought — was advertised nowhere but the site header, on the one screen
 * where nobody reads the header. A licence key rendered here and named nowhere
 * else is a key the customer loses by closing a tab.
 *
 * `orderNumber` is optional deliberately. On the Stripe path the order is
 * written by the webhook, asynchronously, so it is usually still absent when
 * this page renders; the order LIST is the honest destination in that case and
 * costs the buyer one further click. Never a link to
 * `/account/orders/undefined`.
 *
 * SILENT WHERE NOBODY CAN SIGN IN. With no Clerk keys `checkout.simulate` books
 * a guest order and `/account` can only answer "sign in to see what you have",
 * so sending anybody there would be advice they cannot take. The predicate is
 * `isSignInConfigured`, the same one `SimulatedReturn` uses to decide whether a
 * guest order is readable at all, so the two cannot drift apart.
 *
 * `accountOrderHref` is IMPORTED rather than spelled out. The order number goes
 * into a path segment and the account overlay owns the rule for doing that
 * safely; a second copy here is the one that forgets to encode it the day the
 * order-number prefix grows a slash. That the import resolves is not luck —
 * `overlayNamesFor` selects the account overlay on exactly the condition it
 * selects this one, and neither can be installed without the other.
 */
function WhereToFindThis({ orderNumber }: { readonly orderNumber?: string }) {
  if (!isSignInConfigured()) return <BackToProducts />;

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <p className="text-sm font-medium">Where to find this again</p>
        <p className="text-sm text-ink-muted">
          Every order you place, the licence keys it issued, what it entitles you
          to and where any parcel has got to are all in your account. You do not
          need to keep this page.
        </p>
        <div className="flex flex-wrap gap-2">
          {orderNumber ? (
            <Link
              href={accountOrderHref(orderNumber)}
              className={buttonClass("primary")}
            >
              View this order
            </Link>
          ) : (
            <Link href="/account/orders" className={buttonClass("primary")}>
              Your orders
            </Link>
          )}
          <Link href="/account" className={buttonClass("secondary")}>
            Your account
          </Link>
          <Link href="/products" className={buttonClass("secondary")}>
            Browse products
          </Link>
        </div>
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Shared rendering — one order, one card, whichever path made it
// ---------------------------------------------------------------------------

function OrderCard({ order }: { readonly order: FulfilledOrderView }) {
  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-sm font-medium">
            Order <code className="font-mono">{order.orderNumber}</code>
          </p>
          <p className="text-sm font-semibold tabular-nums">
            {formatMinor(order.totalMinor, order.currency)}
          </p>
        </div>

        <ul className="flex flex-col gap-2">
          {order.lines.map((line, index) => (
            <li
              // No stable id on a line — `orderItems.id` is not selected because
              // nothing else needs it. The list is never reordered or filtered,
              // so the index is a correct key here rather than a lazy one.
              key={index}
              className="flex items-baseline justify-between gap-3 border-b border-line pb-2 last:border-b-0 last:pb-0"
            >
              <div className="min-w-0">
                <p className="text-sm">
                  {line.name} × {line.quantity}
                </p>
                {line.licenseKey && (
                  <p className="mt-1 text-sm">
                    <span className="text-ink-muted">Licence key: </span>
                    <code className="font-mono">{line.licenseKey}</code>
                  </p>
                )}
              </div>
              <p className="text-sm tabular-nums text-ink-muted">
                {formatMinor(line.totalMinor, order.currency)}
              </p>
            </li>
          ))}
        </ul>

        {order.source === "simulated" && (
          <p className="text-xs text-ink-muted">
            Recorded without a payment. This order is flagged in the audit log as{" "}
            <code className="font-mono">commerce.order.simulated</code> and
            carries no Stripe payment id.
          </p>
        )}
      </CardBody>
    </Card>
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
      <PageHeader title="Order" description="What this order came to, and what it granted." />
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
