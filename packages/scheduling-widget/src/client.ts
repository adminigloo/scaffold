import {
  createRequester,
  isDateString,
  isObject,
  isString,
  isTimeOfDay,
  isTrue,
  listOf,
  num,
  queryString,
  str,
  strOrNull,
  type Result,
  type TransportOptions,
} from "./http.js";
import type {
  CancelVisitBody,
  DateString,
  PublicConfig,
  PublicService,
  PublicSlot,
  PublicVisit,
  PublicVisitStatus,
  RescheduleVisitBody,
  SlotsResponse,
  VisitRequestBody,
  VisitRequestResponse,
  VisitResponse,
} from "./types.js";

/**
 * The customer-facing transport: `createSchedulingHandlers`' seven routes
 * (contract section 4.1), each answer checked narrowly. Components take this
 * interface, not the class, so a host can back the picker with anything that
 * answers in these shapes (a test fake, a server action, tRPC).
 */

export interface SchedulingTransport {
  config(): Promise<Result<PublicConfig>>;
  slots(q: { service?: string; from?: DateString; days?: number; manage?: string }): Promise<Result<SlotsResponse>>;
  request(body: VisitRequestBody): Promise<Result<VisitRequestResponse>>;
  visit(token: string): Promise<Result<VisitResponse>>;
  reschedule(token: string, body: RescheduleVisitBody): Promise<Result<VisitResponse>>;
  cancel(token: string, body: CancelVisitBody): Promise<Result<VisitResponse>>;
  /** The .ics download link for a visit; null when this transport has none to give. */
  icsUrl(token: string): string | null;
}

export type SchedulingClientOptions = TransportOptions;

// ---------------------------------------------------------------------------
// Shape checks — only what the widget reads, with safe defaults for the rest
// ---------------------------------------------------------------------------

const PUBLIC_STATUSES = new Set<PublicVisitStatus>([
  "requested",
  "confirmed",
  "in_progress",
  "completed",
  "cancelled",
  "declined",
  "expired",
  "missed",
]);

function parseService(raw: unknown): PublicService | null {
  if (!isObject(raw) || !isString(raw.key) || !raw.key || !isString(raw.name)) return null;
  return {
    key: raw.key,
    name: raw.name,
    description: strOrNull(raw.description),
    durationMinutes: num(raw.durationMinutes, 60),
  };
}

export function parsePublicConfig(body: unknown): PublicConfig | null {
  if (!isObject(body) || !Array.isArray(body.services)) return null;
  return {
    businessName: str(body.businessName),
    timeZone: str(body.timeZone, "UTC") || "UTC",
    // Absent reads as open: an older server that doesn't say still takes requests.
    publicBookingEnabled: body.publicBookingEnabled !== false,
    autoConfirm: isTrue(body.autoConfirm),
    services: listOf(body.services, parseService),
    minNoticeMinutes: num(body.minNoticeMinutes, 0),
    horizonDays: num(body.horizonDays, 30),
    requireAddress: isTrue(body.requireAddress),
    cancelCutoffHours: num(body.cancelCutoffHours, 0),
    contactEmail: strOrNull(body.contactEmail),
    contactPhone: strOrNull(body.contactPhone),
    // Only an explicit true promises email: a page that can't tell must not
    // send anyone to an inbox nobody wrote to.
    emailsEnabled: isTrue(body.emailsEnabled),
    minFillMs: Math.max(0, num(body.minFillMs, 0)),
  };
}

export function parsePublicSlot(raw: unknown): PublicSlot | null {
  if (!isObject(raw)) return null;
  if (!isString(raw.slotId) || !raw.slotId || !isDateString(raw.date) || !isTimeOfDay(raw.startTime) || !isTimeOfDay(raw.endTime)) {
    return null;
  }
  return {
    slotId: raw.slotId,
    date: raw.date,
    startTime: raw.startTime,
    endTime: raw.endTime,
    startsAt: str(raw.startsAt),
    endsAt: str(raw.endsAt),
  };
}

