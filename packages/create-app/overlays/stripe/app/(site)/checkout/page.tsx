import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { isDbConfigured } from "__SCOPE__/db";
import { formatMinor } from "__SCOPE__/catalog";
import { CheckoutForm } from "@/components/checkout/CheckoutForm";
import { SimulatePurchase } from "@/components/checkout/SimulatePurchase";
import { Notice, PageHeader, buttonClass } from "@/components/ui";
import { db } from "@/db";
import { env } from "@/env";
import { currentPrincipal, isSignInConfigured } from "@/server/auth";
import {
  MAX_QUANTITY,
  type StorefrontProduct,
  type StorefrontVariant,
} from "@/server/routers/checkout";
// WHICH CHECKOUT IS LIVE. One predicate, and `checkout.simulate` calls the
// same one on the same request — so the page and the procedure cannot disagree
// about it, which is what the comment that used to sit here CLAIMED while the
// page branched on `!stripe` alone and the procedure also checked the
// environment. The button below is handed this result rather than deriving a
// third opinion in the browser.
import { checkoutMode } from "@/server/checkout-mode";
import { api } from "@/trpc/server";

/** Reads searchParams and a live price. Nothing here is cacheable. */
export const dynamic = "force-dynamic";

interface CheckoutParams {
  readonly product?: string;
  readonly variant?: string;
  readonly qty?: string;
}

/**
 * The in-app checkout.
 *
 * A server component that resolves the line item and hands it to a client
 * component for the Stripe Payment Element. The split matters: everything a
 * customer READS about what they are buying — the name, the option, the total —
 * is rendered on the server from the catalog row, so the browser is never the
 * source of the number on the button. The browser's only job is to collect card
 * details, which it does directly with Stripe.
 */
