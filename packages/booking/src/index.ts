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
 *   handlers    the HTTP factory the booking widget speaks (CSRF-checked)
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
export * from "./sandbox.js";
export * from "./emails.js";
export { isPublicAddress, privateHostReason } from "./address.js";
export type {
  AdminBooking,
  BookingContext,
  BookingDb,
  BookingEvent,
  BookingRow,
  EventHost,
  EventType,
  HostRow,
  PublicBooking,
  TypeRow,
} from "./services/context.js";
export * from "./services/public.js";
export * from "./services/admin.js";
export * from "./services/maintenance.js";
export type {
  BookingActor,
  BookingEventKind,
  BookingExceptionKind,
  BookingMedium,
  BookingStatus,
} from "./schema.js";
