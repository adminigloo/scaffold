import {
  createRequester,
  isDateString,
  isObject,
  isString,
  isTimeOfDay,
  isTrue,
  listOf,
  num,
  numOrNull,
  queryString,
  str,
  stringList,
  strOrNull,
  type Result,
  type TransportOptions,
} from "../http.js";
import type { VisitStatus } from "../types.js";
import type {
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
  PeopleResponse,
  PersonOption,
  ProgressBody,
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
  TimeOffDay,
  TimeOffResponse,
  VisitMutationResponse,
  VisitSnapshot,
  WeeklyWindow,
} from "./types.js";

/**
 * The staff transport: `createSchedulingAdminHandlers`' routes (contract 4.2),
 * every answer checked narrowly. The admin components take the interface, so
 * a host can back the calendar with tRPC or server actions by implementing it
 * (the README has a sketch) instead of mounting the HTTP handlers.
 */

export interface SchedulingAdminTransport {
  calendar(q: { from: DateString; to: DateString; resources?: string[]; includeInactive?: boolean }): Promise<Result<CalendarResponse>>;
  crewDay(q: { date?: DateString; resource?: string }): Promise<Result<CrewDayResponse>>;
  suggest(q: {
    service?: string;
    minutes?: number;
    address?: string;
    lat?: number;
    lng?: number;
    from?: DateString;
    days?: number;
    resource?: string;
  }): Promise<Result<SuggestResponse>>;
  getVisit(id: string): Promise<Result<{ visit: VisitSnapshot }>>;
  createVisit(body: CreateVisitBody): Promise<Result<VisitMutationResponse>>;
  accept(id: string, body: AcceptBody): Promise<Result<{ visit: VisitSnapshot }>>;
  decline(id: string, body: DeclineBody): Promise<Result<{ visit: VisitSnapshot }>>;
  setStatus(id: string, body: StatusBody): Promise<Result<{ visit: VisitSnapshot }>>;
  reschedule(id: string, body: RescheduleBody): Promise<Result<VisitMutationResponse>>;
  assign(id: string, body: AssignBody): Promise<Result<VisitMutationResponse>>;
  updateDetails(id: string, body: DetailsBody): Promise<Result<VisitMutationResponse>>;
  expire(): Promise<Result<ExpireResponse>>;
  getSettings(): Promise<Result<{ settings: SettingsWire }>>;
  updateSettings(patch: SettingsPatch): Promise<Result<{ settings: SettingsWire }>>;
  listResources(q?: { includeInactive?: boolean }): Promise<Result<{ resources: AdminResource[] }>>;
  createResource(body: ResourceInput): Promise<Result<{ resource: AdminResource }>>;
  updateResource(id: string, patch: Partial<ResourceInput>): Promise<Result<{ resource: AdminResource }>>;
  deactivateResource(id: string): Promise<Result<{ resource: AdminResource }>>;
  reactivateResource(id: string): Promise<Result<{ resource: AdminResource }>>;
  getAvailability(resourceId: string): Promise<Result<AvailabilityResponse>>;
  setWeekly(resourceId: string, body: SetWeeklyBody): Promise<Result<AvailabilityResponse>>;
  addTimeOff(resourceId: string, body: AddTimeOffBody): Promise<Result<TimeOffResponse>>;
  removeTimeOff(resourceId: string, exceptionId: string): Promise<Result<AvailabilityResponse>>;
  /** What the office should know: are customers emailed, do reminders go out, what's left to set up. */
  status(): Promise<Result<AdminStatus>>;
  /** The people who can sign in, for "who opens this crew's route". `people: null` when the host lists nobody. */
  people(): Promise<Result<PeopleResponse>>;
  /** A crew's own stop, from today's route: start, complete, couldn't do it, or undo. */
  progress(id: string, body: ProgressBody): Promise<Result<{ visit: VisitSnapshot }>>;
}

export type SchedulingAdminClientOptions = TransportOptions;

// ---------------------------------------------------------------------------
// Shape checks
// ---------------------------------------------------------------------------

