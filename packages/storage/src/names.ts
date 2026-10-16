/**
 * Every name the storage table set uses, from `{ prefix, schema }` (D14). One
 * function, read by both the drizzle table (schema.ts) and the shipped SQL
 * (sql.ts), so the two can never disagree about a name.
 */

/** "" (the 0.1 names) or lower-case letters, digits and underscores ending in `_`, at most 32 characters. */
const PREFIX_PATTERN = /^[a-z][a-z0-9_]{0,30}_$/;
/** A Postgres schema name of the host's. */
const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;
/** Postgres truncates identifiers past 63 bytes, which makes drizzle-kit see a rename on every push. */
const PG_MAX_IDENTIFIER = 63;

export interface DefineStorageTablesOptions {
  /** "" (default: the 0.1 name) or /^[a-z][a-z0-9_]{0,30}_$/. */
  readonly prefix?: string;
  /** A Postgres schema of the host's; default none (the connection's search path). /^[a-z_][a-z0-9_]{0,62}$/. */
  readonly schema?: string;
}

/** A prefix or a schema name that isn't safe to put in DDL. */
export class InvalidTableNameError extends Error {
  readonly name = "InvalidTableNameError";
}

export function storageNames(options: DefineStorageTablesOptions = {}) {
  const prefix = options.prefix ?? "";
  if (typeof prefix !== "string" || (prefix !== "" && !PREFIX_PATTERN.test(prefix))) {
    throw new InvalidTableNameError(
      `@adminigloo/storage: the table prefix must be "" or lower-case letters, digits and underscores ending in "_", at most 32 characters (got ${JSON.stringify(prefix)}).`,
    );
  }
  const schema = options.schema ?? null;
  if (schema !== null && (typeof schema !== "string" || !SCHEMA_PATTERN.test(schema))) {
    throw new InvalidTableNameError(
      `@adminigloo/storage: the schema must be lower-case letters, digits and underscores, at most 63 characters (got ${JSON.stringify(schema)}).`,
    );
  }
  const table = `${prefix}stored_files`;
  /**
   * The full name when it fits; otherwise a shorter `{prefix}sf_{what}` form
   * (the analytics rule). Never for the default prefix, and with the longest
   * prefix allowed every name below still fits (32 + 31 = 63): the rule is
   * here so a future index can't silently pass the limit.
   */
  const fitted = (full: string, short: string) => (full.length <= PG_MAX_IDENTIFIER ? full : `${prefix}${short}`);
  return {
    prefix,
    schema,
    table,
    /** `"adminigloo"."stored_files"` or `"stored_files"`: what DDL and to_regclass name. */
    qualified: schema ? `"${schema}"."${table}"` : `"${table}"`,
    /** `adminigloo.stored_files` or `stored_files`: what a person reads in an error. */
    display: schema ? `${schema}.${table}` : table,
    indexes: {
      tenantCreated: fitted(`${table}_tenant_created_idx`, "sf_tenant_created_idx"),
      tenantKind: fitted(`${table}_tenant_kind_idx`, "sf_tenant_kind_idx"),
      pathname: fitted(`${table}_pathname_uidx`, "sf_pathname_uidx"),
      record: fitted(`${table}_record_idx`, "sf_record_idx"),
      live: fitted(`${table}_live_idx`, "sf_live_idx"),
      purge: fitted(`${table}_purge_idx`, "sf_purge_idx"),
    },
  } as const;
}
