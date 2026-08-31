import { prefixedSecret } from "@adminigloo/env";

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
    STRIPE_SECRET_KEY: prefixedSecret("sk_").optional(),
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
