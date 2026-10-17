import type { BookingPermission } from "./permissions.js";

/**
 * One route of the booking handlers, as data (the Tenancy 2a route-table
 * shape, 3.1). The package's tests read it back; a generated companies
 * project's isolation proof drives every row as ANOTHER company. Declared
 * here, never imported from a shared package.
 */
export interface BookingRoute<K extends string = string> {
  readonly kind: K;
  readonly method: "GET" | "POST";
  /** Relative to the handler's mount, e.g. "v1/bookings/{booking}/cancel". */
  readonly path: string;
  /** The permission `authorize` is asked for (private routes); null on public routes. */
  readonly permission: string | null;
  readonly query?: Readonly<Record<string, string>>;
  /** The smallest body its schema accepts. Placeholders allowed in string values. */
  readonly body?: unknown;
}

export type BookingAdminRouteKind =
  | "bookings"
  | "booking"
  | "booking-cancel"
  | "booking-confirm"
  | "booking-outcome"
  | "booking-move"
  | "booking-slots"
  | "bookings-cancel-email"
  | "hosts"
  | "host-add"
  | "host-update"
  | "host-test"
  | "host-feed"
  | "availability"
  | "availability-set"
  | "exception-add"
  | "exception-remove"
  | "holidays"
  | "holiday-add"
  | "holiday-remove"
  | "types"
  | "type-add"
  | "type-update"
  | "holds"
  | "team";

export type BookingPublicRouteKind =
  | "config"
  | "slots"
  | "hold"
  | "release"
  | "book"
  | "manage"
  | "cancel"
  | "reschedule"
  | "ics"
  | "feed";

/** The permission each private route asks for, as data. */
export const BOOKING_ADMIN_ROUTE_PERMISSIONS: Readonly<Record<BookingAdminRouteKind, BookingPermission>> = {
  bookings: "booking.calls.view",
  booking: "booking.calls.view",
  "booking-cancel": "booking.calls.manage",
  "booking-confirm": "booking.calls.manage",
  "booking-outcome": "booking.calls.manage",
  "booking-move": "booking.calls.manage",
  "booking-slots": "booking.calls.manage",
  "bookings-cancel-email": "booking.calls.manage",
  hosts: "booking.calls.view",
  "host-add": "booking.settings.manage",
  "host-update": "booking.settings.manage",
  "host-test": "booking.settings.manage",
  "host-feed": "booking.settings.manage",
  availability: "booking.calls.view",
  "availability-set": "booking.availability.manage",
  "exception-add": "booking.availability.manage",
  "exception-remove": "booking.availability.manage",
  holidays: "booking.calls.view",
  "holiday-add": "booking.availability.manage",
  "holiday-remove": "booking.availability.manage",
  types: "booking.calls.view",
  "type-add": "booking.settings.manage",
  "type-update": "booking.settings.manage",
  holds: "booking.calls.view",
  team: "booking.settings.manage",
};

function freeze<T extends readonly BookingRoute[]>(routes: T): T {
  for (const route of routes) Object.freeze(route);
  return Object.freeze(routes) as T;
}

const P = BOOKING_ADMIN_ROUTE_PERMISSIONS;
const PROBE_START = "2031-03-11T15:00:00.000Z";
const PROBE_TYPE = {
  key: "isolation-probe",
  name: "Isolation probe call",
  description: null,
  durationMinutes: 30,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  stepMinutes: 30,
  minNoticeMinutes: 240,
  horizonDays: 21,
  maxPerDay: null,
  media: ["video"],
  hostIds: [],
  isActive: true,
  sortOrder: 0,
};
const PROBE_HOST = { displayName: "Isolation probe host", email: "probe@isolation.example", timezone: "UTC" };

/**
 * Every private route, under `{mount}/` (a companies project mounts it at
 * /api/app/{company id}/calls/). The entities are the company's own:
 * `{booking}`, `{host}`, `{exception}`, `{holiday}`, `{type}` — another
 * company's is "not found", like an id that never existed.
 */