export default async function CheckoutPage({
  searchParams,
}: {
  readonly searchParams: Promise<CheckoutParams>;
}) {
  const params = await searchParams;
  const quantity = parseQuantity(params.qty);
  const slug = params.product;
  const variantId = params.variant;

  if (!slug || !variantId) {
    return (
      <Shell title="Nothing selected">
        <Notice tone="info" title="This page needs to know what you are buying">
          Pick a product and an option first — the checkout takes the item from
          the link that sent you here.
        </Notice>
        <BackToProducts />
      </Shell>
    );
  }

  // Before either read. Both of them touch Postgres — the price through the
  // tRPC caller, the principal through the users table — and the customer
  // should be told the deployment is unfinished rather than bounced to a
  // sign-in page that also cannot work. Asking the handle rather than catching
  // the throw, because the caller wraps whatever a procedure throws and the
  // name never survived: see the storefront listing for the same fix.
  if (!isDbConfigured(db)) {
    return (
      <Shell title="Checkout is unavailable">
        <Notice tone="warn" title="DATABASE_URL is not set">
          The checkout reads the price from Postgres and this deployment has no
          connection to one, so there is no amount it could honestly charge. Add
          the variable to <code>.env.local</code> and restart —{" "}
          <Link href="/setup" className="text-accent underline underline-offset-2">
            /setup
          </Link>{" "}
          lists what else is outstanding.
        </Notice>
      </Shell>
    );
  }

  const product: StorefrontProduct | null = await (
    await api()
  ).checkout.getProduct({ slug });
  const principalId: string | null = (await currentPrincipal())?.userId ?? null;

  // Carried on both sign-in redirects below, so the customer lands back on THIS
  // checkout with the same item rather than on the storefront having to find it
  // again — which is where a checkout loses people.
  const returnTo = `/checkout?product=${encodeURIComponent(slug)}&variant=${encodeURIComponent(variantId)}&qty=${quantity}`;

  const variant: StorefrontVariant | undefined = product?.variants.find(
    (candidate) => candidate.id === variantId,
  );

  if (!product || !variant) {
    return (
      <Shell title="That option is no longer available">
        <Notice tone="info" title="The product or option in this link has changed">
          It may have been unpublished, archived, or had its options rewritten
          since the link was made. Nothing has been charged.
        </Notice>
        <BackToProducts />
      </Shell>
    );
  }

  // WHICH CHECKOUT THIS DEPLOYMENT IS RUNNING. Asked once, here, and the same
  // answer is passed to the button and re-derived by nothing.
  const mode = checkoutMode();

  // NO STRIPE, AND NOT PERMITTED TO PRETEND. The state that used to fall
  // through to the branches below and render a card form with no publishable
  // key behind it, or — worse, before the environment fix — a Simulate button
  // on a production shop. Said plainly instead, in the predicate's own words,
  // which are the same words the server refuses the mutation with.
  if (mode.kind === "unavailable") {
    return (
      <Shell
        title="This deployment cannot take payments"
        description="Nothing has been charged, and nothing can be until payments are configured."
      >
        <LineItem product={product} variant={variant} quantity={quantity} />
        <Notice tone="warn" title="There is no checkout to show you">
          {mode.reason}
        </Notice>
        <BackToProducts />
      </Shell>
    );
  }

  // NO STRIPE SECRET KEY — the simulated checkout.
  //
  // This is the branch that makes the shop complete before any Stripe account
  // exists. It is gated on the one predicate, NOT on NODE_ENV and not on a
  // hand-rolled copy of the rule: the server enforces the identical call in
  // `checkout.simulate`, and the Stripe half of it flips by itself the moment
  // the keys are pasted into .env.local. Nothing here has to be remembered or
  // removed at launch.
  //
  // FIRST, AHEAD OF EVERY SIGN-IN CHECK BELOW, and that ordering is the whole
  // reason anybody can reach this page on a fresh project. A deployment with no
  // Stripe usually has no Clerk either — it was generated twenty minutes ago —
  // and the two gates underneath used to fire first: one to say sign-in is not
  // configured, the other to bounce to a /sign-in that cannot sign anybody in.
  // Between them they made the simulated checkout unreachable on precisely the
  // configuration it exists to serve.
  if (mode.kind === "simulated") {
    // Attribution wherever it is possible, which is the same rule
    // `checkout.simulate` enforces on the server. With Clerk configured the
    // buyer is sent to sign in and comes back to this exact item; without it
    // there is no account for the order to belong to and it is booked as a
    // guest purchase, which `orders.user_id` is nullable to allow.
    if (isSignInConfigured() && principalId === null) {
      redirect(`/sign-in?redirect_url=${encodeURIComponent(returnTo)}`);
    }

    return (
      <Shell
        title="Checkout"
        description="Payments are not configured on this deployment, so this order is recorded without one."
      >
        <SimulatePurchase
          mode={mode}
          variantId={variant.id}
          quantity={quantity}
          productName={product.name}
          variantName={variant.name}
          unitPriceMinor={variant.priceMinor}
          currency={variant.currency}
          interval={variant.interval}
          buyer={principalId === null ? "guest" : "account"}
        />
        <p className="text-xs text-ink-muted">
          To take real payments, add <code>STRIPE_SECRET_KEY</code>,{" "}
          <code>NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY</code> and{" "}
          <code>STRIPE_WEBHOOK_SECRET</code> to <code>.env.local</code> and
          restart. Nothing else changes — this page becomes the card form and the
          order is written by the same function it is written by now.
        </p>
      </Shell>
    );
  }

  // Everything below is `mode.kind === "stripe"` — the real, money-taking
  // checkout, and the only kind left once the two branches above have returned.
  // It requires an account without exception: Stripe will not take a payment that is not
  // attributable, so a guest order here would be a row with nobody to send a
  // receipt to and nobody to refund.
  //
  // Clerk absent is a DIFFERENT problem from not being signed in, and bouncing
  // to /sign-in would hide it behind a page that cannot sign anybody in either.
  if (!env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    return (
      <Shell title="Checkout needs sign-in, and sign-in is not configured">
        <Notice tone="warn" title="Clerk is not set up on this deployment">
          A payment has to be attributable to an account, so the checkout
          requires a signed-in user. Add{" "}
          <code>NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY</code> and{" "}
          <code>CLERK_SECRET_KEY</code> to <code>.env.local</code>, then restart.
        </Notice>
      </Shell>
    );
  }

  if (principalId === null) {
    // Outside the try/catch above on purpose: `redirect` works by throwing, and
    // a catch-all around it would swallow the redirect and render the page as
    // though the customer were signed in.
    redirect(`/sign-in?redirect_url=${encodeURIComponent(returnTo)}`);
  }

  // A SECRET KEY BUT NO PUBLISHABLE KEY. Half-configured, and the one state
  // where neither checkout can run: Stripe.js never loads without the
  // publishable key, and `simulate` refuses because the secret key is set. Say
  // so plainly rather than silently falling back to the simulated path, which
  // would grant products for free on a deployment that is trying to charge.
  if (!env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY) {
    return (
      <Shell title="Payments are half-configured">
        <LineItem product={product} variant={variant} quantity={quantity} />
        <Notice tone="danger" title="No Stripe publishable key on this deployment">
          Everything about this order resolves correctly — the item, the option
          and the total above are real. What is missing is{" "}
          <code>NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY</code>, without which Stripe.js
          never loads and there is no card form to show. The simulated checkout
          is not offered as a fallback either, because{" "}
          <code>STRIPE_SECRET_KEY</code> is set and this deployment is therefore
          meant to be charging. Add the publishable key to{" "}
          <code>.env.local</code> and restart.
        </Notice>
      </Shell>
    );
  }

  return (
    <Shell title="Checkout">
      <CheckoutForm
        variantId={variant.id}
        quantity={quantity}
        productName={product.name}
        variantName={variant.name}
        unitPriceMinor={variant.priceMinor}
        currency={variant.currency}
        interval={variant.interval}
      />
      <p className="text-xs text-ink-muted">
        Your order is confirmed by Stripe and recorded here by webhook, so it may
        take a moment to appear after you pay.
      </p>
    </Shell>
  );
}

