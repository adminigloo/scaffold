import { createHash, randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import type Stripe from "stripe";
import { products, productVariants } from "__SCOPE__/catalog/schema";
// For the audit line on a simulated order, and for nothing that decides
// anything — the decision is `checkoutMode()` below.
import { describeAppEnv } from "__SCOPE__/env";
import { createLogger } from "__SCOPE__/observability";
import { FIRM_WIDE } from "__SCOPE__/permissions";
import { db } from "@/db";
import { env } from "@/env";
import { isSignInConfigured } from "@/server/auth";
// Which checkout is live on this deployment. THE one predicate — the same call
// `/checkout`, the storefront notice and the Simulate button are drawn from, so
// the page and the procedure cannot disagree about it. Read by `simulate` and
// by nothing else here; see property 1 on that procedure.
import { checkoutMode } from "@/server/checkout-mode";
import {
  assertPurchasable,
  fulfilPurchase,
  loadVariantForPurchase,
  simulatedReference,
  MAX_QUANTITY,
  PurchaseRefusedError,
  STRIPE_MAX_AMOUNT_MINOR,
  type PurchasableVariant,
} from "@/server/fulfilment";
// Imported for its SIDE EFFECT as much as its value. `createStripeClient`
// caches on globalThis and `getStripeOrThrow()` reads that cache — so in a
// process that has never imported this module it reports "not configured" on a
// deployment that is. Importing the handle directly is what makes that
// impossible to get wrong here; `checkout-mode.ts` imports it for the same
// reason.
import { stripe } from "@/server/stripe";
import { createTRPCRouter, protectedProcedure, publicProcedure } from "../trpc";

/**
 * Warnings from this router go to the same structured sink as everything else,
 * with the credential redaction __SCOPE__/observability configures — which
 * matters here because a checkout log line sits next to client secrets.
 */
const logger = createLogger({ level: env.LOG_LEVEL });

/**
 * The in-app checkout: a Stripe Payment Element embedded in our own pages, not
 * a redirect to Stripe's hosted Checkout.
 *
 * WHY NONE OF THESE PROCEDURES IS BEHIND requireTenant/requireStaff, when
 * every other procedure in this app is.
 *
 * A storefront that requires a permission to read is not a storefront. The two
 * reads below are `publicProcedure` because the data they return is by
 * definition published — an `active` product is the shop window. `createIntent`
 * is `protectedProcedure` because a payment must be attributable to a person,
 * but there is no capability to check: any signed-in user may buy. `simulate`
 * is `publicProcedure` with the attribution requirement written out in its own
 * handler, because the deployment it exists for is one where nobody can sign in
 * at all — see the five properties documented on it.
 *
 * What replaces the permission check is that NOTHING AUTHORIZATION-BEARING
 * COMES FROM THE CLIENT. The amount, the currency, the Stripe price and the
 * owning tenant are all read out of the database row named by `variantId`. The
 * client supplies a variant id and a quantity, and a quantity is the only
 * number a customer is allowed to choose. If a price could arrive in the input
 * object, every discount in the catalog would be a devtools edit away.
 */

/**
 * Whose catalog the public storefront sells.
 *
 * A public route has no principal and therefore no tenant, so it MUST be told
 * which one to read. Listing every tenant's `active` products instead would put
 * one customer's catalog — names, prices, launch timing — on another's
 * storefront, which is the worst failure available to a multi-tenant shop and
 * it would look like a feature until somebody noticed.
 *
 * `FIRM_WIDE` is the sentinel @adminigloo/permissions already uses for "belongs
 * to the platform, not to a customer", and it is what `plans.tenant_id`
 * defaults to for exactly this reason. A project whose tenants each run their
 * own shop should replace this with a lookup from the request host or a
 * `[tenant]` path segment — and should change it HERE, not in the three pages,
 * so there is one answer.
 */
export const STOREFRONT_TENANT_ID = FIRM_WIDE;

/**
 * `MAX_QUANTITY` and `STRIPE_MAX_AMOUNT_MINOR` used to be declared here.
 *
 * They moved to @/server/fulfilment because `simulate` below has to enforce the
 * IDENTICAL bounds, and two copies of a limit are two chances for the paid path
 * and the simulated one to disagree about what is purchasable — which is the
 * whole class of bug the shared core exists to remove. Re-exported so the
 * checkout page can render a quantity cap that cannot drift from the enforced
 * one.
 */
export { MAX_QUANTITY, STRIPE_MAX_AMOUNT_MINOR };

/** Metadata key holding our user id on the Stripe Customer. */
const APP_USER_METADATA_KEY = "appUserId";

/**
 * Namespace on the reference we hand the webhook.
 *
 * Mirrors `CHECKOUT_SESSION_KEY_PREFIX` in @adminigloo/commerce and exists for
 * the same reason: the order-creating writer keys rows on
 * `(tenant_id, idempotency_key)`, and two unrelated systems free to pick that
 * string will eventually pick the same one. Prefixing makes the namespaces
 * disjoint at the value level rather than by convention.
 */
const PAYMENT_ELEMENT_REF_PREFIX = "payment_element:";

/*
 * `isDatabaseUnconfigured` USED TO LIVE HERE, and the storefront pages caught
 * their reads with it to answer "is there no database yet". It could not work,
 * and it is gone rather than fixed.
 *
 * It matched on `error.name`, which is the right way to recognise an error
 * across the ESM/CJS duplication @adminigloo/db warns about. What it could not
 * survive was the CALLER: a page reads through `api()`, tRPC wraps anything a
 * procedure throws in a `TRPCError`, and the original is only reachable as
 * `.cause`. So the name never matched, the rethrow fired, and /products — a
 * link in the header and footer of every page — returned a 500 on a project
 * generated with no credentials at all, which is the one thing the scaffold
 * promises will not happen.
 *
 * Every page now asks `isDbConfigured(db)` BEFORE it reads, which is what the
 * admin pages already did. It needs no query, it cannot be wrapped by anything
 * in between, and there is one answer to this question in the project instead
 * of two.
 */

/** A variant as the storefront and the checkout summary render it. */
export interface StorefrontVariant {
  readonly id: string;
  readonly name: string;
  readonly sku: string | null;
  readonly priceMinor: bigint;
  readonly currency: string;
  /** NULL for one-time. `"month"` / `"year"` means this creates a subscription. */
  readonly interval: "month" | "year" | null;
  readonly isDefault: boolean;
  /**
   * NULL MEANS UNTRACKED, 0 MEANS SOLD OUT. Carried through rather than
   * collapsed into a boolean: every digital product in the catalog has NULL
   * here, and an `inStock: false` default would render the whole catalog as
   * sold out.
   */
  readonly inventory: number | null;
}

export interface StorefrontProduct {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly kind: "one_time" | "subscription";
  readonly images: readonly { readonly url: string; readonly alt?: string }[];
  readonly variants: readonly StorefrontVariant[];
}

async function loadStorefrontProducts(
  slug: string | null,
): Promise<StorefrontProduct[]> {
  const productRows = await db
    .select({
      id: products.id,
      slug: products.slug,
      name: products.name,
      description: products.description,
      kind: products.kind,
      images: products.images,
    })
    .from(products)
    .where(
      and(
        eq(products.tenantId, STOREFRONT_TENANT_ID),
        // `active` only. `draft` is a form somebody is still filling in, and
        // `archived` is retired but must stay readable on old receipts — the
        // storefront is the one surface where showing either is a bug with a
        // customer on the other end of it.
        eq(products.status, "active"),
        isNull(products.deletedAt),
        ...(slug === null ? [] : [eq(products.slug, slug)]),
      ),
    )
    .orderBy(asc(products.sortOrder), asc(products.name));

  if (productRows.length === 0) return [];

  // A second query rather than a join. A join multiplies the product row by its
  // variant count and every consumer then has to regroup it; with
  // `noUncheckedIndexedAccess` on, that regrouping is where the undefined
  // checks pile up. Two round trips, no reassembly bugs.
  const variantRows = await db
    .select()
    .from(productVariants)
    .where(
      inArray(
        productVariants.productId,
        productRows.map((row) => row.id),
      ),
    )
    .orderBy(asc(productVariants.sortOrder), asc(productVariants.name));

  const byProduct = new Map<string, StorefrontVariant[]>();
  for (const variant of variantRows) {
    const list = byProduct.get(variant.productId) ?? [];
    list.push({
      id: variant.id,
      name: variant.name,
      sku: variant.sku,
      priceMinor: variant.priceMinor,
      currency: variant.currency,
      interval: variant.interval,
      isDefault: variant.isDefault,
      inventory: variant.inventory,
    });
    byProduct.set(variant.productId, list);
  }

  return productRows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    kind: row.kind,
    images: row.images,
    variants: byProduct.get(row.id) ?? [],
  }));
}

