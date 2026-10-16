import { text, timestamp } from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";

/**
 * COPIED FROM @adminigloo/db's columns.ts (`newId`, `idColumn`, `createdAt`),
 * comms' arrangement; change both or neither.
 *
 * WHY A COPY AND NOT AN IMPORT (D14, IF-19). `@adminigloo/db`'s entry point
 * also builds the Neon client: importing it loads `@neondatabase/serverless`,
 * `ws` and the environment loader, and sets the Neon socket at module load. A
 * host on node-postgres (or Prisma, or anything that isn't Neon) installing
 * this package would then need a database driver it never uses. These helpers
 * need only drizzle and `uuidv7`, so they live here.
 *
 * Step 0 of the contract's hand-off (18.1) drops the `@adminigloo/db`
 * dependency, so the 0.1 schema imports these from here; the files builder
 * owns this file from 6.1 on.
 */

/** UUID v7: sortable by creation time, safe to expose in a URL. */
export const newId = (): string => uuidv7();

/** Primary key for an entity table. */
export const idColumn = () => text("id").primaryKey().$defaultFn(newId);

export const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
