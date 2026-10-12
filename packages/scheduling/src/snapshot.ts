import { formatIcsUtc } from "./ics.js";
import { instantsOf, labelOf } from "./instants.js";
import { serviceNameFor, type SchedulingService } from "./services.js";
import { nextBookingStatuses } from "./status.js";
import type { BookingRow } from "./types.js";
import type { PublicVisit, PublicVisitStatus, VisitSnapshot, VisitStatus } from "./wire.js";

/**
 * Row → wire, pure. THE ONE MAPPING of a visit row to what staff see
 * (`toVisitSnapshot`) and to what its customer sees (`toPublicVisit`). Every
 * read model, every handler and every event goes through these two, so a field
 * can't be renamed in one place and forgotten in another, and nothing a
 * customer must not see (another visit, the requester key, the crew's id) can
 * reach `PublicVisit` by accident: it is built field by field.
 */

/** The settings the projections read. */
export interface SnapshotSettings {
  timeZone: string;
  services: readonly SchedulingService[];
}

const iso = (date: Date | null | undefined): string | null => (date ? date.toISOString() : null);

function asVisitStatus(status: string): VisitStatus {
  return status as VisitStatus;
}

function asCancelledBy(value: string | null): VisitSnapshot["cancelledBy"] {
  return value === "customer" || value === "staff" || value === "system" ? value : null;
}

