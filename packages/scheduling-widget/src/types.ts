/**
 * The public half of the scheduling wire contract (docs/scheduling-0.4-contract.md
 * section 7), declared verbatim. The server declares the same shapes in
 * `@adminigloo/scheduling`'s src/wire.ts; neither package imports the other, so
 * a marketing site that embeds the picker installs nothing but this.
 *
 * Field names, optionality and enums match the server's character for
 * character: change one here and the other half breaks without either test
 * suite noticing. Dates and instants are always strings on the wire.
 *
 * The staff half (VisitSnapshot, CalendarResponse, …) is in ./admin/types.ts.
 */

// ---- scalars ---------------------------------------------------------------
export type DateString = string; // "YYYY-MM-DD": a calendar date in the business's zone
export type TimeOfDay = string; // "HH:MM", 24-hour, zero-padded; an end may be "24:00"
export type Instant = string; // ISO 8601 UTC: "2026-11-02T16:00:00.000Z"

export type VisitStatus =
  | "pending"
  | "confirmed"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "declined"
  | "expired"
  | "no_show";
export type PublicVisitStatus =
  | "requested"
  | "confirmed"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "declined"
  | "expired"
  | "missed";
// PublicVisitStatus from VisitStatus: pending→requested, no_show→missed, the rest the same.

export type WireErrorCode =
  | "invalid"
  | "spam_suspected"
  | "not_found"
  | "forbidden"
  | "rate_limited"
  | "too_many_requests"
  | "booking_closed"
  | "slot_unavailable"
  | "too_soon"
  | "too_far"
  | "invalid_duration"
  | "unknown_service"
  | "address_unresolved"
  | "too_late"
  | "outside_hours"
  | "invalid_window"
  | "resource_unavailable"
  | "not_changeable"
  | "transition_not_allowed"
  | "internal";
export interface WireIssue {
  path: Array<string | number>;
  message: string;
  code?: string;
}
export interface WireErrorBody {
  error: { code: WireErrorCode; message: string; issues?: WireIssue[] };
}

// ---- public (createSchedulingHandlers) ---------------------------------------
export interface PublicService {
  key: string;
  name: string;
  description: string | null;
  durationMinutes: number;
}

export interface PublicConfig {
  businessName: string;
  timeZone: string; // IANA
  publicBookingEnabled: boolean;
  autoConfirm: boolean;
  services: PublicService[];
  minNoticeMinutes: number;
  horizonDays: number;
  requireAddress: boolean;
  cancelCutoffHours: number;
  contactEmail: string | null;
  contactPhone: string | null;
  emailsEnabled: boolean; // false: never promise an email; show the manage link to keep
  minFillMs: number; // the server's fill-time floor; 0 = off
}

export interface PublicSlot {
  slotId: string; // opaque; send back as is
  date: DateString;
  startTime: TimeOfDay;
  endTime: TimeOfDay;
  startsAt: Instant;
  endsAt: Instant;
}
export interface SlotsResponse {
  timeZone: string;
  service: string;
  from: DateString;
  to: DateString;
  closed: boolean; // online booking is off
  slots: PublicSlot[]; // time order
}

export interface VisitRequestBody {
  slotId: string;
  service: string;
  name: string; // 1–200
  email: string; // ≤ 320, an email
  phone?: string; // ≤ 60
  address?: string; // ≤ 500; required when config.requireAddress
  notes?: string; // ≤ 2000
  estimateId?: string; // ≤ 200
  website?: string; // honeypot: must be empty or absent
  fillMs?: number; // ms between the details form appearing and submit
  addressAsTyped?: boolean; // "send it anyway": the map couldn't place the address; the office checks it
}

export interface PublicVisit {
  status: PublicVisitStatus;
  serviceKey: string;
  serviceName: string;
  date: DateString;
  startTime: TimeOfDay;
  endTime: TimeOfDay;
  startsAt: Instant;
  endsAt: Instant;
  timeZone: string;
  durationMinutes: number;
  customerName: string;
  address: string | null;
  businessName: string;
  contactPhone: string | null;
  contactEmail: string | null;
  canReschedule: boolean;
  canCancel: boolean;
  changeDeadline: Instant | null; // startsAt − cutoff; null once the visit isn't pending/confirmed
  cancelCutoffHours: number;
  cancelledBy: "customer" | "business" | null; // staff and system both read as "business"
  googleCalendarUrl: string | null; // null once cancelled/declined/expired
}
export interface VisitRequestResponse {
  visit: PublicVisit;
  manageToken: string | null; // null when `repeated`: the first request's email carries the link
  manageUrl: string | null;
  repeated: boolean;
}
export interface VisitResponse {
  visit: PublicVisit;
}
export interface RescheduleVisitBody {
  slotId: string;
}
export interface CancelVisitBody {
  reason?: string;
} // ≤ 500
