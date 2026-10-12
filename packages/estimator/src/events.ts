import { newId } from "./columns.js";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { estimatorEstimateItems, estimatorEstimates, estimatorPhotos } from "./schema.js";
import type { EstimateItemRow, EstimateRow, EstimatorDb } from "./types.js";
import type { EstimateSnapshot, EstimateSource, EstimateStatus } from "./wire.js";

/**
 * Events: one envelope for everything that happens to an estimate, so the
 * comms listener (`@adminigloo/estimator/comms`) — or a host's own Slack ping,
 * webhook or audit log — reacts to one stream instead of wrapping every
 * function.
 *
 * THE GUARANTEES (scheduling's, word for word; the comms listener and any
 * host rely on them):
 *
 *   - AFTER COMMIT. The listener runs only once the transaction has committed,
 *     so a read inside it sees the new state, and a rolled-back write never
 *     tells anybody anything.
 *   - AWAITED, IN ORDER. A serverless response must not end before the email
 *     is queued, so every listener call is awaited before the function
 *     returns, one after the other.
 *   - CONTAINED. A throwing or rejecting listener never fails the action: the
 *     lead is saved whether or not the mail server is up. The error goes to
 *     `onEventError(error, event)` if one is given.
 *   - NO SECRETS. No quote token, token hash, embed key or requester key is
 *     ever in an event — `EstimateSnapshot` has no field for them — and no
 *     cost or internal note either. Events are safe to log or queue. Whoever
 *     needs a quote link mints one (`issueQuoteToken`).
 *   - NO EVENT FOR A NO-OP: a double-tap accept, a second view, an empty
 *     expiry run.
 */

export type EstimatorEventType =
  | "lead.received"
  | "quote.sent"
  | "quote.viewed"
  | "quote.accepted"
  | "quote.declined"
  | "quote.expired"
  | "quote.revised"
  | "estimate.converted";

export interface EstimatorActor {
  type: "customer" | "staff" | "system";
  /** The staff member's user id, when the host's `authorize` named one. Null otherwise. */
  id: string | null;
}

export interface EstimatorEvent {
  /** `newId()`: unique per event. Use it as an idempotency key. */
  id: string;
  type: EstimatorEventType;
  tenantId: string;
  estimateId: string;
  /** ISO instant: the action's `now`. */
  occurredAt: string;
  actor: EstimatorActor;
  data: {
    /** The estimate AFTER the change. No costs, no internal notes, no tokens. */
    estimate: EstimateSnapshot;
    /** Should the customer be told? */
    notify: boolean;
    via?: "online" | "send" | "resend" | "staff";
    /** accepted / declined: the customer's note. */
    note?: string | null;
  };
}

export type EstimatorEventListener = (event: EstimatorEvent) => void | Promise<void>;

/** Whether the customer is told, when the caller doesn't say (6.11's table). */
export function defaultNotify(type: EstimatorEventType, actor: EstimatorActor["type"]): boolean {
  switch (type) {
    case "lead.received":
    case "quote.sent":
    case "quote.expired":
      return true;
    case "quote.accepted":
    case "quote.declined":
      return actor === "customer";
    case "quote.viewed":
    case "quote.revised":
    case "estimate.converted":
      return false;
  }
}

/** One event to emit, before its snapshot is built. */
export interface EventSpec {
  type: EstimatorEventType;
  estimateId: string;
  actor: EstimatorActor;
  notify?: boolean;
  via?: "online" | "send" | "resend" | "staff";
  note?: string | null;
}

export interface EmitContext {
  now: Date;
  onEvent?: EstimatorEventListener | undefined;
  onEventError?: ((error: unknown, event: EstimatorEvent) => void) | undefined;
}

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

/** The line's stored derivation, as `priceProduct` wrote it. */
export interface StoredDerivation {
  recipe?: string;
  explanation?: string[];
  assumption?: string | null;
  resultPhrase?: string | null;
  reasons?: string[];
  inputsSummary?: string | null;
  /** What the point price rests on ("3 steps, 7.5 in each (estimated), 23 ft of ramp"). */
  quoteBasis?: string | null;
  exact?: boolean;
  basis?: string;
  quantities?: Record<string, Record<string, number>>;
}

export function derivedOf(item: Pick<EstimateItemRow, "derived">): StoredDerivation {
  return item.derived && typeof item.derived === "object" ? (item.derived as StoredDerivation) : {};
}

/** "Surface: Heavy-duty grit", for each chosen option. */
export function optionLabels(item: Pick<EstimateItemRow, "optionSnapshot">): string[] {
  return (item.optionSnapshot ?? []).map((o) => `${o.optionName}: ${o.valueLabel}`);
}

/**
 * The estimate as an event (and the comms listener) sees it. Built from the
 * row and its lines; nothing staff-only (cost, internal notes) and nothing
 * secret has a field here.
 */
