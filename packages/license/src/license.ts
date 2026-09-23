import { verifyToken, type LicenseClaims } from "./token.js";

/**
 * Whether, and how hard, this deployment enforces a license.
 *
 * `off`     — never denies. The default, and the state every existing install
 *             and the founder's own dogfooding runs in: features work, and a
 *             use without a valid license is noticed only in the returned
 *             status, for logging. Nothing breaks.
 * `warn`    — same allow behaviour as `off`; exists so a deployment can log the
 *             status loudly during a transition without turning customers away.
 * `enforce` — denies when there is POSITIVE evidence the license is missing,
 *             invalid, expired or lacks the feature. It does NOT deny when it
 *             cannot check at all (no public key baked) — a seller
 *             misconfiguration must not lock out a paying customer.
 *
 * The mode is per-deployment (`ADMINIGLOO_LICENSE_MODE`), never baked into a
 * package, so flipping to sell is one environment variable rather than a
 * release.
 */
export type LicenseMode = "off" | "warn" | "enforce";

export type LicenseStatus =
  | "unlicensed" // no key configured
  | "valid"
  | "expired"
  | "not-yet-valid"
  | "invalid" // signature failed or token malformed
  | "wrong-feature" // valid license, but not for this feature
  | "unverifiable"; // key present, but no public key to check it with

export interface LicenseResult {
  /** Whether to ALLOW the operation. False only ever happens under `enforce`. */
  readonly ok: boolean;
  readonly status: LicenseStatus;
  readonly mode: LicenseMode;
  readonly feature: string;
  readonly customer?: string;
  readonly expiresAt?: number;
  /** One human sentence, for a log line or a 402 body. */
  readonly reason: string;
}

export interface VerifyLicenseOptions {
  /** The feature being gated, e.g. "assistant". */
  readonly feature: string;
  /** The license token — `ADMINIGLOO_LICENSE_KEY`. */
  readonly key?: string | undefined;
  /** PEM public key to verify with. Falls back to `ADMINIGLOO_LICENSE_PUBLIC_KEY`
   * / the baked key when omitted. */
  readonly publicKey?: string | undefined;
  /** Enforcement mode. Defaults to `off`. */
  readonly mode?: LicenseMode | undefined;
  /** Now, in epoch seconds. Injectable so verification is deterministic in
   * tests; defaults to the wall clock. */
  readonly now?: number | undefined;
}

/**
 * The public key baked into this build.
 *
 * EMPTY BY DESIGN. The founder generates a keypair once (`generateLicenseKeypair`),
 * keeps the private key offline, and provides the public key to deployments via
 * `ADMINIGLOO_LICENSE_PUBLIC_KEY` — or replaces this constant in a fork/build.
 * While it is empty and no env key is set, a configured license token is
 * `unverifiable`, which under `enforce` fails OPEN (see the mode doc): the gate
 * only ever bites once there is a key to check signatures against.
 */
export const BAKED_PUBLIC_KEY = "";

export function verifyLicense(opts: VerifyLicenseOptions): LicenseResult {
  const mode: LicenseMode = opts.mode ?? "off";
  const feature = opts.feature;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const key = nonEmpty(opts.key);
  const publicKey = nonEmpty(opts.publicKey) ?? nonEmpty(BAKED_PUBLIC_KEY);

  const { status, claims } = evaluate(key, publicKey, feature, now);
  const ok = decide(mode, status);

  return {
    ok,
    status,
    mode,
    feature,
    ...(claims?.customer !== undefined ? { customer: claims.customer } : {}),
    ...(claims?.expiresAt !== undefined ? { expiresAt: claims.expiresAt } : {}),
    reason: reasonFor(status, feature, mode, ok),
  };
}

/**
 * Verify, and throw `LicenseError` when the result is a denial. Handlers call
 * this and translate the error into a 402. When `ok` is true — which is always,
 * outside `enforce` — it returns the result so a caller can still log the
 * status.
 */
export function assertLicensed(opts: VerifyLicenseOptions): LicenseResult {
  const result = verifyLicense(opts);
  if (!result.ok) throw new LicenseError(result);
  return result;
}

export class LicenseError extends Error {
  readonly name = "LicenseError";
  readonly status: LicenseStatus;
  readonly feature: string;
  readonly result: LicenseResult;
  constructor(result: LicenseResult) {
    super(result.reason);
    this.status = result.status;
    this.feature = result.feature;
    this.result = result;
  }
}

function evaluate(
  key: string | undefined,
  publicKey: string | undefined,
  feature: string,
  now: number,
): { status: LicenseStatus; claims: LicenseClaims | null } {
  if (key === undefined) return { status: "unlicensed", claims: null };
  if (publicKey === undefined) return { status: "unverifiable", claims: null };

  const { valid, claims } = verifyToken(key, publicKey);
  if (!valid || claims === null) return { status: "invalid", claims: null };
  if (claims.notBefore !== undefined && now < claims.notBefore) {
    return { status: "not-yet-valid", claims };
  }
  if (claims.expiresAt !== undefined && now >= claims.expiresAt) {
    return { status: "expired", claims };
  }
  if (!coversFeature(claims.features, feature)) {
    return { status: "wrong-feature", claims };
  }
  return { status: "valid", claims };
}

function decide(mode: LicenseMode, status: LicenseStatus): boolean {
  if (mode !== "enforce") return true;
  // Deny only on positive evidence of a bad or absent license. `unverifiable`
  // is a seller-side misconfiguration, not a customer's fault, so it fails open.
  return status === "valid" || status === "unverifiable";
}

function coversFeature(features: readonly string[], feature: string): boolean {
  return features.includes("*") || features.includes(feature);
}

function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function reasonFor(
  status: LicenseStatus,
  feature: string,
  mode: LicenseMode,
  ok: boolean,
): string {
  const head = ((): string => {
    switch (status) {
      case "valid":
        return `Licensed for ${feature}.`;
      case "unlicensed":
        return `No AdminIgloo license configured for ${feature} (set ADMINIGLOO_LICENSE_KEY).`;
      case "expired":
        return `The AdminIgloo license for ${feature} has expired.`;
      case "not-yet-valid":
        return `The AdminIgloo license for ${feature} is not valid yet.`;
      case "invalid":
        return `The AdminIgloo license key is not valid.`;
      case "wrong-feature":
        return `This AdminIgloo license does not cover ${feature}.`;
      case "unverifiable":
        return `An AdminIgloo license key is set but cannot be verified (no public key configured).`;
    }
  })();
  if (ok && mode !== "off" && status !== "valid") {
    return `${head} Allowed because ADMINIGLOO_LICENSE_MODE is "${mode}".`;
  }
  return head;
}
