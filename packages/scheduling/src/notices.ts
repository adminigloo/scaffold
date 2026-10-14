import type { SchedulingSettingsValues } from "./settings.js";
import type { AdminNotice, AdminStatus } from "./wire.js";

/**
 * What the office should know about its own deployment, in plain words: the
 * banner on the calendar and the settings page. Pure.
 *
 * WHY. The staff screens offered "Email the customer about this" and "Yes,
 * email them" whether or not any email could leave — no comms, no mail key,
 * no cron — and a Resend failure went only to a server log. The owner ticked
 * the box and believed the customer had been told. The customer widget was
 * already honest about email; this makes the staff side honest too. Each
 * notice is one sentence an owner can act on, most important first.
 */

/**
 * When the comms cron actually runs. `{ dailyAtUtc: "14:00" }` is Vercel
 * Hobby's once-a-day schedule (the one create-app writes); `{ everyMinutes:
 * 15 }` a tighter scheduler. The comms listener snaps each reminder to a run
 * it can actually go out on, and the status wording says when they arrive.
 */
export type ReminderRuns = { dailyAtUtc: string } | { everyMinutes: number };

/** The host's answer to "does anything this office does actually reach a customer?" */
export interface DeliveryStatus {
  /** Will a customer email sent now leave (a listener on `onEvent` AND a sender that sends)? */
  customerEmails: boolean;
  /** Why not, in a few words, for the banner ("no email service is set up yet"). */
  customerEmailsOffReason?: string;
  /** Will reminders go out (the comms cron is scheduled and allowed to run)? */
  reminders: boolean;
  remindersOffReason?: string;
  /** When the comms cron runs, so the banner can say when reminders arrive. */
  reminderRuns?: ReminderRuns;
  /** Anything else the office must hear about ("2 visit emails couldn't be sent this week. See Messages."). */
  problems?: string[];
}

function zoneName(timeZone: string): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "long" })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName")?.value;
    return part ? `${part.replace(/ (Standard|Daylight) Time$/, " Time")} (${timeZone.replace(/_/g, " ")})` : timeZone;
  } catch {
    return timeZone;
  }
}

/** "7:00 AM" — a daily UTC run on the business's own clock today. */
export function runClock(dailyAtUtc: string, timeZone: string, now: Date): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(dailyAtUtc.trim());
  if (!match) return null;
  const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), Number(match[1]), Number(match[2])));
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(at);
  } catch {
    return null;
  }
}

/**
 * What the notices may point at, and who is waiting to be linked to a crew
 * (Tenancy 2a review). All optional: a host passing none gets 0.4's notices.
 */
export interface AdminNoticeContext {
  /**
   * Where the company's own business details are edited (D6), e.g.
   * "/settings/company#details". With a company, the name, contact and zone
   * are changed THERE, so a notice about them links there instead of sending
   * the owner to Schedule settings, where those fields are read-only
   * (review T2A-BO-07).
   */
  readonly companyHref?: string | null;
  /** Where Schedule settings' crews are, e.g. "/app/schedule/settings#crews", for the crew notice's link. */
  readonly crewsHref?: string | null;
  /**
   * People who hold the company's Crew role but open no crew's route yet
   * (review T2A-BO-04): an invited crew member's first morning is otherwise a
   * dead end, and nothing tells the owner why.
   */
  readonly unlinkedCrew?: readonly { readonly name: string | null; readonly email: string | null }[];
}

function personName(person: { readonly name: string | null; readonly email: string | null }): string {
  return person.name?.trim() || person.email?.trim() || "Someone";
}

