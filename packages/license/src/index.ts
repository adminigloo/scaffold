/**
 * @adminigloo/license — does this deployment hold a paid AdminIgloo license for
 * a given feature?
 *
 * The gate lives at the HTTP handlers that do the valuable work (the feedback
 * intake, the estimator takeoff, the assistant chat stream), because on public
 * npm the library source is readable and only a server-side check bites. Call
 * `assertLicensed({ feature, key, publicKey, mode })` before the work; catch
 * `LicenseError` and answer 402. Unconfigured, it allows everything — see
 * `LicenseMode`.
 */
export {
  signLicense,
  verifyToken,
  readClaims,
  generateLicenseKeypair,
  LICENSE_KEY_PREFIX,
  LICENSE_TOKEN_VERSION,
} from "./token.js";
export type { LicenseClaims, VerifiedToken } from "./token.js";

export {
  verifyLicense,
  assertLicensed,
  LicenseError,
  BAKED_PUBLIC_KEY,
} from "./license.js";
export type {
  LicenseMode,
  LicenseStatus,
  LicenseResult,
  VerifyLicenseOptions,
} from "./license.js";

export { licenseServer, resolveLicenseMode } from "./env.js";
export type { LicenseEnv } from "./env.js";
