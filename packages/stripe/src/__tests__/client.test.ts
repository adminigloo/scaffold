import { beforeEach, describe, expect, it } from "vitest";
import {
  createStripeClient,
  getStripeOrThrow,
  isStripeConfigured,
  STRIPE_API_VERSION,
  StripeNotConfiguredError,
} from "../client.js";

const APP_URL = "https://app.example.com";
const KEY = "sk_test_00000000000000000000000000";
const OTHER_KEY = "sk_test_11111111111111111111111111";

beforeEach(() => {
  // The singleton lives on globalThis so it survives Next's hot reloads; that
  // also means it survives between tests unless it is cleared here.
  globalThis.__adminiglooStripe = undefined;
});

describe("createStripeClient", () => {
  it("returns null when the secret key is absent, instead of throwing", () => {
    // A preview branch or a self-hosted install that never takes a payment must
    // still boot. "Billing is not set up" has to be distinguishable from "the
    // app is broken".
    expect(
      createStripeClient({ secretKey: undefined, appUrl: APP_URL }),
    ).toBeNull();
    expect(
      createStripeClient({ secretKey: "", appUrl: APP_URL }),
    ).toBeNull();
    expect(isStripeConfigured()).toBe(false);
  });

  it("pins the API version rather than following the account default", () => {
    const client = createStripeClient({ secretKey: KEY, appUrl: APP_URL });
    expect(client?.apiVersion).toBe(STRIPE_API_VERSION);
  });

  it("honours an explicit apiVersion override", () => {
    const client = createStripeClient({
      secretKey: KEY,
      appUrl: APP_URL,
      apiVersion: STRIPE_API_VERSION,
    });
    expect(client?.apiVersion).toBe(STRIPE_API_VERSION);
  });

  it("reuses the same instance for the same configuration", () => {
    const first = createStripeClient({ secretKey: KEY, appUrl: APP_URL });
    const second = createStripeClient({ secretKey: KEY, appUrl: APP_URL });
    expect(second).toBe(first);
  });

  it("rebuilds when the secret key changes", () => {
    // Swapping a test key for a live one in a dev shell must not keep serving a
    // client bound to the old credentials.
    const first = createStripeClient({ secretKey: KEY, appUrl: APP_URL });
    const second = createStripeClient({ secretKey: OTHER_KEY, appUrl: APP_URL });
    expect(second).not.toBe(first);
  });

  it("rebuilds when the app URL changes", () => {
    const first = createStripeClient({ secretKey: KEY, appUrl: APP_URL });
    const second = createStripeClient({
      secretKey: KEY,
      appUrl: "https://staging.example.com",
    });
    expect(second).not.toBe(first);
    expect(second?.appUrl).toBe("https://staging.example.com");
  });

  it("never stores the raw secret on the global object", () => {
    createStripeClient({ secretKey: KEY, appUrl: APP_URL });
    expect(globalThis.__adminiglooStripe?.fingerprint).not.toContain(KEY);
  });
});

describe("isStripeConfigured / getStripeOrThrow", () => {
  it("throws a typed error naming the variable before configuration", () => {
    expect(() => getStripeOrThrow()).toThrow(StripeNotConfiguredError);
    expect(() => getStripeOrThrow()).toThrow(/STRIPE_SECRET_KEY/);
  });

  it("returns the configured client afterwards", () => {
    const client = createStripeClient({ secretKey: KEY, appUrl: APP_URL });
    expect(isStripeConfigured()).toBe(true);
    expect(getStripeOrThrow()).toBe(client);
  });
});