/** What `createIntent` hands the browser. */
export type CreateIntentResult =
  | {
      readonly status: "requires_payment";
      /**
       * Feeds `<Elements options={{ clientSecret }}>`. Safe to send to the
       * browser — it authorises confirming THIS one payment and nothing else,
       * which is also why the success page can use it as proof of ownership
       * instead of trusting a query parameter.
       */
      readonly clientSecret: string;
      readonly intentKind: "payment" | "subscription";
      /** The value the webhook will use as `orders.idempotency_key`. */
      readonly orderRef: string;
      readonly amountMinor: bigint;
      readonly currency: string;
    }
  | {
      /**
       * A real outcome, not an error: a subscription that starts on a trial, or
       * a 100%-off first invoice, owes nothing today and Stripe therefore
       * creates no payment to confirm. Rendering a Payment Element here would
       * ask for a card that is never charged and then hang, because there is no
       * intent for `confirmPayment` to act on.
       */
      readonly status: "no_payment_due";
      readonly intentKind: "subscription";
      readonly orderRef: string;
    };

/**
 * One checkout attempt's identity: the Stripe idempotency key, and the
 * reference the webhook will key our order row on.
 *
 * Derived from the same digest ON PURPOSE. If the Stripe key is reused the
 * order key must be reused too, or a replayed intent arrives under a second
 * order reference and the ledger books the sale twice.
 */
