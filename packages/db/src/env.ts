import { pooledPostgresUrl, unpooledPostgresUrl } from "@adminigloo/env";

/**
 * This package's contribution to the environment contract.
 *
 * Two URLs, deliberately. The app runs against the pooled endpoint; migrations
 * run against the direct one, because drizzle-kit through a pooler either hangs
 * or misreports which migrations have been applied.
 */
export function dbServer() {
  return {
    DATABASE_URL: pooledPostgresUrl(),
    DATABASE_URL_UNPOOLED: unpooledPostgresUrl(),
  };
}

/**
 * The variables a laptop may leave unset, exported so the generated app's env
 * module composes this list rather than retyping the names.
 *
 * LOCAL ONLY. This is a list of names, not a policy: it makes no variable
 * optional by itself. The app marks these optional when `resolveAppEnv()` is
 * "local" and leaves them required otherwise, so a preview or production
 * deployment missing DATABASE_URL still fails at boot instead of serving a
 * site whose every query throws. Hardcoding the names in the app is what
 * drifts — renaming a variable here would then leave the app deferring a
 * variable that no longer exists while requiring one that is never set.
 */
export const DB_OPTIONAL_UNTIL_DEPLOYED = [
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
] as const;
