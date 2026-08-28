import { describe, expect, it } from "vitest";
import Stripe from "stripe";
import { STRIPE_API_VERSION } from "../client.js";
import {
  assertEventLivemode,
  StripeLivemodeMismatchError,
  StripeSignatureError,
  verifyStripeSignature,
} from "../webhook.js";

// A real Stripe instance signing real payloads, so the tests exercise genuine
// HMAC verification. A stubbed `webhooks.constructEvent` would keep passing if
// the verification call were deleted altogether.
const stripe = new Stripe("sk_test_00000000000000000000000000", {
  apiVersion: STRIPE_API_VERSION,
});

const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";

const checkoutCompleted = {
  id: "evt_1Abc",
  object: "event",
  api_version: STRIPE_API_VERSION,
  created: 1_756_382_400,
  livemode: false,
  pending_webhooks: 1,
  request: null,
  type: "checkout.session.completed",
  data: {
    object: {
      id: "cs_test_1",
      object: "checkout.session",
      metadata: { tenantId: "t_42" },
    },
  },
};

function signed(payload: unknown, atSeconds = Math.floor(Date.now() / 1000)) {
  const body = JSON.stringify(payload);
  return {
    body,
    signature: stripe.webhooks.generateTestHeaderString({
      payload: body,
      secret: SECRET,
      timestamp: atSeconds,
    }),
  };
}

describe("verifyStripeSignature", () => {
  it("returns the event for a genuinely signed raw body", () => {
    const { body, signature } = signed(checkoutCompleted);
    const event = verifyStripeSignature(body, signature, SECRET, stripe);
    expect(event.id).toBe("evt_1Abc");
    expect(event.type).toBe("checkout.session.completed");
  });

  it("rejects a tampered body", () => {
    const { body, signature } = signed(checkoutCompleted);
    const tampered = body.replace("t_42", "t_attacker");
    expect(() => verifyStripeSignature(tampered, signature, SECRET, stripe)).toThrow(
      StripeSignatureError,
    );
  });

  it("rejects a body re-serialised by req.json() — the mis-plumbed route", () => {
    // Byte-identical content, different bytes. This is the failure the RAW-body
    // comment exists for: the payload means the same thing and the HMAC does
    // not match, so it looks exactly like an attack.
    const { signature } = signed(checkoutCompleted);
    const reserialised = JSON.stringify(checkoutCompleted, null, 2);
    expect(() =>
      verifyStripeSignature(reserialised, signature, SECRET, stripe),
    ).toThrow(StripeSignatureError);
  });

  it("rejects a payload signed with a different endpoint's secret", () => {
    const { body, signature } = signed(checkoutCompleted);
    const otherSecret = "whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    expect(() =>
      verifyStripeSignature(body, signature, otherSecret, stripe),
    ).toThrow(StripeSignatureError);
  });

  it("rejects a replay outside the signing tolerance", () => {
    // Stripe's default tolerance is 5 minutes. Worth asserting rather than
    // assuming: without it a captured request stays valid forever.
    const { body, signature } = signed(
      checkoutCompleted,
      Math.floor(Date.now() / 1000) - 3600,
    );
    expect(() => verifyStripeSignature(body, signature, SECRET, stripe)).toThrow(
      StripeSignatureError,
    );
  });

  it("rejects a missing header without making the caller write `signature!`", () => {
    const { body } = signed(checkoutCompleted);
    for (const absent of [null, undefined, ""]) {
      expect(() => verifyStripeSignature(body, absent, SECRET, stripe)).toThrow(
        /stripe-signature header was absent/,
      );
    }
  });

  it("accepts the raw bytes as well as the string", () => {
    // App Router hands back a string; a body-parser hands back a Buffer. Both
    // are the raw bytes and both must verify.
    const { body, signature } = signed(checkoutCompleted);
    const bytes = new TextEncoder().encode(body);
    expect(verifyStripeSignature(bytes, signature, SECRET, stripe).id).toBe("evt_1Abc");
  });
});

describe("assertEventLivemode", () => {
  function eventWithLivemode(livemode: boolean): Stripe.Event {
    return { ...checkoutCompleted, livemode } as unknown as Stripe.Event;
  }

  it("accepts a test event on local and staging", () => {
    expect(() => assertEventLivemode(eventWithLivemode(false), "local")).not.toThrow();
    expect(() => assertEventLivemode(eventWithLivemode(false), "staging")).not.toThrow();
  });

  it("accepts a live event on production", () => {
    expect(() =>
      assertEventLivemode(eventWithLivemode(true), "production"),
    ).not.toThrow();
  });

  it("REJECTS a test event delivered to production", () => {
    // The gap the mode-bound key list cannot close: whsec_ carries no mode
    // marker, so a test endpoint's secret in production verifies perfectly and
    // every payment made with card 4242 becomes a real, fulfilled order.
    expect(() => assertEventLivemode(eventWithLivemode(false), "production")).toThrow(
      StripeLivemodeMismatchError,
    );
  });

  it("REJECTS a live event delivered to staging", () => {
    expect(() => assertEventLivemode(eventWithLivemode(true), "staging")).toThrow(
      StripeLivemodeMismatchError,
    );
  });

  it("names the event id so the delivery is findable in the dashboard", () => {
    expect(() => assertEventLivemode(eventWithLivemode(true), "local")).toThrow(
      /evt_1Abc/,
    );
  });
});
