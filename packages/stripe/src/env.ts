import { prefixedSecret } from "@adminigloo/env";
import { z } from "zod";

/**
 * The two kinds of key that can be STRIPE_SECRET_KEY: a standard secret key
 * (`sk_…`) or a restricted key (`rk_…`).
 *
 * stripe 0.7.1: restricted keys are accepted. Stripe recommends them for a live
 * account, because a restricted key can be cut down so that a leaked one can't
 * move money out. 0.7.0 took `sk_` only, and a real restricted key stopped
 * Hinderstap's production build (2026-11-12, its commit c988bd6); Almanac hit
 * the same wall in October. Both patched their own env.ts around this package.
 *
 * The mode check is unchanged: `detectKeyMode` reads the `_live_` / `_test_`
 * marker whatever the prefix, so an `rk_live_…` key still cannot run outside
 * production. And the logger already redacts `rk_` keys
 * (@adminigloo/observability's CREDENTIAL_PATTERNS).
 */
const STRIPE_SECRET_KEY_PREFIXES = ["sk_", "rk_"] as const;

function stripeSecretKey() {
  return z
    .string()
    .min(11, { message: "is too short to be a valid Stripe secret key" })
    .refine((v) => STRIPE_SECRET_KEY_PREFIXES.some((prefix) => v.startsWith(prefix)), {
      message: 'must start with "sk_" (a secret key) or "rk_" (a restricted key)',
    });
}

/** Stripe server credentials. */
export function stripeServer() {
  return {
    // Optional EVERYWHERE, including on a deployment.
    //
    // A project ships before it charges anyone. Requiring these on deploy means
    // you cannot put the thing online until you have finished a Stripe
    // onboarding — and the simulated-purchase path exists precisely so the
    // checkout flow works, and is demonstrable, before that. The moment a key
    // IS present the mode assertion applies to it in full: a live key still
    // cannot run outside production.
    STRIPE_SECRET_KEY: stripeSecretKey().optional(),
    STRIPE_WEBHOOK_SECRET: prefixedSecret("whsec_").optional(),
  };
}

/** Stripe browser credentials. */
export function stripeClient() {
  return {
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: prefixedSecret("pk_").optional(),
  };
}

/**
 * The Stripe keys whose `_test_` / `_live_` marker must match the deployment.
 *
 * STRIPE_WEBHOOK_SECRET is NOT listed, and its absence is deliberate. A
 * `whsec_…` carries no mode marker at all, so `assertKeyMode` would find
 * neither substring and throw `KeyModeIndeterminateError` on every boot of
 * every environment. Registering it would not add a guarantee, it would break
 * the app.
 *
 * The gap it leaves — a test-mode endpoint secret in production — is closed at
 * the other end, by `assertEventLivemode` on each delivered event.
 */
export const STRIPE_MODE_BOUND_KEYS = [
  "STRIPE_SECRET_KEY",
  "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
] as const;

/**
 * stripe 0.4: a companies site whose companies take card payments from their
 * own customers (Stripe Connect). Both optional: without the secret no
 * company can connect (the payments screen says why), and without the fee the
 * site takes no cut.
 *
 *   STRIPE_CONNECT_WEBHOOK_SECRET  the `whsec_…` of the Connect endpoint (an
 *                                  endpoint that listens to CONNECTED accounts)
 *   PLATFORM_FEE_BPS               this site's cut of each payment, in basis
 *                                  points: 0 (default) none, 250 = 2.5%
 */
export function stripeConnectServer() {
  return {
    STRIPE_CONNECT_WEBHOOK_SECRET: prefixedSecret("whsec_").optional(),
    PLATFORM_FEE_BPS: z.coerce.number().int().min(0).max(10_000).default(0),
  };
}

/**
 * stripe 0.4: a single business taking card payments on invoices with its own
 * Stripe account (no Connect). The endpoint is separate from the store's, so
 * its secret is too.
 */
export function stripeInvoicePaymentsServer() {
  return {
    STRIPE_INVOICE_WEBHOOK_SECRET: prefixedSecret("whsec_").optional(),
  };
}
