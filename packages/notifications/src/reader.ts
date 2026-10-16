import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { AlertRegistry } from "./registry.js";
import type { NotificationTables } from "./schema.js";

/**
 * READS NARROW, NEVER WIDEN (D2, review G4).
 *
 * A row was written for a person because of what they held THEN. Reads show
 * only what they may get NOW: a row reached through the audience needs its
 * kind's `audience.permission`, one reached through assignment needs the
 * kind's `assigned.permission`, and a kind no longer registered (an
 * uninstalled feature) shows to nobody. So someone demoted from admin to
 * Crew stops seeing the old lead alerts (with customers' phone numbers) on
 * their next poll, whatever the host's role model; `prune` (on a role change)
 * then deletes them outright, as housekeeping, not as the guard.
 *
 * THIS IS A RUNTIME PERMISSION FILTER OVER A GENERATED LIST: the kinds come
 * from the project's registry, the permissions from the reader. The same
 * filter is in `list`, the count and every mark, so the badge and the list
 * never disagree.
 */

export interface ReaderKinds {
  /** Kinds whose `audience.permission` the reader holds: their `audience` rows show. */
  readonly audience: readonly string[];
  /** Kinds whose `assigned.permission` the reader holds: their `assigned` rows show. */
  readonly assigned: readonly string[];
}

/** The kinds a reader holding `permissions` may see, by how a row reached them. */
export function readerKinds(registry: AlertRegistry, permissions: readonly string[]): ReaderKinds {
  const held = new Set(permissions);
  const audience: string[] = [];
  const assigned: string[] = [];
  for (const kind of registry.kinds) {
    if (held.has(kind.audience.permission)) audience.push(kind.key);
    if (kind.audience.assigned && held.has(kind.audience.assigned.permission)) assigned.push(kind.key);
  }
  return { audience, assigned };
}

/**
 * prune's two lists (D9, review G4): the registered kinds whose rows this
 * person may NO LONGER see after a role change, by `reached_via`. A kind
 * with no `assigned` any more has no assigned rows anyone may see.
 */
export function prunedKinds(registry: AlertRegistry, permissions: readonly string[]): ReaderKinds {
  const held = new Set(permissions);
  const audience: string[] = [];
  const assigned: string[] = [];
  for (const kind of registry.kinds) {
    if (!held.has(kind.audience.permission)) audience.push(kind.key);
    if (!kind.audience.assigned || !held.has(kind.audience.assigned.permission)) assigned.push(kind.key);
  }
  return { audience, assigned };
}

/** `kind = any(list)`, or false for an empty list (an empty `in ()` is never sent). */
function kindIn(tables: NotificationTables, kinds: readonly string[]): SQL {
  return kinds.length > 0 ? inArray(tables.alerts.kind, [...kinds]) : sql`false`;
}

/**
 * The WHERE fragment every read adds: (`reached_via = 'audience'` and the
 * kind's audience permission is held) or (`reached_via = 'assigned'` and its
 * assigned permission is held). `address` rows (email-only addresses) are
 * never shown to anyone.
 */
export function readerFilter(tables: NotificationTables, kinds: ReaderKinds): SQL {
  const t = tables.alerts;
  return (
    or(and(eq(t.reachedVia, "audience"), kindIn(tables, kinds.audience)), and(eq(t.reachedVia, "assigned"), kindIn(tables, kinds.assigned))) ??
    sql`false`
  );
}

/** prune's WHERE fragment: the same shape over `prunedKinds`' lists (the rows they may no longer see). */
export const prunedFilter: (tables: NotificationTables, kinds: ReaderKinds) => SQL = readerFilter;
