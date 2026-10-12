/**
 * @adminigloo/scheduling — field-service scheduling: crews, hours, drive
 * time, a public booking flow, customer manage links, a staff calendar and
 * crew routes, in the business's own time zone. Server code only; the UI is
 * @adminigloo/scheduling-widget, and the emails are `./comms`.
 *
 * Everything 0.3 exported still exists with the same signature.
 */

// The pure engine and its vocabulary.
export * from "./math.js";
export * from "./maps.js";
export * from "./status.js";
export * from "./permissions.js";
export * from "./zone.js";
// The wire types (section 7 of the contract), shared with the widget.
export * from "./wire.js";
// zone.ts and wire.ts both name the calendar-date string; it is the same type.
export type { DateString } from "./wire.js";

export {
  timeOfDaySchema,
  endTimeSchema,
  BookingNotBookableError,
  BookingStatusTransitionError,
  type BookingRefusalCode,
  type StaffRefusalCode,
  type SchedulingDb,
  type ResourceRow,
  type AvailabilityRow,
  type BookingRow,
  type SettingsRow,
  type VisitTokenRow,
  type SchedulingWriteOptions,
} from "./types.js";

// Instants: the wall clock in the business's zone, and real time.
export { visitInstants, instantsOf, todayIn, type InstantSource } from "./instants.js";

// The public projection and its policy. The slot-id codec stays internal: an
// id is something a host passes back, never something it builds.
export {
  DEFAULT_PUBLIC_BOOKING_POLICY,
  resolvePublicBookingPolicy,
  toPublicSlot,
  type PublicBookingPolicy,
  type ResolvedPublicBookingPolicy,
} from "./public.js";

export {
  schedulingAvailability,
  schedulingBookings,
  schedulingDriveCache,
  schedulingResources,
  schedulingSettings,
  schedulingVisitTokens,
} from "./schema.js";

// Settings and services.
export {
  DEFAULT_SCHEDULING_SETTINGS,
  updateSchedulingSettingsSchema,
  schedulingServiceSchema,
  getSchedulingSettings,
  updateSchedulingSettings,
  settingsToPolicy,
  toSettingsWire,
  type SchedulingSettings,
  type SchedulingSettingsValues,
  type UpdateSchedulingSettingsInput,
} from "./settings.js";
export { humanizeServiceKey, serviceNameFor, findService, type SchedulingService } from "./services.js";

// Events.
export {
  defaultNotify,
  type SchedulingEvent,
  type SchedulingEventType,
  type SchedulingEventListener,
  type SchedulingActor,
  type SchedulingEventVia,
  type SchedulingEventPrevious,
} from "./events.js";
export { toVisitSnapshot, toPublicVisit, toPublicVisitStatus, effectiveStatus, isOverdueRequest } from "./snapshot.js";

// Crews and their hours.
export {
  createResourceSchema,
  updateResourceSchema,
  createResource,
  updateResource,
  deactivateResource,
  reactivateResource,
  listResources,
  toAdminResource,
  type CreateResourceInput,
  type UpdateResourceInput,
  type ListResourcesOptions,
  type ResourceWriteOptions,
} from "./resources.js";
export {
  availabilityBlockSchema,
  setAvailabilitySchema,
  addTimeOffSchema,
  setAvailability,
  listAvailability,
  resolveDayWindows,
  resolveDayWindow,
  addTimeOff,
  removeTimeOff,
  getAvailabilitySummary,
  type AddTimeOffInput,
} from "./availability.js";

// Maps.
export { createCachedMapsProvider, type CachedMapsOptions } from "./cache.js";
export {
  createGoogleMapsProvider,
  selectMapsProvider,
  type GoogleMapsProviderOptions,
  type SelectMapsProviderOptions,
} from "./google.js";

// Finding and booking slots.
export {
  findAvailableSlots,
  findPublicSlots,
  requestPublicBooking,
  requestPublicBookingSchema,
  type FindSlotsOptions,
  type FindPublicSlotsInput,
  type PublicBookingOptions,
  type RequestPublicBookingInput,
  type RequestPublicBookingOptions,
  type PublicBookingReceipt,
  type PublicVisitReceipt,
} from "./offer.js";
export {
  validateBookingSlot,
  type ValidateBookingInput,
  type ValidateBookingResult,
} from "./validate.js";

// Staff writers.
export {
  createBookingSchema,
  setBookingStatusSchema,
  rescheduleBookingSchema,
  assignBookingSchema,
  updateBookingDetailsSchema,
  bookVisit,
  createBooking,
  listBookings,
  getBooking,
  setBookingStatus,
  rescheduleBooking,
  assignBooking,
  updateBookingDetails,
  type CreateBookingInput,
  type CreateBookingOptions,
  type SetBookingStatusInput,
  type SetBookingStatusOptions,
  type RescheduleBookingInput,
  type AssignBookingInput,
  type UpdateBookingDetailsInput,
} from "./visits.js";

// The customer's own visit.
export { issueManageToken } from "./visit-tokens.js";
export {
  getVisitByToken,
  rescheduleVisitByToken,
  cancelVisitByToken,
  rescheduleVisitByTokenSchema,
  cancelVisitByTokenSchema,
} from "./manage.js";

// Expiry, the calendar, the crew's day, the backfill.
export { expirePendingRequests, type ExpirePendingRequestsOptions } from "./expiry.js";
export {
  listCalendar,
  listCalendarSchema,
  listCrewDay,
  backfillVisitInstants,
  type ListCalendarInput,
} from "./calendar.js";

// The .ics file.
export { buildVisitIcs, formatIcsUtc, escapeIcsText, foldLine, type BuildVisitIcsInput } from "./ics.js";

// HTTP: the public handler (VisitPicker, ManageVisit) and the staff handler
// (ScheduleCalendar, CrewDay, SchedulingSettings).
export {
  createSchedulingHandlers,
  clientIpKey,
  createClientIpKey,
  type ClientIpKeyOptions,
  type CreateSchedulingHandlersOptions,
  type SchedulingHandlers,
  type SchedulingRateLimitBucket,
} from "./handlers.js";
export {
  createSchedulingAdminHandlers,
  SCHEDULING_ADMIN_ROUTE_PERMISSIONS,
  type AuthorizeResult,
  type CreateSchedulingAdminHandlersOptions,
  type CrewMemberChange,
  type SchedulingAdminHandlers,
} from "./admin-handlers.js";
// What the office should know (the staff screens' banner), for a host that
// builds its own status page.
export { adminNotices, adminStatus, runClock, type DeliveryStatus, type ReminderRuns } from "./notices.js";
// The refusal codes and statuses a handler answers with, for a host calling
// the functions from its own server actions or tRPC procedures.
export { isCrossSiteRequest, toWireError, WIRE_ERROR_STATUS } from "./http.js";
