/**
 * @adminigloo/booking — book-a-call for an app's own site.
 *
 * Functions and TYPES only; the pgTables are `@adminigloo/booking/schema`, so
 * nothing that imports this barrel holds a table it could query around the
 * tenant scoping every function here applies.
 *
 *   zone        Intl-only time-zone math (DST-correct wall clock ↔ instant)
 *   engine      the pure slot engine: windows, precedence, grid, buffers, assignment
 *   ics         .ics output: invites, the host feed, Google "add" links
 *   ical        iCal input: the busy-feed parser and RRULE expansion
 *   busy-source the seam for a host's real calendar, and the secret-iCal implementation
 *   services/*  tenant-scoped DB functions (admin, public, sandbox, maintenance)
 *   handlers    the HTTP factory the booking widget speaks (CSRF-checked) —
 *               a business's public booking page (0.2: its open/closed gate,
 *               company-wide hold and daily caps, the honeypot)
 *   admin-handlers  a business's own calls, hosts, hours, holidays and call
 *               types over HTTP (0.2), the id in the path asked every call
 *   routes      BOOKING_ADMIN_ROUTES / BOOKING_PUBLIC_ROUTES, as data
 *   sandbox     a per-visitor sandbox around the handlers, cookie to tenant, fenced
 *   emails      the booking emails as plain data, and their variables from onEvent
 *   address     is a host on the public internet? (the busy reader's SSRF fence)
 *   permissions the `booking.*` staff permission fragment
 */
export * from "./zone.js";
export * from "./engine.js";
export * from "./ics.js";
export * from "./ical.js";
export * from "./busy-source.js";
export * from "./errors.js";
export * from "./fields.js";
export * from "./tokens.js";
export * from "./permissions.js";
export * from "./handlers.js";
export { createBookingHandlers as createBookingPublicHandlers } from "./handlers.js";
export * from "./admin-handlers.js";
export * from "./routes.js";
export * from "./sandbox.js";
export * from "./emails.js";
export { isPublicAddress, networkKeyOf, privateHostReason } from "./address.js";
export type {
  AdminBooking,
  BookingContext,
  BookingDb,
  BookingEvent,
  BookingRow,
  EventHost,
  EventType,
  HostMembers,
  HostRow,
  PublicBooking,
  TypeRow,
} from "./services/context.js";
export * from "./services/public.js";
export * from "./services/admin.js";
export * from "./services/maintenance.js";
export * from "./services/reminders.js";
export type {
  BookingActor,
  BookingEventKind,
  BookingExceptionKind,
  BookingMedium,
  BookingStatus,
} from "./schema.js";