interface CheckoutAttempt {
  readonly idempotencyKey: string;
  readonly orderRef: string;
}

function attemptFor(seed: string, parts: readonly string[]): CheckoutAttempt {
  // NUL-separated. Joining on ":" lets a value containing a colon shift the
  // field boundaries, so two different (tenant, user, variant, quantity) tuples
  // can hash to one digest — and a shared digest is a shared idempotency key,
  // which is one customer being handed another's PaymentIntent.
  const digest = createHash("sha256")
    .update([...parts, seed].join("\u0000"))
    .digest("hex")
    .slice(0, 32);
  return {
    idempotencyKey: `checkout:${digest}`,
    orderRef: `${PAYMENT_ELEMENT_REF_PREFIX}${digest}`,
  };
}

/**
 * Create through the deterministic key; if that key turns out to be spent, do
 * it once more through a fresh one.
 *
 * THE DETERMINISTIC KEY IS WHAT MAKES A DOUBLE-CLICK FREE. Two clicks 80ms
 * apart send two requests, both derive the same key, and Stripe replays the
 * first response to the second — one PaymentIntent, one order reference, one
 * charge.
 *
 * THE RETRY IS WHAT STOPS IT BREAKING THE SECOND PURCHASE. A key derived from
 * (user, variant, quantity) is stable forever, so a customer buying the same
 * thing again next week derives the same key and Stripe replays the intent they
 * ALREADY PAID. The Payment Element would then sit on a `succeeded` intent and
 * refuse to take money, with nothing on screen explaining why. So the result is
 * inspected and a spent attempt is redone under a random seed. The same retry
 * covers `idempotency_error`, which is what Stripe returns when a key is reused
 * with different parameters — i.e. when the price changed between two attempts.
 *
 * The residual cost is that a double-click on a REPEAT purchase can create two
 * intents, because both requests see the first one as spent. Only one is ever
 * confirmed — the browser holds a single client secret — and an unconfirmed
 * PaymentIntent expires on Stripe's side without charging anybody. That is the
 * right side of the trade: it accepts an abandoned intent to prevent a customer
 * who cannot buy something twice.
 */
