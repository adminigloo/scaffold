import { text, timestamp } from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";

/**
 * COPIED FROM @adminigloo/db's columns.ts (`newId`, `idColumn`, `createdAt`,
 * `updatedAt`); change both or neither.
 *
 * WHY A COPY AND NOT AN IMPORT. `@adminigloo/db`'s entry point also builds the
 * Neon client: importing it loads `@neondatabase/serverless`, `ws` and the
 * environment loader, and sets the Neon socket at module load. A host on
 * node-postgres (or Prisma, or anything that isn't Neon) installing this
 * package would then need a database driver it never uses, and with
 * `--legacy-peer-deps` the import crashed naming it (review RL-03). These four
 * helpers need only drizzle and `uuidv7`, so they live here.
 */

/** UUID v7: sortable by creation time, safe to expose in a URL. */
export const newId = (): string => uuidv7();

/** Primary key for an entity table. */
export const idColumn = () => text("id").primaryKey().$defaultFn(newId);

export const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
