import type {
  EstimatorDelivery,
  EstimatorRateLimitBucket,
  LinkedVisit,
} from "__SCOPE__/estimator";

/**
 * The decisions this project makes about the estimator, in one module with no
 * database, no environment and no request — so each one is tested on its own
 * (src/server/__tests__/estimator-config.test.ts) and the route files that use
 * them stay a few lines of wiring.
 *
 * Everything else — the prices, the questions a customer is asked, the photo
 * reading, the quotes, the emails — is __SCOPE__/estimator's, reached through
 * its two HTTP handlers. A fix there reaches this project on `pnpm update`;
 * nothing here re-implements it.
 *
 * SHARED BY BOTH MODES (Tenancy 2a). Nothing here names a business: the one
 * fixed business of a single-business project and its staff keys live in
 * src/server/estimator-staff.ts, which a companies project never gets — each
 * company estimates under its own id, and its people hold company roles.
 *
 * TYPE-ONLY IMPORTS, on purpose: this file must load without the package, so
 * the browser test that walks the business scenario (e2e/tests/
 * estimator-scenario.spec.ts) can use these exact decisions rather than a copy.
 */

/**
 * The zone a business's quotes are dated in until the owner picks one in
 * Estimate settings. Mountain Time because the first businesses this was built
 * for are there; ESTIMATOR_TIME_ZONE (or SCHEDULING_TIME_ZONE) chooses another.
 */
export const DEFAULT_ESTIMATOR_TIME_ZONE = "America/Denver";

/** Is this an IANA zone this runtime knows? */
export function isTimeZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || zone.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone.trim() });
    return true;
  } catch {
    return false;
  }
}

/**
 * The zone written the first time the estimator runs: the first of the hints
 * that names a real zone (ESTIMATOR_TIME_ZONE, then SCHEDULING_TIME_ZONE), else
 * Mountain Time.
 *
 * WHY WRITE ONE AT ALL. A business that never saved settings reads the
 * package's defaults, whose zone is UTC: a quote sent at 6 PM in Denver would
 * say it is good until a day later than the owner meant, and the date in the
 * email would disagree with the owner's own calendar.
 *
 * WHY ONLY THE ZONE. The row is written UNSAVED (no `saved_at`), so the admin
 * keeps asking the owner to set the business's name, tax rate and quote rules
 * — and the business name stays empty rather than the project's folder name:
 * an email that signs off with nothing is better than one signed "est03".
 */
export function firstEstimatorTimeZone(hints: readonly (string | null | undefined)[]): string {
  for (const hint of hints) {
    if (isTimeZone(hint)) return hint.trim();
  }
  return DEFAULT_ESTIMATOR_TIME_ZONE;
}

/**
 * The model that reads a customer's photo when ESTIMATOR_TAKEOFF_MODEL is
 * unset: Claude Haiku 4.5, the founder's choice of the cheapest capable model
 * ($1 / $5 per million tokens). The model only reports what it SEES (how many
 * steps, how tall they look); every number a customer is quoted is worked out
 * by the package's code. Equal to the package's DEFAULT_TAKEOFF_MODEL (a test
 * holds them together).
 */
export const DEFAULT_ESTIMATOR_TAKEOFF_MODEL = "claude-haiku-4-5";

/** ESTIMATOR_TAKEOFF_MODEL, or Haiku 4.5 when it is unset or blank. */
export function takeoffModelFor(configured: string | null | undefined): string {
  const model = configured?.trim();
  return model ? model : DEFAULT_ESTIMATOR_TAKEOFF_MODEL;
}

/**
 * The most a day of photo reading may cost ONE COMPANY on this site, in cents
 * (D14): $1.00.
 *
 * WHY A CEILING. In a companies project every company's photo reading spends
 * the PLATFORM's AI key — yours. Each owner sets their own daily budget in
 * Estimate settings, and without a ceiling one of them could set it to $1,000
 * and spend it on your bill. The estimator package applies
 * `min(the company's budget, this)` where the money is spent, and refuses a
 * save above it with "This site allows up to $1.00 a day of photo reading per
 * business." At Claude Haiku 4.5's prices one small reading costs about a
 * tenth of a cent, so $1 is several hundred photos a day per company.
 *
 * A single-business project doesn't pass it: there the owner IS the platform,
 * and their budget is theirs to set. Raise or lower it here.
 */
