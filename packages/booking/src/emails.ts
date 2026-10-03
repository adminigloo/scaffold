/**
 * The emails a booking deserves, as PLAIN DATA plus the variables to fill
 * them — so an app wires `onEvent` to whatever sends its mail (a comms
 * package, Resend, SES, a queue) without writing the words or the date
 * formatting itself. This package sends nothing and depends on no mail
 * vendor: `bookingEmailTemplates` is an array of `{ key, audience, subject,
 * body }` with `{{vars}}`, `bookingEmailVars` builds the variables from an
 * `onEvent` payload, and `renderBookingTemplate` fills one in.
 *
 *   onEvent: async (event) => {
 *     const mail = bookingEmailVars(event, { baseUrl: "https://acme.com", includeManageLink: true });
 *     const key = mail.templateFor.invitee;
 *     if (key && mail.to.invitee) await send(mail.to.invitee, renderBookingTemplate(templateByKey(key), mail.invitee));
 *   }
 *
 * THE MANAGE LINK IS A KEY. Its plaintext token opens, moves and cancels the
 * booking; the package stores only its hash. A message that is SENT NOW may
 * carry it (`includeManageLink: true`). Anything that will sit in a table —
 * a queued reminder, a delivery log — must be built with `includeManageLink:
 * false`: the manage URL, the .ics URL and the Google link's description
 * then say "the private link in your booking confirmation" instead, so a
 * database reader cannot open the invitee's booking from a log row.
 *
 * Words written from the AdminIgloo site's own call emails, made
 * product-neutral: they speak as the host, name nobody, and promise nothing
 * the package cannot see happen ("before the call", never "tomorrow" — a
 * daily cron delivers a reminder anywhere from a day to minutes ahead).
 */

import { googleCalendarUrl, icsLocation } from "./ics.js";
import type { BookingActor } from "./schema.js";
import type { AdminBooking, BookingEvent, EventHost } from "./services/context.js";

export type BookingEmailTemplateKey =
  | "booking_confirmation"
  | "booking_requested"
  | "booking_confirmed"
  | "booking_rescheduled"
  | "booking_cancelled"
  | "booking_host_cancelled"
  | "booking_reminder"
  | "booking_host_notice";

export interface BookingEmailTemplate {
  key: BookingEmailTemplateKey;
  /** Who reads it — and therefore which half of bookingEmailVars fills it. */
  audience: "invitee" | "host";
  subject: string;
  body: string;
}

const lines = (...parts: string[]) => parts.join("\n");

/**
 * Plain-text templates. Variables that change shape per event (how we meet,
 * the calendar links, the manage line, a cancellation note) arrive as WHOLE
 * lines from bookingEmailVars, so the templates stay readable and an empty
 * one leaves no dangling label; renderBookingTemplate folds the blank lines.
 */
