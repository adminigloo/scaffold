import type { DateString, Instant, TimeOfDay, VisitStatus } from "../types.js";

/**
 * The staff half of the scheduling wire contract (docs/scheduling-0.4-contract.md
 * section 7), declared verbatim: what `createSchedulingAdminHandlers` sends and
 * takes. The server declares the same shapes in `@adminigloo/scheduling`'s
 * src/wire.ts; a renamed field here breaks the other half silently, so don't.
 *
 * The scalars (DateString, TimeOfDay, Instant), the statuses and the error
 * shapes are shared with the public half and live in ../types.ts.
 */

export type { DateString, Instant, TimeOfDay, VisitStatus } from "../types.js";

// ---- staff (createSchedulingAdminHandlers) -----------------------------------
export interface VisitSnapshot {
  id: string;
  status: VisitStatus;
  nextStatuses: VisitStatus[]; // staff-settable moves from here (never "expired")
  date: DateString;
  startTime: TimeOfDay;
  endTime: TimeOfDay;
  startsAt: Instant;
  endsAt: Instant;
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
  /** scheduling 0.7: a visit typed in later from past records — when, and by whom (a user id). */
  enteredLater?: { at: Instant; by: string | null } | null;
}

export interface CalendarResource {
  id: string;
  name: string;
  isActive: boolean;
  acceptsPublicBookings: boolean;
  maxJobsPerDay: number;
}
export interface DayWindows {
  resourceId: string;
  date: DateString;
  windows: Array<{ start: TimeOfDay; end: TimeOfDay }>;
}
export interface CalendarResponse {
  timeZone: string;
  today: DateString;
  from: DateString;
  to: DateString;
  slotStepMinutes: number;
  resources: CalendarResource[];
  windows: DayWindows[];
  visits: VisitSnapshot[];
  pending: VisitSnapshot[]; // the request inbox: pending from today on, soonest first, ≤ 50
}

export interface CrewStop {
  order: number; // 1-based
  visit: VisitSnapshot;
  driveFromPrevious: { minutes: number; miles: number; from: "home_base" | "previous_stop"; estimated: boolean } | null;
  directionsUrl: string | null;
  telUrl: string | null;
}
export interface CrewDayResponse {
  timeZone: string;
  date: DateString;
  today: DateString;
  resource: { id: string; name: string; homeBaseAddress: string | null };
  windows: Array<{ start: TimeOfDay; end: TimeOfDay }>;
  stops: CrewStop[];
  totals: { visits: number; driveMinutes: number; distanceMiles: number; estimated: boolean };
  routeUrl: string | null;
  /** True for a login that may open today's route only (a crew member): the screen offers no other day. */
  todayOnly: boolean;
}

export interface StaffSlot {
  date: DateString;
  startTime: TimeOfDay;
  endTime: TimeOfDay;
  startsAt: Instant;
  endsAt: Instant;
  resourceId: string;
  resourceName: string;
  driveMinutesFromPrevious: number | null;
  previousJobAddress: string | null;
  score: number;
}
export interface SuggestResponse {
  timeZone: string;
  estimated: boolean;
  slots: StaffSlot[];
} // best first, ≤ 20

export interface CreateVisitBody {
  resourceId: string | null;
  date: DateString;
  startTime: TimeOfDay;
  endTime?: TimeOfDay; // endTime omitted → service duration (or 60)
  service?: string;
  title?: string;
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  address?: string;
  lat?: number;
  lng?: number;
  notes?: string;
  estimateId?: string;
  status?: "pending" | "confirmed"; // default "confirmed"
  notify?: boolean; // default true
}
export interface VisitMutationResponse {
  visit: VisitSnapshot;
  warnings: string[];
}
export interface AcceptBody {
  notify?: boolean;
}
export interface DeclineBody {
  reason?: string;
  notify?: boolean;
}
export interface StatusBody {
  status: Exclude<VisitStatus, "expired">;
  reason?: string;
  notify?: boolean;
}
export interface RescheduleBody {
  date: DateString;
  startTime: TimeOfDay;
  endTime?: TimeOfDay;
  resourceId?: string;
  notify?: boolean;
}
export interface AssignBody {
  resourceId: string;
  notify?: boolean;
}
export interface DetailsBody {
  title?: string | null;
  serviceType?: string;
  customerName?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  address?: string | null;
  notes?: string | null;
  estimateId?: string | null;
  notify?: boolean; // a corrected email gets the visit re-sent; default true
}
/** A crew's own stop, from today's route: start it, complete it, "couldn't do it" (no_show), or undo the last of those. */
export type ProgressStatus = "in_progress" | "completed" | "no_show" | "confirmed";
export interface ProgressBody {
  status: ProgressStatus;
  note?: string; // ≤ 500, kept with a no-show
}

