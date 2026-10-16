/**
 * Alerts about messages (Tenancy 2b-1, section 12.3): the words a template is
 * CALLED, the one alert kind comms brings ("An email to a customer doesn't
 * go"), and the mapper that turns a final failure into that alert's draft.
 *
 * STRUCTURAL, on purpose (Tenancy 2a D4, 2b-1 D3): nothing here imports
 * @adminigloo/notifications. The shapes below are declared again in every
 * package that produces alerts, identical field for field (2b-1 section 3.2,
 * 3.3), and prefixed with the package's name so a generated file importing two
 * packages never sees two `AlertDraft`s. The notifications package checks a
 * fragment when the project composes its registry; this file's own test runs
 * the same rules as a copy (see __tests__/alerts.test.ts).
 *
 * comms owns these words because it knows the fact: a wording fix reaches
 * every project by npm (create-app rule 3), and the emitted glue only hands a
 * `CommsFailure` to `commsFailureAlert` and the draft to `alerts.notify`.
 */

/** How a person hears about a kind of alert (2b-1 D5). */
export type CommsAlertChannel = "in_app" | "email";

/** One kind of alert (2b-1 section 3.2), structurally identical to notifications' `AlertKindSpec`. */
export interface CommsAlertKind {
  /** Permanent. /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){1,3}$/, at most 64 characters. */
  readonly key: string;
  /** What a person sees in Alert settings, a plain phrase. */
  readonly label: string;
  readonly description?: string;
  /** The heading it is listed under. */
  readonly category: string;
  readonly audience: {
    /** Only active members holding this may receive it (D4). */
    readonly permission: string;
    /** The routing group whose chosen people get it (default: the owner). Absent: everyone holding `permission`. */
    readonly routing?: string;
    /** People assigned to the record who hold this also get it (crew). */
    readonly assigned?: { readonly permission: string };
  };
  /** For someone who never chose. */
  readonly defaultChannel: CommsAlertChannel;
  /** false: never emailed, and the choice isn't offered. Default true. */
  readonly email?: boolean;
  /** "producer": the package sends its own office email for it (D6). Default "notifications". */
  readonly emailBy?: "notifications" | "producer";
  /** Order inside its category. Default 100. */
  readonly order?: number;
}

/** A routing group (2b-1 section 3.2). comms declares none: a failed email isn't new work. */
export interface CommsAlertRouting {
  /** /^[a-z][a-z0-9-]{1,31}$/. Permanent (stored). */
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  /** Who may be chosen for it: members holding this. */
  readonly permission: string;
  readonly order?: number;
}

/** comms' fragment for the project's alert registry. */
export interface CommsAlertKinds {
  readonly kinds: readonly CommsAlertKind[];
  readonly routings: readonly CommsAlertRouting[];
}

/** What a mapper returns and `alerts.notify` takes (2b-1 section 3.3). */
export interface CommsAlertDraft {
  readonly tenantId: string;
  /** A registered kind key. */
  readonly kind: string;
  /** One line, 1–200 characters, plain text: no CR, LF, U+2028 or U+2029 (it becomes an email Subject; D18). */
  readonly title: string;
  /** At most 2000 characters, plain text; null = none. */
  readonly body: string | null;
  /** A same-site path matching /^\/(?![\/\\])[^\\\s\u0000-\u001f]{0,499}$/; null = nothing to open. */
  readonly href: string | null;
  /** Where it opens for someone reached ONLY through `assigned`. Default `href`. */
  readonly assignedHref?: string | null;
  /** D7: from the durable fact; 1–200 characters. */
  readonly dedupeKey: string;
  /** What it is about. */
  readonly subject: { readonly type: string; readonly id: string } | null;
  /** Who caused it; never alerted about it. null for a customer or the system. */
  readonly actorUserId: string | null;
  /** For kinds with `audience.assigned`: who is on the record. */
  readonly assignedUserIds?: readonly string[];
  /** Where a reply to the email copy goes. */
  readonly replyTo?: string | null;
}

/**
 * A message that FAILED FOR GOOD (section 12.1), as `onFailed` is told it.
 * Declared here beside its mapper; the delivery config in index.ts names it.
 */
export interface CommsFailure {
  readonly tenantId: string;
  /** The delivery-log row that recorded it; null for a queued message abandoned mid-send. */
  readonly messageId: string | null;
  /** The queued message, when it came from the queue. */
  readonly scheduledId: string | null;
  readonly channel: "email" | "sms";
  readonly to: string;
  readonly templateKey: string;
  /** The log's words. */
  readonly error: string;
  readonly at: Date;
}

// --- Words -------------------------------------------------------------------

/**
 * What each email the features send is CALLED, in an owner's words. MOVED
 * from comms-widget's `TEMPLATE_WORDS` (review T2A-BO-08) so the server can
 * say the same name the Messages screen shows: Alert settings' "Emails for
 * this are switched off in Messages (New lead (to your office))" and the
 * failed-email alert's title both read it. The widget keeps its own copy
 * (2a: a widget never imports a server package at runtime); the labels below
 * must stay word for word the same, and comms-widget's words test pins the
 * overlap.
 */
