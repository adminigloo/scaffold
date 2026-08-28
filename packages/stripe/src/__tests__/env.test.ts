import { describe, expect, it } from "vitest";
import {
  assertModeBoundKeys,
  KeyModeIndeterminateError,
  KeyModeMismatchError,
} from "@adminigloo/env";
import { STRIPE_MODE_BOUND_KEYS, stripeClient, stripeServer } from "../env.js";

const server = stripeServer();
const client = stripeClient();

describe("stripeServer fragment", () => {
  it("accepts a real-shaped secret key", () => {
    expect(server.STRIPE_SECRET_KEY.safeParse("sk_test_51Abc123Def456").success).toBe(
      true,
    );
  });

  it("rejects a publishable key pasted into the secret slot", () => {
    // The most common real mistake: both are copied from the same dashboard
    // page, and a pk_ in the server slot fails at the first API call rather
    // than at boot unless the prefix is checked.
    const result = server.STRIPE_SECRET_KEY.safeParse("pk_test_51Abc123Def456");
    expect(result.success).toBe(false);
  });

  it("rejects a restricted key, which has a different prefix", () => {
    expect(server.STRIPE_SECRET_KEY.safeParse("rk_test_51Abc123Def456").success).toBe(
      false,
    );
  });

  it("rejects a truncated key that still starts with sk_", () => {
    expect(server.STRIPE_SECRET_KEY.safeParse("sk_test").success).toBe(false);
  });

  it("accepts a whsec_ webhook secret and rejects anything else", () => {
    expect(
      server.STRIPE_WEBHOOK_SECRET.safeParse("whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2La")
        .success,
    ).toBe(true);
    expect(server.STRIPE_WEBHOOK_SECRET.safeParse("sk_test_51Abc123Def456").success).toBe(
      false,
    );
    expect(server.STRIPE_WEBHOOK_SECRET.safeParse("").success).toBe(false);
  });
});

describe("stripeClient fragment", () => {
  it("accepts a publishable key", () => {
    expect(
      client.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY.safeParse("pk_live_51Abc123Def456")
        .success,
    ).toBe(true);
  });

  it("REJECTS a secret key in the NEXT_PUBLIC_ slot", () => {
    // A NEXT_PUBLIC_ value is inlined into the browser bundle. A secret key
    // here is not a misconfiguration, it is a disclosed credential.
    expect(
      client.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY.safeParse("sk_live_51Abc123Def456")
        .success,
    ).toBe(false);
  });
});

describe("STRIPE_MODE_BOUND_KEYS", () => {
  it("registers both keys that carry a mode marker", () => {
    expect([...STRIPE_MODE_BOUND_KEYS]).toEqual([
      "STRIPE_SECRET_KEY",
      "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
    ]);
  });

  it("does NOT register the webhook secret", () => {
    expect([...STRIPE_MODE_BOUND_KEYS]).not.toContain("STRIPE_WEBHOOK_SECRET");
  });

  it("stops a live key reaching a preview deployment", () => {
    expect(() =>
      assertModeBoundKeys(
        {
          STRIPE_SECRET_KEY: "sk_live_51Abc123Def456",
          NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_51Abc123Def456",
        },
        "staging",
        STRIPE_MODE_BOUND_KEYS,
      ),
    ).toThrow(KeyModeMismatchError);
  });

  it("stops a test key reaching production", () => {
    expect(() =>
      assertModeBoundKeys(
        { STRIPE_SECRET_KEY: "sk_test_51Abc123Def456" },
        "production",
        STRIPE_MODE_BOUND_KEYS,
      ),
    ).toThrow(KeyModeMismatchError);
  });

  it("passes a correctly-moded pair, webhook secret present and ignored", () => {
    expect(() =>
      assertModeBoundKeys(
        {
          STRIPE_SECRET_KEY: "sk_live_51Abc123Def456",
          NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_live_51Abc123Def456",
          STRIPE_WEBHOOK_SECRET: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2La",
        },
        "production",
        STRIPE_MODE_BOUND_KEYS,
      ),
    ).not.toThrow();
  });

  it("shows what listing the webhook secret would actually do", () => {
    // Not a hypothetical: a whsec_ contains neither "_test_" nor "_live_", so
    // registering it makes every environment fail to boot. This is why the
    // livemode check on the delivered event exists instead.
    expect(() =>
      assertModeBoundKeys(
        { STRIPE_WEBHOOK_SECRET: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2La" },
        "production",
        ["STRIPE_WEBHOOK_SECRET"],
      ),
    ).toThrow(KeyModeIndeterminateError);
  });
});
