/**
 * THE WIRE TYPES — what `createSchedulingHandlers` and
 * `createSchedulingAdminHandlers` send and accept, as JSON.
 *
 * SHARED WITH @adminigloo/scheduling-widget (its src/types.ts and
 * src/admin/types.ts declare the same shapes); change both or neither. Neither
 * package imports the other, so a renamed field here breaks the widget
 * without either compiler noticing. Field names, optionality and enums match
 * character for character.
 *
 * Dates and instants are always strings on the wire. The server's read
 * models (`listCalendar`, `listCrewDay`, `getAvailabilitySummary`,
 * `toVisitSnapshot`, `toPublicVisit`, `findPublicSlots`) return these shapes
 * directly, so a handler serializes them as they are: one mapping, not two.
 */

// ---- scalars ---------------------------------------------------------------
export type DateString = string; // "YYYY-MM-DD": a calendar date in the business's zone
export type TimeOfDay = string; // "HH:MM", 24-hour, zero-padded; an end may be "24:00"
export type Instant = string; // ISO 8601 UTC: "2026-11-02T16:00:00.000Z"

export type VisitStatus =
  | "pending" | "confirmed" | "in_progress" | "completed" | "cancelled" | "declined" | "expired" | "no_show";
export type PublicVisitStatus =
  | "requested" | "confirmed" | "in_progress" | "completed" | "cancelled" | "declined" | "expired" | "missed";
// PublicVisitStatus from VisitStatus: pending→requested, no_show→missed, the rest the same.

export type WireErrorCode =
  | "invalid" | "spam_suspected" | "not_found" | "forbidden" | "rate_limited" | "too_many_requests"
  | "booking_closed" | "slot_unavailable" | "too_soon" | "too_far" | "invalid_duration" | "unknown_service"
  | "address_unresolved" | "too_late" | "outside_hours" | "invalid_window" | "resource_unavailable"
  | "not_changeable" | "transition_not_allowed" | "internal";
export interface WireIssue { path: Array<string | number>; message: string; code?: string }
export interface WireErrorBody { error: { code: WireErrorCode; message: string; issues?: WireIssue[] } }

// ---- public (createSchedulingHandlers) ---------------------------------------
export interface PublicService { key: string; name: string; description: string | null; durationMinutes: number }

export interface PublicConfig {
  businessName: string;
  timeZone: string;                 // IANA
  publicBookingEnabled: boolean;
  autoConfirm: boolean;
  services: PublicService[];
  minNoticeMinutes: number;
  horizonDays: number;
  requireAddress: boolean;
  cancelCutoffHours: number;
  contactEmail: string | null;
  contactPhone: string | null;
  emailsEnabled: boolean;           // false: never promise an email; show the manage link to keep
  minFillMs: number;                // the server's fill-time floor; 0 = off
}

export interface PublicSlot {
  slotId: string;                   // opaque; send back as is
  date: DateString; startTime: TimeOfDay; endTime: TimeOfDay;
  startsAt: Instant; endsAt: Instant;
}
export interface SlotsResponse {
  timeZone: string; service: string; from: DateString; to: DateString;
  closed: boolean;                  // online booking is off
  slots: PublicSlot[];              // time order
}

export interface VisitRequestBody {
  slotId: string;
  service: string;
  name: string;                     // 1–200
  email: string;                    // ≤ 320, an email
  phone?: string;                   // ≤ 60
  address?: string;                 // ≤ 500; required when config.requireAddress
  notes?: string;                   // ≤ 2000
  estimateId?: string;              // ≤ 200
  website?: string;                 // honeypot: must be empty or absent
  fillMs?: number;                  // ms between the details form appearing and submit
  addressAsTyped?: boolean;         // "send it anyway": the map couldn't place the address; the office checks it
}

export interface PublicVisit {
  status: PublicVisitStatus;
  serviceKey: string;
  serviceName: string;
  date: DateString; startTime: TimeOfDay; endTime: TimeOfDay;
  startsAt: Instant; endsAt: Instant;
  timeZone: string;
  durationMinutes: number;
  customerName: string;
  address: string | null;
  businessName: string;
  contactPhone: string | null;
  contactEmail: string | null;
  canReschedule: boolean;
  canCancel: boolean;
  changeDeadline: Instant | null;   // startsAt − cutoff; null once the visit isn't pending/confirmed
  cancelCutoffHours: number;
  cancelledBy: "customer" | "business" | null;   // staff and system both read as "business"
  googleCalendarUrl: string | null; // null once cancelled/declined/expired
}
export interface VisitRequestResponse {
  visit: PublicVisit;
  manageToken: string | null;       // null when `repeated`: the first request's email carries the link
  manageUrl: string | null;
  repeated: boolean;
}
export interface VisitResponse { visit: PublicVisit }
export interface RescheduleVisitBody { slotId: string }
export interface CancelVisitBody { reason?: string }   // ≤ 500

