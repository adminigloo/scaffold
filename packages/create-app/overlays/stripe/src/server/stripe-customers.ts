import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { companyStripeCustomer } from "__SCOPE__/billing/server";
import { resolveStripeCustomer } from "__SCOPE__/stripe";
import { tenants } from "__SCOPE__/tenancy/schema";
import { db } from "@/db";
import type { stripe } from "@/server/stripe";

/**
 * WHO PAYS, AT STRIPE: the Stripe Customer a person's billing belongs to.
 *
 * Read by the plan checkout (src/server/routers/billing.ts), the billing
 * screens (src/server/routers/account.ts) and, in a project with a shop, the
 * shop's checkout — so it lives here, beside the Stripe client, and none of
 * them imports another's router to get it.
 */

/** Metadata key holding our user id on the Stripe Customer. */
export const APP_USER_METADATA_KEY = "appUserId";

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
 * Is this tenant the person's OWN personal workspace — kind `personal`, owned
 * by them? Only then are the person and the tenant one payer, so only then do
 * their shop purchases and their plans share one Stripe customer (review:
 * companies mode).
 */
export async function isOwnPersonalWorkspace(tenantId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ kind: tenants.kind, owner: tenants.ownerUserId })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return row !== undefined && row.kind === "personal" && row.owner === userId;
}

/**
 * The customer a person's own billing screens open: their tenant's (stripe
 * 0.6) or, failing that, the one this checkout made for them. NEVER creates
 * or stamps anything — a portal opened on an empty customer reads as lost
 * billing history. A person's own customer from the shop is looked for as
 * the TENANT's only in their own workspace, never a company's (review).
 */
export async function findBillingCustomerId(
  client: NonNullable<typeof stripe>,
  input: { readonly tenantId: string; readonly userId: string; readonly knownCustomerId: string | null },
): Promise<string | null> {
  const own = await isOwnPersonalWorkspace(input.tenantId, input.userId);
  const viaTenant = await resolveStripeCustomer(client, {
    tenantId: input.tenantId,
    ...(own ? { userId: input.userId } : {}),
    knownCustomerId: input.knownCustomerId ?? (await companyStripeCustomer(db, input.tenantId)),
    email: null,
    create: false,
  });
  return viaTenant ?? (await findStripeCustomerId(client, input.userId));
}
