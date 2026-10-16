import type { AlertChoiceWire, RoutingGroupWire } from "../types.js";

/**
 * Every sentence the alerts screens print (Tenancy 2b-1, section 5), in one
 * place, in the words a business owner uses: "alerts", "the owner", "who
 * hears about new work". Never "notification", "recipient", "routing" or an
 * id. Pure, so the tests read them back.
 */

export const ALERTS = "Alerts";
export const EMPTY = "Nothing new. Alerts about your work show up here.";
export const EMPTY_UNREAD = "You're all caught up.";
/** Review BO-12: on no alert list and no kind directly. */
export const NOT_ON_A_LIST = "You're not on any alert lists yet. The owner chooses who hears about new work in Alert settings.";
export const NOT_ON_YOUR_LIST = "Not on your list";
export const NOT_ON_YOUR_LIST_NOTE = "The owner chooses who hears about new work in Alert settings.";
export const MARK_ALL = "Mark all as read";
export const ALL_READ = "All caught up.";
export const SEE_ALL = "See all alerts";
export const SETTINGS = "Alert settings";
export const LOAD_MORE = "Load more";
export const CLOSE = "Close";
export const TRY_AGAIN = "Try again";
export const SAVED = "Saved.";
export const IN_APP = "In the app";
export const IN_APP_AND_EMAIL = "In the app and by email";
export const HOW_YOU_GET = "How you get each alert";
export const WHO_HEARS = "Who hears about new work";
export const THESE_PEOPLE = "These people";
export const ALSO_EMAIL = "Also email these addresses (up to 5)";
export const ADD_ADDRESS = "Add an address";
export const REMOVE_ADDRESS = "Remove this address";
export const NOBODY_TICKED = "Nobody is ticked, so the owner gets these in the app.";
export const ADDRESSES_STILL = "These addresses still get the emails.";
export const BAD_ADDRESS = "That doesn't look like an email address.";
export const MESSAGES_LINK = "Go to Messages";
export const SAVE = "Save";

/** The bell's accessible name: "Alerts" / "Alerts, 3 unread". */
export function bellLabel(unread: number): string {
  return unread > 0 ? `${ALERTS}, ${unread} unread` : ALERTS;
}

/** The badge: hidden at 0, the number up to 99, "99+" past it. */
export function badgeText(unread: number): string {
  if (!Number.isFinite(unread) || unread <= 0) return "";
  return unread > 99 ? "99+" : String(Math.trunc(unread));
}