export const VISIT_STATUSES: readonly VisitStatus[] = [
  "pending",
  "confirmed",
  "in_progress",
  "completed",
  "cancelled",
  "declined",
  "expired",
  "no_show",
];
const STATUS_SET = new Set<string>(VISIT_STATUSES);

export function parseVisitSnapshot(raw: unknown): VisitSnapshot | null {
  if (!isObject(raw) || !isString(raw.id) || !raw.id || !isString(raw.status) || !STATUS_SET.has(raw.status)) return null;
  if (!isDateString(raw.date) || !isTimeOfDay(raw.startTime) || !isTimeOfDay(raw.endTime)) return null;
  const cancelledBy =
    raw.cancelledBy === "customer" || raw.cancelledBy === "staff" || raw.cancelledBy === "system" ? raw.cancelledBy : null;
  return {
    id: raw.id,
    status: raw.status as VisitStatus,
    nextStatuses: stringList(raw.nextStatuses).filter((s): s is VisitStatus => STATUS_SET.has(s) && s !== "expired"),
    date: raw.date,
    startTime: raw.startTime,
    endTime: raw.endTime,
    startsAt: str(raw.startsAt),
    endsAt: str(raw.endsAt),
    timeZone: str(raw.timeZone, "UTC") || "UTC",
    durationMinutes: num(raw.durationMinutes, 0),
    resourceId: strOrNull(raw.resourceId),
    resourceName: strOrNull(raw.resourceName),
    serviceKey: str(raw.serviceKey),
    serviceName: str(raw.serviceName, "Visit") || "Visit",
    title: strOrNull(raw.title),
    customerName: strOrNull(raw.customerName),
    customerEmail: strOrNull(raw.customerEmail),
    customerPhone: strOrNull(raw.customerPhone),
    address: strOrNull(raw.address),
    lat: numOrNull(raw.lat),
    lng: numOrNull(raw.lng),
    notes: strOrNull(raw.notes),
    estimateId: strOrNull(raw.estimateId),
    origin: raw.origin === "public" ? "public" : "staff",
    sequence: num(raw.sequence, 0),
    pendingExpiresAt: strOrNull(raw.pendingExpiresAt),
    cancelledAt: strOrNull(raw.cancelledAt),
    cancelledBy,
    cancelReason: strOrNull(raw.cancelReason),
    startedAt: strOrNull(raw.startedAt),
    completedAt: strOrNull(raw.completedAt),
    createdAt: str(raw.createdAt),
    updatedAt: str(raw.updatedAt),
  };
}

function parseCalendarResource(raw: unknown): CalendarResource | null {
  if (!isObject(raw) || !isString(raw.id) || !raw.id || !isString(raw.name)) return null;
  return {
    id: raw.id,
    name: raw.name,
    isActive: raw.isActive !== false,
    acceptsPublicBookings: raw.acceptsPublicBookings !== false,
    maxJobsPerDay: num(raw.maxJobsPerDay, 0),
  };
}

function parseWindow(raw: unknown): { start: string; end: string } | null {
  if (!isObject(raw) || !isTimeOfDay(raw.start) || !isTimeOfDay(raw.end)) return null;
  return { start: raw.start, end: raw.end };
}

function parseDayWindows(raw: unknown): DayWindows | null {
  if (!isObject(raw) || !isString(raw.resourceId) || !isDateString(raw.date)) return null;
  return { resourceId: raw.resourceId, date: raw.date, windows: listOf(raw.windows, parseWindow) };
}

/** A grid step the calendar can draw: a multiple of 5 between 5 and 240, else 30. */
function gridStep(value: unknown): number {
  const step = num(value, 30);
  return step >= 5 && step <= 240 && step % 5 === 0 ? step : 30;
}

export function parseCalendarResponse(body: unknown): CalendarResponse | null {
  if (!isObject(body) || !Array.isArray(body.resources) || !Array.isArray(body.visits)) return null;
  if (!isDateString(body.today) || !isDateString(body.from) || !isDateString(body.to)) return null;
  return {
    timeZone: str(body.timeZone, "UTC") || "UTC",
    today: body.today,
    from: body.from,
    to: body.to,
    slotStepMinutes: gridStep(body.slotStepMinutes),
    resources: listOf(body.resources, parseCalendarResource),
    windows: listOf(body.windows, parseDayWindows),
    visits: listOf(body.visits, parseVisitSnapshot),
    pending: listOf(body.pending, parseVisitSnapshot),
  };
}

