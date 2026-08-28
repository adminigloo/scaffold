import { createDb } from "__SCOPE__/db";
import { env } from "@/env";
import * as schema from "./schema";

/**
 * The database handle.
 *
 * `reuseAcrossReloads` outside production because Next re-evaluates modules on
 * every edit in dev, and without the guard each edit leaks a connection pool
 * until Neon starts refusing new connections.
 */
export const db = createDb({
  connectionString: env.DATABASE_URL,
  reuseAcrossReloads: env.NODE_ENV !== "production",
  schema,
});

export type Db = typeof db;
