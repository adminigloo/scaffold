import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { CARD_PAYMENTS_SWITCHED_OFF, describeStripeFailure, SOMETHING_ON_OUR_SIDE, STRIPE_NOT_ANSWERING, stripeFailureWire, stripeNotSetUp } from "../failure.js";

/** A real SDK error, built the way the SDK builds one from Stripe's answer. */
function stripeError(statusCode: number, raw: { type: string; message: string; code?: string }) {
  return Stripe.errors.StripeError.generate({ ...raw, statusCode, requestId: "req_test123" } as never);
}

const CONNECT_400 = "You can only create new accounts if you've signed up for Connect, which you can do at https://dashboard.stripe.com/connect.";

describe("describeStripeFailure", () => {
  it("reads 'not signed up for Connect' as the site's setup: the owner's sentence, Stripe's for staff, and the link without its full stop", () => {
    const found = describeStripeFailure(stripeError(400, { type: "invalid_request_error", message: CONNECT_400 }));
    expect(found).toMatchObject({ kind: "setup", setup: "connect", ownerMessage: CARD_PAYMENTS_SWITCHED_OFF, stripeMessage: CONNECT_400, fixUrl: "https://dashboard.stripe.com/connect", status: 409 });
    expect(found.detail).toMatchObject({ statusCode: 400, requestId: "req_test123" });
    expect(found.ownerMessage).not.toMatch(/Connect|stripe\.com/);
  });

  it("reads the unfinished platform profile the same way, keeping Stripe's own link", () => {
    const message = "Please review the responsibilities of managing losses for connected accounts at https://dashboard.stripe.com/settings/connect/platform-profile.";
    const found = describeStripeFailure(stripeError(400, { type: "invalid_request_error", message }));
    expect(found).toMatchObject({ kind: "setup", setup: "connect", fixUrl: "https://dashboard.stripe.com/settings/connect/platform-profile" });
  });

  it("a wrong key (401) and a restricted key (403) are the site's setup too, fixed on the API keys page", () => {
    const wrong = describeStripeFailure(stripeError(401, { type: "invalid_request_error", message: "Invalid API Key provided: sk_test_****abcd" }));
    expect(wrong).toMatchObject({ kind: "setup", setup: "keys", ownerMessage: CARD_PAYMENTS_SWITCHED_OFF, fixUrl: "https://dashboard.stripe.com/apikeys" });
    const restricted = describeStripeFailure(stripeError(403, { type: "invalid_request_error", message: "The provided key 'rk_test_***' does not have the required permissions for this endpoint." }));
    expect(restricted).toMatchObject({ kind: "setup", setup: "restricted-key", ownerMessage: CARD_PAYMENTS_SWITCHED_OFF });
  });

  it("Stripe not answering (5xx, the SDK's dropped connection) is an outage: try again, nothing changed", () => {
    expect(describeStripeFailure(stripeError(500, { type: "api_error", message: "An unknown error occurred" }))).toMatchObject({ kind: "outage", ownerMessage: STRIPE_NOT_ANSWERING, status: 503 });
    expect(describeStripeFailure(new Stripe.errors.StripeConnectionError({ message: "An error occurred with our connection to Stripe." } as never))).toMatchObject({ kind: "outage" });
  });

  it("a dropped connection the Stripe SDK didn't raise is NOT Stripe's outage (review: a database outage read as 'Stripe isn't answering')", () => {
    // The Neon serverless driver's failure, and Postgres refusing on :5432.
    const neon = describeStripeFailure(new TypeError("fetch failed"));
    const pg = describeStripeFailure(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" }));
    const reset = describeStripeFailure(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
    const caused = describeStripeFailure(Object.assign(new TypeError("fetch failed"), { cause: { code: "ETIMEDOUT" } }));
    for (const found of [neon, pg, reset, caused]) {
      expect(found).toMatchObject({ kind: "unknown", ownerMessage: SOMETHING_ON_OUR_SIDE, status: 500, code: "internal", fixUrl: null, stripeMessage: null });
      expect(found.ownerMessage).not.toBe(STRIPE_NOT_ANSWERING);
    }
    // NEGATIVE CONTROL: the same dropped connection raised by the Stripe SDK is Stripe's.
    const sdk = describeStripeFailure(new Stripe.errors.StripeConnectionError({ message: "An error occurred with our connection to Stripe. Request was retried 2 times." } as never));
    expect(sdk).toMatchObject({ kind: "outage", ownerMessage: STRIPE_NOT_ANSWERING, fixUrl: "https://status.stripe.com/" });
  });

  it("a rate limit is 'busy'; any other Stripe refusal is 'refused'; anything that wasn't Stripe is the generic fallback", () => {
    expect(describeStripeFailure(stripeError(429, { type: "invalid_request_error", message: "Too many requests", code: "rate_limit" }))).toMatchObject({ kind: "busy" });
    expect(describeStripeFailure(stripeError(400, { type: "invalid_request_error", message: "Country 'ZZ' is unknown" }))).toMatchObject({ kind: "refused", status: 502 });
    const unknown = describeStripeFailure(new Error("relation \"stripe_connected_accounts\" does not exist"));
    expect(unknown).toMatchObject({ kind: "unknown", stripeMessage: null, status: 500 });
  });

  it("no key at all: the owner's sentence, and which setting is empty for staff", () => {
    const found = stripeNotSetUp("STRIPE_SECRET_KEY");
    expect(found).toMatchObject({ kind: "setup", setup: "missing-keys", ownerMessage: CARD_PAYMENTS_SWITCHED_OFF });
    expect(found.stripeMessage).toContain("STRIPE_SECRET_KEY");
  });
});

describe("stripeFailureWire", () => {
  it("hands Stripe's sentence and the fix ONLY to staff", () => {
    const found = describeStripeFailure(stripeError(400, { type: "invalid_request_error", message: CONNECT_400 }));
    expect(stripeFailureWire(found, false)).toEqual({ code: "stripe_setup", message: CARD_PAYMENTS_SWITCHED_OFF });
    expect(stripeFailureWire(found, true)).toEqual({
      code: "stripe_setup",
      message: CARD_PAYMENTS_SWITCHED_OFF,
      staff: { message: CONNECT_400, fixUrl: "https://dashboard.stripe.com/connect", fixLabel: "Finish setting up Connect in Stripe" },
    });
  });
});
