import { z } from "zod";
import type { LicenseMode } from "./license.js";

/**
 * This package's contribution to the environment contract.
 *
 * EVERY KEY IS OPTIONAL, and the default behaviour with all three absent is
 * "allow everything" — the same degrade-don't-block rule the rest of the suite
 * follows. A project must boot and run with no license configured; enforcement
 * is something the founder turns ON when they start selling, not something a
 * fresh install has to satisfy.
 */
export function licenseServer() {
  return {
    // The signed license token the customer pastes in. `aig_…`.
    ADMINIGLOO_LICENSE_KEY: z.string().min(1).optional(),
    // The Ed25519 public key licenses are verified against. Usually baked into
    // the build; this override lets a deployment carry it without a rebuild.
    ADMINIGLOO_LICENSE_PUBLIC_KEY: z.string().min(1).optional(),
    // off (default) | warn | enforce. Per-deployment, so flipping to sell is one
    // variable rather than a release.
    ADMINIGLOO_LICENSE_MODE: z.enum(["off", "warn", "enforce"]).optional(),
  };
}

export interface LicenseEnv {
  readonly ADMINIGLOO_LICENSE_KEY?: string | undefined;
  readonly ADMINIGLOO_LICENSE_PUBLIC_KEY?: string | undefined;
  readonly ADMINIGLOO_LICENSE_MODE?: LicenseMode | undefined;
}

/** The mode this deployment runs in, defaulting to the safe `off`. */
export function resolveLicenseMode(env: LicenseEnv): LicenseMode {
  return env.ADMINIGLOO_LICENSE_MODE ?? "off";
}
