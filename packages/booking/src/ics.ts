/**
 * iCalendar (RFC 5545) OUTPUT — the .ics a prospect downloads, the per-host
 * subscribable feed, and the Google "add to calendar" link.
 *
 * Pure functions, every input an argument, so the bytes are testable. That
 * matters more than it sounds: the usual reason a hand-built .ics fails in
 * Outlook is invisible in a text editor — LF instead of CRLF, an unfolded
 * long line, an unescaped comma in a company name.
 *
 * DEFECT D23, FIXED BY SHAPE. Squire's confirmation .ics was registered as an
 * attachment builder by a side-effect import; one refactor dropped the import
 * and confirmations went out with no invite, silently. Nothing here registers
 * anything: `buildIcs` is a function, and the handler serves it at a token URL
 * (`/v1/manage/:token/ics`) that any email can link to.
 *
 * DEFECT D2 / the orphaned-event bug, fixed by the UID. A reschedule moves the
 * SAME booking row, so the UID (`${bookingId}@${uidDomain}`) never changes and
 * SEQUENCE goes up by one — calendar clients update the event they already
 * have instead of keeping the old one beside a new one.
 */

const CRLF = "\r\n";
const MAX_LINE_OCTETS = 75;
const encoder = new TextEncoder();

export type Medium = "video" | "phone" | "prospect_hosted";

/** UTC date-time in the basic format: 20260915T160000Z. */
export function formatIcsUtc(date: Date): string {
  return `${date.toISOString().replace(/[-:]/g, "").split(".")[0]}Z`;
}

/**
 * Escape a TEXT value. Backslash first, or the backslashes added for the
 * others get doubled; commas and semicolons are value separators, so an
 * unescaped one in "Acme, Inc." truncates the field in strict parsers.
 */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * A parameter value (CN=…). Parameters cannot be backslash-escaped; a value
 * containing `:` `;` or `,` must be DQUOTE-wrapped, and DQUOTE itself is not
 * representable at all, so it is dropped. Control characters go too — a
 * display name is not a place for a line break.
 */
