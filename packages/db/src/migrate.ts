import type { AppEnv } from "@adminigloo/env";

export class ProductionMigrationBlockedError extends Error {
  readonly name = "ProductionMigrationBlockedError";
  constructor(reason: string) {
    super(
      `Refusing to migrate production: ${reason}. ` +
        `Production migrations run from the deploy workflow, which sets ` +
        `allowProduction explicitly after the staging migration has succeeded.`,
    );
  }
}

export interface MigrationGuardInput {
  appEnv: AppEnv;
  /** Must be the UNPOOLED connection string. */
  connectionString: string;
  /** Only the deploy workflow sets this. */
  allowProduction?: boolean;
}

/**
 * Decide whether a migration is allowed to run, before any SQL is sent.
 *
 * Separated from the runner so it is unit-testable without a database, and so
 * a caller can check the decision without holding a connection.
 *
 * The guard is deliberately two-sided: it blocks an unauthorised production
 * run, and it also blocks an authorised production run that was handed a
 * pooled connection string — drizzle through a pooler can report success while
 * leaving the journal inconsistent, which is worse than failing.
 */
export function assertMigrationAllowed(input: MigrationGuardInput): void {
  const { appEnv, connectionString, allowProduction = false } = input;

  if (connectionString.includes("-pooler")) {
    throw new ProductionMigrationBlockedError(
      "the connection string is the POOLED endpoint. Use DATABASE_URL_UNPOOLED",
    );
  }

  if (appEnv === "production" && !allowProduction) {
    throw new ProductionMigrationBlockedError(
      "allowProduction was not set. This looks like a hand-run migration",
    );
  }
}