const TEMPLATE_LABELS: Readonly<Record<string, string>> = {
  visit_requested: "Visit request received",
  visit_confirmed: "Visit confirmed",
  visit_declined: "Visit request declined",
  visit_rescheduled: "Visit moved",
  visit_reassigned: "New crew for a visit",
  visit_cancelled: "Visit cancelled",
  visit_expired: "Request not confirmed in time",
  visit_reminder: "Visit reminder",
  visit_staff_notice: "New request or change (to your office)",
  estimate_lead_customer: "Estimate copy for the customer",
  estimate_lead_staff: "New lead (to your office)",
  quote_sent: "Quote",
  quote_follow_up: "Quote follow-up",
  quote_accepted_customer: "Quote accepted",
  quote_expired_customer: "Quote expired",
  quote_staff_notice: "Quote answered (to your office)",
  invoice_sent: "Invoice",
  team_alert: "Team alert",
};

/**
 * A template's written name: "visit_reminder" → "Visit reminder",
 * "team_alert" → "Team alert". A key the list doesn't know (one a project
 * added itself) is title-cased ("thank_you" → "Thank you"), never shown raw.
 */
export function templateLabel(key: string): string {
  const known = TEMPLATE_LABELS[key];
  if (known) return known;
  const words = key.split(/[_\s]+/).filter(Boolean).join(" ");
  if (!words) return key;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// --- The alert kind ----------------------------------------------------------

/** The kind's permanent key (stored on alert rows and on people's choices). */
export const COMMS_MESSAGE_FAILED_KIND = "comms.message.failed";

/**
 * comms' alert fragment (section 12.3).
 *
 * `email: false`, with `defaultChannel: "in_app"` (the registry refuses an
 * email default on a kind that is never emailed): an alert about mail that
 * failed mustn't depend on mail (the provider that refused the customer's
 * reminder may refuse this too), and it can't loop — a failed alert email
 * would otherwise raise a failed-email alert about itself.
 *
 * Audience `comms.manage`: the people who can open Messages and fix the
 * wording, the address or the switch. No routing group: a failed email is
 * not new work coming in, so everyone who manages messages hears of it.
 */
export const commsAlertKinds: CommsAlertKinds = Object.freeze({
  kinds: Object.freeze([
    Object.freeze({
      key: COMMS_MESSAGE_FAILED_KIND,
      label: "An email to a customer doesn't go",
      description: "A reminder, quote or invoice email that couldn't be delivered, so you can reach the customer another way.",
      category: "Messages",
      audience: Object.freeze({ permission: "comms.manage" }),
      defaultChannel: "in_app",
      email: false,
      order: 10,
    }) as CommsAlertKind,
  ]),
  routings: Object.freeze([]) as readonly CommsAlertRouting[],
}) as CommsAlertKinds;

/** CR, LF, U+2028, U+2029 and every other control character: a title becomes an email Subject (D18). */
function oneLine(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
    out += control ? " " : char;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** At most `max` characters (by code point), with an ellipsis when cut. */
function cap(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

/** 3.3's href rule (D18): a same-site path, no "//", no "/\", no backslash, whitespace or control character. */
const HREF_PATTERN = /^\/(?![\/\\])[^\\\s\u0000-\u001f]{0,499}$/;

/**
 * A final failure → the "didn't go" alert, or null.
 *
 * NULL for a template not in `customerTemplateKeys`: only CUSTOMER emails are
 * alerted. An office notice or a team alert that failed is the alerts
 * package's own retry's job (2b-1 D6, D8); alerting the office that the
 * office's own email failed would be a second message about the first, to the
 * same people.
 *
 * Title "The {label in lower case} email to {to} didn't go" (review BO-26):
 * "The visit reminder email to pat@x.com didn't go" reads as a sentence, where
 * "Visit reminder failed" did not. `templateLabel` keeps title case for lists;
 * the lower case is only this sentence's.
 *
 * Dedupe key from the durable fact (D7): the delivery-log row that recorded
 * the failure, or, for a queued message given up with no log row of its own
 * (abandoned mid-send), the queue row — so a drain that gives the same row up
 * twice (it can't, but a host replaying `onFailed` might) alerts once.
 */
export function commsFailureAlert(
  failure: CommsFailure,
  options: { readonly href: string; readonly customerTemplateKeys: ReadonlySet<string> },
): CommsAlertDraft | null {
  if (!options.customerTemplateKeys.has(failure.templateKey)) return null;
  const id = failure.messageId ?? failure.scheduledId;
  if (!id) return null;
  const dedupeKey = failure.messageId
    ? `${COMMS_MESSAGE_FAILED_KIND}:${failure.messageId}`
    : `${COMMS_MESSAGE_FAILED_KIND}:queued:${failure.scheduledId}`;
  // CONTRACT: 12.3 words the title for email ("… email to … didn't go"). A
  // text message is called a "text" in the same sentence rather than an
  // email it never was; no 2b-1 project sends texts, so the email wording is
  // the one every owner reads.
  const medium = failure.channel === "sms" ? "text" : "email";
  const label = templateLabel(failure.templateKey).toLowerCase();
  const title = cap(oneLine(`The ${label} ${medium} to ${failure.to} didn't go`), 200);
  // The href is a pattern like every mapper's (2b-1 3.3): `{id}` is the
  // message, URL-encoded. A pattern failing the same-site rule opens nothing
  // rather than handing the bell a link it must refuse.
  const href = options.href.replace(/\{id\}/g, encodeURIComponent(id));
  return {
    tenantId: failure.tenantId,
    kind: COMMS_MESSAGE_FAILED_KIND,
    title,
    body: "Open Messages to see what happened.",
    href: HREF_PATTERN.test(href) ? href : null,
    dedupeKey,
    subject: { type: "comms.message", id },
    actorUserId: null,
  };
}