export const bookingEmailTemplates: readonly BookingEmailTemplate[] = [
  {
    key: "booking_confirmation",
    audience: "invitee",
    subject: "Booked: {{typeName}} with {{hostName}}, {{shortWhen}}",
    body: lines(
      "Hi {{firstName}},",
      "",
      "You're booked for a {{durationMinutes}}-minute {{typeName}} with {{hostName}}.",
      "",
      "When: {{when}}",
      "How we meet: {{howWeMeet}}",
      "",
      "{{calendarLinks}}",
      "",
      "{{manageLine}}",
      "",
      "Talk soon,",
      "{{hostName}}",
    ),
  },
  {
    key: "booking_requested",
    audience: "invitee",
    subject: "Requested: {{typeName}} with {{hostName}}, {{shortWhen}}",
    body: lines(
      "Hi {{firstName}},",
      "",
      "Thanks, your request for a {{durationMinutes}}-minute {{typeName}} with {{hostName}} is in. You'll hear again as soon as it's confirmed.",
      "",
      "Requested time: {{when}}",
      "How we meet: {{howWeMeet}}",
      "",
      "{{manageLine}}",
      "",
      "{{hostName}}",
    ),
  },
  {
    key: "booking_confirmed",
    audience: "invitee",
    subject: "Confirmed: {{typeName}} with {{hostName}}, {{shortWhen}}",
    body: lines(
      "Hi {{firstName}},",
      "",
      "{{hostName}} confirmed your {{typeName}}.",
      "",
      "When: {{when}}",
      "How we meet: {{howWeMeet}}",
      "",
      "{{calendarLinks}}",
      "",
      "{{manageLine}}",
      "",
      "{{hostName}}",
    ),
  },
  {
    key: "booking_rescheduled",
    audience: "invitee",
    subject: "Moved: {{typeName}} with {{hostName}}, now {{shortWhen}}",
    body: lines(
      "Hi {{firstName}},",
      "",
      "{{rescheduleLine}}",
      "",
      "New time: {{when}}",
      "Was: {{previousWhen}}",
      "How we meet: {{howWeMeet}}",
      "",
      "{{calendarLinks}}",
      "",
      "{{manageLine}}",
      "",
      "{{hostName}}",
    ),
  },
  {
    key: "booking_cancelled",
    audience: "invitee",
    subject: "Cancelled: {{typeName}} with {{hostName}}, {{shortWhen}}",
    body: lines(
      "Hi {{firstName}},",
      "",
      "Your {{typeName}} with {{hostName}} is cancelled, as you asked. It was set for {{when}}.",
      "",
      "If you'd like another time, you can pick one here: {{bookUrl}}",
      "",
      "{{hostName}}",
    ),
  },
  {
    key: "booking_host_cancelled",
    audience: "invitee",
    subject: "Cancelled: {{typeName}} with {{hostName}}, {{shortWhen}}",
    body: lines(
      "Hi {{firstName}},",
      "",
      "{{hostName}} had to cancel your {{typeName}}, which was set for {{when}}. Sorry for the change.",
      "{{cancelNote}}",
      "",
      "If you'd like another time, you can pick one here: {{bookUrl}}",
      "",
      "{{hostName}}",
    ),
  },
  {
    key: "booking_reminder",
    audience: "invitee",
    subject: "Reminder: {{typeName}} with {{hostName}}, {{shortWhen}}",
    body: lines(
      "Hi {{firstName}},",
      "",
      "A reminder of your {{typeName}} with {{hostName}}.",
      "",
      "When: {{when}}",
      "How we meet: {{howWeMeet}}",
      "",
      "{{manageLine}}",
      "",
      "{{hostName}}",
    ),
  },
  {
    key: "booking_host_notice",
    audience: "host",
    subject: "{{subjectTag}}: {{inviteeName}}, {{shortWhen}}",
    body: lines(
      "{{headline}}",
      "",
      "When: {{when}}",
      "How: {{howWeMeet}}",
      "",
      "Who: {{inviteeName}}",
      "Company: {{inviteeCompany}}",
      "Email: {{inviteeEmail}}",
      "Phone: {{inviteePhone}}",
      "Notes: {{notes}}",
      "Came from: {{source}}",
      "",
      "{{calendarLine}}",
      "",
      "All your calls: {{adminUrl}}",
    ),
  },
];

/** One template by key (every key in the union has one). */
export function bookingEmailTemplate(key: BookingEmailTemplateKey): BookingEmailTemplate {
  const found = bookingEmailTemplates.find((template) => template.key === key);
  if (!found) throw new Error(`@adminigloo/booking: no email template "${key}"`);
  return found;
}

export interface BookingEmailVarsOptions {
  /** The site's origin, e.g. "https://acme.com". Links are built on it. */
  baseUrl: string;
  /**
   * Whether this message may carry the invitee's manage link (a key to the
   * booking). true only for a message sent NOW; false for anything queued or
   * logged — see the module doc.
   */
  includeManageLink: boolean;
  /** The host's zone for host-facing times; defaults to the host's own. */
  hostZone?: string;
  /** The manage page for a token. Default `${baseUrl}/book/manage/${token}`. */
  manageUrl?: (token: string) => string;
  /** Where the handlers are mounted, for the .ics link. Default "/api/booking". */
  apiBase?: string;
  /** Where a new time is picked (cancellation emails). Default `${baseUrl}/book`. */
  bookUrl?: string;
  /** The host's admin, linked from the host notice. Default `${baseUrl}/admin`. */
  adminUrl?: string;
  /** Intl locale for dates. Default "en-US". */
  locale?: string;
}

export interface BookingEmailVars {
  /** Fills every `audience: "invitee"` template: times in the invitee's zone. */
  invitee: Record<string, string>;
  /** Fills `booking_host_notice`: times in the host's zone, the invitee's details. */
  host: Record<string, string>;
  /**
   * Which template each side gets for THIS event; null → nobody needs one
   * (the host who cancelled or moved a call from the admin is not told about
   * it). Reminders are not event-driven: queue `booking_reminder` yourself,
   * with vars built using `includeManageLink: false`.
   */
  templateFor: { invitee: BookingEmailTemplateKey | null; host: BookingEmailTemplateKey | null };
  /** Where each goes. `invitee` is null when the booking has no email. */
  to: { invitee: string | null; host: string };
}

const SAFE_LINK = "the private link in your booking confirmation";

function formatWhen(start: Date, end: Date, zone: string, locale: string): string {
  const format = new Intl.DateTimeFormat(locale, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: zone,
    timeZoneName: "short",
  });
  return `${format.formatRange(start, end)} (${zone.replace(/_/g, " ")})`;
}

