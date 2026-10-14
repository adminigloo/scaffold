import {
  isValidTimeZone,
  updateSchedulingSettingsSchema,
  type DeliveryStatus,
  type ReminderRuns,
  type SchedulingRateLimitBucket,
  type UpdateSchedulingSettingsInput,
} from "__SCOPE__/scheduling";

/**
 * The decisions this project makes about scheduling, in one module with no
 * database, no environment and no request — so each one is tested on its own
 * (src/server/__tests__/scheduling-config.test.ts) and the route files that
 * use them stay a few lines of wiring.
 *
 * SHARED BY BOTH MODES (Tenancy 2a). Nothing here names a business: the one
 * fixed business of a single-business project, its staff keys and its crew
 * staff role live in src/server/scheduling-staff.ts, which a companies project
 * never gets — each company's tenant is the company's own id, and its people
 * hold company roles (Crew among them).
 *
 * Everything else — the slots, the requests, the manage links, the calendar,
 * the emails — is __SCOPE__/scheduling's, reached through its two HTTP
 * handlers. A fix there reaches this project on `pnpm update`; nothing here
 * re-implements it.
 */

/**
 * The zone a business starts in when SCHEDULING_TIME_ZONE is unset or not a
 * zone this runtime knows. Mountain Time because the first businesses this
 * was built for are there; the owner changes it in Schedule settings, and
 * every visit keeps its clock time when they do.
 */
export const DEFAULT_SCHEDULING_TIME_ZONE = "America/Denver";

/** The service a new business offers until the owner names its own. */
export const FIRST_SERVICE = { key: "estimate", name: "Free estimate", durationMinutes: 60 } as const;

/**
 * The settings written the first time this project's scheduling runs — and
 * never again: once a row exists it is the owner's, and nothing here
 * overwrites it.
 *
 * WHY WRITE ANY AT ALL. A business that never saved settings reads the
 * package's defaults, whose zone is UTC (0.3's behaviour). A window cleaner in
 * Salt Lake City would see 3 PM offered as 9 AM. So the zone is chosen here,
 * from SCHEDULING_TIME_ZONE when it names a real zone, and the address is
 * required — the crew drives to it, and a visit with no address is a phone
 * call somebody has to make.
 *
 * ONLINE BOOKING STARTS OFF, AND NAMELESS. The first deploy used to put a live
 * booking page up under the project's folder name ("sched04"), in Mountain
 * Time, before the owner had looked at anything — and a Chicago owner who
 * fixed the zone a week later moved every booked visit an hour. Now the page
 * says "online booking is closed" until the owner turns it on in Schedule
 * settings, and the calendar's banner lists what's left: the name, a phone,
 * the zone. No name is better than the wrong one: an email signs off with
 * nothing rather than with a folder name.
 *
 * Parsed through the package's own settings schema, so a value that would be
 * refused at save time is refused here, in a test, instead.
 */
export function firstSchedulingSettings(input: {
  readonly businessName?: string | undefined;
  readonly timeZone?: string | undefined;
}): UpdateSchedulingSettingsInput {
  const zone = input.timeZone?.trim();
  return updateSchedulingSettingsSchema.parse({
    timeZone: zone && isValidTimeZone(zone) ? zone : DEFAULT_SCHEDULING_TIME_ZONE,
    businessName: (input.businessName ?? "").slice(0, 120),
    requireAddress: true,
    publicBookingEnabled: false,
    services: [{ ...FIRST_SERVICE }],
  });
}

/** The crew a business that never had one starts with, so the booking page offers times on first boot. */
export const FIRST_CREW = {
  name: "Field crew",
  workStartTime: "08:00",
  workEndTime: "17:00",
  maxJobsPerDay: 6,
} as const;

/**
 * How often one visitor may hit each part of the public API.
 *
 *   request  5 an hour   a new booking request — the one that holds time
 *   manage  30 an hour   moving or cancelling from an emailed link
 *   read   120 a minute  the config, the times, viewing a visit, its .ics
 *
 * The package also caps how many requests one caller may have WAITING at once
 * (the business's "open requests" setting, counted in the database), which is
 * what holds across serverless instances; these bound how fast a script can
 * try, and they count in Upstash when it is configured.
 */
export const SCHEDULING_RATE_LIMITS: Readonly<
  Record<SchedulingRateLimitBucket, { readonly limit: number; readonly windowMs: number }>
