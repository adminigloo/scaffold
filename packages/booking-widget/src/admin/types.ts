import type { BookingStatus, BusySync, Medium, Slot } from "../types.js";

/**
 * The admin screens' contract with the host app: plain data types and one
 * adapter of async functions.
 *
 * The functions mirror `@adminigloo/booking`'s admin services one for one
 * (listBookings, getBooking, hostCancelBooking, confirmBooking, setOutcome,
 * hostRescheduleBooking, upsertHost, testBusySource, rotateHostFeedToken,
 * getAvailability, setWeeklyAvailability, add/removeException,
 * add/list/removeBlackout, listTypes, upsertType …), so wiring them is a
 * line each — through tRPC procedures, server actions, or fetch to your own
 * routes. The widget package still never imports the server package: these
 * shapes are declared here, by hand, for the same reason the public wire
 * types are (see ../types.ts).
 *
 * Instants may arrive as Date (tRPC with superjson, server actions) or as
 * ISO strings (plain JSON); every field typed `Instant` accepts both.
 * Every function may throw — the message is shown next to the control that
 * called it, so a server's "Must be an https:// link." reaches the person.
 */

export type Instant = string | Date;

export interface AdminHost {
  id: string;
  displayName: string;
  /** Where host notices go — and, in calendar files, the organizer. */
  email: string;
  timezone: string;
  meetingLink: string | null;
  phone: string | null;
  inviteMailbox: string | null;
  /** MASKED by the server ("https://calendar.google.com/…ics ✓"); null when no calendar is connected. */
  busyIcsUrl: string | null;
  busySync: { error: string | null; failingSince: Instant | null; okAt: Instant | null };
  hasFeedToken: boolean;
  autoConfirm: boolean;
  isActive?: boolean;
  updatedAt?: Instant;
}

export interface AdminBookingType {
  id: string;
  key: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  stepMinutes: number;
  minNoticeMinutes: number;
  horizonDays: number;
  maxPerDay: number | null;
  media: Medium[];
  /** Hosts who take this type; empty = every active host. */
  hostIds: string[];
  isActive: boolean;
  sortOrder: number;
  updatedAt?: Instant;
}

export type AdminActor = "host" | "invitee" | "system" | (string & {});

export interface AdminBooking {
  id: string;
  typeKey: string | null;
  typeName: string | null;
  hostId: string;
  hostDisplayName: string | null;
  status: BookingStatus;
  start: Instant;
  end: Instant;
  hostTimezone: string;
  inviteeTimezone: string | null;
  inviteeName: string | null;
  inviteeEmail: string | null;
  inviteePhone: string | null;
  inviteeCompany: string | null;
  notes: string | null;
  medium: Medium | null;
  source: string | null;
  sequence: number;
  cancelledBy: AdminActor | null;
  cancelReason: string | null;
  outcome: string | null;
}

export interface AdminBookingEvent {
  id: string | number;
  kind: string;
  actor: string;
  detail: Record<string, unknown> | null;
  at: Instant;
}

export interface WeeklyWindow {
  /** 0 = Sunday … 6 = Saturday. */
  dayOfWeek: number;
  /** Minutes after the host's midnight, on the 15-minute grid, 0..1440. */
  startMinute: number;
  endMinute: number;
}

export type ExceptionKind = "off" | "hours" | "block";

export interface AdminException {
  id: string;
  /** The host-zone calendar date, YYYY-MM-DD. */
  date: string;
  kind: ExceptionKind;
  startMinute: number | null;
  endMinute: number | null;
  note: string | null;
}

export interface AdminBlackout {
  id: string;
  date: string;
  label: string | null;
}

/** `upsertHost`'s input. No `id` creates a host. For the optional strings, "" clears the field and absent leaves it. */
export interface HostInput {
  id?: string;
  displayName: string;
  email: string;
  timezone: string;
  meetingLink?: string | null;
  phone?: string | null;
  inviteMailbox?: string | null;
  /** The secret iCal address. "" disconnects; absent leaves it as is. */
  busyIcsUrl?: string | null;
  autoConfirm?: boolean;
  isActive?: boolean;
}