function parseStop(raw: unknown): CrewStop | null {
  if (!isObject(raw)) return null;
  const visit = parseVisitSnapshot(raw.visit);
  if (!visit) return null;
  const drive = isObject(raw.driveFromPrevious) ? raw.driveFromPrevious : null;
  return {
    order: num(raw.order, 0),
    visit,
    driveFromPrevious:
      drive && typeof drive.minutes === "number"
        ? {
            minutes: num(drive.minutes),
            miles: num(drive.miles),
            from: drive.from === "home_base" ? "home_base" : "previous_stop",
            estimated: isTrue(drive.estimated),
          }
        : null,
    directionsUrl: strOrNull(raw.directionsUrl),
    telUrl: strOrNull(raw.telUrl),
  };
}

export function parseCrewDayResponse(body: unknown): CrewDayResponse | null {
  if (!isObject(body) || !isObject(body.resource) || !Array.isArray(body.stops)) return null;
  const resource = body.resource;
  if (!isString(resource.id) || !isString(resource.name) || !isDateString(body.date)) return null;
  const totals = isObject(body.totals) ? body.totals : {};
  const stops = listOf(body.stops, parseStop).sort((a, b) => a.order - b.order);
  return {
    timeZone: str(body.timeZone, "UTC") || "UTC",
    date: body.date,
    today: isDateString(body.today) ? body.today : body.date,
    resource: { id: resource.id, name: resource.name, homeBaseAddress: strOrNull(resource.homeBaseAddress) },
    windows: listOf(body.windows, parseWindow),
    stops,
    totals: {
      visits: num(totals.visits, stops.length),
      driveMinutes: num(totals.driveMinutes, 0),
      distanceMiles: num(totals.distanceMiles, 0),
      estimated: isTrue(totals.estimated),
    },
    routeUrl: strOrNull(body.routeUrl),
    // Only an explicit false from the server offers other days: a server that
    // predates the flag is read as today-only, the safe way round.
    todayOnly: body.todayOnly !== false,
  };
}

function parseStaffSlot(raw: unknown): StaffSlot | null {
  if (!isObject(raw) || !isDateString(raw.date) || !isTimeOfDay(raw.startTime) || !isTimeOfDay(raw.endTime)) return null;
  if (!isString(raw.resourceId) || !raw.resourceId) return null;
  return {
    date: raw.date,
    startTime: raw.startTime,
    endTime: raw.endTime,
    startsAt: str(raw.startsAt),
    endsAt: str(raw.endsAt),
    resourceId: raw.resourceId,
    resourceName: str(raw.resourceName),
    driveMinutesFromPrevious: numOrNull(raw.driveMinutesFromPrevious),
    previousJobAddress: strOrNull(raw.previousJobAddress),
    score: num(raw.score, 0),
  };
}

export function parseSuggestResponse(body: unknown): SuggestResponse | null {
  if (!isObject(body) || !Array.isArray(body.slots)) return null;
  return { timeZone: str(body.timeZone, "UTC") || "UTC", estimated: isTrue(body.estimated), slots: listOf(body.slots, parseStaffSlot) };
}

function parseVisitEnvelope(body: unknown): { visit: VisitSnapshot } | null {
  const visit = isObject(body) ? parseVisitSnapshot(body.visit) : null;
  return visit ? { visit } : null;
}

function parseMutation(body: unknown): VisitMutationResponse | null {
  const visit = isObject(body) ? parseVisitSnapshot(body.visit) : null;
  if (!visit || !isObject(body)) return null;
  return { visit, warnings: stringList(body.warnings) };
}

function parseExpire(body: unknown): ExpireResponse | null {
  return isObject(body) && typeof body.expired === "number" ? { expired: body.expired } : null;
}

function parseServiceWire(raw: unknown): ServiceWire | null {
  if (!isObject(raw) || !isString(raw.key) || !isString(raw.name)) return null;
  return {
    key: raw.key,
    name: raw.name,
    durationMinutes: num(raw.durationMinutes, 60),
    description: strOrNull(raw.description),
    requiredSkill: strOrNull(raw.requiredSkill),
  };
}

