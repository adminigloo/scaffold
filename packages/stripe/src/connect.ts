import { and, count, eq, isNull, lt, or } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type Stripe from "stripe";
import { withTenantMetadata } from "./checkout.js";
import type { StripeClient } from "./client.js";
import { stripeConnectedAccounts } from "./schema.js";

/**
 * STRIPE CONNECT FOR COMPANIES (stripe 0.4, getting paid part 1).
 *
 * Each company connects ITS OWN Stripe account and its customers pay it
 * directly. The account is Standard-style, set through the Accounts API's
 * controller settings:
 *
 *   stripe_dashboard: full      the company signs in to its own Stripe dashboard
 *   fees.payer: account         the company pays its own Stripe fees
 *   losses.payments: stripe     Stripe, not this site, carries refunds and
 *                               disputes the company can't cover
 *   requirement_collection: stripe   Stripe asks the company for its details
 *
 * Charges are DIRECT charges on the company's account (`stripeAccount` on
 * every call): the money, the customer's receipt and the payout are the
 * company's. This site's optional cut is `application_fee_amount`, from
 * PLATFORM_FEE_BPS (default 0: no cut), shown to the owner before connecting.
 *
 * The platform's own account still bills companies for their plans, through
 * the rest of this package. The two never mix: plan events arrive at the
 * platform webhook, a company's payments at the Connect webhook with its own
 * secret (STRIPE_CONNECT_WEBHOOK_SECRET).
 */

export type StripeDb = PgDatabase<any, any, any>;
export type ConnectedAccountRow = typeof stripeConnectedAccounts.$inferSelect;

// --- The fee ------------------------------------------------------------------

/** The most this site may take: 10_000 basis points = 100%. */
export const MAX_PLATFORM_FEE_BPS = 10_000;

/**
 * This site's cut of a payment, in the payment's minor units (cents).
 *
 * ROUNDED DOWN to the whole cent: the fee is never more than the stated rate,
 * so a 2.5% fee on $10.01 is 25¢ (25.025¢ rounded down), never 26¢. Integer
 * arithmetic throughout: `amount × bps` is exact for any invoice this package
 * accepts (both are integers well under 2^53 / 10_000), and the one division
 * is floored. 0 bps is no fee at all.
 */
export function platformFeeMinor(amountMinor: number, feeBps: number): number {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new RangeError(`platformFeeMinor: the amount must be a whole number of cents, got ${amountMinor}`);
  }
  assertFeeBps(feeBps);
  if (feeBps === 0 || amountMinor === 0) return 0;
  return Math.floor((amountMinor * feeBps) / 10_000);
}

function assertFeeBps(feeBps: number): void {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > MAX_PLATFORM_FEE_BPS) {
    throw new RangeError(`PLATFORM_FEE_BPS must be a whole number from 0 to ${MAX_PLATFORM_FEE_BPS}, got ${feeBps}`);
  }
}

/** "No fee", or "2.5% of each payment (25¢ on $10.00)" — what the owner reads before connecting. */
export function describePlatformFee(feeBps: number, format: (minor: number) => string = (m) => `$${(m / 100).toFixed(2)}`): string {
  assertFeeBps(feeBps);
  if (feeBps === 0) return "No fee: every cent your customers pay goes to your Stripe account (Stripe's own card fees aside).";
  const percent = (feeBps / 100).toString();
  return `${percent}% of each payment goes to this site (${format(platformFeeMinor(10_000, feeBps))} on ${format(10_000)}), on top of Stripe's own card fees. This site's fee is not returned on refunds.`;
}

// --- The company's account ----------------------------------------------------

/** The Accounts API parameters for a company's own, Standard-style account. */
export function companyAccountParams(tenantId: string, input: { email?: string | null; country?: string | null } = {}): Stripe.AccountCreateParams {
  return {
    controller: {
      stripe_dashboard: { type: "full" },
      fees: { payer: "account" },
      losses: { payments: "stripe" },
      requirement_collection: "stripe",
    },
    ...(input.email ? { email: input.email } : {}),
    ...(input.country ? { country: input.country } : {}),
    metadata: { tenantId },
  };
}

