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
