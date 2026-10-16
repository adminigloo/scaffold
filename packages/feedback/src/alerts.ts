import type { FeedbackEvent } from "./core.js";

/**
 * Alerts about feedback (0.10.0): a customer sent something new, and a
 * customer answered on their ticket — the two moments the team should hear
 * about. Feedback's fragment for the project's alert registry, and the mapper
 * from its events to alert drafts.
 *
 * STRUCTURAL (Tenancy 2a D4, 2b-1 D3): nothing here imports
 * @adminigloo/notifications. The shapes are declared again, identical field
 * for field (2b-1 section 3.2, 3.3), prefixed `Feedback…` so a generated file
 * importing two packages never sees two `AlertDraft`s. Feedback writes the
 * words because it knows the facts.
 */

export type FeedbackAlertChannel = "in_app" | "email";

/** One kind of alert (2b-1 section 3.2), structurally identical to notifications' `AlertKindSpec`. */
export interface FeedbackAlertKind {
  /** Permanent. /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){1,3}$/, at most 64 characters. */
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  readonly category: string;
  readonly audience: {
    readonly permission: string;
    readonly routing?: string;
    readonly assigned?: { readonly permission: string };
  };
  readonly defaultChannel: FeedbackAlertChannel;
  readonly email?: boolean;
  readonly emailBy?: "notifications" | "producer";
  readonly order?: number;
}

/** A routing group (2b-1 section 3.2). Feedback has none. */
export interface FeedbackAlertRouting {
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  readonly permission: string;
  readonly order?: number;
}

export interface FeedbackAlertKinds {
  readonly kinds: readonly FeedbackAlertKind[];
  readonly routings: readonly FeedbackAlertRouting[];
}

/** What a mapper returns and `alerts.notify` takes (2b-1 section 3.3). */
export interface FeedbackAlertDraft {
  readonly tenantId: string;
  readonly kind: string;
  /** One line, 1–200 characters, plain text (it becomes an email Subject). */
  readonly title: string;
  /** At most 2000 characters, plain text; null = none. */
  readonly body: string | null;
  /** A same-site path; null = nothing to open. */
  readonly href: string | null;
  readonly assignedHref?: string | null;
  /** From the durable fact; 1–200 characters. */
  readonly dedupeKey: string;
  readonly subject: { readonly type: string; readonly id: string } | null;
  /** Who caused it; never alerted about it. null for a customer. */
  readonly actorUserId: string | null;
  readonly assignedUserIds?: readonly string[];
  readonly replyTo?: string | null;
}

export const FEEDBACK_TICKET_NEW_KIND = "feedback.ticket.new";
export const FEEDBACK_TICKET_REPLIED_KIND = "feedback.ticket.replied";

const audience = Object.freeze({ permission: "feedback.view" });

/**
 * Feedback's alert fragment. Both kinds go to EVERYONE WHO CAN SEE THE BOARD
 * (`feedback.view`), with no routing group: feedback isn't new work one
 * person is chosen for — it is the whole office's inbox, and whoever opens it
 * first answers. Both default to the app (the bell), so a busy board doesn't
 * fill five inboxes; anyone can switch either to email in Alert settings.
 */
export const feedbackAlertKinds: FeedbackAlertKinds = Object.freeze({
  kinds: Object.freeze([
    Object.freeze({
      key: FEEDBACK_TICKET_NEW_KIND,
      label: "A customer sends feedback",
      description: "Something new on the feedback board, from your website or your feedback page.",
      category: "Feedback",
      audience,
      defaultChannel: "in_app",
      order: 10,
    }) as FeedbackAlertKind,
    Object.freeze({
      key: FEEDBACK_TICKET_REPLIED_KIND,
      label: "A customer answers on their feedback",
      description: "A customer replied on a ticket, usually to something your team asked.",
      category: "Feedback",
      audience,
      defaultChannel: "in_app",
      order: 20,
    }) as FeedbackAlertKind,
  ]),
  routings: Object.freeze([]),
}) as FeedbackAlertKinds;

/** 3.3's href rule (D18): a same-site path; no "//", no "/\", no backslash, whitespace or control character. */
const HREF_PATTERN = /^\/(?![\/\\])[^\\\s\u0000-\u001f]{0,499}$/;

/**
 * One line of plain text: control characters become spaces (a title becomes
 * an email Subject, D18), runs of space collapse, cut to `max` with an
 * ellipsis. What a customer typed is text, never a header.
 */
function oneLine(value: string, max: number): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
    out += control ? " " : char;
  }
  const cleaned = out.replace(/\s+/g, " ").trim();
  const chars = Array.from(cleaned);
  return chars.length <= max ? cleaned : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

function hrefFor(pattern: string, id: string): string | null {
  const href = pattern.replace(/\{id\}/g, encodeURIComponent(id));
  return HREF_PATTERN.test(href) ? href : null;
}

function nameOf(name: string | null | undefined): string | null {
  const cleaned = typeof name === "string" ? oneLine(name, 80) : "";
  return cleaned === "" ? null : cleaned;
}

/**
 * A feedback event → its alert drafts.
 *
 *   ticket.created   → "New feedback FB-00012: {first line}", "From {name}"
 *   reporter.replied → "{Name} answered on FB-00012", "{excerpt}"
 *
 * DEDUPE KEYS (2b-1 D7) from the durable fact: the ticket for a new one, the
 * reply's own message id for an answer — the same event handed over twice is
 * one alert, two replies are two. Nobody on the team caused either (the
 * customer did), so no one is left out. The staff-side events (staff.replied,
 * ticket.moved) raise no alert: the team did them.
 *
 * `hrefs.ticket` is a pattern with `{id}` (e.g. "/app/feedback?ticket={id}").
 */
export function feedbackAlertsFor(
  event: FeedbackEvent,
  options: { readonly hrefs: { readonly ticket: string } },
): readonly FeedbackAlertDraft[] {
  const number = oneLine(event.ticketNumber, 20);
  const subject = { type: "feedback.ticket", id: event.ticketId } as const;
  const href = hrefFor(options.hrefs.ticket, event.ticketId);
  switch (event.type) {
    case "ticket.created": {
      const who = nameOf(event.reporterName) ?? nameOf(event.reporterEmail);
      const title = oneLine(event.title, 120) || "No description";
      return [
        {
          tenantId: event.tenantId,
          kind: FEEDBACK_TICKET_NEW_KIND,
          title: oneLine(`New feedback ${number}: ${title}`, 200),
          body: who ? `From ${who}` : null,
          href,
          dedupeKey: `${FEEDBACK_TICKET_NEW_KIND}:${event.ticketId}`,
          subject,
          actorUserId: null,
          replyTo: event.reporterEmail && /^[^\s@]+@[^\s@]+$/.test(event.reporterEmail) ? event.reporterEmail : null,
        },
      ];
    }
    case "reporter.replied": {
      const who = nameOf(event.reporterName) ?? "A customer";
      return [
        {
          tenantId: event.tenantId,
          kind: FEEDBACK_TICKET_REPLIED_KIND,
          title: oneLine(`${who} answered on ${number}`, 200),
          body: event.excerpt.slice(0, 2000) || null,
          href,
          dedupeKey: `${FEEDBACK_TICKET_REPLIED_KIND}:${event.messageId}`,
          subject,
          actorUserId: null,
        },
      ];
    }
    default:
      return [];
  }
}