/** The company's connected account, or null. A disconnected one is still returned (its refunds still arrive). */
export async function connectedAccountFor(db: StripeDb, tenantId: string): Promise<ConnectedAccountRow | null> {
  // The ACTIVE account: one disconnected here is still returned (Connect reuses
  // it); one the company deauthorized in Stripe is history, never returned.
  const [row] = await db
    .select()
    .from(stripeConnectedAccounts)
    .where(and(eq(stripeConnectedAccounts.tenantId, tenantId), isNull(stripeConnectedAccounts.deauthorizedAt)))
    .limit(1);
  return (row as ConnectedAccountRow | undefined) ?? null;
}

/** The name the owner knows the account by: its business name, else its email. */
export function accountDisplayName(account: Partial<Pick<Stripe.Account, "business_profile" | "settings" | "email">>): string | null {
  return account.business_profile?.name || account.settings?.dashboard?.display_name || account.email || null;
}

/** May this company's customers pay by card right now? Connected, not disconnected, and Stripe says charges are on. */
export function accountTakesCharges(row: Pick<ConnectedAccountRow, "chargesEnabled" | "disconnectedAt"> | null): boolean {
  return row !== null && row.disconnectedAt === null && row.chargesEnabled;
}

export interface StartOnboardingInput {
  readonly tenantId: string;
  /** Absolute: where Stripe sends the owner when they finish (…/app/payments?connected=1). */
  readonly returnUrl: string;
  /** Absolute: where Stripe sends the owner when the link expired (…/app/payments). */
  readonly refreshUrl: string;
  readonly email?: string | null;
  readonly country?: string | null;
}

/**
 * The owner pressed "Connect Stripe": make the company's ONE account if it has
 * none, and hand back a one-time onboarding link. A company that connected
 * before (or disconnected) gets its same account back — never a second one.
 *
 * The account create carries an idempotency key on the company, so two clicks
 * racing before the row exists ask Stripe for the same account twice and get
 * the same answer; the row's primary key then lets exactly one insert land.
 */
export async function startConnectOnboarding(db: StripeDb, client: StripeClient, input: StartOnboardingInput): Promise<{ url: string; accountId: string }> {
  let row = await connectedAccountFor(db, input.tenantId);
  if (!row) {
    // Keyed on the company AND how many accounts it had: two racing clicks get
    // the same account, a company that deauthorized its old one gets a new one.
    const [had] = (await db
      .select({ n: count() })
      .from(stripeConnectedAccounts)
      .where(eq(stripeConnectedAccounts.tenantId, input.tenantId))) as Array<{ n: number }>;
    const account = await client.stripe.accounts.create(companyAccountParams(input.tenantId, { email: input.email, country: input.country ?? "US" }), {
      idempotencyKey: `connect-account:${input.tenantId}:${Number(had?.n ?? 0)}`,
    });
    await db
      .insert(stripeConnectedAccounts)
      .values({
        tenantId: input.tenantId,
        accountId: account.id,
        displayName: accountDisplayName(account),
        chargesEnabled: account.charges_enabled === true,
        payoutsEnabled: account.payouts_enabled === true,
        detailsSubmitted: account.details_submitted === true,
      })
      .onConflictDoNothing();
    row = await connectedAccountFor(db, input.tenantId);
    if (!row) throw new Error("startConnectOnboarding: the company's account row was not written");
  } else if (row.disconnectedAt !== null) {
    await db
      .update(stripeConnectedAccounts)
      .set({ disconnectedAt: null, updatedAt: new Date() })
      .where(eq(stripeConnectedAccounts.id, row.id));
  }
  const link = await client.stripe.accountLinks.create({
    account: row.accountId,
    type: "account_onboarding",
    return_url: input.returnUrl,
    refresh_url: input.refreshUrl,
  });
  return { url: link.url, accountId: row.accountId };
}

