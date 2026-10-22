/**
 * CONVERSIONS (create-app 0.39): which pages bring the people who sign up and
 * the people who pay. With --analytics, a sign-up and a first payment each
 * mark the visitor's visit converted (@adminigloo/analytics'
 * `recordConversion`), so the site's numbers at /admin/analytics show which
 * landing pages and sources those visits came from. Without it, every hook
 * below is a no-op and the sign-up goes straight where it was going.
 *
 *   src/conversions.ts                 where a new sign-up lands first: via
 *                                      /welcome (which records "Signed up"),
 *                                      or straight to where they were going;
 *                                      and what counts as each conversion
 *   src/server/conversions.ts          recordConversion, recordSignUp and
 *                                      recordFirstPayment
 *   app/welcome/route.ts               (analytics) records "Signed up", then
 *                                      307s to where the person was going
 *
 * The first payment is recorded when Stripe's checkout sends the person back
 * (app/(site)/account/billing/return/route.ts, the account overlay's): a real
 * browser visit, which a webhook is not — and only once Stripe's own Checkout
 * Session says it was paid.
 *
 * ONCE PER PERSON (review): a sign-up only for an account made in the last
 * few minutes, a first payment only for a checkout Stripe says was paid (a
 * free trial pays nothing) on an account that never paid before — and each
 * under a key analytics records at most once (`once`), so a refresh, a
 * back-button or a bookmarked return link never counts again.
 */
import { personEmails, type Answers } from "./answers.js";

// ---------------------------------------------------------------------------
// src/conversions.ts
// ---------------------------------------------------------------------------

export function renderConversionPaths(answers: Answers): string {
  if (!answers.includeAnalytics && personEmails(answers)) {
    return `/**
 * Where a person lands straight after signing up (create-app 0.40): through
 * /welcome (app/welcome/route.ts), which keeps the emails they ticked beside
 * the sign-up form and their browser's time zone, then sends them on to
 * where they were going. GENERATED in variants; with --analytics /welcome
 * also marks their visit "Signed up".
 */
export function afterSignUpPath(next: string): string {
  return \`/welcome?next=\${encodeURIComponent(next)}\`;
}
`;
  }
  if (!answers.includeAnalytics) {
    return `/**
 * Where a person lands straight after signing up (create-app 0.39): where
 * they were going. GENERATED in two variants; with --analytics they pass
 * through /welcome first, which marks their visit "Signed up".
 */
export function afterSignUpPath(next: string): string {
  return next;
}
`;
  }
  const money = answers.businessModel !== "none";
  return `/**
 * Where a person lands straight after signing up (create-app 0.39): through
 * /welcome (app/welcome/route.ts), which marks their visit "Signed up" for the
 * site's numbers, then sends them on to where they were going. GENERATED in
 * two variants; without --analytics it is where they were going.
 */
export function afterSignUpPath(next: string): string {
  return \`/welcome?next=\${encodeURIComponent(next)}\`;
}

/**
 * WHAT COUNTS AS EACH CONVERSION (review), decided here — pure, so
 * src/__tests__/conversions.test.ts holds them — and recorded by
 * src/server/conversions.ts.
 */

/** How long after an account is made its first page still counts as the sign-up. */
export const SIGN_UP_WINDOW_MS = 10 * 60 * 1000;

/**
 * Is this account new enough that landing on /welcome is its sign-up? Made in
 * the last few minutes (a minute's grace for the database's clock and this
 * server's to differ): anyone else reaching /welcome — a returning person, a
 * link someone kept — is not signing up.
 */
export function isNewSignUp(accountCreatedAt: Date, now: Date = new Date()): boolean {
  const age = now.getTime() - accountCreatedAt.getTime();
  return age >= -60_000 && age <= SIGN_UP_WINDOW_MS;
}
${money ? `
/** The parts of a Stripe Checkout Session a first payment is judged on. */
export interface CheckoutFacts {
  readonly mode: string;
  readonly status: string | null;
  readonly payment_status: string;
  readonly amount_total: number | null;
  /** Epoch seconds, as Stripe sends it. */
  readonly created: number;
  readonly metadata: Readonly<Record<string, string>> | null;
}

/** How long a checkout's return link still counts: a day. */
export const FIRST_PAYMENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Did this checkout really take a payment, for this account, lately? Stripe's
 * own answer, never "they came back": complete, paid, more than nothing — a
 * free trial is \`no_payment_required\` and pays nothing, so it isn't a payment —
 * for the account it was made for, in the last day.
 */
export function paidCheckoutFor(session: CheckoutFacts, tenantId: string, now: Date = new Date()): boolean {
  return (
    session.mode === "subscription" &&
    session.status === "complete" &&
    session.payment_status === "paid" &&
    (session.amount_total ?? 0) > 0 &&
    session.metadata?.["tenantId"] === tenantId &&
    now.getTime() - session.created * 1000 <= FIRST_PAYMENT_WINDOW_MS
  );
}
` : ""}`;
}

// ---------------------------------------------------------------------------
// src/server/conversions.ts
// ---------------------------------------------------------------------------

export function renderServerConversions(answers: Answers): string {
  const scope = answers.scope;
  const money = answers.businessModel !== "none";
  if (!answers.includeAnalytics) {
    return `/**
 * CONVERSIONS (create-app 0.39) — off: this project was generated without
 * --analytics, so there are no visits to mark. GENERATED in two variants;
 * with analytics, a sign-up and a first payment each mark the visitor's visit
 * converted, and /admin/analytics shows which pages they came from.
 */

