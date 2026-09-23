import { describe, expect, it } from "vitest";
import {
  assertLicensed,
  generateLicenseKeypair,
  LICENSE_KEY_PREFIX,
  LicenseError,
  readClaims,
  signLicense,
  verifyLicense,
  verifyToken,
  type LicenseClaims,
} from "../index.js";

const KEYS = generateLicenseKeypair();
const OTHER = generateLicenseKeypair();
const NOW = 1_700_000_000; // fixed epoch seconds

function license(over: Partial<LicenseClaims> = {}): string {
  const claims: LicenseClaims = {
    v: 1,
    customer: "acme-co",
    features: ["assistant"],
    issuedAt: NOW - 1000,
    ...over,
  };
  return signLicense(claims, KEYS.privateKey);
}

describe("token signing and verification", () => {
  it("round-trips a signed license", () => {
    const token = license();
    expect(token.startsWith(LICENSE_KEY_PREFIX)).toBe(true);
    const { valid, claims } = verifyToken(token, KEYS.publicKey);
    expect(valid).toBe(true);
    expect(claims?.customer).toBe("acme-co");
  });

  it("rejects a token signed by a different key", () => {
    expect(verifyToken(license(), OTHER.publicKey).valid).toBe(false);
  });

  it("rejects a tampered payload", () => {
    const token = license();
    const body = token.slice(LICENSE_KEY_PREFIX.length);
    const [payload, sig] = body.split(".");
    // Flip a character in the payload; the signature no longer matches.
    const tampered =
      LICENSE_KEY_PREFIX + payload!.slice(0, -1) + (payload!.endsWith("A") ? "B" : "A") + "." + sig;
    expect(verifyToken(tampered, KEYS.publicKey).valid).toBe(false);
  });

  it("rejects garbage without throwing", () => {
    expect(verifyToken("not-a-token", KEYS.publicKey).valid).toBe(false);
    expect(verifyToken("aig_only-one-part", KEYS.publicKey).valid).toBe(false);
    expect(verifyToken("", KEYS.publicKey).valid).toBe(false);
  });

  it("reads claims without verifying, for diagnostics", () => {
    expect(readClaims(license())?.features).toEqual(["assistant"]);
    expect(readClaims("garbage")).toBeNull();
  });
});

describe("verifyLicense status", () => {
  const base = { publicKey: KEYS.publicKey, now: NOW, mode: "enforce" as const };

  it("valid for a covering, unexpired license", () => {
    const r = verifyLicense({ ...base, feature: "assistant", key: license() });
    expect(r.status).toBe("valid");
    expect(r.ok).toBe(true);
    expect(r.customer).toBe("acme-co");
  });

  it("wildcard covers any feature", () => {
    const r = verifyLicense({ ...base, feature: "feedback", key: license({ features: ["*"] }) });
    expect(r.status).toBe("valid");
  });

  it("wrong-feature when the license does not cover it", () => {
    const r = verifyLicense({ ...base, feature: "feedback", key: license() });
    expect(r.status).toBe("wrong-feature");
    expect(r.ok).toBe(false);
  });

  it("expired past expiresAt", () => {
    const r = verifyLicense({ ...base, feature: "assistant", key: license({ expiresAt: NOW - 1 }) });
    expect(r.status).toBe("expired");
    expect(r.ok).toBe(false);
  });

  it("not-yet-valid before notBefore", () => {
    const r = verifyLicense({ ...base, feature: "assistant", key: license({ notBefore: NOW + 100 }) });
    expect(r.status).toBe("not-yet-valid");
  });

  it("invalid for a bad signature", () => {
    const r = verifyLicense({ ...base, feature: "assistant", key: license(), publicKey: OTHER.publicKey });
    expect(r.status).toBe("invalid");
    expect(r.ok).toBe(false);
  });

  it("unlicensed when no key is set", () => {
    const r = verifyLicense({ ...base, feature: "assistant", key: undefined });
    expect(r.status).toBe("unlicensed");
    expect(r.ok).toBe(false);
  });

  it("unverifiable — and fails OPEN under enforce — when no public key", () => {
    const r = verifyLicense({ feature: "assistant", key: license(), publicKey: "", mode: "enforce", now: NOW });
    expect(r.status).toBe("unverifiable");
    expect(r.ok).toBe(true); // seller misconfig must not lock out a buyer
  });
});

describe("mode governs the allow decision", () => {
  it("off allows even an expired/absent license", () => {
    expect(verifyLicense({ feature: "assistant", key: undefined, mode: "off", now: NOW }).ok).toBe(true);
    const expired = verifyLicense({
      feature: "assistant",
      key: license({ expiresAt: NOW - 1 }),
      publicKey: KEYS.publicKey,
      mode: "off",
      now: NOW,
    });
    expect(expired.ok).toBe(true);
    expect(expired.status).toBe("expired"); // status still tells the truth for logs
  });

  it("warn allows but is not off", () => {
    const r = verifyLicense({ feature: "assistant", key: undefined, mode: "warn", now: NOW });
    expect(r.ok).toBe(true);
  });

  it("off is the default when mode is omitted", () => {
    expect(verifyLicense({ feature: "assistant", key: undefined, now: NOW }).ok).toBe(true);
  });

  it("enforce denies an absent license", () => {
    expect(
      verifyLicense({ feature: "assistant", key: undefined, mode: "enforce", now: NOW }).ok,
    ).toBe(false);
  });
});

describe("assertLicensed", () => {
  it("returns the result when allowed", () => {
    const r = assertLicensed({ feature: "assistant", key: license(), publicKey: KEYS.publicKey, mode: "enforce", now: NOW });
    expect(r.status).toBe("valid");
  });

  it("throws LicenseError when denied", () => {
    try {
      assertLicensed({ feature: "assistant", key: undefined, mode: "enforce", now: NOW });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(LicenseError);
      expect((error as LicenseError).status).toBe("unlicensed");
    }
  });

  it("does not throw in the default mode", () => {
    expect(() => assertLicensed({ feature: "assistant", key: undefined, now: NOW })).not.toThrow();
  });
});
