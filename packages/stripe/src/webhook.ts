import { expectedKeyMode, type AppEnv } from "@adminigloo/env";
import type Stripe from "stripe";

export class StripeSignatureError extends Error {
  readonly name = "StripeSignatureError";
  constructor(reason: string, cause?: unknown) {
    super(
      `Stripe webhook signature verification failed: ${reason}. The request was ` +
        `not sent by Stripe, STRIPE_WEBHOOK_SECRET belongs to a different ` +
        `endpoint, or the route parsed the body before verifying it.`,
      { cause },
    );
  }
}

/**
 * Verify a webhook and return the event Stripe signed.
 *
 * THE BODY MUST BE THE RAW BYTES. `await req.text()` in a route handler, or the
 * raw Buffer under a body parser — never `await req.json()` and never a
 * re-serialised object. The signature is an HMAC over the exact bytes Stripe
 * sent, and a JSON round trip changes key order, number formatting and
 * whitespace. The failure is invisible from here: a re-serialised body throws
 * the same error as a forged one, so the route looks like it is under attack
 * when it is only mis-plumbed.
 *
 * The client is a parameter rather than the singleton so verification is
 * testable without configuring the process, and so a Connect app can verify
 * against the account the endpoint belongs to.
 */
export function verifyStripeSignature(
  body: string | Uint8Array,
  signature: string | null | undefined,
  secret: string,
  stripe: Stripe,
): Stripe.Event {
  // `headers.get()` returns null and a missing header on a proxied request
  // returns undefined. Both are handled here so no caller writes `signature!`
  // and turns an absent header into an unreadable crash inside the SDK.
  if (!signature) {
    throw new StripeSignatureError(
      "the stripe-signature header was absent — either the request did not come " +
        "from Stripe, or a proxy stripped the header",
    );
  }

  try {
    return stripe.webhooks.constructEvent(body, signature, secret);
  } catch (cause) {
    throw new StripeSignatureError("the signature did not match the body", cause);
  }
}

export class StripeLivemodeMismatchError extends Error {
  readonly name = "StripeLivemodeMismatchError";
  constructor(
    readonly eventId: string,
    readonly livemode: boolean,
    readonly appEnv: AppEnv,
  ) {
    super(
      `Stripe event ${eventId} is a ${livemode ? "LIVE" : "TEST"} mode event but ` +
        `this is the "${appEnv}" environment, which must only receive ` +
        `${appEnv === "production" ? "LIVE" : "TEST"} mode events. ` +
        `STRIPE_WEBHOOK_SECRET points at an endpoint in the wrong Stripe mode.`,
    );
  }
}

/**
 * Reject an event whose mode does not match the deployment.
 *
 * This exists because STRIPE_WEBHOOK_SECRET is the one Stripe credential with
 * no `_test_` / `_live_` marker in it, so it cannot be registered in
 * `modeBoundKeys` and `assertKeyMode` cannot bind it to the environment at
 * boot. A test-mode endpoint's `whsec_…` pasted into production verifies
 * perfectly — and then every payment made with card 4242 becomes a real,
 * fulfilled order. `event.livemode` is the only place that mismatch is
 * observable, and it is observable exactly once per delivery.
 *
 * Reuses `expectedKeyMode` rather than testing `appEnv === "production"`
 * directly, so this stays in lockstep with the rule the env package enforces.
 */
export function assertEventLivemode(event: Stripe.Event, appEnv: AppEnv): void {
  const expectLive = expectedKeyMode(appEnv) === "live";
  if (event.livemode !== expectLive) {
    throw new StripeLivemodeMismatchError(event.id, event.livemode, appEnv);
  }
}