// ---- staff (createSchedulingAdminHandlers) -----------------------------------
export interface VisitSnapshot {
  id: string;
  status: VisitStatus;
  nextStatuses: VisitStatus[];      // staff-settable moves from here (never "expired")
  date: DateString; startTime: TimeOfDay; endTime: TimeOfDay;
  startsAt: Instant; endsAt: Instant;
  timeZone: string;
  durationMinutes: number;
  resourceId: string | null;
  resourceName: string | null;
  serviceKey: string;
  serviceName: string;
  title: string | null;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  notes: string | null;
  estimateId: string | null;
  origin: "public" | "staff";
  sequence: number;
  pendingExpiresAt: Instant | null;
  cancelledAt: Instant | null;
  cancelledBy: "customer" | "staff" | "system" | null;
  cancelReason: string | null;
  startedAt: Instant | null;
  completedAt: Instant | null;
  createdAt: Instant;
  updatedAt: Instant;
}

export interface CalendarResource {
  id: string; name: string; isActive: boolean; acceptsPublicBookings: boolean; maxJobsPerDay: number;
}
export interface DayWindows { resourceId: string; date: DateString; windows: Array<{ start: TimeOfDay; end: TimeOfDay }> }
export interface CalendarResponse {
  timeZone: string; today: DateString; from: DateString; to: DateString;
  slotStepMinutes: number;
  resources: CalendarResource[];
  windows: DayWindows[];
  visits: VisitSnapshot[];
  pending: VisitSnapshot[];          // the request inbox: pending from today on, soonest first, ≤ 50
}

export interface CrewStop {
  order: number;                     // 1-based
  visit: VisitSnapshot;
  driveFromPrevious: { minutes: number; miles: number; from: "home_base" | "previous_stop"; estimated: boolean } | null;
  directionsUrl: string | null;
  telUrl: string | null;
}
export interface CrewDayResponse {
  timeZone: string; date: DateString; today: DateString;
  resource: { id: string; name: string; homeBaseAddress: string | null };
  windows: Array<{ start: TimeOfDay; end: TimeOfDay }>;
  stops: CrewStop[];
  totals: { visits: number; driveMinutes: number; distanceMiles: number; estimated: boolean };
  routeUrl: string | null;
  /** True for a login that may open today's route only (a crew member): the screen offers no other day. */
  todayOnly: boolean;
}

export interface StaffSlot {
  date: DateString; startTime: TimeOfDay; endTime: TimeOfDay; startsAt: Instant; endsAt: Instant;
  resourceId: string; resourceName: string;
  driveMinutesFromPrevious: number | null;
  previousJobAddress: string | null;
  score: number;
}
export interface SuggestResponse { timeZone: string; estimated: boolean; slots: StaffSlot[] }   // best first, ≤ 20

export interface CreateVisitBody {
  resourceId: string | null;
  date: DateString; startTime: TimeOfDay; endTime?: TimeOfDay;    // endTime omitted → service duration (or 60)
  service?: string;
  title?: string; customerName?: string; customerEmail?: string; customerPhone?: string;
  address?: string; lat?: number; lng?: number; notes?: string; estimateId?: string;
  status?: "pending" | "confirmed";   // default "confirmed"
  notify?: boolean;                   // default true
}
export interface VisitMutationResponse { visit: VisitSnapshot; warnings: string[] }
export interface AcceptBody { notify?: boolean }
export interface DeclineBody { reason?: string; notify?: boolean }
export interface StatusBody { status: Exclude<VisitStatus, "expired">; reason?: string; notify?: boolean }
export interface RescheduleBody { date: DateString; startTime: TimeOfDay; endTime?: TimeOfDay; resourceId?: string; notify?: boolean }
export interface AssignBody { resourceId: string; notify?: boolean }
export interface DetailsBody {
  title?: string | null; serviceType?: string; customerName?: string | null; customerEmail?: string | null;
  customerPhone?: string | null; address?: string | null; notes?: string | null; estimateId?: string | null;
  notify?: boolean;                   // a corrected email gets the visit re-sent; default true
}
/** A crew's own stop, from today's route: start it, complete it, "couldn't do it" (no_show), or undo the last of those. */
export type ProgressStatus = "in_progress" | "completed" | "no_show" | "confirmed";
export interface ProgressBody { status: ProgressStatus; note?: string }   // note ≤ 500, kept with a no-show