export function parseSettingsWire(raw: unknown): SettingsWire | null {
  if (!isObject(raw) || !isString(raw.timeZone) || !Array.isArray(raw.services)) return null;
  return {
    timeZone: raw.timeZone,
    businessName: str(raw.businessName),
    contactEmail: strOrNull(raw.contactEmail),
    contactPhone: strOrNull(raw.contactPhone),
    staffNotifyEmails: stringList(raw.staffNotifyEmails),
    services: listOf(raw.services, parseServiceWire),
    slotStepMinutes: num(raw.slotStepMinutes, 30),
    minNoticeMinutes: num(raw.minNoticeMinutes, 1440),
    horizonDays: num(raw.horizonDays, 30),
    travelBufferMinutes: num(raw.travelBufferMinutes, 30),
    maxSlotsPerDay: numOrNull(raw.maxSlotsPerDay),
    maxOpenRequestsPerRequester: numOrNull(raw.maxOpenRequestsPerRequester),
    requireAddress: isTrue(raw.requireAddress),
    autoConfirm: isTrue(raw.autoConfirm),
    publicBookingEnabled: raw.publicBookingEnabled !== false,
    pendingExpiryHours: num(raw.pendingExpiryHours, 48),
    reminderLeadHours: num(raw.reminderLeadHours, 24),
    cancelCutoffHours: num(raw.cancelCutoffHours, 24),
    saved: isTrue(raw.saved),
    updatedAt: strOrNull(raw.updatedAt),
    // Tenancy 2a: an older server sends nothing here, which reads as
    // "editable here" (null), the 0.1 screen.
    managedByCompany: isObject(raw.managedByCompany) ? { href: strOrNull(raw.managedByCompany.href) } : null,
  };
}

function parseSettingsEnvelope(body: unknown): { settings: SettingsWire } | null {
  const settings = isObject(body) ? parseSettingsWire(body.settings) : null;
  return settings ? { settings } : null;
}

export function parseAdminResource(raw: unknown): AdminResource | null {
  if (!isObject(raw) || !isString(raw.id) || !raw.id || !isString(raw.name)) return null;
  return {
    id: raw.id,
    name: raw.name,
    userId: strOrNull(raw.userId),
    homeBaseAddress: strOrNull(raw.homeBaseAddress),
    homeBaseLat: numOrNull(raw.homeBaseLat),
    homeBaseLng: numOrNull(raw.homeBaseLng),
    skills: stringList(raw.skills),
    workStartTime: isTimeOfDay(raw.workStartTime) ? raw.workStartTime : "08:00",
    workEndTime: isTimeOfDay(raw.workEndTime) ? raw.workEndTime : "17:00",
    maxJobsPerDay: num(raw.maxJobsPerDay, 0),
    hoursConfigured: isTrue(raw.hoursConfigured),
    acceptsPublicBookings: raw.acceptsPublicBookings !== false,
    isActive: raw.isActive !== false,
    createdAt: str(raw.createdAt),
    updatedAt: str(raw.updatedAt),
  };
}

function parseResourceEnvelope(body: unknown): { resource: AdminResource } | null {
  const resource = isObject(body) ? parseAdminResource(body.resource) : null;
  return resource ? { resource } : null;
}

function parseResourceList(body: unknown): { resources: AdminResource[] } | null {
  return isObject(body) && Array.isArray(body.resources) ? { resources: listOf(body.resources, parseAdminResource) } : null;
}

function parseWeekly(raw: unknown): WeeklyWindow | null {
  if (!isObject(raw) || typeof raw.dayOfWeek !== "number" || !isTimeOfDay(raw.startTime) || !isTimeOfDay(raw.endTime)) return null;
  if (!Number.isInteger(raw.dayOfWeek) || raw.dayOfWeek < 0 || raw.dayOfWeek > 6) return null;
  return { dayOfWeek: raw.dayOfWeek, startTime: raw.startTime, endTime: raw.endTime };
}

