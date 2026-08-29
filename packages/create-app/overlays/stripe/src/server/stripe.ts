import { createStripeClient } from "__SCOPE__/stripe";
import { env } from "@/env";

/**
 * The Stripe client for __PROJECT_NAME__.
 *
 * Null when no key is configured, so the app boots and the UI can gate on
 * `isConfigured` instead of every billing surface throwing. The key's
 * test/live mode is already bound to the deployment by @adminigloo/env — a
 * live key outside production never reaches this line.
 */
export const stripe = createStripeClient({
  secretKey: env.STRIPE_SECRET_KEY,
  appUrl: env.NEXT_PUBLIC_APP_URL,
});
