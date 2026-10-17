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
import type { AdminBooking, BookingEvent, DueReminder, EventHost } from "./services/context.js";

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
      "{{signature}}",
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
      "{{signature}}",
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
      "{{signature}}",
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
      "{{signature}}",
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
      "{{signature}}",
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
      "{{signature}}",
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
      "{{signature}}",
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
  /**
   * The business the call is with (0.2) — a company's name in an app where
   * many businesses take calls. Signs the invitee's emails under the host's
   * name and is returned as `fromName`, so the email comes from the business,
   * never from the site that hosts it. Absent → signed by the host alone.
   */
  businessName?: string | null;
  /**
   * Where the invitee's replies go (0.2): the business's own address. Absent
   * → the host's email. Never the platform's: a customer's "can we move it?"
   * must reach the business.
   */
  replyTo?: string | null;
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
  /**
   * Where a reply to each goes (0.2): the invitee's to the business (its
   * `replyTo`, else the host), the host's notice to the invitee.
   */
  replyTo: { invitee: string; host: string | null };
  /** The sender's display name (0.2): the business's name, else the host's. */
  fromName: string;
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
export function bookingEmailVars(event: BookingEvent | DueReminder, options: BookingEmailVarsOptions): BookingEmailVars {
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
  const businessName = options.businessName?.trim() || null;

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
    businessName: businessName ?? "",
    signature: businessName && businessName !== host.displayName ? lines(host.displayName, businessName) : host.displayName,
  };

  const headline: Record<BookingEvent["event"] | DueReminder["event"], string> = {
    "booking.reminder": `A reminder: ${who}'s call (${event.type.name}).`,
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
  const subjectTag: Record<BookingEvent["event"] | DueReminder["event"], string> = {
    "booking.reminder": "Call reminder",
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
    case "booking.reminder":
      inviteeKey = "booking_reminder";
      hostKey = null;
      break;
  }
  // A host whose person left the business is written nothing (0.2).
  if ("hostActive" in event && event.hostActive === false) hostKey = null;

  return {
    invitee,
    host: hostVars,
    templateFor: { invitee: inviteeKey, host: hostKey },
    to: { invitee: b.inviteeEmail ?? null, host: host.email },
    replyTo: { invitee: options.replyTo?.trim() || host.email, host: b.inviteeEmail ?? null },
    fromName: businessName ?? host.displayName,
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

// ---------------------------------------------------------------------------
// The platform's version (0.2): many businesses sending from one site
// ---------------------------------------------------------------------------

/**
 * Meeting services whose links become a button (0.2). Any other link in a
 * business's email is shown as plain text with its host in bold, so a
 * look-alike address can't hide behind a friendly button.
 */
export const KNOWN_MEETING_HOSTS: readonly string[] = [
  "zoom.us",
  "meet.google.com",
  "teams.microsoft.com",
  "teams.live.com",
  "whereby.com",
  "webex.com",
];

/** Is this an https link on a known meeting service (or one of its subdomains, like us02web.zoom.us)? */
export function isKnownMeetingLink(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    return KNOWN_MEETING_HOSTS.some((known) => host === known || host.endsWith(`.${known}`));
  } catch {
    return false;
  }
}

/** A display name safe in a From header or a subject: no control characters, quotes or angle brackets, one line, at most 64. */
export function sanitizeEmailName(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f<>"\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64)
    .trim();
}

export interface PlatformEmailOptions extends Omit<BookingEmailVarsOptions, "businessName" | "replyTo"> {
  /** The business the call is with. */
  businessName: string;
  /** This site's name: the From reads "{business} via {app}", the footer "Sent for {business} by {app}." */
  appName: string;
  /**
   * Where the customer's replies go: the business owner's VERIFIED sign-in
   * address, or null for none. Never an address the business typed in.
   */
  replyTo: string | null;
}

export interface PlatformEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo: string | null;
}

