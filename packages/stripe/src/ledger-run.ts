import { eq, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { decideClaim, DEFAULT_CLAIM_LEASE_MS } from "./ledger.js";
import { stripeEvents } from "./schema.js";

/**
 * THE LEDGER PROTOCOL AS ONE CALL (stripe 0.4), for the Connect webhook and the
 * single-business invoice webhook. The platform's own route still spells the
 * protocol out inline; this is the same four statements (`claimStatements`)
 * in the same order, so a new route can't drop one:
 *
 *   1. INSERT … ON CONFLICT (event_id) DO NOTHING RETURNING — a row back means
 *      this delivery owns the event;
 *   2. otherwise read processed_at/claimed_at → done (duplicate), someone else
 *      in flight (retry later: 500), or abandoned (take it over);
 *   3. run the handler; on success stamp processed_at, on a throw RELEASE the
 *      claim and keep the message, so the next delivery re-claims at once.
 *
 * `key` is the ledger's event id. A Connect event's is `connectLedgerKey`
 * (account + event), so two accounts' events can never collide.
 */

export interface LedgeredEvent {
  readonly key: string;
  readonly type: string;
  /** The company the event belongs to, resolved before the call; null when none. */
  readonly tenantId: string | null;
  /** The verified event, stored as is. */
  readonly payload: unknown;
}

export type LedgerRunResult =
  | { readonly outcome: "processed" }
  | { readonly outcome: "duplicate" }
  | { readonly outcome: "in-flight" }
  | { readonly outcome: "failed"; readonly error: unknown };

/** The HTTP status each outcome answers: a duplicate is done (200), in flight or failed asks Stripe to retry (500). */
export function ledgerRunStatus(result: LedgerRunResult): 200 | 500 {
  return result.outcome === "processed" || result.outcome === "duplicate" ? 200 : 500;
}

function rowsOf(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  const rows = (result as { rows?: unknown }).rows;
  return Array.isArray(rows) ? rows : [];
}

export async function runLedgeredEvent(
  db: PgDatabase<any, any, any>,
  event: LedgeredEvent,
  handler: () => Promise<void>,
  options: { readonly leaseMs?: number } = {},
): Promise<LedgerRunResult> {
  const inserted = await db.execute(
    sql`INSERT INTO stripe_events (event_id, type, tenant_id, payload, claimed_at, attempts)
        VALUES (${event.key}, ${event.type}, ${event.tenantId}, ${JSON.stringify(event.payload ?? null)}::jsonb, now(), 1)
        ON CONFLICT (event_id) DO NOTHING
        RETURNING event_id`,
  );
  const insertedRow = rowsOf(inserted).length === 1;
  let existingProcessedAt: Date | null = null;
  let existingClaimedAt: Date | null = null;
  if (!insertedRow) {
    const [row] = (await db
      .select({ processedAt: stripeEvents.processedAt, claimedAt: stripeEvents.claimedAt })
      .from(stripeEvents)
      .where(eq(stripeEvents.eventId, event.key))
      .limit(1)) as Array<{ processedAt: Date | null; claimedAt: Date | null }>;
    existingProcessedAt = row?.processedAt ?? null;
    existingClaimedAt = row?.claimedAt ?? null;
  }
  const outcome = decideClaim({ insertedRow, existingProcessedAt, existingClaimedAt, leaseMs: options.leaseMs ?? DEFAULT_CLAIM_LEASE_MS });
  if (outcome.action === "skip-duplicate") return { outcome: "duplicate" };
  if (outcome.action === "retry-later") return { outcome: "in-flight" };
  if (outcome.reclaimed) {
    const retaken = await db.execute(
      sql`UPDATE stripe_events SET claimed_at = now(), attempts = attempts + 1
          WHERE event_id = ${event.key} AND processed_at IS NULL
          RETURNING event_id`,
    );
    if (rowsOf(retaken).length === 0) return { outcome: "duplicate" };
  }
  try {
    await handler();
  } catch (error) {
    await db
      .update(stripeEvents)
      .set({ claimedAt: null, lastError: error instanceof Error ? error.message : String(error) })
      .where(eq(stripeEvents.eventId, event.key));
    return { outcome: "failed", error };
  }
  await db.update(stripeEvents).set({ processedAt: new Date(), claimedAt: null, lastError: null }).where(eq(stripeEvents.eventId, event.key));
  return { outcome: "processed" };
}
