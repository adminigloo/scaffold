import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle, type NeonDatabase } from "drizzle-orm/neon-serverless";
import ws from "ws";
import { createUnconfiguredDb } from "./unconfigured.js";

// The Neon serverless driver needs a WebSocket implementation on Node.
// Set at module load, deliberately not lazily: a lazy init races the first
// query on a cold serverless instance.
neonConfig.webSocketConstructor = ws;

declare global {
  // eslint-disable-next-line no-var
  var __adminiglooPool: Pool | undefined;
}

export interface CreateDbOptions {
  /**
   * Pooled Neon connection string.
   *
   * Undefined is a supported state, not an error: on a laptop where the Neon
   * project does not exist yet, `env.DATABASE_URL` is absent and the app still
   * has to boot. Passing it straight through keeps the guard out of every call
   * site; see the return contract below for what an undefined string produces.
   */
  connectionString: string | undefined;
  /**
   * Reuse one pool across module reloads. Set true outside production:
   * Next's hot reload re-evaluates modules on every edit, and without this
   * each edit leaks a pool until Neon refuses new connections.
   */
  reuseAcrossReloads?: boolean;
  schema?: Record<string, unknown>;
}

/**
 * Pooled Postgres connection over the WebSocket transport.
 *
 * WebSocket, not HTTP mode, and this is not a preference. HTTP mode cannot do
 * interactive transactions, so any multi-statement invariant — write a row,
 * bump a counter, advance a pointer — stops being atomic. That class of
 * corruption is silent and unrecoverable.
 *
 * With no connection string this returns a handle of the same type that opens
 * nothing and throws DatabaseNotConfiguredError on first use. Construction
 * never throws, so a project whose Neon account does not exist yet boots and
 * only the pages that actually query fail — with the variable to set named.
 */
export function createDb<TSchema extends Record<string, unknown>>(
  options: CreateDbOptions & { schema: TSchema },
): NeonDatabase<TSchema>;
export function createDb(options: CreateDbOptions): NeonDatabase<Record<string, never>>;
export function createDb(options: CreateDbOptions) {
  const { connectionString, reuseAcrossReloads = false, schema } = options;

  // Empty counts as absent. `new Pool({ connectionString: "" })` falls back to
  // libpq defaults and dials localhost, so a blank line in .env.local would
  // surface as ECONNREFUSED against a database nobody meant to use instead of
  // as "DATABASE_URL is not set".
  if (!connectionString) return createUnconfiguredDb();

  const pool =
    (reuseAcrossReloads ? globalThis.__adminiglooPool : undefined) ??
    new Pool({ connectionString });

  if (reuseAcrossReloads) globalThis.__adminiglooPool = pool;

  return schema
    ? drizzle(pool, { schema })
    : (drizzle(pool) as unknown as NeonDatabase<Record<string, never>>);
}

export type Db = NeonDatabase<Record<string, never>>;
