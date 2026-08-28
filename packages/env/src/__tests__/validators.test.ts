import { describe, expect, it } from "vitest";
import {
  assertKeyMode,
  assertModeBoundKeys,
  detectKeyMode,
  isPooledPostgresUrl,
  isPostgresUrl,
  KeyModeIndeterminateError,
  KeyModeMismatchError,
  pointsAtLocalhost,
} from "../validators.js";

describe("pointsAtLocalhost", () => {
  it.each([
    "http://localhost:3000",
    "https://localhost",
    "http://127.0.0.1:3000",
    "http://0.0.0.0:8080",
    "http://[::1]:3000",
    "http://app.localhost:3000",
  ])("catches %s", (url) => {
    expect(pointsAtLocalhost(url)).toBe(true);
  });

  it.each(["https://adminigloo.com", "https://staging.adminigloo.com"])(
    "allows %s",
    (url) => {
      expect(pointsAtLocalhost(url)).toBe(false);
    },
  );

  it("does not throw on an unparseable value", () => {
    expect(pointsAtLocalhost("not a url")).toBe(false);
  });
});

describe("postgres url discrimination", () => {
  const pooled = "postgresql://u:p@ep-cool-name-pooler.us-east-2.aws.neon.tech/db";
  const direct = "postgresql://u:p@ep-cool-name.us-east-2.aws.neon.tech/db";

  it("identifies the pooled endpoint", () => {
    expect(isPooledPostgresUrl(pooled)).toBe(true);
    expect(isPooledPostgresUrl(direct)).toBe(false);
  });

  it("rejects non-postgres urls", () => {
    expect(isPostgresUrl("https://example.com")).toBe(false);
    expect(isPooledPostgresUrl("https://example.com")).toBe(false);
  });
});

describe("detectKeyMode", () => {
  it.each([
    ["sk_live_abc123", "live"],
    ["sk_test_abc123", "test"],
    ["pk_live_abc123", "live"],
    ["rk_test_abc123", "test"],
  ])("%s -> %s", (value, expected) => {
    expect(detectKeyMode(value)).toBe(expected);
  });

  it("returns null when no mode marker is present", () => {
    expect(detectKeyMode("whsec_abc123")).toBeNull();
  });
});

describe("assertKeyMode", () => {
  it("accepts a test key outside production", () => {
    expect(() => assertKeyMode("STRIPE_SECRET_KEY", "sk_test_x", "local")).not.toThrow();
    expect(() => assertKeyMode("STRIPE_SECRET_KEY", "sk_test_x", "staging")).not.toThrow();
  });

  it("accepts a live key in production", () => {
    expect(() =>
      assertKeyMode("STRIPE_SECRET_KEY", "sk_live_x", "production"),
    ).not.toThrow();
  });

  it("REFUSES a live key in staging — the whole point of the package", () => {
    expect(() => assertKeyMode("STRIPE_SECRET_KEY", "sk_live_x", "staging")).toThrow(
      KeyModeMismatchError,
    );
  });

  it("refuses a live key locally", () => {
    expect(() => assertKeyMode("STRIPE_SECRET_KEY", "sk_live_x", "local")).toThrow(
      KeyModeMismatchError,
    );
  });

  it("refuses a test key in production", () => {
    expect(() =>
      assertKeyMode("STRIPE_SECRET_KEY", "sk_test_x", "production"),
    ).toThrow(KeyModeMismatchError);
  });

  it("names both modes and the fix in the message", () => {
    try {
      assertKeyMode("STRIPE_SECRET_KEY", "sk_live_x", "staging");
      expect.unreachable("should have thrown");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("STRIPE_SECRET_KEY");
      expect(message).toContain("LIVE");
      expect(message).toContain("TEST");
      expect(message).toContain("staging");
      expect(message).toContain("Preview");
    }
  });

  it("refuses a key it cannot classify rather than passing it through", () => {
    expect(() => assertKeyMode("STRIPE_SECRET_KEY", "whsec_x", "staging")).toThrow(
      KeyModeIndeterminateError,
    );
  });
});

describe("assertModeBoundKeys", () => {
  const keys = ["STRIPE_SECRET_KEY", "CLERK_SECRET_KEY"] as const;

  it("skips keys that are absent or empty", () => {
    expect(() => assertModeBoundKeys({}, "staging", keys)).not.toThrow();
    expect(() =>
      assertModeBoundKeys({ STRIPE_SECRET_KEY: "" }, "staging", keys),
    ).not.toThrow();
  });

  it("checks every key that is present", () => {
    expect(() =>
      assertModeBoundKeys(
        { STRIPE_SECRET_KEY: "sk_test_x", CLERK_SECRET_KEY: "sk_live_x" },
        "staging",
        keys,
      ),
    ).toThrow(KeyModeMismatchError);
  });
});
