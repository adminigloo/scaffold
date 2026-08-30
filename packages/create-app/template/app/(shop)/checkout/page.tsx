import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { formatMinor } from "__SCOPE__/catalog";
import { CheckoutForm } from "@/components/checkout/CheckoutForm";
import { Notice, PageHeader, buttonClass } from "@/components/ui";
import { env } from "@/env";
import { currentPrincipal } from "@/server/auth";
import {
  isDatabaseUnconfigured,
  type StorefrontProduct,
  type StorefrontVariant,
} from "@/server/routers/checkout";
import { api } from "@/trpc/server";

/** Reads searchParams and a live price. Nothing here is cacheable. */
export const dynamic = "force-dynamic";

const MAX_QUANTITY = 999;

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

  let product: StorefrontProduct | null = null;
  let principalId: string | null = null;
  let databaseMissing = false;

  try {
    product = await (await api()).checkout.getProduct({ slug });
    // Read inside the try because it queries the users table, so on a laptop
    // with no DATABASE_URL it throws exactly like the product read does — and
    // the customer should be told the deployment is unfinished, not bounced to
    // a sign-in page that also cannot work.
    principalId = (await currentPrincipal())?.userId ?? null;
  } catch (error) {
    if (!isDatabaseUnconfigured(error)) throw error;
    databaseMissing = true;
  }

  if (databaseMissing) {
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
    //
    // The return path is carried so the customer lands back on THIS checkout
    // with the same item, rather than on the storefront having to find it
    // again — which is where a checkout loses people.
    const returnTo = `/checkout?product=${encodeURIComponent(slug)}&variant=${encodeURIComponent(variantId)}&qty=${quantity}`;
    redirect(`/sign-in?redirect_url=${encodeURIComponent(returnTo)}`);
  }

  // Stripe's browser half. The secret key is checked again server-side inside
  // `createIntent`; this one only decides whether it is honest to render a
  // payment form at all.
  if (!env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY) {
    return (
      <Shell title="Payments are switched off">
        <LineItem product={product} variant={variant} quantity={quantity} />
        <Notice tone="warn" title="No Stripe publishable key on this deployment">
          Everything about this order resolves correctly — the item, the option
          and the total below are real. What is missing is{" "}
          <code>NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY</code>, without which Stripe.js
          never loads and there is no card form to show. Add it and{" "}
          <code>STRIPE_SECRET_KEY</code> to <code>.env.local</code>, then restart.
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

function Shell({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <main className="mx-auto max-w-xl px-6 py-10">
      <PageHeader
        title={title}
        description="Card details are collected by Stripe inside this page. They never reach this application."
      />
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