function parseTimeOffDay(raw: unknown): TimeOffDay | null {
  if (!isObject(raw) || !isString(raw.id) || !isDateString(raw.date)) return null;
  return { id: raw.id, date: raw.date, note: strOrNull(raw.note) };
}

function parseSpecialHours(raw: unknown): SpecialHours | null {
  if (!isObject(raw) || !isString(raw.id) || !isDateString(raw.date) || !isTimeOfDay(raw.startTime) || !isTimeOfDay(raw.endTime)) {
    return null;
  }
  return { id: raw.id, date: raw.date, startTime: raw.startTime, endTime: raw.endTime, note: strOrNull(raw.note) };
}

export function parseAvailability(body: unknown): AvailabilityResponse | null {
  if (!isObject(body) || !isString(body.resourceId) || !Array.isArray(body.weekly)) return null;
  const weekly = listOf(body.weekly, parseWeekly);
  return {
    resourceId: body.resourceId,
    hoursConfigured: isTrue(body.hoursConfigured),
    weekly,
    effectiveWeekly: Array.isArray(body.effectiveWeekly) ? listOf(body.effectiveWeekly, parseWeekly) : weekly,
    timeOff: listOf(body.timeOff, parseTimeOffDay),
    specialHours: listOf(body.specialHours, parseSpecialHours),
  };
}

const NOTICE_CODES = new Set<string>([
  "booking_off",
  "setup_name",
  "setup_contact",
  "setup_zone",
  "emails_off",
  "reminders_off",
  "reminders_daily",
  "delivery_problem",
  "crew_unlinked",
]);

/** A notice's "where to fix it" link: a path on this site or an http(s) address, never a script URL. */
function parseNoticeLink(raw: unknown): { href: string; label: string } | null {
  if (!isObject(raw) || !isString(raw.href) || !isString(raw.label) || !raw.label.trim()) return null;
  return /^(\/(?!\/)|https?:\/\/)/i.test(raw.href) ? { href: raw.href, label: raw.label } : null;
}

function parseNotice(raw: unknown): AdminNotice | null {
  if (!isObject(raw) || !isString(raw.message) || !raw.message) return null;
  // An unknown code from a newer server is still a sentence worth showing.
  const code = (isString(raw.code) && NOTICE_CODES.has(raw.code) ? raw.code : "delivery_problem") as AdminNoticeCode;
  const link = parseNoticeLink(raw.link);
  return { code, tone: raw.tone === "warn" ? "warn" : "info", message: raw.message, ...(link ? { link } : {}) };
}

/**
 * The office's status. Read cautiously: an answer that doesn't say emails are
 * off is NOT taken to mean they are on unless it says so — but a server too
 * old to have the route at all is handled by the caller (it shows nothing and
 * keeps the old behaviour).
 */
export function parseAdminStatus(body: unknown): AdminStatus | null {
  if (!isObject(body) || typeof body.customerEmails !== "boolean") return null;
  return {
    customerEmails: body.customerEmails,
    reminders: isTrue(body.reminders),
    upcomingVisits: Math.max(0, num(body.upcomingVisits, 0)),
    notices: listOf(body.notices, parseNotice),
  };
}

function parsePerson(raw: unknown): PersonOption | null {
  if (!isObject(raw) || !isString(raw.userId) || !raw.userId) return null;
  return { userId: raw.userId, name: strOrNull(raw.name), email: strOrNull(raw.email) };
}

export function parsePeople(body: unknown): PeopleResponse | null {
  if (!isObject(body)) return null;
  if (body.people === null) return { people: null };
  return Array.isArray(body.people) ? { people: listOf(body.people, parsePerson) } : null;
}