/** `upsertType`'s input — it replaces every field, so the form sends the ones it does not show as they are. */
export interface BookingTypeInput {
  id?: string;
  key: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  stepMinutes: number;
  minNoticeMinutes: number;
  horizonDays: number;
  maxPerDay: number | null;
  media: Medium[];
  hostIds: string[];
  isActive: boolean;
  sortOrder: number;
}

export interface ExceptionInput {
  hostId: string;
  date: string;
  kind: ExceptionKind;
  startMinute?: number | null;
  endMinute?: number | null;
  note?: string | null;
}

export type BookingScope = "upcoming" | "past";

export interface BookingAdminAdapter {
  /**
   * Whether the server actually sends email (booking events wired to a mail
   * provider). Every button that would promise an email reads this: with it
   * false, "Cancel the call and email them" becomes "Cancel the call", with
   * a mailto link so the host can tell the person themselves.
   */
  emailsEnabled: boolean;

  // --- bookings -----------------------------------------------------------
  /** Upcoming: not yet ended, soonest first. Past: ended, most recent first. Never holds. */
  listBookings(input: { scope: BookingScope }): Promise<AdminBooking[]>;
  /** One booking with its audit trail, newest first; null when there is none. */
  getBooking(id: string): Promise<(AdminBooking & { events: AdminBookingEvent[] }) | null>;
  cancelBooking(input: { id: string; reason: string | null }): Promise<AdminBooking>;
  confirmBooking(id: string): Promise<AdminBooking>;
  setOutcome(input: { id: string; outcome: string | null; status?: "completed" | "no_show" }): Promise<AdminBooking>;
  /** The host moves a call (the server's hostRescheduleBooking): same booking, new start. */
  rescheduleBooking(input: { id: string; start: string }): Promise<AdminBooking>;
  /**
   * Open starts the call could move to, for the "Move call" picker. Ideally
   * the booking itself is left out of busy (so "half an hour later" is
   * offered); a server without that can list the type's open slots as is.
   */
  listRescheduleSlots(input: { id: string; typeKey: string; from: string; to: string }): Promise<{ slots: Slot[]; busySync?: BusySync }>;

  // --- hosts ----------------------------------------------------------------
  listHosts(): Promise<AdminHost[]>;
  upsertHost(input: HostInput): Promise<AdminHost>;
  /** Fetch the next two weeks from the host's calendar address: how many busy blocks, or why not. */
  testCalendar(hostId: string): Promise<{ ok: boolean; events: number; error?: string }>;
  /** A new subscribable feed link, killing the old one. Returned once; only its hash is kept. */
  rotateFeed(hostId: string): Promise<{ httpsUrl: string; webcalUrl?: string }>;

  // --- availability -----------------------------------------------------------
  getAvailability(hostId: string): Promise<{ weekly: WeeklyWindow[]; exceptions: AdminException[] }>;
  /** Replaces the whole week. */
  setWeekly(input: { hostId: string; windows: WeeklyWindow[] }): Promise<unknown>;
  addException(input: ExceptionInput): Promise<AdminException>;
  removeException(id: string): Promise<unknown>;
  listBlackouts(): Promise<AdminBlackout[]>;
  addBlackout(input: { date: string; label: string | null }): Promise<AdminBlackout>;
  removeBlackout(id: string): Promise<unknown>;

  // --- types ------------------------------------------------------------------
  listTypes(): Promise<AdminBookingType[]>;
  upsertType(input: BookingTypeInput): Promise<AdminBookingType>;

  // --- optional ---------------------------------------------------------------
  /**
   * Live holds right now (times people are filling in the form for). Shown
   * so a calendar kept full of holds — by a bot or a bad actor — is visible
   * instead of silent.
   */
  countLiveHolds?(): Promise<number>;
  /**
   * Whether the host's week is still the placeholder your app seeded. Only
   * the app knows its defaults, so it says; a function is asked again after
   * the week is saved. Saving the week here also clears the item locally.
   */
  hoursAreDefault?: boolean | ((host: AdminHost) => boolean | Promise<boolean>);
}