export const BOOKING_ADMIN_ROUTES: readonly BookingRoute<BookingAdminRouteKind>[] = freeze([
  { kind: "bookings", method: "GET", path: "v1/bookings", permission: P.bookings, query: { scope: "upcoming" } },
  { kind: "booking", method: "GET", path: "v1/bookings/{booking}", permission: P.booking },
  { kind: "booking-cancel", method: "POST", path: "v1/bookings/{booking}/cancel", permission: P["booking-cancel"], body: { reason: null } },
  { kind: "booking-confirm", method: "POST", path: "v1/bookings/{booking}/confirm", permission: P["booking-confirm"], body: {} },
  { kind: "booking-outcome", method: "POST", path: "v1/bookings/{booking}/outcome", permission: P["booking-outcome"], body: { outcome: "Isolation probe" } },
  { kind: "booking-move", method: "POST", path: "v1/bookings/{booking}/move", permission: P["booking-move"], body: { start: PROBE_START } },
  {
    kind: "booking-slots",
    method: "GET",
    path: "v1/bookings/{booking}/slots",
    permission: P["booking-slots"],
    query: { from: "2031-03-10T00:00:00.000Z", to: "2031-03-17T00:00:00.000Z" },
  },
  {
    kind: "bookings-cancel-email",
    method: "POST",
    path: "v1/bookings/cancel-from-email",
    permission: P["bookings-cancel-email"],
    body: { email: "probe@isolation.example" },
  },
  { kind: "hosts", method: "GET", path: "v1/hosts", permission: P.hosts },
  { kind: "host-add", method: "POST", path: "v1/hosts", permission: P["host-add"], body: PROBE_HOST },
  { kind: "host-update", method: "POST", path: "v1/hosts/{host}", permission: P["host-update"], body: PROBE_HOST },
  { kind: "host-test", method: "POST", path: "v1/hosts/{host}/test-calendar", permission: P["host-test"], body: {} },
  { kind: "host-feed", method: "POST", path: "v1/hosts/{host}/feed", permission: P["host-feed"], body: {} },
  { kind: "availability", method: "GET", path: "v1/hosts/{host}/availability", permission: P.availability },
  { kind: "availability-set", method: "POST", path: "v1/hosts/{host}/availability", permission: P["availability-set"], body: { windows: [] } },
  {
    kind: "exception-add",
    method: "POST",
    path: "v1/hosts/{host}/exceptions",
    permission: P["exception-add"],
    body: { date: "2031-03-12", kind: "off", note: "Isolation probe" },
  },
  { kind: "exception-remove", method: "POST", path: "v1/exceptions/{exception}/remove", permission: P["exception-remove"], body: {} },
  { kind: "holidays", method: "GET", path: "v1/holidays", permission: P.holidays },
  { kind: "holiday-add", method: "POST", path: "v1/holidays", permission: P["holiday-add"], body: { date: "2031-12-26", label: "Isolation probe" } },
  { kind: "holiday-remove", method: "POST", path: "v1/holidays/{holiday}/remove", permission: P["holiday-remove"], body: {} },
  { kind: "types", method: "GET", path: "v1/types", permission: P.types },
  { kind: "type-add", method: "POST", path: "v1/types", permission: P["type-add"], body: PROBE_TYPE },
  { kind: "type-update", method: "POST", path: "v1/types/{type}", permission: P["type-update"], body: PROBE_TYPE },
  { kind: "holds", method: "GET", path: "v1/holds", permission: P.holds },
  { kind: "team", method: "GET", path: "v1/team", permission: P.team },
] as const);

/**
 * Every public route, under `{mount}/` — a company's own pages mount it at
 * /api/t/{web address}/calls/. Its entities are what a visitor holds: a call
 * type's key (`{type-key}`), a hold (`{hold-token}`), the private link to a
 * booking (`{manage-token}`) and a host's calendar feed (`{feed-token}`).
 * Another company's, at this one's address, is "not found".
 */
export const BOOKING_PUBLIC_ROUTES: readonly BookingRoute<BookingPublicRouteKind>[] = freeze([
  { kind: "config", method: "GET", path: "v1/config", permission: null },
  { kind: "slots", method: "GET", path: "v1/slots", permission: null, query: { type: "{type-key}" } },
  { kind: "hold", method: "POST", path: "v1/hold", permission: null, body: { type: "{type-key}", start: PROBE_START } },
  { kind: "release", method: "POST", path: "v1/hold/release", permission: null, body: { holdToken: "{hold-token}" } },
  {
    kind: "book",
    method: "POST",
    path: "v1/book",
    permission: null,
    body: { type: "{type-key}", start: PROBE_START, name: "Isolation Probe", email: "probe@isolation.example", medium: "video", timezone: "UTC" },
  },
  { kind: "manage", method: "GET", path: "v1/manage/{manage-token}", permission: null },
  { kind: "cancel", method: "POST", path: "v1/manage/{manage-token}/cancel", permission: null, body: {} },
  { kind: "reschedule", method: "POST", path: "v1/manage/{manage-token}/reschedule", permission: null, body: { start: PROBE_START } },
  { kind: "ics", method: "GET", path: "v1/manage/{manage-token}/ics", permission: null },
  { kind: "feed", method: "GET", path: "v1/feed/{feed-token}.ics", permission: null },
] as const);

/**
 * The public requests a business's CLOSED PLAN never closes (0.2): the links
 * it already sent its customers — open, cancel, reschedule and the calendar
 * file of a booking they have (and the times a reschedule offers and holds),
 * and a host's own calendar feed. A suspended business closes these too; a
 * plan that ended only stops NEW bookings. Mirrors tenancy's
 * keptOpenWhilePlanClosed, which knows only quote, visit and invoice links.
 */
export function bookingKeptOpenWhilePlanClosed(kind: BookingPublicRouteKind, actingForBooking: boolean): boolean {
  if (kind === "manage" || kind === "cancel" || kind === "reschedule" || kind === "ics" || kind === "feed" || kind === "release") return true;
  return (kind === "slots" || kind === "hold") && actingForBooking;
}