export interface PlatformEmails {
  /** "{business} via {app}", cleaned. */
  fromName: string;
  invitee: PlatformEmail | null;
  host: PlatformEmail | null;
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** A link as plain text with its host in bold: what the reader sees is where it goes. */
function plainLink(url: string): string {
  try {
    const parsed = new URL(url);
    const at = url.indexOf(parsed.host);
    if (at < 0) return escapeHtml(url);
    return `${escapeHtml(url.slice(0, at))}<b>${escapeHtml(parsed.host)}</b>${escapeHtml(url.slice(at + parsed.host.length))}`;
  } catch {
    return escapeHtml(url);
  }
}

/** This site's own links (the manage page, the .ics) and Google's "add to calendar" are clickable; nothing else is. */
function ownLink(url: string, origin: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    if (parsed.origin === origin) return true;
    return parsed.origin === "https://calendar.google.com" && parsed.pathname.startsWith("/calendar/render");
  } catch {
    return false;
  }
}

function toHtml(text: string, origin: string): string {
  const linked = (line: string) =>
    line
      .split(/(https?:\/\/[^\s<>"]+)/g)
      .map((part, index) => {
        if (index % 2 === 0) return escapeHtml(part);
        if (isKnownMeetingLink(part)) {
          return `${plainLink(part)}<br><a href="${escapeHtml(part)}" style="display:inline-block;margin-top:6px;padding:8px 14px;border-radius:6px;background:#111;color:#fff;text-decoration:none">Join the call</a>`;
        }
        if (ownLink(part, origin)) return `<a href="${escapeHtml(part)}">${plainLink(part)}</a>`;
        return plainLink(part);
      })
      .join("");
  return text
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${paragraph.split("\n").map(linked).join("<br>")}</p>`)
    .join("\n");
}

/**
 * THE BOOKING EMAILS, AS A PLATFORM SENDS THEM (0.2) — many businesses, one
 * sending domain. Every word a business typed (its name, the call type, the
 * host's name) stays out of the subject except its sanitised name, inside a
 * fixed sentence; the call type appears in the body only as quoted text; a
 * meeting link is a button only on a known meeting service; the From is
 * "{business} via {app}"; replies go to the owner's verified address; and
 * every email ends "Sent for {business} by {app}."
 */
export function platformBookingEmails(event: BookingEvent | DueReminder, options: PlatformEmailOptions): PlatformEmails {
  const business = sanitizeEmailName(options.businessName) || "the business";
  const app = sanitizeEmailName(options.appName) || "this site";
  const vars = bookingEmailVars(event, { ...options, businessName: business, replyTo: options.replyTo ?? "" });
  let origin = "";
  try {
    origin = new URL(options.baseUrl).origin;
  } catch {
    origin = "";
  }
  const quotedType = `“${event.type.name.replace(/[\u0000-\u001f\u007f]/g, " ").trim()}”`;
  const footer = `Sent for ${business} by ${app}.`;
  const date = vars.invitee["shortWhen"] ?? "";
  const subjects: Record<BookingEmailTemplateKey, string> = {
    booking_confirmation: `Your call with ${business} is booked — ${date}`,
    booking_requested: `Your call request with ${business} — ${date}`,
    booking_confirmed: `Your call with ${business} is confirmed — ${date}`,
    booking_rescheduled: `Your call with ${business} has moved — ${date}`,
    booking_cancelled: `Your call with ${business} is cancelled — ${date}`,
    booking_host_cancelled: `Your call with ${business} is cancelled — ${date}`,
    booking_reminder: `Reminder: your call with ${business} — ${date}`,
    booking_host_notice: `${vars.host["subjectTag"] ?? "Call"} — ${vars.host["shortWhen"] ?? ""}`,
  };
  const build = (key: BookingEmailTemplateKey | null, to: string | null, fill: Record<string, string>, replyTo: string | null): PlatformEmail | null => {
    if (!key || !to) return null;
    const { body } = renderBookingTemplate(bookingEmailTemplate(key), { ...fill, typeName: quotedType });
    const text = `${body}\n\n${footer}`;
    return { to, subject: subjects[key].replace(/\s+/g, " ").trim(), text, html: toHtml(text, origin), replyTo };
  };
  return {
    fromName: sanitizeEmailName(`${business} via ${app}`),
    invitee: build(vars.templateFor.invitee, vars.to.invitee, vars.invitee, options.replyTo ?? null),
    host: build(vars.templateFor.host, vars.to.host, vars.host, vars.replyTo.host),
  };
}