> = {
  request: { limit: 5, windowMs: 60 * 60 * 1000 },
  manage: { limit: 30, windowMs: 60 * 60 * 1000 },
  read: { limit: 120, windowMs: 60 * 1000 },
};

/**
 * Whether anything the office does reaches a customer — the staff screens'
 * banner, and what decides whether they offer "Email the customer". Pure; the
 * facts come from src/server/scheduling-notify.ts (is the mail sender
 * configured, is the cron secret set, what failed lately).
 */
export function schedulingDeliveryStatus(input: {
  readonly commsInstalled: boolean;
  readonly emailConfigured: boolean;
  readonly cronSecretSet: boolean;
  readonly reminderRuns: ReminderRuns;
  readonly failedLastWeek: number;
  readonly overdueReminders: number;
  readonly overdueSince: Date | null;
  readonly timeZone: string;
  /**
   * Who reads it (review T2A-BO-05). "owner" (the default): the business owns
   * this deployment, so a reason names the setting to fix. "company": one
   * company of many on someone else's site — it can't set an environment
   * variable, so it reads only what that means for it. The site's operator
   * sees the same gaps, with their fixes, on /setup.
   */
  readonly audience?: "owner" | "company";
}): DeliveryStatus {
  const company = input.audience === "company";
  if (!input.commsInstalled) {
    return {
      customerEmails: false,
      customerEmailsOffReason: "this site was set up without customer emails",
      reminders: false,
    };
  }
  const problems: string[] = [];
  if (input.failedLastWeek > 0) {
    problems.push(
      `${input.failedLastWeek} visit email${input.failedLastWeek === 1 ? "" : "s"} couldn't be sent in the last 7 days. Messages shows which, and why.`,
    );
  }
  if (input.overdueReminders > 0 && input.overdueSince) {
    const since = new Intl.DateTimeFormat("en-US", { timeZone: input.timeZone, weekday: "short", month: "short", day: "numeric" }).format(input.overdueSince);
    problems.push(
      company
        ? `${input.overdueReminders} reminder${input.overdueReminders === 1 ? " is" : "s are"} waiting to go out: this site's reminder job hasn't run since about ${since}. Remind those customers yourself, and contact support if it doesn't clear up by tomorrow.`
        : `${input.overdueReminders} reminder${input.overdueReminders === 1 ? " is" : "s are"} waiting to go out: the daily reminder job hasn't run since about ${since}. Ask whoever set up your site to check CRON_SECRET on the deployment.`,
    );
  }
  return {
    customerEmails: input.emailConfigured,
    ...(input.emailConfigured
      ? {}
      : { customerEmailsOffReason: company ? "this site doesn't send email yet" : "no email service is set up yet (RESEND_API_KEY)" }),
    reminders: input.emailConfigured && input.cronSecretSet,
    ...(input.cronSecretSet
      ? {}
      : { remindersOffReason: company ? "reminders aren't switched on for this site yet" : "the daily reminder job isn't set up yet (CRON_SECRET)" }),
    reminderRuns: input.reminderRuns,
    problems,
  };
}

/** The public pages, as paths. The emails, the calendar and the nav all build links from these. */
export const BOOK_VISIT_PATH = "/book-visit";
export const MANAGE_VISIT_PATH = "/visit";
export const SCHEDULE_ADMIN_PATH = "/admin/schedule";
/** Where somebody signs in once, so the owner can pick them for a crew. */
export const SIGN_IN_PATH = "/sign-in";

/**
 * Absolute links on this deployment.
 *
 * ABSOLUTE because they leave the site: an email link that says
 * "/visit/abc" is not a link in an inbox. Built with `new URL` against the
 * app's own address, so a base with or without a trailing slash, or with a
 * path, joins the same way.
 *
 * The token is the customer's whole key to their visit. It goes into the
 * path, encoded, and nowhere else — never a log line, never a query string a
 * proxy might record.
 */
export function schedulingLinks(appUrl: string) {
  const at = (path: string) => new URL(path, appUrl.endsWith("/") ? appUrl : `${appUrl}/`).toString();
  return {
    book: at(BOOK_VISIT_PATH.slice(1)),
    manage: (token: string) => at(`${MANAGE_VISIT_PATH.slice(1)}/${encodeURIComponent(token)}`),
    admin: at(SCHEDULE_ADMIN_PATH.slice(1)),
    signIn: at(SIGN_IN_PATH.slice(1)),
  };
}