/** The first line of a body, for the bell's one-line preview. */
export function firstLine(body: string | null): string {
  return (body ?? "").split(/\r?\n/)[0]?.trim() ?? "";
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dateLabel(date: Date, locale?: string): string {
  try {
    return new Intl.DateTimeFormat(locale ?? "en-US", { weekday: "short", month: "short", day: "numeric" }).format(date);
  } catch {
    return date.toDateString();
  }
}

/** "just now", "3 min ago", "2 hours ago", "Yesterday", "Mon, Nov 2". */
export function timeAgo(at: string, now: Date = new Date(), locale?: string): string {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return "";
  const seconds = Math.max(0, Math.round((now.getTime() - when.getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24 && dayKey(when) === dayKey(now)) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  return dayHeading(at, now, locale);
}

/** The inbox's day groups: "Today", "Yesterday", "Mon, Nov 2". */
export function dayHeading(at: string, now: Date = new Date(), locale?: string): string {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return "Earlier";
  if (dayKey(when) === dayKey(now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayKey(when) === dayKey(yesterday)) return "Yesterday";
  return dateLabel(when, locale);
}

/**
 * Review BO-8: true whether or not this person is on a crew (holding the
 * crew permission doesn't put anyone on one).
 */
export const CREW_SENTENCE = "You get these for visits of a crew you're on. If you're on no crew, you won't get these.";

/** Under a routed kind (review BO-12). */
export function routedSentence(routed: AlertChoiceWire["routed"]): string | null {
  if (!routed) return null;
  if (routed.onList) return "You're on the list for these.";
  if (routed.viaAssigned) return CREW_SENTENCE;
  return "Only the people chosen in 'Who hears about new work' get these.";
}

/**
 * Where the business email is set, in the three sentences that name it: the
 * template's own page. A host whose app keeps it elsewhere passes its own
 * words (`<AlertSettings businessEmailSettings="Settings → Business profile">`).
 */
export const BUSINESS_EMAIL_SETTINGS = "company settings";

/** The host's words for that page, or the template's when it gave none (or only spaces). */
export function businessEmailSettingsOr(given?: string | null): string {
  const where = given?.trim();
  return where ? where : BUSINESS_EMAIL_SETTINGS;
}

/**
 * Alert settings' top line. `workEmail` (review BO-1): where this person's
 * emails about new work go when that isn't their own address (the owner's,
 * while a list is on "The owner": the business email), set in `where`.
 */
export function emailLine(input: {
  emailAvailable: boolean;
  emailAddress: string | null;
  emailOffReason: string | null;
  workEmail?: string | null;
  where?: string | null;
}): string {
  if (!input.emailAvailable) return input.emailOffReason ?? "This site doesn't send email yet, so alerts stay in the app.";
  const work = input.workEmail ? ` Emails about new work go to ${input.workEmail}, the business email in ${businessEmailSettingsOr(input.where)}.` : "";
  if (!input.emailAddress) {
    return work ? `There's no email address on your account.${work}` : "There's no email address on your account, so your alerts stay in the app.";
  }
  return `Alert emails go to ${input.emailAddress}.${work}`;
}

/** Review BO-1: under a kind whose emails go to the business email (set in `where`), not the person's own. */
export function kindEmailToLine(emailTo: string, where?: string | null): string {
  return `Emails for this go to ${emailTo}, the business email in ${businessEmailSettingsOr(where)}.`;
}

/** "The owner (Gail Owner)". */
export function ownerChoice(name: string | null): string {
  return name ? `The owner (${name})` : "The owner";
}

/** Review BO-01: while on The owner, the owner's copies go to the business email (set in `where`). */
export function businessEmailLine(ownerEmail: string, where?: string | null): string {
  return `Emails go to ${ownerEmail}, the business email in ${businessEmailSettingsOr(where)}.`;
}

/** "Someone asks for an estimate, a customer accepts a quote": the first as it is, the rest lower case. */
function phrases(labels: readonly string[]): string {
  return labels.map((label, i) => (i === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1))).join(", ");
}

/** "This covers: Someone asks for an estimate, A customer accepts a quote." */
export function coversLine(labels: readonly string[]): string | null {
  if (labels.length === 0) return null;
  return `This covers: ${phrases(labels)}.`;
}

/**
 * Review BO-1: while a list is on "The owner", the owner's own channel
 * decides whether the business mailbox gets each kind. Names the kinds it
 * gets nothing for, and where that is set (`ownerIsYou`: the owner reading
 * their own page, else an admin reading the owner's choice).
 */
export function noEmailsLine(labels: readonly string[], ownerIsYou: boolean): string | null {
  if (labels.length === 0) return null;
  const where = ownerIsYou ? 'in "How you get each alert", above' : "in the owner's own Alert settings";
  return `No emails go out for: ${phrases(labels)}. ${labels.length > 1 ? "They're" : "It's"} set to "In the app" ${where}.`;
}

/** Every kind the group covers is "In the app" only for the owner: no email goes anywhere for it. */
export function ownerAllInApp(group: Pick<RoutingGroupWire, "covers" | "ownerInAppOnly">): boolean {
  return group.covers.length > 0 && group.covers.every((label) => group.ownerInAppOnly.includes(label));
}

/**
 * Review BO-20, BO-7: a list with nobody ticked goes to the owner, never to
 * nobody, and with a business email in company settings the emails go there.
 */
export function nobodyTickedLine(group: Pick<RoutingGroupWire, "covers" | "ownerEmail" | "ownerEmailIsBusiness" | "ownerInAppOnly">): string {
  if (!ownerAllInApp(group) && group.ownerEmailIsBusiness && group.ownerEmail) {
    return `Nobody is ticked, so the owner gets these, and emails go to ${group.ownerEmail}.`;
  }
  return NOBODY_TICKED;
}

/** A loose email check before sending (the server checks again). */
export const EMAIL_ADDRESS = /^[^\s@<>()",;:\\]+@[^\s@<>()",;:\\]+\.[^\s@<>()",;:\\]+$/;
