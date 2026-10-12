/**
 * The .ics a customer downloads for their visit (RFC 5545). Pure functions,
 * every input an argument, so the bytes are testable.
 *
 * `formatIcsUtc`, `escapeIcsText` and `foldLine` are PORTED FROM
 * @adminigloo/booking's ics.ts; change both or neither. The usual reason a
 * hand-built .ics fails in Outlook is invisible in a text editor — LF instead
 * of CRLF, an unfolded long line, an unescaped comma in a business name — so
 * CRLF and folding are not optional.
 *
 * A reschedule moves the SAME visit row, so the UID (`${visitId}@${uidDomain}`)
 * never changes and SEQUENCE is the row's `sequence`: a calendar client
 * updates the event it already has instead of keeping a stale copy beside the
 * new one. A cancelled, declined or expired visit is served as METHOD:CANCEL,
 * which removes it.
 */

const CRLF = "\r\n";
const MAX_LINE_OCTETS = 75;
const encoder = new TextEncoder();

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

export interface BuildVisitIcsInput {
  visitId: string;
  startsAt: Date;
  endsAt: Date;
  sequence: number;
  /** The visit row's status. */
  status: string;
  serviceName: string;
  businessName: string;
  address: string | null;
  /** The customer's manage page, for the DESCRIPTION. */
  manageUrl: string | null;
  /** The right-hand side of the UID. Stable forever per install. */
  uidDomain: string;
  /** DTSTAMP. Injected for byte-stable tests; defaults to the wall clock. */
  now?: Date;
}

const CANCELLED: ReadonlySet<string> = new Set(["cancelled", "declined", "expired"]);

/**
 * A complete VCALENDAR with one VEVENT for a visit. PUBLISH while the visit
 * stands (STATUS TENTATIVE for a request nobody has accepted yet, CONFIRMED
 * otherwise); CANCEL with STATUS:CANCELLED once it is cancelled, declined or
 * expired. PUBLISH rather than REQUEST: a REQUEST names an organizer the
 * customer's calendar would RSVP to, and nobody reads those replies.
 */
export function buildVisitIcs(input: BuildVisitIcsInput): string {
  const cancelled = CANCELLED.has(input.status);
  const status = cancelled ? "CANCELLED" : input.status === "pending" ? "TENTATIVE" : "CONFIRMED";
  const summary = input.businessName.trim() ? `${input.serviceName} — ${input.businessName.trim()}` : input.serviceName;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//AdminIgloo//Scheduling//EN",
    "CALSCALE:GREGORIAN",
    `METHOD:${cancelled ? "CANCEL" : "PUBLISH"}`,
    "BEGIN:VEVENT",
    `UID:${input.visitId}@${input.uidDomain}`,
    `DTSTAMP:${formatIcsUtc(input.now ?? new Date())}`,
    `DTSTART:${formatIcsUtc(input.startsAt)}`,
    `DTEND:${formatIcsUtc(input.endsAt)}`,
    `SEQUENCE:${Math.max(0, Math.trunc(input.sequence))}`,
    `STATUS:${status}`,
    `SUMMARY:${escapeIcsText(summary)}`,
  ];
  if (input.address) lines.push(`LOCATION:${escapeIcsText(input.address)}`);
  if (input.manageUrl) {
    lines.push(`DESCRIPTION:${escapeIcsText(`Reschedule or cancel: ${input.manageUrl}`)}`, `URL:${input.manageUrl}`);
  }
  lines.push("TRANSP:OPAQUE", "END:VEVENT", "END:VCALENDAR");
  return serialize(lines);
}