function formatShort(start: Date, zone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: zone,
    timeZoneName: "short",
  }).format(start);
}

const orDash = (value: string | null | undefined) => (value && value.trim() ? value : "—");
const firstNameOf = (name: string | null | undefined, fallback: string) => name?.trim().split(/\s+/)[0] || fallback;

/** How the call happens, to the person who booked it. Never promises an email. */
function inviteeHowWeMeet(booking: AdminBooking, host: EventHost): string {
  switch (booking.medium) {
    case "phone":
      return (
        `Phone call. ${host.displayName} will call you at ${booking.inviteePhone ?? "the number you gave"}.` +
        (host.phone ? ` The call will come from ${host.phone}.` : "")
      );
    case "prospect_hosted":
      return `Your meeting link. Please send a calendar invite with your Zoom, Meet or Teams link to ${host.inviteMailbox ?? host.email}.`;
    case "video":
    default:
      return host.meetingLink
        ? `Video call. Join at the time with this link: ${host.meetingLink}`
        : `Video call. ${host.displayName} will send you the link before the call.`;
  }
}

/** The same, to the host. */
function hostHowWeMeet(booking: AdminBooking, host: EventHost): string {
  switch (booking.medium) {
    case "phone":
      return `Phone call: you call them at ${booking.inviteePhone ?? "the number they gave"}.`;
    case "prospect_hosted":
      return `Their meeting link: they'll send the invite to ${host.inviteMailbox ?? host.email}.`;
    case "video":
    default:
      return host.meetingLink
        ? `Video call on your meeting link: ${host.meetingLink}`
        : "Video call. No meeting link is saved, so send them one before the call.";
  }
}

/**
 * The variables for one `onEvent` payload, both audiences, plus which
 * templates this event calls for. Pure: the same event and options always
 * give the same strings (the clock is never read).
 */