export const ESTIMATOR_AI_CEILING_CENTS = 100;

/**
 * The most a day of photo reading may cost the WHOLE SITE, every company
 * together, in cents: $5.00 (review SEC-2A-07).
 *
 * WHY A SECOND CEILING. The one above protects you from one company; this one
 * protects you from the sum of them. Anyone can sign up and make a company
 * here, so a dollar a day per company is a dollar for every company somebody
 * bothers to create. Once today's readings across the site would pass this,
 * every company's photo reading pauses until midnight UTC — customers are
 * asked to count the steps or items themselves, which they always can — and
 * the next day starts fresh. At about a tenth of a cent a reading, $5 is
 * several thousand photos a day. Raise it here as the site grows; the
 * estimator's Usage screen shows what each company spent.
 *
 * Companies projects only: a single business is the whole site.
 */
export const ESTIMATOR_AI_SITE_CEILING_CENTS = 500;

/**
 * How often one visitor may hit each part of the public API.
 *
 *   read       120 a minute   the business's products, a quote page
 *   calculate  120 a minute   the live price as a customer types
 *   photo       20 an hour    keeping a photo without reading it
 *   takeoff     10 an hour    reading a photo — the one that spends money
 *   submit       5 an hour    saving an estimate (a lead)
 *   respond     10 an hour    accepting or declining a quote
 *
 * The package also holds a per-business DAILY budget for photo reading and a
 * per-visitor daily count (Estimate settings), both counted in the database,
 * so they hold across serverless instances; these bound how fast a script can
 * try, and they count in Upstash when it is configured.
 */
export const ESTIMATOR_RATE_LIMITS: Readonly<
  Record<EstimatorRateLimitBucket, { readonly limit: number; readonly windowMs: number }>
> = {
  read: { limit: 120, windowMs: 60 * 1000 },
  calculate: { limit: 120, windowMs: 60 * 1000 },
  photo: { limit: 20, windowMs: 60 * 60 * 1000 },
  takeoff: { limit: 10, windowMs: 60 * 60 * 1000 },
  submit: { limit: 5, windowMs: 60 * 60 * 1000 },
  respond: { limit: 10, windowMs: 60 * 60 * 1000 },
};

/**
 * The buckets counted on the limiter that FAILS CLOSED (src/server/rate-limit.ts).
 *
 * Reading a photo calls a paid model, so "the limiter's store is down, let
 * everything through" is the expensive answer there — the customer is told to
 * count the steps themselves instead, which they always can. Every other
 * bucket fails open: a Redis outage must not take the estimate page down.
 */
export const ESTIMATOR_FAIL_CLOSED_BUCKETS: ReadonlySet<EstimatorRateLimitBucket> = new Set<EstimatorRateLimitBucket>([
  "takeoff",
]);

/**
 * Whether anything the office does reaches a customer — what the staff
 * screens are told (`delivery`), and the reason in plain words when not. Pure;
 * the facts come from src/server/estimator-notify.ts.
 */
export function estimatorDeliveryStatus(input: {
  readonly commsInstalled: boolean;
  readonly emailConfigured: boolean;
  readonly cronSecretSet: boolean;
  /**
   * Who reads it (review T2A-BO-05). "owner" (the default): the business owns
   * this deployment, so the note names the setting to fix. "company": one
   * company of many on someone else's site — it can't set an environment
   * variable, so it reads only what that means for it. The site's operator
   * sees the same gaps, with their fixes, on /setup.
   */
  readonly audience?: "owner" | "company";
}): EstimatorDelivery {
  const company = input.audience === "company";
  if (!input.commsInstalled) {
    return {
      emails: false,
      followUps: false,
      note: "This site was set up without customer emails, so leads and quotes aren't emailed. Copy the quote link to the customer yourself.",
    };
  }
  if (!input.emailConfigured) {
    return {
      emails: false,
      followUps: false,
      note: company
        ? "This site doesn't send email yet, so leads and quotes aren't emailed. Copy the quote link to the customer yourself."
        : "No email service is set up yet (RESEND_API_KEY), so leads and quotes aren't emailed.",
    };
  }
  if (!input.cronSecretSet) {
    return {
      emails: true,
      followUps: false,
      note: company
        ? "Follow-ups on unanswered quotes aren't switched on for this site yet, so follow up with customers yourself."
        : "Follow-ups on unanswered quotes go out from a daily job that isn't set up yet (CRON_SECRET).",
    };
  }
  return { emails: true, followUps: true, note: null };
}

