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

export function adminNotices(
  settings: Pick<
    SchedulingSettingsValues,
    "publicBookingEnabled" | "businessName" | "contactPhone" | "contactEmail" | "timeZone" | "reminderLeadHours"
  >,
  delivery: DeliveryStatus,
  now: Date,
): AdminNotice[] {
  const notices: AdminNotice[] = [];
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
  if (!settings.publicBookingEnabled) {
    notices.push({
      code: "booking_off",
      tone: "warn",
      message:
        "Online booking is off, so customers can't book on your website. When your business details below are right, turn it on in Schedule settings → Online booking.",
    });
  }
  if (!settings.businessName.trim()) {
    notices.push({
      code: "setup_name",
      tone: "warn",
      message: "Add your business name in Schedule settings. Customers see it on the booking page and in every email.",
    });
  }
  if (!settings.contactPhone?.trim() && !settings.contactEmail?.trim()) {
    notices.push({
      code: "setup_contact",
      tone: "warn",
      message:
        "Add a phone number in Schedule settings. Customers are told to call it when it's too late to change a visit online.",
    });
  }
  if (!settings.publicBookingEnabled) {
    notices.push({
      code: "setup_zone",
      tone: "info",
      message: `Visits are in ${zoneName(settings.timeZone)}. If that isn't where you work, change it in Schedule settings before customers book.`,
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
): AdminStatus {
  return {
    customerEmails: delivery.customerEmails,
    reminders: delivery.customerEmails && delivery.reminders && settings.reminderLeadHours > 0,
    upcomingVisits,
    notices: adminNotices(settings, delivery, now),
  };
}
