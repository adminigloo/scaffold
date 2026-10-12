import { newId } from "@adminigloo/db";
import { and, eq, inArray } from "drizzle-orm";
import { instantsOf, labelOf } from "./instants.js";
import { schedulingResources } from "./schema.js";
import { toVisitSnapshot, type SnapshotSettings } from "./snapshot.js";
import type { BookingRow, SchedulingDb } from "./types.js";
import type { VisitSnapshot } from "./wire.js";

/**
 * Events: one envelope for everything that happens to a visit, so the comms
 * listener (`@adminigloo/scheduling/comms`) — or a host's own Slack ping,
 * webhook or audit log — reacts to one stream instead of wrapping every
 * function.
 *
 * THE GUARANTEES (the comms listener and any host rely on them):
 *
 *   - AFTER COMMIT. The listener runs only once the transaction has committed,
 *     so a read inside it sees the new state, and a rolled-back write never
 *     tells anybody anything.
 *   - AWAITED, IN ORDER. A serverless response must not end before the email
 *     is queued, so every listener call is awaited before the function
 *     returns. When one action emits two events (an auto-confirmed request:
 *     requested, then confirmed), they run one after the other.
 *   - CONTAINED. A throwing or rejecting listener never fails the action: the
 *     visit is booked whether or not the mail server is up. The error goes to
 *     `onEventError(error, event)` if one is given.
 *   - NO SECRETS. No manage token, token hash or requester key is ever in an
 *     event — `VisitSnapshot` has no field for them. Events are safe to log or
 *     queue. Whoever needs a manage link mints one (`issueManageToken`).
 *   - NO EVENT FOR A NO-OP: a repeated request, re-asserting a status, or a
 *     move to the same time and crew.
 */

export type SchedulingEventType =
  | "visit.requested" | "visit.confirmed" | "visit.declined" | "visit.rescheduled" | "visit.reassigned"
  | "visit.cancelled" | "visit.expired" | "visit.started" | "visit.completed";

export interface SchedulingActor {
  type: "customer" | "staff" | "system";
  /** The staff member's user id, when the host's `authorize` named one. Null otherwise. */
  id: string | null;
}

/**
 * How the change came about: `online` (the booking page), `staff`, `auto`
 * (auto-confirm), `accept`, `restore`, `time_zone` (the business corrected its
 * zone; the wall clock stayed), and `contact` (staff corrected the customer's
 * email address: the visit is re-sent to the new one, see
 * `updateBookingDetails`).
 */
export type SchedulingEventVia = "online" | "staff" | "auto" | "accept" | "restore" | "time_zone" | "contact";

export interface SchedulingEventPrevious {
  date: string;
  startTime: string;
  endTime: string;
  startsAt: string;
  endsAt: string;
  resourceId: string | null;
  resourceName: string | null;
}

export interface SchedulingEvent {
  /** `newId()` from @adminigloo/db: unique per event. Use it as an idempotency key. */
  id: string;
  type: SchedulingEventType;
  tenantId: string;
  visitId: string;
  /** ISO instant: the action's `now`. */
  occurredAt: string;
  actor: SchedulingActor;
  data: {
    /** The visit AFTER the change. */
    visit: VisitSnapshot;
    /** Should the customer be told? */
    notify: boolean;
    via?: SchedulingEventVia;
    /** rescheduled, reassigned: where it was. */
    previous?: SchedulingEventPrevious;
    /** declined, cancelled: what staff (or the customer) typed. */
    reason?: string | null;
    /**
     * requested: the customer sent an address the map couldn't find and chose
     * to send it anyway, so the office should check it with them.
     */
    addressUnverified?: boolean;
  };
}

export type SchedulingEventListener = (event: SchedulingEvent) => void | Promise<void>;

/**
 * Whether the customer is told, when the caller doesn't say. True for the
 * events that change what the customer expects; false for the crew's own
 * progress (started, completed). A time-zone reschedule passes false itself:
 * the wall-clock time the customer was shown didn't move.
 */
export function defaultNotify(type: SchedulingEventType): boolean {
  return type !== "visit.started" && type !== "visit.completed";
}

/** One event to emit, before its snapshot is built. */
export interface EventSpec {
  type: SchedulingEventType;
  row: BookingRow;
  actor: SchedulingActor;
  notify?: boolean;
  via?: SchedulingEventVia;
  /** The visit as it was, for a reschedule or reassignment. */
  previous?: BookingRow;
  reason?: string | null;
  addressUnverified?: boolean;
}

