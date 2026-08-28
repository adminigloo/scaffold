import { z } from "zod";
import { appUrl } from "./schemas.js";
import type { EnvSource } from "./app-env.js";

/**
 * Every package owns its own environment variables, the same way it owns its
 * permission catalog fragment: `@adminigloo/db` will export `dbServer()`,
 * `@adminigloo/auth` will export `authServer()` / `authClient()` plus its
 * mode-bound key names. An app spreads the fragments belonging to the packages
 * it actually installed.
 *
 *   export const env = defineEnv({
 *     server: { ...coreServer(), ...dbServer(), ...authServer() },
 *     client: { ...coreClient(), ...authClient() },
 *     modeBoundKeys: [...AUTH_MODE_BOUND_KEYS],
 *     runtimeEnv: { ... },
 *   });
 *
 * Return types are deliberately left to inference so spreading preserves the
 * exact shape and `env.NEXT_PUBLIC_APP_URL` stays typed.
 */

/** Server variables every project has, whichever packages it installed. */
export function coreServer() {
  return {
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z
      .enum(["trace", "debug", "info", "warn", "error", "fatal"])
      .default("info"),
  };
}

/** Client variables every project has. */
export function coreClient(source: EnvSource = process.env) {
  return {
    NEXT_PUBLIC_APP_URL: appUrl(source),
  };
}