async function throughAttempt<T>(
  parts: readonly string[],
  create: (attempt: CheckoutAttempt) => Promise<T>,
  spent: (result: T) => boolean,
): Promise<T> {
  const first = attemptFor("", parts);

  let result: T | null = null;
  try {
    result = await create(first);
  } catch (error) {
    if (!isIdempotencyConflict(error)) throw error;
  }

  if (result !== null && !spent(result)) return result;
  return create(attemptFor(randomUUID(), parts));
}

/**
 * Duck-typed rather than `instanceof Stripe.errors.StripeIdempotencyError`,
 * which would turn `stripe` from a type-only import into a value import — in a
 * module whose TYPE the browser bundle already reaches through `AppRouter`.
 * `type` is a documented field on every StripeError and is what the raw API
 * returns.
 */
function isIdempotencyConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { type?: unknown }).type === "idempotency_error"
  );
}

/** PaymentIntent states from which no further payment can be taken. */
function isSpentIntent(intent: Stripe.PaymentIntent): boolean {
  return intent.status === "succeeded" || intent.status === "canceled";
}

/**
 * The Stripe Customer this user already has, or NULL.
 *
 * SPLIT OUT OF `ensureCustomer` AND EXPORTED because the billing portal needs
 * the opposite behaviour to a checkout. Checkout may create a Customer, because
 * a Subscription requires one and the customer is about to pay. The portal must
 * not: a portal session opened against a Customer created seconds earlier shows
 * no payment methods, no invoices and no subscription, which reads to the
 * person looking at it as though their billing history has been lost. "There is
 * nothing to manage yet" is the honest answer, and a NULL is what lets the
 * caller say it.
 *
 * `metadata['appUserId']` is the join, and this is the only place that spelling
 * lives. `/account/billing` finding the customer by a query written a second
 * time is how the two come to disagree about which Stripe object belongs to a
 * person — and the disagreement would surface as a customer being handed a
 * stranger's billing portal.
 */
export async function findStripeCustomerId(
  client: NonNullable<typeof stripe>,
  userId: string,
): Promise<string | null> {
  // The id goes into a Stripe search QUERY, which is a string language with
  // quoting. Our ids are generated (see `idColumn`), so this can only trip if
  // something upstream starts minting them differently — and the moment it
  // does, an unescaped quote turns this into query injection against our own
  // Stripe account.
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId)) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Refusing to build a Stripe search query from an unexpected user id.",
    });
  }

  const found = await client.stripe.customers.search({
    query: `metadata['${APP_USER_METADATA_KEY}']:'${userId}'`,
    limit: 1,
  });
  return found.data[0]?.id ?? null;
}

/**
 * The Stripe Customer for this user, created if we have never seen them.
 *
 * A Subscription requires one; a PaymentIntent does not, which is why the
 * one-time path skips this entirely rather than paying for a lookup on every
 * checkout.
 *
 * TWO LAYERS, because neither alone is enough. The search finds the customer we
 * made last month. Stripe's search index lags writes by up to a minute, so the
 * search alone would create a second Customer for anyone who checks out twice
 * in quick succession — hence the idempotency key on the create, which covers
 * exactly that window. The gap that remains is a returning customer whose
 * search read is stale AND whose 24-hour idempotency key has expired: that
 * duplicates a Customer record. Harmless to billing, untidy in the dashboard.
 *
 * The real fix is a `stripe_customer_id` column on the user, so that neither
 * mechanism is load-bearing. That is a schema change and belongs to whoever
 * owns the schema.
 */
async function ensureCustomer(
  client: NonNullable<typeof stripe>,
  principal: { readonly userId: string; readonly email: string | null },
): Promise<string> {
  const existing = await findStripeCustomerId(client, principal.userId);
  if (existing !== null) return existing;

  const created = await client.stripe.customers.create(
    {
      ...(principal.email === null ? {} : { email: principal.email }),
      metadata: { [APP_USER_METADATA_KEY]: principal.userId },
    },
    { idempotencyKey: `customer:${principal.userId}` },
  );
  return created.id;
}