/** What the office should know about this deployment, in plain words (a banner on the calendar and settings). */
export type AdminNoticeCode =
  | "booking_off" | "setup_name" | "setup_contact" | "setup_zone"
  | "emails_off" | "reminders_off" | "reminders_daily" | "delivery_problem"
  | "crew_unlinked";
/** link: where to fix it ("Open company settings"), when the host said where. */
export interface AdminNotice { code: AdminNoticeCode; tone: "info" | "warn"; message: string; link?: { href: string; label: string } | null }
export interface AdminStatus {
  customerEmails: boolean;          // false: no customer is emailed about anything — the screens say so instead of offering to
  reminders: boolean;               // false: no reminder goes out
  upcomingVisits: number;           // requests and confirmed visits still to come (what a time-zone change moves)
  notices: AdminNotice[];           // most important first
}
/** Somebody who has signed in to the app, for "who opens this crew's route". */
export interface PersonOption { userId: string; name: string | null; email: string | null }
export interface PeopleResponse { people: PersonOption[] | null }   // null: the host lists nobody (type the login id instead)
export interface ExpireResponse { expired: number }

export interface ServiceWire { key: string; name: string; durationMinutes: number; description: string | null; requiredSkill: string | null }
export interface SettingsWire {
  timeZone: string; businessName: string; contactEmail: string | null; contactPhone: string | null;
  staffNotifyEmails: string[];
  services: ServiceWire[];
  slotStepMinutes: number; minNoticeMinutes: number; horizonDays: number; travelBufferMinutes: number;
  maxSlotsPerDay: number | null; maxOpenRequestsPerRequester: number | null; requireAddress: boolean;
  autoConfirm: boolean; publicBookingEnabled: boolean;
  pendingExpiryHours: number; reminderLeadHours: number; cancelCutoffHours: number;
  saved: boolean; updatedAt: Instant | null;
  /** The name, zone and contact come from the company profile (Tenancy 2a): show them read-only, linking here. null = editable here. */
  managedByCompany: { href: string | null } | null;
}
export type SettingsPatch = Partial<Omit<SettingsWire, "saved" | "updatedAt" | "managedByCompany">> & {
  notifyCustomers?: boolean;        // with a new timeZone: email each upcoming visit's customer the corrected time
};

export interface AdminResource {
  id: string; name: string; userId: string | null;
  homeBaseAddress: string | null; homeBaseLat: number | null; homeBaseLng: number | null;
  skills: string[]; workStartTime: TimeOfDay; workEndTime: TimeOfDay; maxJobsPerDay: number;
  hoursConfigured: boolean; acceptsPublicBookings: boolean; isActive: boolean;
  createdAt: Instant; updatedAt: Instant;
}
export interface ResourceInput {
  name: string; userId?: string | null;
  homeBaseAddress?: string | null; homeBaseLat?: number | null; homeBaseLng?: number | null;
  skills?: string[]; workStartTime?: TimeOfDay; workEndTime?: TimeOfDay; maxJobsPerDay?: number;
  acceptsPublicBookings?: boolean;
}

export interface WeeklyWindow { dayOfWeek: number /* 0=Sun … 6=Sat */; startTime: TimeOfDay; endTime: TimeOfDay }
export interface TimeOffDay { id: string; date: DateString; note: string | null }
export interface SpecialHours { id: string; date: DateString; startTime: TimeOfDay; endTime: TimeOfDay; note: string | null }
export interface AvailabilityResponse {
  resourceId: string;
  hoursConfigured: boolean;
  weekly: WeeklyWindow[];            // saved weekly rows (empty when never configured)
  effectiveWeekly: WeeklyWindow[];   // what applies: saved rows, or the Mon–Fri default
  timeOff: TimeOffDay[];             // from today on
  specialHours: SpecialHours[];      // from today on
}
export interface SetWeeklyBody { weekly: WeeklyWindow[] }   // ≤ 50 windows; several per day allowed
export interface AddTimeOffBody { from: DateString; to: DateString; note?: string }   // ≤ 62 days
export interface TimeOffResponse extends AvailabilityResponse { visitsOnThoseDays: VisitSnapshot[] }