export function bookingEmailVars(event: BookingEvent, options: BookingEmailVarsOptions): BookingEmailVars {
  const base = options.baseUrl.replace(/\/+$/, "");
  const locale = options.locale ?? "en-US";
  const b = event.booking;
  const host = event.host;
  const medium = b.medium ?? "video";
  const inviteeZone = b.inviteeTimezone ?? b.hostTimezone;
  const hostZone = options.hostZone ?? host.timezone;
  const token = "manageToken" in event && event.manageToken ? event.manageToken : null;
  const linked = options.includeManageLink && token !== null;
  const manageUrl = linked ? (options.manageUrl ?? ((t: string) => `${base}/book/manage/${encodeURIComponent(t)}`))(token) : null;
  const icsUrl = linked ? `${base}${options.apiBase ?? "/api/booking"}/v1/manage/${encodeURIComponent(token)}/ics` : null;
  const bookUrl = options.bookUrl ?? `${base}/book`;
  const adminUrl = options.adminUrl ?? `${base}/admin`;
  const by: BookingActor = event.event === "booking.cancelled" ? event.by : event.event === "booking.rescheduled" ? (event.by ?? "invitee") : "invitee";
  const who = `${b.inviteeName ?? "Someone"}${b.inviteeCompany ? ` (${b.inviteeCompany})` : ""}`;
  const howInvitee = inviteeHowWeMeet(b, host);

  const inviteeGoogle = googleCalendarUrl({
    title: `${event.type.name} with ${host.displayName}`,
    start: b.start,
    end: b.end,
    // The description embeds the manage URL only when the message may carry it.
    details: howInvitee + (manageUrl ? `\n\nReschedule or cancel: ${manageUrl}` : ""),
    location: icsLocation(medium, host, "invitee"),
  });
  const hostGoogle = googleCalendarUrl({
    title: `${event.type.name}: ${who}`,
    start: b.start,
    end: b.end,
    details: [
      hostHowWeMeet(b, host),
      "",
      `Email: ${orDash(b.inviteeEmail)}`,
      `Phone: ${orDash(b.inviteePhone)}`,
      `Notes: ${orDash(b.notes)}`,
      "",
      adminUrl,
    ].join("\n"),
    location: medium === "phone" ? `Call ${orDash(b.inviteePhone)}` : icsLocation(medium, host, "host"),
  });

  const previousWhen =
    event.event === "booking.rescheduled"
      ? formatWhen(event.previousStart, new Date(event.previousStart.getTime() + (b.end.getTime() - b.start.getTime())), inviteeZone, locale)
      : "";

  const invitee: Record<string, string> = {
    firstName: firstNameOf(b.inviteeName, "there"),
    inviteeName: b.inviteeName ?? "",
    typeName: event.type.name,
    hostName: host.displayName,
    durationMinutes: String(Math.round((b.end.getTime() - b.start.getTime()) / 60_000)),
    when: formatWhen(b.start, b.end, inviteeZone, locale),
    shortWhen: formatShort(b.start, inviteeZone, locale),
    previousWhen,
    howWeMeet: howInvitee,
    googleCalendarUrl: inviteeGoogle,
    icsUrl: icsUrl ?? SAFE_LINK,
    manageUrl: manageUrl ?? SAFE_LINK,
    calendarLinks: icsUrl
      ? lines("Add it to your calendar:", `Google Calendar: ${inviteeGoogle}`, `Apple Calendar, Outlook and others (.ics file): ${icsUrl}`)
      : `Add it to Google Calendar: ${inviteeGoogle}`,
    manageLine: manageUrl
      ? lines("Need to move it or cancel? Your private link, no account needed:", manageUrl)
      : `Need to move it or cancel? Use ${SAFE_LINK}.`,
    rescheduleLine:
      by === "host"
        ? `${host.displayName} had to move your ${event.type.name}. Sorry for the change.`
        : `Your ${event.type.name} with ${host.displayName} has moved.`,
    cancelNote: b.cancelReason && by === "host" ? `Note from ${firstNameOf(host.displayName, host.displayName)}: "${b.cancelReason}"` : "",
    bookUrl,
  };

  const headline: Record<BookingEvent["event"], string> = {
    "booking.created":
      b.status === "requested"
        ? `${who} asked for a call (${event.type.name}). Confirm it in your admin.`
        : `${who} booked a call with you (${event.type.name}).`,
    "booking.confirmed": `You confirmed ${who}'s call (${event.type.name}).`,
    "booking.rescheduled":
      event.event === "booking.rescheduled"
        ? `${who} moved their call (${event.type.name}). It was ${formatShort(event.previousStart, hostZone, locale)}.`
        : "",
    "booking.cancelled": `${who} cancelled their call (${event.type.name}).`,
  };
  const subjectTag: Record<BookingEvent["event"], string> = {
    "booking.created": b.status === "requested" ? "Call request" : "New call",
    "booking.confirmed": "Call confirmed",
    "booking.rescheduled": "Call moved",
    "booking.cancelled": "Call cancelled",
  };
  const calendarLine =
    event.event === "booking.cancelled"
      ? "If it's on your calendar, you can delete it."
      : event.event === "booking.rescheduled"
        ? `Add the new time to your Google Calendar in one click (and delete the old event): ${hostGoogle}`
        : `Add it to your Google Calendar in one click: ${hostGoogle}`;

  const hostVars: Record<string, string> = {
    subjectTag: subjectTag[event.event],
    headline: headline[event.event],
    calendarLine,
    hostGoogleCalendarUrl: hostGoogle,
    inviteeName: orDash(b.inviteeName),
    inviteeCompany: orDash(b.inviteeCompany),
    inviteeEmail: orDash(b.inviteeEmail),
    inviteePhone: orDash(b.inviteePhone),
    notes: orDash(b.notes),
    source: orDash(b.source),
    typeName: event.type.name,
    hostName: host.displayName,
    when: formatWhen(b.start, b.end, hostZone, locale),
    shortWhen: formatShort(b.start, hostZone, locale),
    howWeMeet: hostHowWeMeet(b, host),
    adminUrl,
  };

  let inviteeKey: BookingEmailTemplateKey | null;
  let hostKey: BookingEmailTemplateKey | null;
  switch (event.event) {
    case "booking.created":
      inviteeKey = b.status === "requested" ? "booking_requested" : "booking_confirmation";
      hostKey = "booking_host_notice";
      break;
    case "booking.confirmed":
      inviteeKey = "booking_confirmed";
      hostKey = null;
      break;
    case "booking.rescheduled":
      inviteeKey = "booking_rescheduled";
      hostKey = by === "host" ? null : "booking_host_notice";
      break;
    case "booking.cancelled":
      inviteeKey = by === "host" ? "booking_host_cancelled" : "booking_cancelled";
      hostKey = by === "host" ? null : "booking_host_notice";
      break;
  }

  return {
    invitee,
    host: hostVars,
    templateFor: { invitee: inviteeKey, host: hostKey },
    to: { invitee: b.inviteeEmail ?? null, host: host.email },
  };
}

/**
 * Fill `{{name}}` placeholders. An unknown name renders empty (an email with
 * a gap beats one that never sends), and the blank lines an empty whole-line
 * variable leaves are folded to one.
 */
export function renderBookingTemplate(
  template: Pick<BookingEmailTemplate, "subject" | "body">,
  vars: Record<string, string>,
): { subject: string; body: string } {
  const fill = (text: string) => text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_match, name: string) => vars[name] ?? "");
  return {
    subject: fill(template.subject).replace(/\s+/g, " ").trim(),
    body: fill(template.body)
      .replace(/[ \t]+$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  };
}