function parseTimeOffResponse(body: unknown): TimeOffResponse | null {
  const availability = parseAvailability(body);
  if (!availability || !isObject(body)) return null;
  return { ...availability, visitsOnThoseDays: listOf(body.visitsOnThoseDays, parseVisitSnapshot) };
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

const ADMIN = "/v1/admin";
const id = (value: string) => encodeURIComponent(value);

/**
 * A POST whose route takes no body (expire, deactivate, reactivate, remove
 * time off) still sends `{}` as JSON.
 * CONTRACT: the contract lists these requests as "none"; an empty JSON object
 * is the reading that every JSON-parsing handler accepts.
 */
const NO_BODY = {};

export function createSchedulingAdminClient(options: SchedulingAdminClientOptions): SchedulingAdminTransport {
  const http = createRequester(options);
  return {
    calendar: (q) =>
      http.get(
        `${ADMIN}/calendar${queryString({
          from: q.from,
          to: q.to,
          resources: q.resources && q.resources.length > 0 ? q.resources.join(",") : undefined,
          include: q.includeInactive ? "inactive" : undefined,
        })}`,
        parseCalendarResponse,
      ),
    crewDay: (q) => http.get(`${ADMIN}/crew-day${queryString({ date: q.date, resource: q.resource })}`, parseCrewDayResponse),
    suggest: (q) =>
      http.get(
        `${ADMIN}/suggest${queryString({
          service: q.service,
          minutes: q.minutes,
          address: q.address,
          lat: q.lat,
          lng: q.lng,
          from: q.from,
          days: q.days,
          resource: q.resource,
        })}`,
        parseSuggestResponse,
      ),
    getVisit: (visitId) => http.get(`${ADMIN}/visits/${id(visitId)}`, parseVisitEnvelope),
    createVisit: (body) => http.post(`${ADMIN}/visits`, body, parseMutation),
    accept: (visitId, body) => http.post(`${ADMIN}/visits/${id(visitId)}/accept`, body, parseVisitEnvelope),
    decline: (visitId, body) => http.post(`${ADMIN}/visits/${id(visitId)}/decline`, body, parseVisitEnvelope),
    setStatus: (visitId, body) => http.post(`${ADMIN}/visits/${id(visitId)}/status`, body, parseVisitEnvelope),
    reschedule: (visitId, body) => http.post(`${ADMIN}/visits/${id(visitId)}/reschedule`, body, parseMutation),
    assign: (visitId, body) => http.post(`${ADMIN}/visits/${id(visitId)}/assign`, body, parseMutation),
    updateDetails: (visitId, body) => http.post(`${ADMIN}/visits/${id(visitId)}/details`, body, parseMutation),
    expire: () => http.post(`${ADMIN}/expire`, NO_BODY, parseExpire),
    getSettings: () => http.get(`${ADMIN}/settings`, parseSettingsEnvelope),
    updateSettings: (patch) => http.post(`${ADMIN}/settings`, patch, parseSettingsEnvelope),
    listResources: (q) =>
      http.get(`${ADMIN}/resources${queryString({ include: q?.includeInactive ? "inactive" : undefined })}`, parseResourceList),
    createResource: (body) => http.post(`${ADMIN}/resources`, body, parseResourceEnvelope),
    updateResource: (resourceId, patch) => http.post(`${ADMIN}/resources/${id(resourceId)}`, patch, parseResourceEnvelope),
    deactivateResource: (resourceId) => http.post(`${ADMIN}/resources/${id(resourceId)}/deactivate`, NO_BODY, parseResourceEnvelope),
    reactivateResource: (resourceId) => http.post(`${ADMIN}/resources/${id(resourceId)}/reactivate`, NO_BODY, parseResourceEnvelope),
    getAvailability: (resourceId) => http.get(`${ADMIN}/resources/${id(resourceId)}/availability`, parseAvailability),
    setWeekly: (resourceId, body) => http.post(`${ADMIN}/resources/${id(resourceId)}/availability`, body, parseAvailability),
    addTimeOff: (resourceId, body) => http.post(`${ADMIN}/resources/${id(resourceId)}/time-off`, body, parseTimeOffResponse),
    removeTimeOff: (resourceId, exceptionId) =>
      http.post(`${ADMIN}/resources/${id(resourceId)}/time-off/${id(exceptionId)}/remove`, NO_BODY, parseAvailability),
    status: () => http.get(`${ADMIN}/status`, parseAdminStatus),
    people: () => http.get(`${ADMIN}/people`, parsePeople),
    progress: (visitId, body) => http.post(`${ADMIN}/visits/${id(visitId)}/progress`, body, parseVisitEnvelope),
  };
}
