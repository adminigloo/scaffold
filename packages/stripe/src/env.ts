import { prefixedSecret } from "@adminigloo/env";

/** Stripe server credentials. */
export function stripeServer() {
  return {
    STRIPE_SECRET_KEY: prefixedSecret("sk_"),
    STRIPE_WEBHOOK_SECRET: prefixedSecret("whsec_"),
  };
}

/** Stripe browser credentials. */
export function stripeClient() {
  return {
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: prefixedSecret("pk_"),
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