export function icsParamValue(value: string): string {
  const cleaned = value.replace(/["\u0000-\u001f\u007f]/g, "").trim();
  return /[:;,]/.test(cleaned) ? `"${cleaned}"` : cleaned;
}

/**
 * Fold one content line to 75 OCTETS, continuing with CRLF + space. Octets,
 * not characters: "Café" is five bytes on the wire, and folding on `.length`
 * leaves lines that are still too long. A multi-byte character (or surrogate
 * pair) is never split across a fold.
 */
export function foldLine(line: string): string {
  if (encoder.encode(line).length <= MAX_LINE_OCTETS) return line;
  const parts: string[] = [];
  let current = "";
  let octets = 0;
  // The continuation's leading space costs an octet, so later chunks get 74.
  let budget = MAX_LINE_OCTETS;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (octets + size > budget) {
      parts.push(current);
      current = char;
      octets = size;
      budget = MAX_LINE_OCTETS - 1;
    } else {
      current += char;
      octets += size;
    }
  }
  if (current) parts.push(current);
  return parts.join(`${CRLF} `);
}

function serialize(lines: string[]): string {
  // CRLF between every line AND after the last; both are required.
  return lines.map(foldLine).join(CRLF) + CRLF;
}

/** The fields of a booking row `buildIcs` reads. */
export interface IcsBooking {
  id: string;
  startUtc: Date;
  endUtc: Date;
  sequence: number;
  medium: Medium;
  inviteeName: string;
  inviteeEmail: string;
  status?: string;
}

export interface IcsHost {
  displayName: string;
  email: string;
  meetingLink: string | null;
  phone: string | null;
  inviteMailbox: string | null;
}

export interface IcsType {
  name: string;
}

/**
 * Who reads the words. LOCATION for a prospect-hosted call is written from
 * the HOST's side by default ("Their meeting link (they send the invite)", as
 * the spec words it); the prospect's own download passes "invitee" and reads
 * "Your meeting link (you send the invite)" instead.
 */
export type IcsAudience = "host" | "invitee";

/**
 * One line a human reads: how this call happens.
 *
 * A video call with no saved meeting link says who sends it and when, and
 * nothing about HOW: "the link follows by email" was a promise a deployment
 * with no mail provider could not keep, and it sat in the prospect's
 * calendar event until the call.
 */
export function howWeMeet(input: {
  medium: Medium;
  host: Pick<IcsHost, "displayName" | "meetingLink" | "phone" | "inviteMailbox" | "email">;
  audience?: IcsAudience;
}): string {
  const { medium, host } = input;
  if (medium === "phone") {
    return (
      `${host.displayName} will call you at the number you gave.` +
      (host.phone ? ` The call will come from ${host.phone}.` : "")
    );
  }
  if (medium === "prospect_hosted") {
    const mailbox = host.inviteMailbox ?? host.email;
    return input.audience === "host"
      ? `They send the meeting invite from their own calendar (to ${mailbox}).`
      : `You send the meeting invite from your own calendar — please invite ${mailbox}.`;
  }
  if (host.meetingLink) return `Video call: ${host.meetingLink}`;
  return input.audience === "host"
    ? "Video call — no meeting link is saved, so send them one before the call."
    : `Video call — ${host.displayName} will send you the link before the call.`;
}

/**
 * SANDBOX EXPORTS ARE NOT EVENTS. A demo visitor who presses "Add to
 * calendar" must not end up with something on Monday that reads like a real
 * call ("Intro call with Dallin (demo)" read as "a demo call with Dallin").
 * So a sandbox booking's .ics and Google link carry this title prefix, this
 * description in place of the real one, no location, organizer, attendee or
 * manage link, and — in the .ics — STATUS:TENTATIVE and TRANSP:TRANSPARENT,
 * so it never blocks the visitor's time.
 */
export const SANDBOX_TITLE_PREFIX = "[Sandbox — not a real booking] ";
export const SANDBOX_EVENT_DESCRIPTION = "This was made in a live demo. Nothing was booked and nobody will join.";

/** The sandbox description, with the way to a real booking when the app gave one. */
export function sandboxEventDescription(realBookingUrl?: string | null): string {
  return SANDBOX_EVENT_DESCRIPTION + (realBookingUrl ? `\n\nBook a real call: ${realBookingUrl}` : "");
}

/** LOCATION, per medium. */
export function icsLocation(medium: Medium, host: Pick<IcsHost, "meetingLink">, audience: IcsAudience = "host"): string {
  if (medium === "phone") return "Phone call";
  if (medium === "prospect_hosted") {
    return audience === "invitee"
      ? "Your meeting link (you send the invite)"
      : "Their meeting link (they send the invite)";
  }
  return host.meetingLink ?? "Video call";
}

export interface BuildIcsInput {
  booking: IcsBooking;
  host: IcsHost;
  type: IcsType;
  /**
   * PUBLISH: "here is an event, add it" — what a downloaded file should be.
   * Not REQUEST: a REQUEST names an organizer the recipient is expected to
   * reply to, and the reply would go to a mailbox that does not process
   * iTIP. CANCEL: remove the event with this UID (STATUS:CANCELLED).
   */
  method: "PUBLISH" | "CANCEL";
  /** The right-hand side of the UID, e.g. "adminigloo.com". Stable forever per install. */
  uidDomain: string;
  manageUrl?: string;
  /** DTSTAMP. Injected for byte-stable tests; defaults to the wall clock. */
  now?: Date;
  audience?: IcsAudience;
  /** PRODID's product segment. */
  productName?: string;
  /**
   * A demo booking: the file becomes an unmistakable non-event (see
   * SANDBOX_TITLE_PREFIX) — prefixed title, the sandbox description, no
   * location, ORGANIZER, ATTENDEE or URL, STATUS:TENTATIVE (CANCELLED once
   * cancelled, so a client still removes it) and TRANSP:TRANSPARENT.
   */
  sandbox?: boolean;
  /** Sandbox only: appended to the description as "Book a real call: …". */
  realBookingUrl?: string | null;
}

/** The UID a booking's event keeps for its whole life. */
export function bookingUid(bookingId: string, uidDomain: string): string {
  return `${bookingId}@${uidDomain}`;
}

/** A complete VCALENDAR with one VEVENT for a booking. */
export function buildIcs(input: BuildIcsInput): string {
  const { booking, host, type, method } = input;
  const audience = input.audience ?? "host";
  const cancelled = method === "CANCEL";
  if (input.sandbox) return buildSandboxIcs(input, cancelled);
  const summary = `${type.name} with ${host.displayName}`;
  const description =
    howWeMeet({ medium: booking.medium, host, audience }) +
    (input.manageUrl ? `\n\nReschedule or cancel: ${input.manageUrl}` : "");

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//AdminIgloo//${input.productName ?? "Booking"}//EN`,
    "CALSCALE:GREGORIAN",
    `METHOD:${method}`,
    "BEGIN:VEVENT",
    `UID:${bookingUid(booking.id, input.uidDomain)}`,
    `DTSTAMP:${formatIcsUtc(input.now ?? new Date())}`,
    `DTSTART:${formatIcsUtc(booking.startUtc)}`,
    `DTEND:${formatIcsUtc(booking.endUtc)}`,
    `SEQUENCE:${Math.max(0, Math.trunc(booking.sequence))}`,
    `STATUS:${cancelled ? "CANCELLED" : "CONFIRMED"}`,
    // The same SUMMARY on CANCEL: a client matches the event by UID and
    // removes it, and one that shows the cancellation first shows its name.
    `SUMMARY:${escapeIcsText(summary)}`,
    `LOCATION:${escapeIcsText(icsLocation(booking.medium, host, audience))}`,
    `DESCRIPTION:${escapeIcsText(description)}`,
    "TRANSP:OPAQUE",
    `ORGANIZER;CN=${icsParamValue(host.displayName)}:mailto:${host.email}`,
    `ATTENDEE;CN=${icsParamValue(booking.inviteeName)};ROLE=REQ-PARTICIPANT:mailto:${booking.inviteeEmail}`,
  ];
  if (input.manageUrl) lines.push(`URL:${input.manageUrl}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return serialize(lines);
}

/**
 * The sandbox file: same UID rules (so a cancel still removes it), and
 * nothing that makes it look like a meeting. No ORGANIZER/ATTENDEE — a
 * client that sees them may offer an RSVP that mails the demo host — and no
 * LOCATION or URL, whose meeting room and manage page are sandbox ones that
 * stop working within a day.
 */
function buildSandboxIcs(input: BuildIcsInput, cancelled: boolean): string {
  const { booking, type, host } = input;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//AdminIgloo//${input.productName ?? "Booking"} sandbox//EN`,
    "CALSCALE:GREGORIAN",
    `METHOD:${input.method}`,
    "BEGIN:VEVENT",
    `UID:${bookingUid(booking.id, input.uidDomain)}`,
    `DTSTAMP:${formatIcsUtc(input.now ?? new Date())}`,
    `DTSTART:${formatIcsUtc(booking.startUtc)}`,
    `DTEND:${formatIcsUtc(booking.endUtc)}`,
    `SEQUENCE:${Math.max(0, Math.trunc(booking.sequence))}`,
    `STATUS:${cancelled ? "CANCELLED" : "TENTATIVE"}`,
    `SUMMARY:${escapeIcsText(`${SANDBOX_TITLE_PREFIX}${type.name} with ${host.displayName}`)}`,
    `DESCRIPTION:${escapeIcsText(sandboxEventDescription(input.realBookingUrl))}`,
    "TRANSP:TRANSPARENT",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return serialize(lines);
}

/** What a feed entry carries — first name and company, nothing that identifies a person further. */
export interface FeedBooking {
  id: string;
  startUtc: Date;
  endUtc: Date;
  sequence: number;
  medium: Medium;
  typeName: string;
  inviteeName: string;
  inviteeCompany: string | null;
}

export interface BuildHostFeedInput {
  host: Pick<IcsHost, "displayName">;
  bookings: readonly FeedBooking[];
  uidDomain: string;
  now?: Date;
  calendarName?: string;
}

/** "Ada Lovelace" → "Ada". */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}

