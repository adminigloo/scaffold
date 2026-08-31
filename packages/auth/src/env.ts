import { prefixedSecret } from "@adminigloo/env";

/** Clerk server credentials. */
export function authServer() {
  return {
    CLERK_SECRET_KEY: prefixedSecret("sk_"),
    // Optional. The webhook keeps the mirrored user row FRESH — renames, email
    // changes, deletions — but `currentPrincipal` creates the row from the
    // session, so a deployment without it still signs people in. Requiring it
    // would block every deploy on registering a webhook endpoint that needs the
    // deployment's URL to exist first, which it does not yet.
    CLERK_WEBHOOK_SIGNING_SECRET: prefixedSecret("whsec_").optional(),
  };
}

/** Clerk browser credentials. */
export function authClient() {
  return {
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: prefixedSecret("pk_"),
  };
}

/**
 * Clerk keys carry `_test_` / `_live_` exactly as Stripe's do, and separate
 * Clerk applications back staging and production. Registering them here means
 * a production Clerk key in a preview deployment fails at boot rather than
 * quietly pointing staging at the real user directory.
 */
export const AUTH_MODE_BOUND_KEYS = [
  "CLERK_SECRET_KEY",
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
] as const;
