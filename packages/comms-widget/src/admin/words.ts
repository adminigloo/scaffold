import type { MessageStatus, RunDueWire } from "../types.js";

/**
 * The console's plain words. A business owner never reads a template KEY or a
 * status CODE: "visit_reminder" is "Visit reminder", "skipped" is "Skipped".
 */

export type TemplateGroup = "Visits" | "Estimates" | "Invoices" | "Other";

/** The groups, in the order the screen shows them. */
export const TEMPLATE_GROUPS: readonly TemplateGroup[] = ["Visits", "Estimates", "Invoices", "Other"];

/** What a template is about, from its key's first word. */
export function templateGroup(key: string): TemplateGroup {
  const first = key.split("_")[0] ?? "";
  if (first === "visit") return "Visits";
  if (first === "estimate" || first === "quote" || first === "lead") return "Estimates";
  if (first === "invoice") return "Invoices";
  return "Other";
}

/**
 * What each email the features send is CALLED, and WHEN it goes out, in an
 * owner's words (review T2A-BO-08). The console used to title-case the key
 * ("Estimate lead staff", "Visit staff notice"): a key with spaces, not a name
 * anybody would look for. These are the emails @adminigloo/scheduling,
 * @adminigloo/estimator and @adminigloo/invoicing send; a key not listed here
 * (one a project added itself) falls back to its title-cased key.
 */
export const TEMPLATE_WORDS: Readonly<Record<string, { readonly label: string; readonly when: string }>> = {
  visit_requested: { label: "Visit request received", when: "To the customer, right after they ask for a visit online." },
  visit_confirmed: { label: "Visit confirmed", when: "To the customer, when you accept their request or book a visit for them." },
  visit_declined: { label: "Visit request declined", when: "To the customer, when you say no to a requested time." },
  visit_rescheduled: { label: "Visit moved", when: "To the customer, when a visit moves to a new time." },
  visit_reassigned: { label: "New crew for a visit", when: "To the customer, when a different crew will do the visit." },
  visit_cancelled: { label: "Visit cancelled", when: "To the customer, when a visit is cancelled." },
  visit_expired: { label: "Request not confirmed in time", when: "To the customer, when a request waited too long for an answer." },
  visit_reminder: { label: "Visit reminder", when: "To the customer, the day before the visit." },
  visit_staff_notice: {
    label: "New request or change (to your office)",
    when: "To your office, when a customer asks for, moves or cancels a visit.",
  },
  estimate_lead_customer: { label: "Estimate copy for the customer", when: "To the customer, when they save an instant estimate." },
  estimate_lead_staff: { label: "New lead (to your office)", when: "To your office, when a customer saves an instant estimate." },
  quote_sent: { label: "Quote", when: "To the customer, when you send a quote." },
  quote_follow_up: { label: "Quote follow-up", when: "To the customer, a few days after a quote they haven't answered." },
  quote_accepted_customer: { label: "Quote accepted", when: "To the customer, after they accept a quote." },
  quote_expired_customer: { label: "Quote expired", when: "To the customer, when a quote passes its expiry date." },
  quote_staff_notice: { label: "Quote answered (to your office)", when: "To your office, when a customer accepts or declines a quote." },
  invoice_sent: { label: "Invoice", when: "To the customer, when you send an invoice." },
};

/** The template's written name; a key the list doesn't know is title-cased ("thank_you" → "Thank you"). */
export function templateLabel(key: string): string {
  const known = TEMPLATE_WORDS[key];
  if (known) return known.label;
  const words = key.split(/[_\s]+/).filter(Boolean).join(" ");
  if (!words) return key;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** When the template goes out, in one sentence; null for a key the list doesn't know. */
export function templateWhen(key: string): string | null {
  return TEMPLATE_WORDS[key]?.when ?? null;
}

/**
 * Example values for the subject PREVIEW in the list, so an owner reads
 * "Confirmed: Lawn mowing, Tue, Nov 4, 9:00 AM" rather than
 * "{{serviceName}}, {{shortWhen}}". The edit form still shows the wording with
 * its blanks, because that is what they change.
 */
const SAMPLE_VALUES: Readonly<Record<string, string>> = {
  serviceName: "Lawn mowing",
  shortWhen: "Tue, Nov 4, 9:00 AM",
  when: "Tuesday, November 4 at 9:00 AM",
  customerName: "Pat Rivera",
  firstName: "Pat",
  subjectTag: "New request",
  invoiceNumber: "INV-0042",
  estimateNumber: "Q-1042",
  rangeText: "$1,100 to $1,400",
  total: "$1,250.00",
  name: "Pat",
  date: "Tue, Nov 4",
  time: "9:00 AM",
};

/** A subject with its blanks filled by example values; a blank with no example becomes "…". */
export function previewSubject(subject: string, businessName: string | null): string {
  return subject.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_match, name: string) => {
    if (name === "businessName") return businessName ?? "Your business";
    return SAMPLE_VALUES[name] ?? "…";
  });
}

export const STATUS_WORDS: Readonly<Record<MessageStatus, string>> = {
  sent: "Sent",
  skipped: "Skipped",
  failed: "Failed",
  cancelled: "Cancelled",
  expired: "Expired",
};

export const STATUS_TONE: Readonly<Record<MessageStatus, "ok" | "warn" | "danger" | "muted">> = {
  sent: "ok",
  skipped: "warn",
  failed: "danger",
  cancelled: "muted",
  expired: "muted",
};

/**
 * The outcome of "Send what's due now" in one sentence listing EVERY non-zero
 * count: "Sent 3 · failed 1 · 2 will retry." Never "Sent 3" alone when two of
 * the three failed: that is how a broken provider goes unnoticed (the 0.2
 * page's rule).
 */
export function runDueSentence(result: RunDueWire): string {
  const parts = [`Sent ${result.sent}`];
  if (result.skipped) parts.push(`skipped ${result.skipped}`);
  if (result.failed) parts.push(`failed ${result.failed}`);
  if (result.retrying) parts.push(`${result.retrying} will retry`);
  if (result.cancelled) parts.push(`cancelled ${result.cancelled}`);
  if (result.expired) parts.push(`expired ${result.expired}`);
  const sentence = `${parts.join(" · ")}.`;
  return result.stoppedEarly ? `${sentence} More are due: send again.` : sentence;
}

/**
 * "{n} scheduled messages missed their send time…" (review SEC-2A-01): due
 * over an hour ago and still waiting, because the job that sends them ran out
 * of time before reaching them. Said plainly, with who can fix it.
 */
export function behindSentence(behind: number): string {
  const subject = behind === 1 ? "1 scheduled message missed its send time" : `${behind} scheduled messages missed their send time`;
  return `${subject} and will go out on the next run. If you see this often, your site sends more than its job can keep up with: ask whoever set up your site to run it more often.`;
}

/** "{n} scheduled messages are late…" with the right plural. */
export function lateSentence(late: number): string {
  const subject = late === 1 ? "1 scheduled message is late" : `${late} scheduled messages are late`;
  return `${subject}: the daily job that sends them hasn't run. Ask whoever set up your site to check it.`;
}

/** A log time, in the viewer's own clock: "Oct 13, 2:05 PM". Bad input → the raw text. */
export function formatWhen(instant: string, locale?: string): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return instant;
  try {
    return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
  } catch {
    return date.toISOString();
  }
}