/**
 * Quantity is the ONE number a customer is allowed to choose, so it is the one
 * that has to be sanitised. Anything unparseable becomes 1 rather than an error
 * page: a truncated link should still sell something.
 *
 * The server re-validates this with the same bounds. This copy exists so the
 * summary on screen matches what will actually be charged, not to enforce
 * anything — enforcement that lives only in a page is enforcement an HTTP
 * client skips.
 */
function parseQuantity(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "1", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(parsed, MAX_QUANTITY);
}

/**
 * `description` is a parameter because the stock line — "card details are
 * collected by Stripe inside this page" — is FALSE on the simulated checkout,
 * and a page that describes a card form nobody is being shown is the kind of
 * small lie that costs trust in everything else on it.
 */
function Shell({
  title,
  description = "Card details are collected by Stripe inside this page. They never reach this application.",
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
}) {
  return (
    <main className="mx-auto max-w-xl px-6 py-10">
      <PageHeader title={title} description={description} />
      <div className="flex flex-col gap-4">{children}</div>
    </main>
  );
}

/** The summary shown when there is no payment form to put it above. */
function LineItem({
  product,
  variant,
  quantity,
}: {
  readonly product: StorefrontProduct;
  readonly variant: StorefrontVariant;
  readonly quantity: number;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line pb-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{product.name}</p>
        <p className="text-sm text-ink-muted">
          {variant.name} × {quantity}
          {variant.interval ? ` · every ${variant.interval}` : ""}
        </p>
      </div>
      <p className="text-sm font-semibold tabular-nums">
        {formatMinor(variant.priceMinor * BigInt(quantity), variant.currency)}
      </p>
    </div>
  );
}

function BackToProducts() {
  return (
    <p>
      <Link href="/products" className={buttonClass("secondary")}>
        Browse products
      </Link>
    </p>
  );
}
