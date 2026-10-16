import type { FeedbackEvent } from "./core.js";

/**
 * The emails a REPORTER gets (0.10.0): the team answered them, and their
 * ticket moved to another column. Words here, sending in the host — this
 * package imports no mailer and no @adminigloo/comms. A host with comms hands
 * each `FeedbackReporterEmail` to comms' `sendNow`, which sends it as the
 * company (its name on the From, its reply-to), logs it in the company's
 * Messages, and lets the owner reword it there.
 *
 * Plain text with `{{variables}}`, the comms template format. Inserted once
 * per company if absent (never over an owner's edit) by the host.
 */

export type FeedbackEmailTemplateKey = "feedback_staff_reply" | "feedback_status_changed";

export const FEEDBACK_EMAIL_TEMPLATES: ReadonlyArray<{ readonly key: FeedbackEmailTemplateKey; readonly label: string; readonly subject: string; readonly body: string }> =
  Object.freeze([
    {
      key: "feedback_staff_reply",
      label: "Feedback: the team replied",
      subject: "{{businessName}} replied to your feedback ({{ticketNumber}})",
      body: [
        "Hi {{reporterName}},",
        "",
        "{{staffName}} at {{businessName}} replied to your feedback \"{{title}}\":",
        "",
        "{{reply}}",
        "",
        "To answer, reply on our feedback page: {{feedbackUrl}}",
        "(Open it on the device you sent your feedback from, and choose \"My reports\".)",
        "",
        "{{businessName}}",
      ].join("\n"),
    },
    {
      key: "feedback_status_changed",
      label: "Feedback: the ticket moved",
      subject: "Your feedback {{ticketNumber}} is now {{statusLabel}}",
      body: [
        "Hi {{reporterName}},",
        "",
        "Your feedback \"{{title}}\" ({{ticketNumber}}) is now {{statusLabel}}.",
        "",
        "See the whole conversation on our feedback page: {{feedbackUrl}}",
        "",
        "{{businessName}}",
      ].join("\n"),
    },
  ]);

/** One reporter email, ready for comms' `sendNow` (with `tenantId`). */
export interface FeedbackReporterEmail {
  readonly tenantId: string;
  readonly to: string;
  readonly templateKey: FeedbackEmailTemplateKey;
  readonly vars: Readonly<Record<string, string>>;
  /**
   * The provider's idempotency key, from the durable fact (the reply's id, or
   * the ticket and the move: from which column to which): the same event
   * handed over twice is one email. A provider that honours it (Resend) drops
   * a repeat within a day, so a ticket dragged back and forth twice in an
   * afternoon emails the reporter once for each direction, not four times.
   */
  readonly idempotencyKey: string;
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

/** One line, no control characters: what a customer typed never becomes a header. */
function clean(value: string, max: number): string {
  const flat = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * A staff-side event → the reporter's email, or null when there is none to
 * send: no address on the ticket (a reporter who left none hears nothing by
 * email and still sees the reply under "My reports"), or an event the
 * reporter isn't told about.
 *
 *   staff.replied → feedback_staff_reply
 *   ticket.moved  → feedback_status_changed
 *
 * `businessName` is the company's name as its customers know it;
 * `feedbackUrl` is the company's public feedback page (absolute — it leaves
 * the site in an email).
 */
export function feedbackReporterEmailFor(
  event: FeedbackEvent,
  context: { readonly businessName: string; readonly feedbackUrl: string },
): FeedbackReporterEmail | null {
  if (event.type !== "staff.replied" && event.type !== "ticket.moved") return null;
  const to = event.reporterEmail?.trim() ?? "";
  if (!EMAIL.test(to)) return null;
  const base = {
    businessName: clean(context.businessName, 120) || "The team",
    reporterName: clean(event.reporterName ?? "", 80) || "there",
    ticketNumber: clean(event.ticketNumber, 20),
    title: clean(event.title, 120),
    feedbackUrl: context.feedbackUrl,
  };
  if (event.type === "staff.replied") {
    return {
      tenantId: event.tenantId,
      to,
      templateKey: "feedback_staff_reply",
      vars: { ...base, staffName: clean(event.staffName, 80) || "The team", reply: event.body },
      idempotencyKey: `feedback-reply:${event.messageId}`,
    };
  }
  return {
    tenantId: event.tenantId,
    to,
    templateKey: "feedback_status_changed",
    vars: { ...base, statusLabel: clean(event.toLabel, 60) },
    idempotencyKey: `feedback-moved:${event.ticketId}:${event.fromStatus}:${event.toStatus}`,
  };
}