/**
 * The subscribable per-host feed (`webcal://…/v1/feed/<token>.ics`).
 *
 * F7 — MINIMAL BY CONSTRUCTION. A calendar subscription URL ends up shared,
 * pasted into a family calendar, synced to a phone that gets lost; it is a
 * bearer secret with a long life. So an entry carries the invitee's FIRST name
 * and company and nothing else — no email, no phone, no notes — and the host
 * reads the rest in the admin, behind a sign-in. The function only accepts
 * those fields, so a later edit cannot leak more by passing a fuller row.
 *
 * No ORGANIZER/ATTENDEE: a subscription is a view of your own time, not an
 * invitation, and some clients prompt for an RSVP on every refresh otherwise.
 */
export function buildHostFeed(input: BuildHostFeedInput): string {
  const stamp = formatIcsUtc(input.now ?? new Date());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//AdminIgloo//Booking feed//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(input.calendarName ?? `Calls — ${input.host.displayName}`)}`,
    // Ask subscribers to refresh hourly rather than whenever they feel like it.
    "X-PUBLISHED-TTL:PT1H",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
  ];
  for (const booking of input.bookings) {
    const who = firstName(booking.inviteeName) + (booking.inviteeCompany ? ` (${booking.inviteeCompany})` : "");
    const medium =
      booking.medium === "phone"
        ? "Phone call — you call them; the number is in the admin."
        : booking.medium === "prospect_hosted"
          ? "They send the meeting invite."
          : "Video call.";
    lines.push(
      "BEGIN:VEVENT",
      `UID:${bookingUid(booking.id, input.uidDomain)}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${formatIcsUtc(booking.startUtc)}`,
      `DTEND:${formatIcsUtc(booking.endUtc)}`,
      `SEQUENCE:${Math.max(0, Math.trunc(booking.sequence))}`,
      "STATUS:CONFIRMED",
      `SUMMARY:${escapeIcsText(`${booking.typeName}: ${who}`)}`,
      `DESCRIPTION:${escapeIcsText(medium)}`,
      "TRANSP:OPAQUE",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return serialize(lines);
}

/**
 * Google Calendar's one-click "add event" URL. It is a TEMPLATE link — Google
 * pre-fills an event the person saves themselves — so it needs no account,
 * no OAuth, and it works for every invitee whatever calendar they use day to
 * day (Google is simply the most common one to offer).
 */
export function googleCalendarUrl(input: {
  title: string;
  start: Date;
  end: Date;
  details?: string;
  location?: string;
}): string {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: input.title,
    dates: `${formatIcsUtc(input.start)}/${formatIcsUtc(input.end)}`,
  });
  if (input.details) params.set("details", input.details);
  if (input.location) params.set("location", input.location);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