/**
 * Copy Stripe's flags onto the company's row, from `account.updated` or a
 * fresh `accounts.retrieve`. Matched on the ACCOUNT, so it can only ever
 * touch the one company that owns it. Returns that company, or null for an
 * account nobody here connected.
 */
export async function applyAccountUpdate(
  db: StripeDb,
  account: Pick<Stripe.Account, "id" | "charges_enabled" | "payouts_enabled" | "details_submitted"> &
    Partial<Pick<Stripe.Account, "business_profile" | "settings" | "email">>,
  /** When this state was true (an event's `created`): an OLDER update than the one applied changes nothing. */
  observedAt: Date = new Date(),
): Promise<string | null> {
  const name = accountDisplayName(account);
  const rows = (await db
    .update(stripeConnectedAccounts)
    .set({
      chargesEnabled: account.charges_enabled === true,
      payoutsEnabled: account.payouts_enabled === true,
      detailsSubmitted: account.details_submitted === true,
      ...(name ? { displayName: name } : {}),
      accountUpdatedAt: observedAt,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(stripeConnectedAccounts.accountId, account.id),
        or(isNull(stripeConnectedAccounts.accountUpdatedAt), lt(stripeConnectedAccounts.accountUpdatedAt, observedAt)),
      ),
    )
    .returning({ tenantId: stripeConnectedAccounts.tenantId })) as Array<{ tenantId: string }>;
  return rows[0]?.tenantId ?? null;
}

/**
 * The owner pressed "Disconnect": no new card payments for this company.
 * The account is the company's own and stays with it in Stripe; this site only
 * stops charging on it. Refunds and disputes on earlier payments still map
 * back to the company. True when there was an account to disconnect.
 */
export async function disconnectConnectedAccount(db: StripeDb, tenantId: string, now: Date = new Date()): Promise<boolean> {
  const rows = await db
    .update(stripeConnectedAccounts)
    .set({ disconnectedAt: now, updatedAt: now })
    .where(and(eq(stripeConnectedAccounts.tenantId, tenantId), isNull(stripeConnectedAccounts.deauthorizedAt)))
    .returning({ tenantId: stripeConnectedAccounts.tenantId });
  return rows.length > 0;
}

/** The company deauthorized this site from its own Stripe dashboard (`account.application.deauthorized`). */
export async function markAccountDeauthorized(db: StripeDb, accountId: string, now: Date = new Date()): Promise<string | null> {
  const rows = (await db
    .update(stripeConnectedAccounts)
    // History from here: kept so refunds and disputes on it still find the company; Connect makes a new one.
    .set({ disconnectedAt: now, deauthorizedAt: now, chargesEnabled: false, updatedAt: now })
    .where(eq(stripeConnectedAccounts.accountId, accountId))
    .returning({ tenantId: stripeConnectedAccounts.tenantId })) as Array<{ tenantId: string }>;
  return rows[0]?.tenantId ?? null;
}

// --- The Connect webhook ------------------------------------------------------

/**
 * The ledger key for an event delivered to the Connect endpoint: the account
 * AND the event, so one company's event can never be mistaken for, or
 * deduplicated against, another account's.
 */
export function connectLedgerKey(event: Pick<Stripe.Event, "id" | "account">): string {
  if (!event.account) throw new Error(`connectLedgerKey: event ${event.id} names no connected account`);
  return `${event.account}:${event.id}`;
}

export type ConnectEventCompany =
  | { readonly kind: "company"; readonly tenantId: string; readonly accountId: string }
  | { readonly kind: "ignored"; readonly reason: "no-account" | "unknown-account"; readonly accountId: string | null };

/**
 * WHOSE EVENT IS THIS. The answer comes from `event.account` — the account
 * Stripe signed the event for — looked up in the companies' own rows, and
 * from nowhere else. Metadata on the payment is checked against it later,
 * never trusted to choose it.
 *
 * An event for an account nobody here connected is IGNORED: the caller logs
 * it and answers 200, so Stripe doesn't retry something that will never map.
 */