export interface EmitContext {
  settings: SnapshotSettings;
  now: Date;
  onEvent?: SchedulingEventListener | undefined;
  onEventError?: ((error: unknown, event: SchedulingEvent) => void) | undefined;
  /**
   * How many listener calls may run at once. Default 1: in order, one after
   * the other — what every single action needs (an auto-confirmed request's
   * requested, then confirmed). Only a batch of events about DIFFERENT visits
   * raises it: a time-zone save re-queues every upcoming visit's reminder, and
   * hundreds of those one after another, inside the HTTP request, can outlast
   * the function's time limit part-way through.
   */
  concurrency?: number;
}

/** The names of these crews, in ONE query. */
export async function resourceNames(
  db: SchedulingDb,
  tenantId: string,
  ids: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))];
  const names = new Map<string, string>();
  if (wanted.length === 0) return names;
  const rows = (await db
    .select({ id: schedulingResources.id, name: schedulingResources.name })
    .from(schedulingResources)
    .where(and(eq(schedulingResources.tenantId, tenantId), inArray(schedulingResources.id, wanted)))) as Array<{
    id: string;
    name: string;
  }>;
  for (const row of rows) names.set(row.id, row.name);
  return names;
}

/** Build the envelopes (one query for the crew names), without calling anybody. */
export async function buildEvents(
  db: SchedulingDb,
  tenantId: string,
  specs: readonly EventSpec[],
  context: Pick<EmitContext, "settings" | "now">,
): Promise<SchedulingEvent[]> {
  if (specs.length === 0) return [];
  let names = new Map<string, string>();
  try {
    names = await resourceNames(
      db,
      tenantId,
      specs.flatMap((spec) => [spec.row.resourceId, spec.previous?.resourceId]),
    );
  } catch {
    // The crew names are a nicety. A failed read must not cost the customer
    // their confirmation email for an action that has already committed.
  }
  const nameOf = (id: string | null): string | null => (id ? (names.get(id) ?? null) : null);
  return specs.map((spec) => {
    const data: SchedulingEvent["data"] = {
      visit: toVisitSnapshot(spec.row, { settings: context.settings, resourceName: nameOf(spec.row.resourceId) }),
      notify: spec.notify ?? defaultNotify(spec.type),
    };
    if (spec.via) data.via = spec.via;
    if (spec.previous) {
      const before = instantsOf(spec.previous, context.settings.timeZone);
      data.previous = {
        date: labelOf(spec.previous.scheduledDate),
        startTime: spec.previous.startTime,
        endTime: spec.previous.endTime,
        startsAt: before.startsAt.toISOString(),
        endsAt: before.endsAt.toISOString(),
        resourceId: spec.previous.resourceId,
        resourceName: nameOf(spec.previous.resourceId),
      };
    }
    if (spec.reason !== undefined) data.reason = spec.reason;
    if (spec.addressUnverified) data.addressUnverified = true;
    return {
      id: newId(),
      type: spec.type,
      tenantId,
      visitId: spec.row.id,
      occurredAt: context.now.toISOString(),
      actor: { type: spec.actor.type, id: spec.actor.id ?? null },
      data,
    };
  });
}

/**
 * Call the listener for each event, in order, awaiting each, containing every
 * failure. Call it only AFTER the writer's transaction has committed. With no
 * listener it does nothing at all (not even the crew-name query).
 */
export async function emitEvents(
  db: SchedulingDb,
  tenantId: string,
  specs: readonly EventSpec[],
  context: EmitContext,
): Promise<void> {
  const listener = context.onEvent;
  if (!listener || specs.length === 0) return;
  const events = await buildEvents(db, tenantId, specs, context);
  const deliver = async (event: SchedulingEvent): Promise<void> => {
    try {
      await listener(event);
    } catch (error) {
      try {
        context.onEventError?.(error, event);
      } catch {
        /* a broken error reporter must not fail the action either */
      }
    }
  };
  const width = Math.max(1, Math.min(32, Math.trunc(context.concurrency ?? 1)));
  if (width === 1) {
    for (const event of events) await deliver(event);
    return;
  }
  // A small pool: `width` workers taking the next event until none are left.
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < events.length) {
      const event = events[next] as SchedulingEvent;
      next += 1;
      await deliver(event);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, events.length) }, worker));
}
