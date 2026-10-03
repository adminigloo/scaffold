/**
 * @adminigloo/booking-widget/admin — the host's admin screens.
 *
 *   <BookingAdmin adapter={adapter} bookingPageUrl="/book" />
 *
 * Bookings (upcoming and past: confirm, move, cancel, outcome, history),
 * availability (the week, time off with ranges, holidays), settings (host,
 * the real calendar, the feed, call types) and a "Finish setting up" list —
 * talking to the host app only through `adapter`, a plain object of async
 * functions that mirror `@adminigloo/booking`'s admin services. A client
 * entry ("use client" is stamped on the bundle by tsup), separate from the
 * public widget so a marketing page never ships the admin.
 */

export { BookingAdmin, type BookingAdminProps } from "./admin/BookingAdmin.js";
export { BookingsPanel, BookingRow, CancelPanel, MovePanel, OutcomePanel, adapterSlotSource } from "./admin/BookingsPanel.js";
export { AvailabilityPanel, Holidays, TimeOff, WeeklyEditor } from "./admin/AvailabilityPanel.js";
export { CalendarCard, FeedCard, HostCard, SettingsPanel, TypeCard } from "./admin/SettingsPanel.js";
export { bookingAdminCss, injectAdminStyles } from "./admin/styles.js";

export {
  canCancel,
  canMove,
  canRecordOutcome,
  cancelButtonLabel,
  confirmButtonLabel,
  datesInRange,
  describeExceptionGroup,
  formatDateRange,
  groupBlackouts,
  groupExceptions,
  isLive,
  mailtoInvitee,
  MAX_RANGE_DAYS,
  minuteLabel,
  moveButtonLabel,
  sameWeekly,
  setupChecklist,
  weekFrom,
  weekProblem,
  weekToWindows,
  type AdminTab,
  type BlackoutGroup,
  type ChecklistItem,
  type ExceptionGroup,
} from "./admin/helpers.js";

export type {
  AdminBlackout,
  AdminBooking,
  AdminBookingEvent,
  AdminBookingType,
  AdminException,
  AdminHost,
  BookingAdminAdapter,
  BookingScope,
  BookingTypeInput,
  ExceptionInput,
  ExceptionKind,
  HostInput,
  Instant,
  WeeklyWindow,
} from "./admin/types.js";
