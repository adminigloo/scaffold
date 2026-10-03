/**
 * @adminigloo/booking-widget — the client half of AdminIgloo booking.
 *
 *   <BookingWidget baseUrl="/api/booking" />           the public booking flow
 *   <ManageBooking baseUrl="/api/booking" token={t} /> the invitee's manage page
 *
 * Talks to `@adminigloo/booking`'s `createBookingHandlers` over the JSON wire
 * contract declared in ./types (no dependency on the server package). The pure
 * helpers — time-zone cutting, part-of-day grouping, the hold countdown, form
 * validation, request building and error mapping — are exported too, for tests
 * and for buyers who want to build their own picker on the same rules.
 */

export { BookingWidget, type BookingWidgetProps } from "./BookingWidget.js";
export { ManageBooking, type ManageBookingProps } from "./ManageBooking.js";
export { Confirmation, defaultConfirmationNote, type ConfirmationProps } from "./Confirmation.js";
export { Picker, type PickerProps } from "./Picker.js";

export {
  BookingClient,
  CLIENT_KEY_HEADER,
  joinUrl,
  parseBooking,
  parseConfig,
  parseSlots,
  resolveBookingTypeKey,
  type BookingClientOptions,
  type Result,
  type SlotSource,
} from "./client.js";

export {
  alreadyBookedMessage,
  buildBookRequest,
  emailsOn,
  EMPTY_FORM,
  firstInvalidField,
  friendlyError,
  isSlotGone,
  isValidEmail,
  issuesToFieldErrors,
  LIMITS,
  MEDIUM_COPY,
  MEDIUM_ORDER,
  networkError,
  normalizeCallingCode,
  normalizeIssues,
  normalizePhone,
  orderedMedia,
  PHONE_EXAMPLE,
  phoneProblem,
  reachHost,
  reachHostText,
  scrubSource,
  sourceFromSearch,
  toBookingError,
  validateBookForm,
  type BookField,
  type BookFormValues,
  type BookingError,
  type BookingIssue,
  type ClientErrorCode,
  type EmailFacts,
  type ErrorContext,
  type FieldErrors,
  type MediumCopy,
  type PhoneOptions,
  type ReachHost,
} from "./requests.js";

export {
  addDays,
  browserTimeZone,
  buildDateStrip,
  chooseDay,
  daysBetween,
  formatCountdown,
  formatDayTile,
  formatDuration,
  formatLongDate,
  formatTime,
  formatTimeRange,
  formatUtcOffset,
  formatWhen,
  groupByPartOfDay,
  groupSlotsByDay,
  holdAnnouncement,
  holdDeadline,
  HOLD_MS,
  horizonEndMs,
  isValidTimeZone,
  lastBookableDay,
  listTimeZones,
  localizeSlot,
  matchTimeZoneChoice,
  mayHaveLaterSlots,
  PART_OF_DAY_LABELS,
  partOfDay,
  resolveChoiceZone,
  resolveInitialZone,
  sameInstant,
  SLOT_WINDOW_DAYS,
  slotWindow,
  startOfDateIn,
  stripStartDay,
  timeLabels,
  timeZoneChoices,
  US_TIME_ZONES,
  zoneAbbreviation,
  zoneCity,
  zoneDisplayName,
  zonedParts,
  zoneName,
  zoneOffsetMinutes,
  zoneOptionLabel,
  zoneRegion,
  type DateString,
  type LocalSlot,
  type PartGroup,
  type PartOfDay,
  type SlotDay,
  type StripDay,
  type TimeZoneChoice,
  type TimeZoneList,
  type ZonedParts,
} from "./time.js";

export {
  defaultRealBookingLabel,
  defaultSandboxNotice,
  describeWhen,
  REAL_BOOKING_STEPS,
} from "./parts.js";

export { bookingWidgetCss, DARK_TOKENS, injectStyles, LIGHT_TOKENS } from "./styles.js";

export type {
  BookingConfig,
  BookingErrorBody,
  BookingErrorCode,
  BookingStatus,
  BookRequest,
  BookResponse,
  BusySync,
  CancelRequest,
  HoldRequest,
  HoldResponse,
  ManageResponse,
  Medium,
  PublicBooking,
  PublicBookingType,
  ReleaseRequest,
  RescheduleRequest,
  Slot,
  SlotsResponse,
} from "./types.js";