export async function companyForConnectEvent(db: StripeDb, event: Pick<Stripe.Event, "account">): Promise<ConnectEventCompany> {
  const accountId = typeof event.account === "string" && event.account.length > 0 ? event.account : null;
  if (!accountId) return { kind: "ignored", reason: "no-account", accountId: null };
  const [row] = (await db
    .select({ tenantId: stripeConnectedAccounts.tenantId })
    .from(stripeConnectedAccounts)
    .where(eq(stripeConnectedAccounts.accountId, accountId))
    .limit(1)) as Array<{ tenantId: string }>;
  if (!row) return { kind: "ignored", reason: "unknown-account", accountId };
  return { kind: "company", tenantId: row.tenantId, accountId };
}

// --- Direct charges -----------------------------------------------------------

export interface DirectCheckoutInput {
  /** The company the payment is for. Stamped on the Session and the PaymentIntent. */
  readonly tenantId: string;
  /** The company's connected account; null in a single-business site (the site's own account). */
  readonly accountId: string | null;
  /** Minor units, decided by the SERVER (the invoice's balance or deposit). */
  readonly amountMinor: number;
  /** ISO 4217, any case; sent lower-case. */
  readonly currency: string;
  /** What the customer sees on Stripe's page: "Invoice INV-2026-0042 from Green Acres". */
  readonly description: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
  /** This site's cut, in basis points (0 = none). Never sent for a single business (no account to take it from). */
  readonly feeBps?: number;
  /** Carried on the Session AND the PaymentIntent, beside the tenant. */
  readonly metadata?: Readonly<Record<string, string>>;
  readonly customerEmail?: string | null;
  /** Derive from the thing being paid (the checkout row), so a double click is one Session. */
  readonly idempotencyKey: string;
  /** Seconds since the epoch; Stripe's minimum is 30 minutes away. */
  readonly expiresAt?: number;
}

/**
 * A Checkout Session for one fixed amount, charged DIRECTLY on the company's
 * account (`stripeAccount`), with this site's fee as `application_fee_amount`
 * when there is one. The amount is the caller's server-side figure; nothing
 * the browser sent reaches this call.
 */
export async function createDirectCheckoutSession(client: StripeClient, input: DirectCheckoutInput): Promise<Stripe.Checkout.Session> {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 1) {
    throw new RangeError(`createDirectCheckoutSession: the amount must be at least 1 cent, got ${input.amountMinor}`);
  }
  const fee = input.accountId === null ? 0 : platformFeeMinor(input.amountMinor, input.feeBps ?? 0);
  const metadata = { ...input.metadata };
  const params = withTenantMetadata(input.tenantId, {
    mode: "payment",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: input.currency.toLowerCase(),
          unit_amount: input.amountMinor,
          product_data: { name: input.description.slice(0, 250) },
        },
      },
    ],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    metadata,
    payment_intent_data: { metadata, ...(fee > 0 ? { application_fee_amount: fee } : {}) },
    ...(input.customerEmail ? { customer_email: input.customerEmail } : {}),
    ...(input.expiresAt ? { expires_at: input.expiresAt } : {}),
  });
  return client.stripe.checkout.sessions.create(params, {
    idempotencyKey: input.idempotencyKey,
    ...(input.accountId ? { stripeAccount: input.accountId } : {}),
  });
}

/**
 * Close an open Checkout Session (the invoice was voided, or a newer one
 * replaced it). A Session that already completed or expired can't be expired
 * again; that's reported as false, not thrown, because the goal — no open
 * Session — already holds.
 */
export async function expireDirectCheckoutSession(client: StripeClient, input: { accountId: string | null; sessionId: string }): Promise<boolean> {
  try {
    await client.stripe.checkout.sessions.expire(input.sessionId, {}, input.accountId ? { stripeAccount: input.accountId } : undefined);
    return true;
  } catch (error) {
    const code = (error as { code?: unknown; raw?: { code?: unknown } }).code;
    if (code === "checkout_session_not_open" || (error as { statusCode?: unknown }).statusCode === 400) return false;
    throw error;
  }
}