/**
 * The PaymentIntent an invoice is collected through.
 *
 * `invoice.payment_intent` WAS the field. It was removed from the Invoice
 * object in API version 2025-03-31.basil, and this deployment pins
 * 2026-08-26.dahlia — reading it now yields undefined, so a subscription
 * checkout that looks correct simply never gets a client secret. The
 * replacements are `confirmation_secret` (the secret itself) and the `payments`
 * sub-list (the PaymentIntent's id), and both have to be expanded explicitly.
 */
function paymentIntentIdFromInvoice(invoice: Stripe.Invoice): string | null {
  for (const payment of invoice.payments?.data ?? []) {
    const intent = payment.payment.payment_intent;
    if (typeof intent === "string") return intent;
    if (intent && typeof intent === "object") return intent.id;
  }
  return null;
}

/**
 * The one gate both purchase paths pass through, in tRPC clothing.
 *
 * The refusal reasons and their wording live in @/server/fulfilment; this only
 * maps them onto HTTP-ish codes, because a tRPC code is a transport concern and
 * has no business deciding what is purchasable. Adding a rule to
 * `assertPurchasable` therefore reaches `createIntent` and `simulate` at the
 * same instant, with no third place to remember.
 */
async function purchasableOrThrow(
  variantId: string,
  quantity: number,
): Promise<PurchasableVariant> {
  const variant = await loadVariantForPurchase(variantId);
  if (!variant) {
    // Same message a draft product gets. A 404 that distinguishes "no such
    // variant" from "not published" is a way to enumerate an unreleased catalog.
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "That product is no longer for sale.",
    });
  }

  try {
    assertPurchasable(variant, quantity);
  } catch (error) {
    if (!(error instanceof PurchaseRefusedError)) throw error;
    throw new TRPCError({ code: refusalCode(error), message: error.message });
  }

  return variant;
}

function refusalCode(
  error: PurchaseRefusedError,
): "NOT_FOUND" | "CONFLICT" | "BAD_REQUEST" {
  switch (error.code) {
    case "not_for_sale":
      return "NOT_FOUND";
    case "sold_out":
    case "insufficient_stock":
      return "CONFLICT";
    case "quantity_too_large":
    case "amount_too_large":
      return "BAD_REQUEST";
  }
}

