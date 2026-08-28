/**
 * This project's schema.
 *
 * Base tables come from the packages that own them — re-exported here so
 * drizzle-kit sees one schema, and so a migration covers base and app tables
 * in the right order. Do not copy a base table's definition into this file: the
 * package owns its migrations, and a local copy silently forks them.
 */
export * from "__SCOPE__/auth/schema";
export * from "__SCOPE__/tenancy/schema";
export * from "__SCOPE__/permissions/schema";

// ---------------------------------------------------------------------------
// __PROJECT_NAME__ tables go below. Use the shared column helpers so ids,
// timestamps and money follow the same rules everywhere:
//
//   import { idColumn, createdAt, updatedAt, amountMinor } from "__SCOPE__/db";
// ---------------------------------------------------------------------------