export function adminNotices(
  settings: Pick<
    SchedulingSettingsValues,
    "publicBookingEnabled" | "businessName" | "contactPhone" | "contactEmail" | "timeZone" | "reminderLeadHours"
  > & { readonly managedByCompany?: boolean; readonly zoneFromCompany?: boolean },
  delivery: DeliveryStatus,
  now: Date,
  context: AdminNoticeContext = {},
): AdminNotice[] {
  const notices: AdminNotice[] = [];
  const company = settings.managedByCompany === true;
  const companyLink = company && context.companyHref ? { href: context.companyHref, label: "Open company settings" } : null;
  if (!delivery.customerEmails) {
    notices.push({
      code: "emails_off",
      tone: "warn",
      message: `Customer emails are off${delivery.customerEmailsOffReason ? `: ${delivery.customerEmailsOffReason}` : ""}. Nobody is told about your answers, moves or cancellations, so call customers yourself until it's set up.`,
    });
  } else if (settings.reminderLeadHours > 0 && !delivery.reminders) {
    notices.push({
      code: "reminders_off",
      tone: "warn",
      message: `Reminders aren't going out${delivery.remindersOffReason ? `: ${delivery.remindersOffReason}` : ""}.`,
    });
  }
  for (const problem of delivery.problems ?? []) {
    if (problem.trim()) notices.push({ code: "delivery_problem", tone: "warn", message: problem.trim() });
  }
  for (const person of context.unlinkedCrew ?? []) {
    notices.push({
      code: "crew_unlinked",
      tone: "warn",
      message: `${personName(person)} joined as a crew member but isn't on a crew yet, so their route won't open. Pick them for their crew in Schedule settings → Crews.`,
      ...(context.crewsHref ? { link: { href: context.crewsHref, label: "Pick their crew" } } : {}),
    });
  }
  // With a company and no time zone of its own, visits run on the starting
  // zone — and online booking stays off until the company sets one (the
  // settings save refuses it), so customers never book on a clock that
  // isn't the business's (review T2A-BO-07).
  const companyZoneMissing = company && settings.zoneFromCompany === false;
  if (companyZoneMissing) {
    notices.push({
      code: "setup_zone",
      tone: "warn",
      message: `Your company's time zone isn't set yet, so visits are shown in ${zoneName(settings.timeZone)}. Set it in your company settings before you take bookings online.`,
      ...(companyLink ? { link: companyLink } : {}),
    });
  }
  if (!settings.publicBookingEnabled) {
    notices.push({
      code: "booking_off",
      tone: "warn",
      message: company
        ? "Online booking is off, so customers can't book on your website. When your services and crew hours are right, turn it on in Schedule settings → Online booking."
        : "Online booking is off, so customers can't book on your website. When your business details below are right, turn it on in Schedule settings → Online booking.",
    });
  }
  if (!settings.businessName.trim()) {
    notices.push({
      code: "setup_name",
      tone: "warn",
      message: company
        ? "Add your business name in your company settings. Customers see it on the booking page and in every email."
        : "Add your business name in Schedule settings. Customers see it on the booking page and in every email.",
      ...(companyLink ? { link: companyLink } : {}),
    });
  }
  if (!settings.contactPhone?.trim() && !settings.contactEmail?.trim()) {
    notices.push({
      code: "setup_contact",
      tone: "warn",
      message: company
        ? "Add a phone number in your company settings. Customers are told to call it when it's too late to change a visit online."
        : "Add a phone number in Schedule settings. Customers are told to call it when it's too late to change a visit online.",
      ...(companyLink ? { link: companyLink } : {}),
    });
  }
  if (!settings.publicBookingEnabled && !companyZoneMissing) {
    notices.push({
      code: "setup_zone",
      tone: "info",
      message: company
        ? `Visits are in ${zoneName(settings.timeZone)}, your company's time zone. If that isn't where you work, change it in your company settings before customers book.`
        : `Visits are in ${zoneName(settings.timeZone)}. If that isn't where you work, change it in Schedule settings before customers book.`,
      ...(companyLink ? { link: companyLink } : {}),
    });
  }
  if (delivery.customerEmails && delivery.reminders && settings.reminderLeadHours > 0 && delivery.reminderRuns && "dailyAtUtc" in delivery.reminderRuns) {
    const at = runClock(delivery.reminderRuns.dailyAtUtc, settings.timeZone, now);
    notices.push({
      code: "reminders_daily",
      tone: "info",
      message:
        `Reminders go out once a day${at ? `, at ${at}` : ""}, so each one arrives the day before the visit — ` +
        `at least ${settings.reminderLeadHours} hour${settings.reminderLeadHours === 1 ? "" : "s"} ahead, often more. ` +
        `For reminders at exactly ${settings.reminderLeadHours} hour${settings.reminderLeadHours === 1 ? "" : "s"}, the reminder job has to run every 15 minutes: ask whoever set up your site.`,
    });
  }
  return notices;
}

/** The status route's answer. */
export function adminStatus(
  settings: Parameters<typeof adminNotices>[0],
  delivery: DeliveryStatus,
  upcomingVisits: number,
  now: Date,
  context: AdminNoticeContext = {},
): AdminStatus {
  return {
    customerEmails: delivery.customerEmails,
    reminders: delivery.customerEmails && delivery.reminders && settings.reminderLeadHours > 0,
    upcomingVisits,
    notices: adminNotices(settings, delivery, now, context),
  };
}