export function toEstimateSnapshot(row: EstimateRow, items: readonly EstimateItemRow[], photoCount: number): EstimateSnapshot {
  return {
    id: row.id,
    number: row.estimateNumber,
    status: row.status as EstimateStatus,
    source: row.source as EstimateSource,
    customerName: row.customerName,
    customerEmail: row.customerEmail,
    customerPhone: row.customerPhone,
    jobAddress: row.jobAddress,
    notes: row.notes,
    currency: row.currency,
    subtotal: row.subtotal,
    discount: row.discount,
    taxRateBp: row.taxRateBp,
    taxAmount: row.taxAmount,
    total: row.total,
    rangeLow: row.rangeLow,
    rangeHigh: row.rangeHigh,
    rangeReasons: Array.isArray(row.rangeReasons) ? [...row.rangeReasons] : [],
    validUntil: iso(row.validUntil),
    sentAt: iso(row.sentAt),
    viewedAt: iso(row.viewedAt),
    respondedAt: iso(row.respondedAt),
    approvedAt: iso(row.approvedAt),
    rejectedAt: iso(row.rejectedAt),
    expiredAt: iso(row.expiredAt),
    convertedAt: iso(row.convertedAt),
    archivedAt: iso(row.archivedAt),
    responseName: row.responseName,
    responseNote: row.responseNote,
    quoteMessage: row.quoteMessage,
    quoteSequence: row.quoteSequence,
    photoCount,
    lines: [...items]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((item) => {
        const derived = derivedOf(item);
        return {
          description: item.description,
          inputsSummary: derived.inputsSummary ?? null,
          quantity: item.quantity,
          total: item.total,
          lowTotal: item.lowTotal,
          highTotal: item.highTotal,
          options: optionLabels(item),
          assumption: derived.assumption ?? null,
        };
      }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Snapshots of these estimates as they are NOW, in three queries. */
export async function loadSnapshots(
  db: EstimatorDb,
  tenantId: string,
  ids: readonly string[],
): Promise<Map<string, EstimateSnapshot>> {
  const wanted = [...new Set(ids)];
  const out = new Map<string, EstimateSnapshot>();
  if (wanted.length === 0) return out;
  const rows = (await db
    .select()
    .from(estimatorEstimates)
    .where(and(eq(estimatorEstimates.tenantId, tenantId), inArray(estimatorEstimates.id, wanted)))) as EstimateRow[];
  if (rows.length === 0) return out;
  const items = (await db
    .select()
    .from(estimatorEstimateItems)
    .where(
      inArray(
        estimatorEstimateItems.estimateId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(estimatorEstimateItems.sortOrder))) as EstimateItemRow[];
  const counts = (await db
    .select({ estimateId: estimatorPhotos.estimateId, count: sql<number>`count(*)::int` })
    .from(estimatorPhotos)
    .where(
      and(
        eq(estimatorPhotos.tenantId, tenantId),
        inArray(
          estimatorPhotos.estimateId,
          rows.map((r) => r.id),
        ),
      ),
    )
    .groupBy(estimatorPhotos.estimateId)) as Array<{ estimateId: string; count: number | string }>;
  for (const row of rows) {
    const photoCount = Number(counts.find((c) => c.estimateId === row.id)?.count ?? 0);
    out.set(
      row.id,
      toEstimateSnapshot(
        row,
        items.filter((item) => item.estimateId === row.id),
        photoCount,
      ),
    );
  }
  return out;
}

/** Build the envelopes (reading each estimate as it is now), without calling anybody. */
export async function buildEvents(
  db: EstimatorDb,
  tenantId: string,
  specs: readonly EventSpec[],
  context: Pick<EmitContext, "now">,
): Promise<EstimatorEvent[]> {
  if (specs.length === 0) return [];
  const snapshots = await loadSnapshots(
    db,
    tenantId,
    specs.map((spec) => spec.estimateId),
  );
  const events: EstimatorEvent[] = [];
  for (const spec of specs) {
    const estimate = snapshots.get(spec.estimateId);
    if (!estimate) continue;
    const data: EstimatorEvent["data"] = {
      estimate,
      notify: spec.notify ?? defaultNotify(spec.type, spec.actor.type),
    };
    if (spec.via) data.via = spec.via;
    if (spec.note !== undefined) data.note = spec.note;
    events.push({
      id: newId(),
      type: spec.type,
      tenantId,
      estimateId: spec.estimateId,
      occurredAt: context.now.toISOString(),
      actor: { type: spec.actor.type, id: spec.actor.id ?? null },
      data,
    });
  }
  return events;
}

/**
 * Call the listener for each event, in order, awaiting each, containing every
 * failure. Call it only AFTER the writer's transaction has committed. With no
 * listener it does nothing at all (not even the snapshot reads).
 */
export async function emitEvents(
  db: EstimatorDb,
  tenantId: string,
  specs: readonly EventSpec[],
  context: EmitContext,
): Promise<void> {
  const listener = context.onEvent;
  if (!listener || specs.length === 0) return;
  let events: EstimatorEvent[];
  try {
    events = await buildEvents(db, tenantId, specs, context);
  } catch {
    // The action has committed; a failed snapshot read must not fail it.
    return;
  }
  for (const event of events) {
    try {
      await listener(event);
    } catch (error) {
      try {
        context.onEventError?.(error, event);
      } catch {
        /* a broken error reporter must not fail the action either */
      }
    }
  }
}