/** The public pages, as paths. The emails, the staff screens and the nav all build links from these. */
export const ESTIMATE_PAGE_PATH = "/estimate";
export const QUOTE_PAGE_PATH = "/quote";
export const ESTIMATES_ADMIN_PATH = "/admin/estimates";
export const PUBLIC_ESTIMATOR_API_PATH = "/api/estimator";
export const ADMIN_ESTIMATOR_API_PATH = "/api/admin/estimator";

/**
 * Absolute links on this deployment.
 *
 * ABSOLUTE because they leave the site: an email link that says "/quote/abc"
 * is not a link in an inbox, and the embed snippet is pasted into another
 * website. Built with `new URL` against the app's own address, so a base with
 * or without a trailing slash, or with a path, joins the same way.
 *
 * The quote token is the customer's whole key to their quote — anybody
 * holding it can accept. It goes into the path, encoded, and nowhere else.
 */
export function estimatorLinks(appUrl: string) {
  const base = appUrl.endsWith("/") ? appUrl : `${appUrl}/`;
  const at = (path: string) => new URL(path, base).toString();
  return {
    estimatePage: at(ESTIMATE_PAGE_PATH.slice(1)),
    quote: (token: string) => at(`${QUOTE_PAGE_PATH.slice(1)}/${encodeURIComponent(token)}`),
    adminEstimates: at(ESTIMATES_ADMIN_PATH.slice(1)),
    adminEstimate: (estimateId: string) => at(`${ESTIMATES_ADMIN_PATH.slice(1)}/${encodeURIComponent(estimateId)}`),
    /** What the embed snippet in Estimate settings points another website at. */
    embedBase: at(PUBLIC_ESTIMATOR_API_PATH.slice(1)),
    /** With scheduling: the booking page, tied to the estimate. */
    bookVisit: (estimateId: string) => at(`book-visit?estimate=${encodeURIComponent(estimateId)}`),
    /** With scheduling: the staff calendar, for "this visit" links. */
    scheduleAdmin: at("admin/schedule"),
  };
}

/** A visit's status, as a person says it. */
const VISIT_STATUS_WORDS: Readonly<Record<string, string>> = {
  pending: "requested",
  confirmed: "confirmed",
  in_progress: "in progress",
  completed: "done",
  cancelled: "cancelled",
  declined: "declined",
  expired: "not confirmed in time",
  no_show: "no-show",
};

/** "09:30" → "9:30 AM", for a visit written before scheduling stored its start instant. */
function clockText(time: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) return time;
  const hour = Number(match[1]);
  const suffix = hour >= 12 ? "PM" : "AM";
  return `${hour % 12 === 0 ? 12 : hour % 12}:${match[2]} ${suffix}`;
}

/**
 * One visit booked from an estimate, as the estimate editor lists it: when, in
 * the BUSINESS'S zone ("Mon, Nov 2, 9:00 AM MST" — never the browser's or the
 * server's), its status in words, and a link that opens the staff calendar on
 * that day.
 *
 * `scheduledDate` is scheduling's calendar-date label (the business's date as
 * UTC midnight), so its ISO date IS the day to open; `startsAt` is the real
 * instant (null only on a visit scheduling 0.3 wrote and never backfilled).
 */
export function linkedVisit(
  row: {
    readonly id: string;
    readonly status: string;
    readonly startsAt: Date | null;
    readonly scheduledDate: Date;
    readonly startTime: string;
  },
  timeZone: string,
  scheduleAdminUrl: string,
): LinkedVisit {
  const day = row.scheduledDate.toISOString().slice(0, 10);
  const zone = isTimeZone(timeZone) ? timeZone : DEFAULT_ESTIMATOR_TIME_ZONE;
  const when = row.startsAt
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(row.startsAt)
    : `${new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(row.scheduledDate)}, ${clockText(row.startTime)}`;
  const url = new URL(scheduleAdminUrl);
  url.searchParams.set("date", day);
  return {
    id: row.id,
    when,
    status: VISIT_STATUS_WORDS[row.status] ?? row.status.replace(/_/g, " "),
    url: url.toString(),
  };
}