export const checkoutRouter = createTRPCRouter({
  /**
   * The storefront listing. Active products with their prices, no account
   * required — a shop nobody can browse without signing up is a shop nobody
   * browses.
   */
  listProducts: publicProcedure
    .meta({ scope: "public" })
    .query(async (): Promise<StorefrontProduct[]> => loadStorefrontProducts(null)),

  getProduct: publicProcedure
    .meta({ scope: "public" })
    .input(z.object({ slug: z.string().min(1) }))
    .query(async ({ input }): Promise<StorefrontProduct | null> => {
      const [found] = await loadStorefrontProducts(input.slug);
      return found ?? null;
    }),

  /**
   * Start a payment for one variant and hand back the client secret the Payment
   * Element confirms against.
   *
   * A quantity arrives from the client. A price never does.
   */
  createIntent: protectedProcedure
    .meta({ scope: "authenticated" })
    .input(
      z.object({
        variantId: z.string().min(1),
        quantity: z.number().int().min(1).max(MAX_QUANTITY),
      }),
    )
    .mutation(async ({ ctx, input }): Promise<CreateIntentResult> => {
      if (!stripe) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Payments are not configured on this deployment: STRIPE_SECRET_KEY " +
            "is not set. See /setup.",
        });
      }
      const client = stripe;

      // Loaded and guarded through the SHARED functions, not through a query
      // written here. `simulate` below calls exactly these two, which is what
      // makes "a simulated purchase cannot grant something a real one would
      // refuse" a structural property rather than a promise. The guard is also
      // re-run here rather than trusted from the page that linked in: this
      // mutation is reachable directly, and "the page already filtered" is not
      // a property anything enforces.
      const row = await purchasableOrThrow(input.variantId, input.quantity);
      const amountMinor = row.priceMinor * BigInt(input.quantity);

      /**
       * Everything the webhook needs to book this sale without asking us.
       *
       * `tenantId` is what `tenantIdFromEvent` reads back, so an event without
       * it is an event no support engineer can attribute to a customer.
       * `orderRef` is the key the order row is written under, which is what
       * makes a redelivered event a no-op instead of a second order.
       *
       * Every value is a string. Stripe stringifies whatever it is handed, so a
       * number comes back as a string anyway and an object comes back as
       * `[object Object]`.
       */
      const metadata: Record<string, string> = {
        tenantId: row.tenantId,
        userId: ctx.principal.userId,
        productId: row.productId,
        variantId: row.variantId,
        quantity: String(input.quantity),
      };

      // The digest inputs. Quantity is in here because changing it changes the
      // amount, and reusing one key across two different amounts is exactly
      // what Stripe answers with `idempotency_error`.
      const attemptParts = [
        row.tenantId,
        ctx.principal.userId,
        row.variantId,
        String(input.quantity),
      ];

      // A recurring variant becomes a Subscription, a one-time variant becomes
      // a PaymentIntent. The decision is the VARIANT's interval and not the
      // product's `kind`: the interval is what Stripe is actually billed on,
      // and `validateProduct` is what keeps the two in agreement.
      if (row.interval !== null) {
        if (!row.stripePriceId) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "This subscription has not been synced to Stripe yet, so there " +
              "is no price to bill against. Sync the product from the catalog " +
              "admin and try again.",
          });
        }
        const priceId = row.stripePriceId;
        const customerId = await ensureCustomer(client, {
          userId: ctx.principal.userId,
          email: ctx.principal.email,
        });

        const subscription = await throughAttempt(
          attemptParts,
          (attempt) =>
            client.stripe.subscriptions.create(
              {
                customer: customerId,
                items: [{ price: priceId, quantity: input.quantity }],
                // The subscription is created unpaid and its first invoice is
                // left open, so the browser can collect payment for it through
                // the Payment Element. Without this, Stripe tries to charge a
                // payment method the customer has not given us yet and the
                // subscription lands `incomplete` behind a failed invoice.
                payment_behavior: "default_incomplete",
                payment_settings: {
                  save_default_payment_method: "on_subscription",
                },
                metadata: { ...metadata, orderRef: attempt.orderRef },
                expand: [
                  "latest_invoice.confirmation_secret",
                  "latest_invoice.payments",
                ],
              },
              { idempotencyKey: attempt.idempotencyKey },
            ),
          (created) =>
            created.status === "canceled" || created.status === "incomplete_expired",
        );

        const invoice = subscription.latest_invoice;
        if (invoice === null || typeof invoice === "string") {
          // Only reachable if the `expand` above is edited away — which is
          // precisely the edit that would otherwise surface as "clientSecret is
          // undefined" three files later, in the browser.
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Stripe returned a subscription with no expanded invoice.",
          });
        }

        // Read back off the subscription rather than recomputed, because
        // `throughAttempt` may have fallen through to its retry seed and the
        // two references must not disagree.
        const orderRef = subscription.metadata["orderRef"] ?? "";
        const clientSecret = invoice.confirmation_secret?.client_secret ?? null;

        if (clientSecret === null) {
          return { status: "no_payment_due", intentKind: "subscription", orderRef };
        }

        // A Subscription's metadata does NOT propagate to the PaymentIntent its
        // invoice creates — the same Stripe behaviour `withTenantMetadata`
        // exists to work around for Checkout Sessions. Without this write the
        // ledger sees `payment_intent.succeeded` carrying no tenant at all, and
        // the sale cannot be attributed to anyone.
        const paymentIntentId = paymentIntentIdFromInvoice(invoice);
        if (paymentIntentId !== null) {
          await client.stripe.paymentIntents.update(paymentIntentId, {
            metadata: {
              ...metadata,
              orderRef,
              subscriptionId: subscription.id,
              invoiceId: invoice.id ?? "",
            },
          });
        }

        return {
          status: "requires_payment",
          clientSecret,
          intentKind: "subscription",
          orderRef,
          amountMinor,
          currency: row.currency,
        };
      }

      const intent = await throughAttempt(
        attemptParts,
        (attempt) =>
          client.stripe.paymentIntents.create(
            {
              // FROM THE DATABASE ROW. The client sent a variant id and a
              // quantity; if it could send this number, the catalog's prices
              // would be advisory.
              amount: Number(amountMinor),
              currency: row.currency,
              // Lets the Payment Element offer every method enabled in the
              // Stripe dashboard — cards, wallets, bank debits — without this
              // file enumerating them and going stale.
              automatic_payment_methods: { enabled: true },
              description: `${row.productName} — ${row.variantName} x${input.quantity}`,
              ...(ctx.principal.email === null
                ? {}
                : { receipt_email: ctx.principal.email }),
              metadata: { ...metadata, orderRef: attempt.orderRef },
            },
            { idempotencyKey: attempt.idempotencyKey },
          ),
        isSpentIntent,
      );

      if (intent.client_secret === null) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Stripe returned a PaymentIntent with no client secret.",
        });
      }

      return {
        status: "requires_payment",
        clientSecret: intent.client_secret,
        intentKind: "payment",
        orderRef: intent.metadata["orderRef"] ?? "",
        amountMinor,
        currency: row.currency,
      };
    }),

  /**
   * Complete a purchase with no Stripe account, on the SAME code path a real
   * payment takes.
   *
   * WHY THIS EXISTS. A shop that cannot be bought from cannot be tested. Until
   * the Stripe keys arrive, every screen after "Pay" is theory: no order row,
   * no entitlement, no receipt, no success page — so the whole second half of
   * the product is written blind and integrated on the day money starts moving.
   * This closes the loop early by calling `fulfilPurchase`, which is the exact
   * function `payment_intent.succeeded` calls. The day the keys land, the only
   * thing that changes is who calls it.
   *
   * FOUR PROPERTIES MAKE IT SAFE, and it is not safe without all four.
   *
   *  1. IT RUNS ONLY WHERE IT CAN PROVE IT IS MEANT TO. One call, to the one
   *     predicate: `checkoutMode()`. Not "is Stripe missing", not "is this not
   *     production" — those are NEGATIVE gates, and this procedure is the
   *     standing proof of what a negative gate costs. It used to read
   *     `!stripe && resolveAppEnv() !== "production"`, which grants the
   *     capability unless it can name a reason not to; `resolveAppEnv()` read
   *     `VERCEL_ENV` and nothing else, a self-hosted production shop was
   *     therefore not "production" by that reading, no exclusion fired, and a
   *     verifier minted a licence key against a £29 product for free on a real
   *     host. `checkoutMode()` inverts it: `simulated` is granted by two named
   *     cases — a positively identified local environment, or a staging
   *     deployment carrying `ALLOW_SIMULATED_CHECKOUT=true` — and everything
   *     else, including an environment nobody labelled and any value added to
   *     `AppEnv` in future, falls through to a refusal without anyone having
   *     had to think of it. It still flips by itself the moment the Stripe keys
   *     are pasted in, because "is Stripe configured" is the first thing that
   *     predicate asks.
   *  2. IT NEVER TOUCHES STRIPE. No customer, no PaymentIntent, no
   *     subscription. `fulfilPurchase` does not import Stripe at all.
   *  3. IT GOES THROUGH THE SAME ELIGIBILITY GATE AS `createIntent` — the same
   *     `purchasableOrThrow` call, so a simulated purchase cannot grant
   *     something a real one would refuse. Not a copy of the checks: the same
   *     function.
   *  4. IT IS IDEMPOTENT AND LOUD. Fulfilment is keyed on the reference by a
   *     unique index, and every call writes a `commerce.order.simulated` audit
   *     row — flagged sensitive, so it lands in the compliance slice rather
   *     than the firehose — plus a `logger.warn` naming who bought what and
   *     which environment allowed it. An order granted without payment must be
   *     identifiable forever after.
   *
   * WHY IT IS `publicProcedure` WHEN `createIntent` IS NOT. The one decision
   * here that looks like a weakening, and is not.
   *
   * A real payment is always attributable, because Stripe will not take money
   * without a customer and this project will not make one without a session. A
   * deployment with no Clerk keys has no sessions at all: nobody can sign in,
   * `currentPrincipal()` returns null for every request by construction, and a
   * `protectedProcedure` therefore refuses everybody. That is what made the
   * simulated path unreachable on the exact configuration it exists for — a
   * fresh project with a database and nothing else — and "sign in first" is not
   * advice anybody can act on when there is nowhere to sign in.
   *
   * So attribution is required WHEREVER IT IS POSSIBLE, and only there. With
   * Clerk configured this still refuses an anonymous caller, exactly as before.
   * Without it the order is booked with `user_id = NULL`, which is not a
   * degraded state invented here: `orders.user_id` is nullable by design so
   * that a guest purchase is a first-class record, and every reader of that
   * table already handles one. The moment the Clerk keys are pasted in the
   * requirement comes back by itself, with nothing to remember and nothing to
   * remove.
   *
   * The rung change also moves this onto the anonymous, IP-keyed rate-limit
   * budget instead of the per-user one, which is the right budget for a
   * mutation an unauthenticated caller can reach.
   */
  simulate: publicProcedure
    .meta({ scope: "public" })
    .input(
      z.object({
        variantId: z.string().min(1),
        quantity: z.number().int().min(1).max(MAX_QUANTITY),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Property 1, and it is the FIRST statement in the procedure. Before the
      // eligibility read, because a deployment with no database would otherwise
      // answer "cannot connect" here — which reads as an outage and sends
      // somebody looking for the wrong fault entirely.
      //
      // The refusal carries the predicate's own `reason`, so the sentence the
      // API returns is the same sentence the checkout page and the storefront
      // notice are rendering from. There is no second copy to keep in step.
      const mode = checkoutMode();
      if (mode.kind !== "simulated") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Simulated purchases are not available here. ${mode.reason}`,
        });
      }

      // For the log line and the audit row only — never for the decision, which
      // was made above. Both are recorded because "which environment allowed
      // this" is the first question asked of a free grant after the fact, and
      // `origin` is the half that says whether anybody had declared it.
      const { appEnv, origin } = describeAppEnv();

      // Attribution wherever it is possible, and nowhere it is not. With Clerk
      // configured this is the same refusal `protectedProcedure` used to make;
      // without it there is no account for an order to belong to.
      const buyerId = ctx.principal?.userId ?? null;
      if (buyerId === null && isSignInConfigured()) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message:
            "Sign in first. This deployment can identify people, so an order " +
            "recorded on it has to belong to somebody.",
        });
      }

      // Property 4. The same call `createIntent` makes, three procedures up.
      const variant = await purchasableOrThrow(input.variantId, input.quantity);

      const reference = simulatedReference();

      // Property 5, first half. Logged BEFORE the write as well as after, so a
      // fulfilment that throws halfway still leaves a record that somebody
      // tried — the pre-write line is the only evidence a crashed grant ever
      // happened. A guest purchase logs `userId: null` rather than omitting the
      // field, so the line still reads as an answer instead of a gap.
      logger.warn(
        {
          reference,
          appEnv,
          appEnvOrigin: origin,
          userId: buyerId,
          tenantId: variant.tenantId,
          variantId: variant.variantId,
          productSlug: variant.productSlug,
          quantity: input.quantity,
          amountMinor: (variant.priceMinor * BigInt(input.quantity)).toString(),
          currency: variant.currency,
        },
        "SIMULATED PURCHASE — no money collected, no Stripe call made",
      );

      const result = await fulfilPurchase({
        variantId: variant.variantId,
        quantity: input.quantity,
        userId: buyerId,
        // From the product row, never from the request. The storefront's tenant
        // is whose catalog this is, and letting a client name it would let one
        // customer book an order into another's ledger.
        tenantId: variant.tenantId,
        reference,
        source: "simulated",
      });

      logger.warn(
        {
          reference,
          orderId: result.orderId,
          orderNumber: result.orderNumber,
          grants: result.grants.map((grant) => grant.kind),
        },
        "SIMULATED PURCHASE — order booked and grants applied",
      );

      // The reference, not the order id. `/checkout/success` reads an order by
      // reference for BOTH paths — that one reader is the proof the paths
      // converged — and the id is not a handle anything else accepts.
      return { reference, orderNumber: result.orderNumber };
    }),
});
