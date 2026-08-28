import { bigint, bigserial, text, timestamp } from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";

/**
 * Column conventions, applied by every package and every generated app.
 *
 *   - Entity primary keys: UUID v7 — sortable by creation time, globally
 *     unique, URL-safe. Sortability is why not v4: it keeps index locality
 *     and makes "most recent" queries cheap without a separate column.
 *   - Identity-provider-owned rows: text PKs holding the provider's own id.
 *   - Append-only logs: bigserial. Cheaper than UUIDs when nothing references
 *     the row and volume is high.
 *   - Money: bigint minor units. Never a float, never `numeric` in app code.
 *   - Timestamps: timestamptz, always UTC.
 *   - `text` over `varchar(n)` — Zod enforces length at the boundary, where
 *     the error can be a useful message instead of a driver exception.
 */

/** UUID v7 — sortable by creation time, safe to expose in a URL. */
export const newId = (): string => uuidv7();

/** Primary key for an entity table. */
export const idColumn = () => text("id").primaryKey().$defaultFn(newId);

/** Primary key for an append-only log table. */
export const logIdColumn = () => bigserial("id", { mode: "bigint" }).primaryKey();

export const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/**
 * Soft-delete marker. Applied per table, not by default.
 *
 * Rows mirrored from an identity provider need this: webhook events arrive out
 * of order, and a hard delete makes a late `user.updated` unreconcilable.
 */
export const deletedAt = () => timestamp("deleted_at", { withTimezone: true });

/** Money, in minor units (cents). */
export const amountMinor = (name: string) =>
  bigint(name, { mode: "bigint" }).notNull();
