import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";

/**
 * The license token: a set of claims, signed by AdminIgloo's private key,
 * verified anywhere with only the public key.
 *
 * WHY ED25519 AND OFFLINE. The suite's central promise is that a generated
 * project boots and runs with no network dependency AdminIgloo controls — no
 * phone-home, no license server the customer's checkout waits on. A signed token
 * keeps that: the package ships the PUBLIC key, verification is a local
 * signature check on a Vercel cold start, and the private key never leaves the
 * founder's machine. Ed25519 because Node's own `crypto` signs and verifies it
 * with no dependency, and the keys and signatures are small enough to paste into
 * an environment variable.
 *
 * WHAT THIS IS NOT. Verification is open source, so a determined buyer can
 * delete the check from the code they installed. That is understood and
 * accepted: this converts "silently don't pay" into "knowingly strip a license
 * check", which is a contract act, not a technical accident — the right bar for
 * a high-ticket, self-serve product. Do not market it as unbreakable.
 */

/** Bumped only if the claim shape changes in a way a verifier cannot absorb. */
export const LICENSE_TOKEN_VERSION = 1;

/** Distinguishes a license token from the tenant intake keys (`aik_`/`esk_`),
 * which are a different thing entirely — those authenticate a buyer's own
 * visitors; this proves the BUYER paid AdminIgloo. Never conflate the two. */
export const LICENSE_KEY_PREFIX = "aig_";

export interface LicenseClaims {
  /** Token format version. */
  readonly v: number;
  /** Who the license was issued to. Free-form; shown in diagnostics. */
  readonly customer: string;
  /** Feature keys this license covers, or `["*"]` for the whole suite. */
  readonly features: readonly string[];
  /** When it was issued. Epoch seconds. */
  readonly issuedAt: number;
  /** Not valid before this. Epoch seconds. Optional. */
  readonly notBefore?: number;
  /** Expires at this. Epoch seconds. Absent means perpetual. */
  readonly expiresAt?: number;
}

const ENCODING = "base64url" as const;

/**
 * Sign a license. Runs where the PRIVATE key is — the founder's issuance
 * script, offline — never in a generated project.
 */
export function signLicense(claims: LicenseClaims, privateKeyPem: string): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString(ENCODING);
  const key = createPrivateKey(privateKeyPem);
  // Ed25519 takes a null algorithm — the curve fixes the hash.
  const signature = sign(null, Buffer.from(payload), key).toString(ENCODING);
  return `${LICENSE_KEY_PREFIX}${payload}.${signature}`;
}

/**
 * Read a token's claims WITHOUT verifying the signature. For diagnostics only —
 * a decision must never be made on these. Returns null on any malformation.
 */
export function readClaims(token: string): LicenseClaims | null {
  const parts = stripAndSplit(token);
  if (parts === null) return null;
  try {
    return JSON.parse(Buffer.from(parts.payload, ENCODING).toString("utf8")) as LicenseClaims;
  } catch {
    return null;
  }
}

export interface VerifiedToken {
  readonly valid: boolean;
  readonly claims: LicenseClaims | null;
}

/**
 * Verify a token's signature against a public key, and return its claims only
 * when the signature holds. A false `valid` with null `claims` covers every
 * failure — wrong key, tampered payload, garbage input — so a caller never has
 * to tell them apart to fail closed.
 */
export function verifyToken(token: string, publicKeyPem: string): VerifiedToken {
  const parts = stripAndSplit(token);
  if (parts === null) return { valid: false, claims: null };
  try {
    const key = createPublicKey(publicKeyPem);
    const ok = verify(
      null,
      Buffer.from(parts.payload),
      key,
      Buffer.from(parts.signature, ENCODING),
    );
    if (!ok) return { valid: false, claims: null };
    const claims = JSON.parse(
      Buffer.from(parts.payload, ENCODING).toString("utf8"),
    ) as LicenseClaims;
    return { valid: true, claims };
  } catch {
    return { valid: false, claims: null };
  }
}

/** Generate an Ed25519 keypair as PEM. The founder runs this ONCE, bakes the
 * public key into the deployment (or the package), and keeps the private key
 * offline to sign licenses with. */
export function generateLicenseKeypair(): {
  readonly publicKey: string;
  readonly privateKey: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKey, privateKey };
}

function stripAndSplit(
  token: string,
): { readonly payload: string; readonly signature: string } | null {
  if (typeof token !== "string") return null;
  const body = token.startsWith(LICENSE_KEY_PREFIX)
    ? token.slice(LICENSE_KEY_PREFIX.length)
    : token;
  const dot = body.indexOf(".");
  if (dot <= 0 || dot === body.length - 1) return null;
  return { payload: body.slice(0, dot), signature: body.slice(dot + 1) };
}