export function parseSlotsResponse(body: unknown): SlotsResponse | null {
  if (!isObject(body) || !Array.isArray(body.slots)) return null;
  return {
    timeZone: str(body.timeZone, "UTC") || "UTC",
    service: str(body.service),
    from: str(body.from),
    to: str(body.to),
    closed: isTrue(body.closed),
    slots: listOf(body.slots, parsePublicSlot),
  };
}

export function parsePublicVisit(raw: unknown): PublicVisit | null {
  if (!isObject(raw) || !isString(raw.status) || !PUBLIC_STATUSES.has(raw.status as PublicVisitStatus)) return null;
  if (!isDateString(raw.date) || !isTimeOfDay(raw.startTime) || !isTimeOfDay(raw.endTime)) return null;
  const cancelledBy = raw.cancelledBy === "customer" || raw.cancelledBy === "business" ? raw.cancelledBy : null;
  return {
    status: raw.status as PublicVisitStatus,
    serviceKey: str(raw.serviceKey),
    serviceName: str(raw.serviceName, "Visit") || "Visit",
    date: raw.date,
    startTime: raw.startTime,
    endTime: raw.endTime,
    startsAt: str(raw.startsAt),
    endsAt: str(raw.endsAt),
    timeZone: str(raw.timeZone, "UTC") || "UTC",
    durationMinutes: num(raw.durationMinutes, 0),
    customerName: str(raw.customerName),
    address: strOrNull(raw.address),
    businessName: str(raw.businessName),
    contactPhone: strOrNull(raw.contactPhone),
    contactEmail: strOrNull(raw.contactEmail),
    canReschedule: isTrue(raw.canReschedule),
    canCancel: isTrue(raw.canCancel),
    changeDeadline: strOrNull(raw.changeDeadline),
    cancelCutoffHours: num(raw.cancelCutoffHours, 0),
    cancelledBy,
    googleCalendarUrl: strOrNull(raw.googleCalendarUrl),
  };
}

export function parseVisitResponse(body: unknown): VisitResponse | null {
  const visit = isObject(body) ? parsePublicVisit(body.visit) : null;
  return visit ? { visit } : null;
}

/**
 * A new request always carries its manage token; a REPEAT carries none (the
 * server hands a repeat no key to the visit — the first request's email has
 * the link), so a missing token is a bad answer only when it isn't a repeat.
 */
export function parseVisitRequestResponse(body: unknown): VisitRequestResponse | null {
  if (!isObject(body)) return null;
  const visit = parsePublicVisit(body.visit);
  if (!visit) return null;
  const repeated = isTrue(body.repeated);
  const token = isString(body.manageToken) && body.manageToken ? body.manageToken : null;
  if (!token && !repeated) return null;
  return { visit, manageToken: token, manageUrl: token ? strOrNull(body.manageUrl) : null, repeated };
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/** Token routes carry the token in the PATH, encoded (contract 4.1). */
function visitPath(token: string, suffix = ""): string {
  return `/v1/visit/${encodeURIComponent(token)}${suffix}`;
}

export function createSchedulingClient(options: SchedulingClientOptions): SchedulingTransport {
  const http = createRequester(options);
  return {
    config: () => http.get("/v1/config", parsePublicConfig),
    slots: (q) =>
      http.get(
        `/v1/slots${queryString({ service: q.service, from: q.from, days: q.days, manage: q.manage })}`,
        parseSlotsResponse,
      ),
    request: (body) => http.post("/v1/request", body, parseVisitRequestResponse),
    visit: (token) => http.get(visitPath(token), parseVisitResponse),
    reschedule: (token, body) => http.post(visitPath(token, "/reschedule"), body, parseVisitResponse),
    cancel: (token, body) => http.post(visitPath(token, "/cancel"), body, parseVisitResponse),
    icsUrl: (token) => http.url(visitPath(token, "/ics")),
  };
}