/** What the office should know about this deployment, in plain words (a banner on the calendar and settings). */
export type AdminNoticeCode =
  | "booking_off"
  | "setup_name"
  | "setup_contact"
  | "setup_zone"
  | "emails_off"
  | "reminders_off"
  | "reminders_daily"
  | "delivery_problem"
  | "crew_unlinked";
/** link: where to fix it ("Open company settings"), when the host said where. */
export interface AdminNotice {
  code: AdminNoticeCode;
  tone: "info" | "warn";
  message: string;
  link?: { href: string; label: string } | null;
}
export interface AdminStatus {
  customerEmails: boolean; // false: no customer is emailed about anything — the screens say so instead of offering to
  reminders: boolean; // false: no reminder goes out
  upcomingVisits: number; // requests and confirmed visits still to come (what a time-zone change moves)
  notices: AdminNotice[]; // most important first
}
/** Somebody who has signed in to the app, for "who opens this crew's route". */
export interface PersonOption {
  userId: string;
  name: string | null;
  email: string | null;
}
export interface PeopleResponse {
  people: PersonOption[] | null; // null: the host lists nobody (type the login id instead)
}
export interface ExpireResponse {
  expired: number;
}

export interface ServiceWire {
  key: string;
  name: string;
  durationMinutes: number;
  description: string | null;
  requiredSkill: string | null;
}
export interface SettingsWire {
  timeZone: string;
  businessName: string;
  contactEmail: string | null;
  contactPhone: string | null;
  staffNotifyEmails: string[];
  services: ServiceWire[];
  slotStepMinutes: number;
  minNoticeMinutes: number;
  horizonDays: number;
  travelBufferMinutes: number;
  maxSlotsPerDay: number | null;
  maxOpenRequestsPerRequester: number | null;
  requireAddress: boolean;
  autoConfirm: boolean;
  publicBookingEnabled: boolean;
  pendingExpiryHours: number;
  reminderLeadHours: number;
  cancelCutoffHours: number;
  saved: boolean;
  updatedAt: Instant | null;
  /** The name, zone and contact come from the company profile (Tenancy 2a): show them read-only, linking here. null = editable here. */
  managedByCompany: { href: string | null } | null;
  /** Who gets the new-request alerts is chosen in Alert settings (Tenancy 2b-1): show this link instead of the address list. null = the list is edited here. */
  alertRecipients: { href: string | null } | null;
}
export type SettingsPatch = Partial<Omit<SettingsWire, "saved" | "updatedAt" | "managedByCompany" | "alertRecipients">> & {
  notifyCustomers?: boolean; // with a new timeZone: email each upcoming visit's customer the corrected time
};

export interface AdminResource {
  id: string;
  name: string;
  userId: string | null;
  homeBaseAddress: string | null;
  homeBaseLat: number | null;
  homeBaseLng: number | null;
  skills: string[];
  workStartTime: TimeOfDay;
  workEndTime: TimeOfDay;
  maxJobsPerDay: number;
  hoursConfigured: boolean;
  acceptsPublicBookings: boolean;
  isActive: boolean;
  createdAt: Instant;
  updatedAt: Instant;
}
export interface ResourceInput {
  name: string;
  userId?: string | null;
  homeBaseAddress?: string | null;
  homeBaseLat?: number | null;
  homeBaseLng?: number | null;
  skills?: string[];
  workStartTime?: TimeOfDay;
  workEndTime?: TimeOfDay;
  maxJobsPerDay?: number;
  acceptsPublicBookings?: boolean;
}

export interface WeeklyWindow {
  dayOfWeek: number /* 0=Sun … 6=Sat */;
  startTime: TimeOfDay;
  endTime: TimeOfDay;
}
export interface TimeOffDay {
  id: string;
  date: DateString;
  note: string | null;
}
export interface SpecialHours {
  id: string;
  date: DateString;
  startTime: TimeOfDay;
  endTime: TimeOfDay;
  note: string | null;
}
export interface AvailabilityResponse {
  resourceId: string;
  hoursConfigured: boolean;
  weekly: WeeklyWindow[]; // saved weekly rows (empty when never configured)
  effectiveWeekly: WeeklyWindow[]; // what applies: saved rows, or the Mon–Fri default
  timeOff: TimeOffDay[]; // from today on
  specialHours: SpecialHours[]; // from today on
}
export interface SetWeeklyBody {
  weekly: WeeklyWindow[];
} // ≤ 50 windows; several per day allowed
export interface AddTimeOffBody {
  from: DateString;
  to: DateString;
  note?: string;
} // ≤ 62 days
export interface TimeOffResponse extends AvailabilityResponse {
  visitsOnThoseDays: VisitSnapshot[];
}
