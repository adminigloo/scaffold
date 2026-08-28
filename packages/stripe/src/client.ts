import { createHash } from "node:crypto";
import Stripe from "stripe";

/**
 * The API version this package's types were generated against.
 *
 * PINNED, and pinned as a literal rather than read from the SDK, because an
 * unpinned client uses the account's default version — a value someone can
 * change in the Stripe dashboard, at which point the shape of every webhook
 * payload and every API response changes under a deployment nobody rebuilt.
 *
 * The `satisfies` is the tripwire: bumping the `stripe` dependency to a release
 * that targets a newer version fails the build here, which is where the payload
 * diff gets read, instead of in production where it gets discovered.
 */
export const STRIPE_API_VERSION = "2026-08-26.dahlia" satisfies Stripe.LatestApiVersion;

export interface CreateStripeClientOptions {
  /**
   * `sk_…`. Accepts undefined so an app can pass `env.STRIPE_SECRET_KEY`
   * straight through without a guard at every call site.
   */
  secretKey: string | undefined;
  /** This deployment's public origin — used for return URLs and appInfo. */
  appUrl: string;
  apiVersion?: Stripe.LatestApiVersion;
}

export interface StripeClient {
  /** The raw SDK. Everything this package does not wrap goes through here. */
  readonly stripe: Stripe;
  readonly appUrl: string;
  readonly apiVersion: Stripe.LatestApiVersion;
}

export class StripeNotConfiguredError extends Error {
  readonly name = "StripeNotConfiguredError";
  constructor() {
    super(
      "Stripe is not configured on this deployment: STRIPE_SECRET_KEY was absent " +
        "when createStripeClient ran. Guard billing surfaces with " +
        "isStripeConfigured() so they are hidden rather than reached, or set the " +
        "variable and redeploy.",
    );
  }
}

interface CachedClient {
  readonly client: StripeClient;
  /** SHA-256 of the secret key, so a changed key rebuilds rather than reuses. */
  readonly fingerprint: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __adminiglooStripe: CachedClient | undefined;
}

/**
 * Configure the Stripe singleton for this process.
 *
 * Returns null instead of throwing when the key is absent. A deployment with no
 * Stripe credentials must still boot — preview branches that never take a
 * payment, and self-hosted installs that do not sell anything. Failing at
 * import time would make "billing is not set up" indistinguishable from "the
 * app is broken", so the throw is deferred to `getStripeOrThrow`, at the moment
 * something actually tries to move money, where the error can name the variable.
 *
 * Cached on `globalThis` the same way `createDb` caches its pool: Next
 * re-evaluates modules on every hot reload, and a fresh `Stripe` per reload
 * discards the keep-alive agent, so every subsequent call pays a new TLS
 * handshake. The cache key is a hash of the secret, never the secret, so
 * swapping a test key for a live one in a dev shell rebuilds the client instead
 * of silently serving the old one.
 */
export function createStripeClient(
  options: CreateStripeClientOptions,
): StripeClient | null {
  const { secretKey, appUrl, apiVersion = STRIPE_API_VERSION } = options;
  if (!secretKey) return null;

  const fingerprint = createHash("sha256")
    .update(`${secretKey}:${apiVersion}:${appUrl}`)
    .digest("hex");

  const cached = globalThis.__adminiglooStripe;
  if (cached && cached.fingerprint === fingerprint) return cached.client;

  const stripe = new Stripe(secretKey, {
    apiVersion,
    // The default is 1. Two, because stripe-node attaches an idempotency key to
    // every retried request, so a retry cannot double-charge — which makes the
    // only cost of retrying a little latency, against a transient 502 that the
    // customer would otherwise see as a declined checkout.
    maxNetworkRetries: 2,
    // Without appInfo every request in Stripe's logs is attributed to
    // "stripe-node" and staging is indistinguishable from production when you
    // are trying to work out which deployment issued a refund. No version
    // field: it would have to be hand-copied from package.json and would drift.
    appInfo: { name: "@adminigloo/stripe", url: appUrl },
    typescript: true,
  });

  const client: StripeClient = { stripe, appUrl, apiVersion };
  globalThis.__adminiglooStripe = { client, fingerprint };
  return client;
}

/** Can this deployment take money? Gate billing routes and UI on it. */
export function isStripeConfigured(): boolean {
  return globalThis.__adminiglooStripe !== undefined;
}

/** The configured client, or a typed error naming the variable to set. */
export function getStripeOrThrow(): StripeClient {
  const cached = globalThis.__adminiglooStripe;
  if (!cached) throw new StripeNotConfiguredError();
  return cached.client;
}