/** A sign-up, a first payment, …: nothing to record without analytics. */
export async function recordConversion(_name: string, _input: { readonly userId: string | null; readonly once?: string }): Promise<void> {}

/** A new account's sign-up: nothing to record without analytics. */
export async function recordSignUp(_userId: string): Promise<void> {}

/** A person's first payment: nothing to record without analytics. */
export async function recordFirstPayment(_userId: string, _checkoutSessionId: string | null): Promise<void> {}
`;
  }
  const firstPayment = money
    ? `
/** A Checkout Session id, as Stripe makes them: nothing else is sent to Stripe. */
const CHECKOUT_SESSION_ID = /^cs_(?:test|live)_[A-Za-z0-9]{8,200}$/;

/**
 * A person back from Stripe's checkout: their FIRST payment (review), counted
 * once. Stripe's own Checkout Session decides it was paid — never the fact of
 * coming back, which a free trial, a refresh or a pasted link also are — for
 * their own account, which never paid for a plan before.
 */
export async function recordFirstPayment(userId: string, checkoutSessionId: string | null): Promise<void> {
  try {
    if (!stripe || checkoutSessionId === null || !CHECKOUT_SESSION_ID.test(checkoutSessionId)) return;
    const tenant = await currentTenantFor(userId);
    if (tenant === null) return;
    const session = await stripe.stripe.checkout.sessions.retrieve(checkoutSessionId);
    if (!paidCheckoutFor(session, tenant.id)) return;
    const paidFor = typeof session.subscription === "string" ? session.subscription : (session.subscription?.id ?? null);
    // An earlier plan this account PAID for (one that reached active or past
    // due, or was cancelled after its trial): this is a later purchase, not a
    // first payment.
    const [earlier] = await db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.tenantId, tenant.id),
          isNotNull(subscriptions.stripeSubscriptionId),
          ...(paidFor === null ? [] : [ne(subscriptions.stripeSubscriptionId, paidFor)]),
          or(
            inArray(subscriptions.status, ["active", "past_due", "unpaid"]),
            and(eq(subscriptions.status, "canceled"), or(isNull(subscriptions.trialEndsAt), gt(subscriptions.canceledAt, subscriptions.trialEndsAt))),
          ),
        ),
      )
      .limit(1);
    if (earlier !== undefined) return;
    await recordConversion("First payment", { userId, once: \`first-payment:\${userId}\` });
  } catch (error) {
    reportWebsiteError(error, { tenantId: null, route: "conversion:first-payment" });
  }
}
`
    : `
/** A first payment: this project takes no money. */
export async function recordFirstPayment(_userId: string, _checkoutSessionId: string | null): Promise<void> {}
`;
  return `import { headers } from "next/headers";
import { ${money ? "and, eq, gt, inArray, isNotNull, isNull, ne, or" : "eq"} } from "drizzle-orm";
import { users } from "${scope}/auth/schema";${money ? `
import { subscriptions } from "${scope}/billing/schema";` : ""}
import { clientIpFromHeaders } from "${scope}/observability/request";
import { isNewSignUp${money ? ", paidCheckoutFor" : ""} } from "@/conversions";
import { db } from "@/db";${money ? `
import { stripe } from "@/server/stripe";
import { currentTenantFor } from "@/server/tenant";` : ""}
import { analytics, reportWebsiteError, SITE_ANALYTICS } from "@/server/website";

/**
 * CONVERSIONS (create-app 0.39): mark the visitor's live visit converted —
 * "Signed up", "First payment" — from the request where it happened, so this
 * site's numbers (/admin/analytics) show which pages and sources bring the
 * people who sign up and the people who pay. Only for a request with a live,
 * counted visit (the beacon ran, no Do Not Track or Global Privacy Control,
 * not a crawler); the site's own people stay out (the audience is asked).
 * What counts as each one is decided in src/conversions.ts.
 *
 * Never throws and never blocks the page it's on: a conversion that can't be
 * recorded is reported and dropped.
 */
export async function recordConversion(
  name: string,
  input: { readonly userId: string | null; readonly path?: string; readonly once?: string },
): Promise<void> {
  try {
    const request = await headers();
    await analytics.recordConversion({
      tenantId: SITE_ANALYTICS,
      ip: clientIpFromHeaders(request),
      userAgent: request.get("user-agent"),
      headers: request,
      name,
      userId: input.userId,
      ...(input.path === undefined ? {} : { path: input.path }),
      // At most once under this key, however many times the page is reached.
      ...(input.once === undefined ? {} : { once: input.once }),
    });
  } catch (error) {
    reportWebsiteError(error, { tenantId: null, route: \`conversion:\${name}\` });
  }
}

/**
 * A NEW account's sign-up (review: /welcome counted every visit, signed in or
 * not): only for an account made in the last few minutes, and once.
 */
export async function recordSignUp(userId: string): Promise<void> {
  try {
    const [account] = await db.select({ createdAt: users.createdAt }).from(users).where(eq(users.id, userId)).limit(1);
    if (account === undefined || !isNewSignUp(account.createdAt)) return;
    await recordConversion("Signed up", { userId, once: \`signed-up:\${userId}\` });
  } catch (error) {
    reportWebsiteError(error, { tenantId: null, route: "conversion:signed-up" });
  }
}
${firstPayment}`;
}

// ---------------------------------------------------------------------------
// app/welcome/route.ts (with --analytics)
// ---------------------------------------------------------------------------

export function renderWelcomeRoute(answers: Answers): string {
  const counted = answers.includeAnalytics;
  const emails = personEmails(answers);
  const imports = [
    `import { NextResponse, type NextRequest } from "next/server";`,
    `import { safeReturnPath } from "@/redirect";`,
    `import { currentPrincipal } from "@/server/auth";`,
    ...(counted ? [`import { recordSignUp } from "@/server/conversions";`] : []),
    ...(emails ? [`import { applySignUpEmailChoice, SIGN_UP_EMAIL_COOKIE } from "@/server/digest";`] : []),
    `import { AFTER_AUTH_PATH } from "@/tenancy";`,
  ];
  const what = [
    ...(counted
      ? [`their visit is marked
 * "Signed up" (src/server/conversions.ts) — only when the account was made
 * moments ago, and only once`]
      : []),
    ...(emails
      ? [`the emails they ticked beside the sign-up form and
 * their browser's time zone are kept (src/server/digest.ts; the cookie the
 * form wrote is read once and deleted)`]
      : []),
  ].join(`, and
 * `);
  return `${imports.join("\n")}

/**
 * WHERE A NEW SIGN-UP LANDS FIRST (create-app ${emails ? "0.40" : "0.39"}): ${what} — then they go where
 * they were going: a real 307, so nothing renders here and nothing is
 * indexed. The sign-up page sends people here (src/conversions.ts); a
 * returning sign-in never does, and reaching it any other way counts nothing.
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const next = safeReturnPath(req.nextUrl.searchParams.get("next") ?? undefined) ?? AFTER_AUTH_PATH;
  const principal = await currentPrincipal().catch(() => null);${counted ? `
  if (principal) await recordSignUp(principal.userId);` : ""}${emails ? `
  if (principal) await applySignUpEmailChoice(principal.userId, req.cookies.get(SIGN_UP_EMAIL_COOKIE)?.value);` : ""}
  const response = NextResponse.redirect(new URL(next, req.url), 307);${emails ? `
  // Read once: the choice belongs to this sign-up, never the next one on this browser.
  if (principal) response.cookies.delete(SIGN_UP_EMAIL_COOKIE);` : ""}
  return response;
}
`;
}

// ---------------------------------------------------------------------------
// src/__tests__/conversions.test.ts (with --analytics)
// ---------------------------------------------------------------------------

export function renderConversionsTest(answers: Answers): string {
  const money = answers.businessModel !== "none";
  return `import { describe, expect, it } from "vitest";
import { ${money ? "FIRST_PAYMENT_WINDOW_MS, isNewSignUp, paidCheckoutFor, SIGN_UP_WINDOW_MS" : "isNewSignUp, SIGN_UP_WINDOW_MS"} } from "@/conversions";

/**
 * WHAT COUNTS AS A CONVERSION (create-app 0.39, review): /welcome used to
 * count every visit, and a return from Stripe's checkout counted a free trial
 * — and anyone who had never paid — as a first payment.
 */
const NOW = new Date("2026-10-21T12:00:00Z");

describe("a sign-up", () => {
  it("is an account made moments ago", () => {
    expect(isNewSignUp(new Date(NOW.getTime() - 5_000), NOW)).toBe(true);
    expect(isNewSignUp(new Date(NOW.getTime() - SIGN_UP_WINDOW_MS), NOW)).toBe(true);
  });

  it("NEGATIVE CONTROL: never an account from yesterday, or one past the window", () => {
    expect(isNewSignUp(new Date(NOW.getTime() - 24 * 60 * 60 * 1000), NOW)).toBe(false);
    expect(isNewSignUp(new Date(NOW.getTime() - SIGN_UP_WINDOW_MS - 1), NOW)).toBe(false);
  });
});
${money ? `
describe("a first payment", () => {
  const paid = {
    mode: "subscription",
    status: "complete",
    payment_status: "paid",
    amount_total: 500,
    created: Math.floor(NOW.getTime() / 1000) - 30,
    metadata: { tenantId: "ws_a" },
  };

  it("is a checkout Stripe says was paid, for this account, today", () => {
    expect(paidCheckoutFor(paid, "ws_a", NOW)).toBe(true);
  });

  it("NEGATIVE CONTROLS: a free trial, an unfinished checkout, nothing charged, someone else's, or an old link", () => {
    expect(paidCheckoutFor({ ...paid, payment_status: "no_payment_required", amount_total: 0 }, "ws_a", NOW)).toBe(false);
    expect(paidCheckoutFor({ ...paid, status: "open", payment_status: "unpaid" }, "ws_a", NOW)).toBe(false);
    expect(paidCheckoutFor({ ...paid, amount_total: 0 }, "ws_a", NOW)).toBe(false);
    expect(paidCheckoutFor(paid, "ws_b", NOW)).toBe(false);
    expect(paidCheckoutFor({ ...paid, created: Math.floor((NOW.getTime() - FIRST_PAYMENT_WINDOW_MS) / 1000) - 60 }, "ws_a", NOW)).toBe(false);
    expect(paidCheckoutFor({ ...paid, mode: "payment" }, "ws_a", NOW)).toBe(false);
  });
});
` : ""}`;
}
