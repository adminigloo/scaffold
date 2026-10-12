/**
 * @adminigloo/scheduling-widget — the client half of AdminIgloo scheduling.
 *
 *   <VisitPicker baseUrl="/api/schedule" />              a customer picks a time for a visit
 *   <ManageVisit baseUrl="/api/schedule" token={t} />    the page behind the link in their email
 *
 * Talks to `@adminigloo/scheduling`'s `createSchedulingHandlers` over the JSON
 * wire contract in docs/scheduling-0.4-contract.md (declared again in this
 * package's own types; it does not depend on the server package, so a
 * marketing site that embeds the picker installs nothing but this). The staff
 * screens are a separate entry, `@adminigloo/scheduling-widget/admin`, so a
 * marketing page never ships them.
 */

export { SCHEDULING_WIRE_VERSION } from "./version.js";

export { VisitPicker, type VisitPickerProps } from "./VisitPicker.js";
export { ManageVisit, isPastChangeDeadline, type ManageVisitProps } from "./ManageVisit.js";
export { SlotPicker, type SlotPickerProps } from "./SlotPicker.js";

export {
  createSchedulingClient,
  parsePublicConfig,
  parsePublicSlot,
  parsePublicVisit,
  parseSlotsResponse,
  parseVisitRequestResponse,
  parseVisitResponse,
  type SchedulingClientOptions,
  type SchedulingTransport,
} from "./client.js";
export { joinUrl, toClientError, type ClientError, type Result, type TransportOptions } from "./http.js";

export {
  buildVisitRequest,
  contactSentence,
  cutoffMessage,
  EMPTY_VISIT_FORM,
  firstInvalidField,
  friendlyError,
  isTimeGone,
  isValidEmail,
  issuesToFieldErrors,
  LIMITS,
  toPublicStatusLabel,
  validateVisitForm,
  type ErrorContext,
  type FieldErrors,
  type VisitField,
  type VisitFormValues,
} from "./form.js";

export {
  addDays,
  dayOfWeek,
  daysBetween,
  describeShortWhen,
  describeVisitWhen,
  formatClock,
  formatDateRange,
  formatDayTile,
  formatDuration,
  formatDurationShort,
  formatLongDate,
  formatShortDate,
  formatTimeRange,
  googleCalendarUrl,
  groupByPartOfDay,
  groupSlotsByDay,
  isValidTimeZone,
  minutesOf,
  PART_OF_DAY_LABELS,
  partOfDay,
  timeOf,
  todayIn,
  zoneAbbreviation,
  zoneLabel,
  type PartGroup,
  type PartOfDay,
  type SlotDay,
} from "./time.js";

export { resolveHostTheme, useHostTheme, type MatchMediaLike, type ResolvedTheme, type ThemeChoice } from "./theme.js";
export {
  contrastRatio,
  CONTRAST_PAIRS,
  DARK_TOKENS,
  injectSchedulingStyles,
  LIGHT_TOKENS,
  schedulingWidgetCss,
  type InjectStylesOptions,
} from "./styles.js";

export type {
  CancelVisitBody,
  DateString,
  Instant,
  PublicConfig,
  PublicService,
  PublicSlot,
  PublicVisit,
  PublicVisitStatus,
  RescheduleVisitBody,
  SlotsResponse,
  TimeOfDay,
  VisitRequestBody,
  VisitRequestResponse,
  VisitResponse,
  VisitStatus,
  WireErrorBody,
  WireErrorCode,
  WireIssue,
} from "./types.js";
