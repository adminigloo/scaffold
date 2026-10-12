/**
 * @adminigloo/scheduling-widget/admin — the staff screens.
 *
 *   <ScheduleCalendar baseUrl="/api/admin/schedule" />    day/week calendar per crew, drag to move
 *   <CrewDay baseUrl="/api/admin/schedule" />             today's route, on a phone
 *   <SchedulingSettings baseUrl="/api/admin/schedule" />  the business, online booking, crews and hours
 *
 * Talks to `@adminigloo/scheduling`'s `createSchedulingAdminHandlers` (or any
 * object implementing `SchedulingAdminTransport`). A client entry, separate
 * from the customer-facing one so a marketing page never ships the admin.
 */

export { SCHEDULING_WIRE_VERSION } from "../version.js";

export { ScheduleCalendar, type ScheduleCalendarProps } from "./ScheduleCalendar.js";
export { CrewDay, type CrewDayProps } from "./CrewDay.js";
export { SchedulingSettings, WeeklyEditor, type SchedulingSettingsProps, type SettingsSection } from "./SchedulingSettings.js";
export { VisitPanel, type PanelChange } from "./VisitPanel.js";
export { NewVisitDialog } from "./NewVisitDialog.js";

export {
  createSchedulingAdminClient,
  parseAdminResource,
  parseAdminStatus,
  parseAvailability,
  parseCalendarResponse,
  parseCrewDayResponse,
  parsePeople,
  parseSettingsWire,
  parseSuggestResponse,
  parseVisitSnapshot,
  VISIT_STATUSES,
  type SchedulingAdminClientOptions,
  type SchedulingAdminTransport,
} from "./client.js";
export type { ClientError, Result, TransportOptions } from "../http.js";

export { injectSchedulingAdminStyles, schedulingAdminCss } from "./styles.js";
export { AdminNotices, useAdminStatus } from "./ui.js";

export {
  dayRange,
  dragStart,
  hourMarks,
  layoutLanes,
  MIN_BLOCK_PX,
  positionVisit,
  PX_PER_MINUTE,
  shiftEnd,
  snapMinutes,
  weekDates,
  type DayRange,
  type LaneItem,
} from "./layout.js";

export {
  adminErrorText,
  crewColor,
  driveLabel,
  expiresIn,
  groupTimeOff,
  isMovable,
  nextWindow,
  noticeMinutes,
  noticeParts,
  serviceKeyFrom,
  STATUS_LABEL,
  strandedVisitsWarning,
  US_TIME_ZONES,
  visitActions,
  weekFromWindows,
  weekProblem,
  windowsFromWeek,
  type EditWindow,
  type TimeOffRange,
  type VisitAction,
  type ZoneChoice,
} from "./helpers.js";

export type {
  AcceptBody,
  AddTimeOffBody,
  AdminNotice,
  AdminNoticeCode,
  AdminResource,
  AdminStatus,
  AssignBody,
  AvailabilityResponse,
  CalendarResource,
  CalendarResponse,
  CreateVisitBody,
  CrewDayResponse,
  CrewStop,
  DateString,
  DayWindows,
  DeclineBody,
  DetailsBody,
  ExpireResponse,
  Instant,
  PeopleResponse,
  PersonOption,
  ProgressBody,
  ProgressStatus,
  RescheduleBody,
  ResourceInput,
  ServiceWire,
  SetWeeklyBody,
  SettingsPatch,
  SettingsWire,
  SpecialHours,
  StaffSlot,
  StatusBody,
  SuggestResponse,
  TimeOfDay,
  TimeOffDay,
  TimeOffResponse,
  VisitMutationResponse,
  VisitSnapshot,
  VisitStatus,
  WeeklyWindow,
} from "./types.js";
export type { WireErrorBody, WireErrorCode, WireIssue } from "../types.js";
