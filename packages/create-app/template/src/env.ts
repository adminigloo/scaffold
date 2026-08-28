import { authClient, authServer, AUTH_MODE_BOUND_KEYS } from "__SCOPE__/auth";
import { dbServer } from "__SCOPE__/db";
import { coreClient, coreServer, defineEnv } from "__SCOPE__/env";

/**
 * The environment contract for __PROJECT_NAME__.
 *
 * HARD RULE: this is the only module allowed to read `process.env`. Everywhere
 * else imports `env`. Composed from the fragments of the packages actually
 * installed, so a project without Stripe is never asked for a Stripe key.
 *
 * Validation runs at boot. Missing or malformed stops the server — which is
 * what catches a forgotten Vercel variable before it becomes a runtime bug in
 * staging rather than a build failure.
 */
export const env = defineEnv({
  server: {
    ...coreServer(),
    ...dbServer(),
    ...authServer(),
  },
  client: {
    ...coreClient(),
    ...authClient(),
  },
  // Their `_test_` / `_live_` mode must match the deployment. Checked outside
  // Zod, so SKIP_ENV_VALIDATION cannot switch it off.
  modeBoundKeys: [...AUTH_MODE_BOUND_KEYS],
  runtimeEnv: {
    NODE_ENV: process.env.NODE_ENV,
    LOG_LEVEL: process.env.LOG_LEVEL,
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
    CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
    CLERK_WEBHOOK_SIGNING_SECRET: process.env.CLERK_WEBHOOK_SIGNING_SECRET,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  },
});