/** A visit as staff see it (section 7's `VisitSnapshot`). */
export function toVisitSnapshot(
  row: BookingRow,
  context: { settings: SnapshotSettings; resourceName: string | null },
): VisitSnapshot {
  const { settings } = context;
  const { startsAt, endsAt } = instantsOf(row, settings.timeZone);
  return {
    id: row.id,
    status: asVisitStatus(row.status),
    nextStatuses: [...nextBookingStatuses(row.status)] as VisitStatus[],
    date: labelOf(row.scheduledDate),
    startTime: row.startTime,
    endTime: row.endTime,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    timeZone: settings.timeZone,
    durationMinutes: row.durationMinutes,
    resourceId: row.resourceId,
    resourceName: row.resourceId ? context.resourceName : null,
    serviceKey: row.serviceType,
    serviceName: serviceNameFor(settings.services, row.serviceType),
    title: row.title,
    customerName: row.customerName,
    customerEmail: row.customerEmail,
    customerPhone: row.customerPhone,
    address: row.address,
    lat: row.lat,
    lng: row.lng,
    notes: row.notes,
    estimateId: row.estimateId,
    origin: row.origin === "public" ? "public" : "staff",
    sequence: row.sequence,
    pendingExpiresAt: iso(row.pendingExpiresAt),
    cancelledAt: iso(row.cancelledAt),
    cancelledBy: asCancelledBy(row.cancelledBy),
    cancelReason: row.cancelReason,
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** pending → requested, no_show → missed, the rest the same. */
export function toPublicVisitStatus(status: string): PublicVisitStatus {
  if (status === "pending") return "requested";
  if (status === "no_show") return "missed";
  return status as PublicVisitStatus;
}

/** The settings `toPublicVisit` and the change rules read. */
export interface PublicVisitSettings extends SnapshotSettings {
  businessName: string;
  contactEmail: string | null;
  contactPhone: string | null;
  cancelCutoffHours: number;
  publicBookingEnabled: boolean;
}

/**
 * A request whose deadline has passed and that nobody has answered: it holds
 * no time any more (see `notOverdue`), whether or not the sweep has flipped
 * it to `expired` yet. Every decision a customer can make treats it as
 * expired — on Vercel Hobby the sweep may be most of a day behind, and in that
 * gap a customer moving their overdue request was told "moved, as you asked",
 * lost the slot to the next booker, and then heard it had lapsed.
 */
export function isOverdueRequest(row: Pick<BookingRow, "status" | "pendingExpiresAt">, now: Date): boolean {
  return row.status === "pending" && row.pendingExpiresAt !== null && row.pendingExpiresAt.getTime() <= now.getTime();
}

/** The status a customer is shown and acted on: `expired` for an overdue request, else the row's own. */
export function effectiveStatus(row: Pick<BookingRow, "status" | "pendingExpiresAt">, now: Date): string {
  return isOverdueRequest(row, now) ? "expired" : row.status;
}

/**
 * Whether the customer may still change this visit online: it is pending (and
 * not past its deadline) or confirmed, AND `now` is before `startsAt −
 * cancelCutoffHours`.
 *
 * WHY A CUTOFF AND NOT JUST "BEFORE IT STARTS". A crew plans its day the
 * evening before. A same-morning online cancel is a lost slot nobody can
 * refill, and the business would rather take the call.
 */
export function changeWindow(
  row: BookingRow,
  settings: Pick<PublicVisitSettings, "timeZone" | "cancelCutoffHours">,
  now: Date,
): { changeable: boolean; deadline: Date | null; startsAt: Date } {
  const { startsAt } = instantsOf(row, settings.timeZone);
  const open = (row.status === "pending" && !isOverdueRequest(row, now)) || row.status === "confirmed";
  if (!open) return { changeable: false, deadline: null, startsAt };
  const deadline = new Date(startsAt.getTime() - settings.cancelCutoffHours * 3_600_000);
  return { changeable: now.getTime() < deadline.getTime(), deadline, startsAt };
}

const GONE: ReadonlySet<string> = new Set(["cancelled", "declined", "expired"]);

/**
 * Google Calendar's one-click "add event" link: a template a person saves
 * themselves, so it needs no account and no OAuth. It carries no manage link —
 * this URL ends up in browser history and in Google's servers, and a manage
 * link is a key.
 */
export function visitGoogleCalendarUrl(input: {
  title: string;
  startsAt: Date;
  endsAt: Date;
  location?: string | null;
  details?: string | null;
}): string {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: input.title,
    dates: `${formatIcsUtc(input.startsAt)}/${formatIcsUtc(input.endsAt)}`,
  });
  if (input.details) params.set("details", input.details);
  if (input.location) params.set("location", input.location);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/** "Free estimate — Acme Windows", or just the service when the business has no name saved. */
export function visitTitle(serviceName: string, businessName: string): string {
  return businessName.trim() ? `${serviceName} — ${businessName.trim()}` : serviceName;
}

/** The contact line for the customer's calendar entry: "Questions? Call (801) 555-0143." */
function contactDetails(settings: Pick<PublicVisitSettings, "contactPhone" | "contactEmail">): string | null {
  if (settings.contactPhone && settings.contactEmail) {
    return `Questions? Call ${settings.contactPhone} or email ${settings.contactEmail}.`;
  }
  if (settings.contactPhone) return `Questions? Call ${settings.contactPhone}.`;
  if (settings.contactEmail) return `Questions? Email ${settings.contactEmail}.`;
  return null;
}

/**
 * A visit as its customer sees it (section 7's `PublicVisit`), built field by
 * field: no crew, no requester key, no other visit, no internal ids. The
 * cutoff decides `canCancel`/`canReschedule`; a business that has switched
 * online booking off still lets customers cancel, but not move. A request past
 * its deadline reads `expired` (with "Book a new time"), whatever the sweep
 * has got round to.
 */
export function toPublicVisit(row: BookingRow, settings: PublicVisitSettings, options: { now: Date }): PublicVisit {
  const { startsAt, endsAt } = instantsOf(row, settings.timeZone);
  const window = changeWindow(row, settings, options.now);
  const serviceName = serviceNameFor(settings.services, row.serviceType);
  const status = effectiveStatus(row, options.now);
  const cancelledBy =
    row.cancelledBy === "customer" ? "customer" : row.cancelledBy === "staff" || row.cancelledBy === "system" ? "business" : null;
  return {
    status: toPublicVisitStatus(status),
    serviceKey: row.serviceType,
    serviceName,
    date: labelOf(row.scheduledDate),
    startTime: row.startTime,
    endTime: row.endTime,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    timeZone: settings.timeZone,
    durationMinutes: row.durationMinutes,
    customerName: row.customerName ?? "",
    address: row.address,
    businessName: settings.businessName,
    contactPhone: settings.contactPhone,
    contactEmail: settings.contactEmail,
    canReschedule: window.changeable && settings.publicBookingEnabled,
    canCancel: window.changeable,
    changeDeadline: window.deadline ? window.deadline.toISOString() : null,
    cancelCutoffHours: settings.cancelCutoffHours,
    cancelledBy,
    googleCalendarUrl: GONE.has(status)
      ? null
      : visitGoogleCalendarUrl({
          title: visitTitle(serviceName, settings.businessName),
          startsAt,
          endsAt,
          location: row.address,
          details: contactDetails(settings),
        }),
  };
}
