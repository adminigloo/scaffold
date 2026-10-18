/**
 * The Tenancy 2b-4c renderers for BOOK A CALL (--booking, @adminigloo/booking
 * 0.2 and booking-widget 0.2), per mode:
 *
 *   src/server/booking.ts                  the glue: whose calls a route is,
 *                                          who may take calls (the company's
 *                                          own people), its plan's people
 *                                          taking calls, the open/closed gate,
 *                                          the emails (with --email) and the
 *                                          daily job
 *   app/api/cron/booking/route.ts          reminders and the hold clean-up,
 *                                          inside the 50-second budget
 *   src/components/CallsAdmin.tsx          the package's calls screen over the
 *                                          admin routes
 *
 *   companies   /app/calls over /api/app/{id}/calls (the id in the PATH,
 *               asked every call), and /t/{web address}/book with its manage
 *               page over /api/t/{web address}/calls
 *   single      /admin/calls over /api/admin/calls (staff keys), and /book
 *               with its manage page over /api/calls
 *
 * No emitted `if` asks about an answer: each file is written per mode and per
 * feature set; the `if`s that ARE emitted are about runtime data (a key that
 * isn't set, a company that isn't taking bookings, a reminder already sent).
 */

import { tenantLabel, type Answers } from "./answers.js";
import { plansEnforced } from "./plans-emit.js";
import { companiesMode } from "./tenancy-emit.js";

/** "People taking calls" is sold only where plans are enforced and booking exists. */
export function bookingHostsQuota(answers: Answers): boolean {
  return plansEnforced(answers) && answers.includeBooking;
}

/** Every file booking writes, by path (POSIX separators; emit.ts joins them). */
export function bookingFiles(answers: Answers): ReadonlyArray<readonly [string, string]> {
  const companies = companiesMode(answers);
  const files: Array<readonly [string, string]> = [
    ["src/server/booking.ts", renderBookingGlue(answers)],
    ["app/api/cron/booking/route.ts", renderBookingCron(answers)],
    ["src/components/CallsAdmin.tsx", renderCallsAdmin(answers)],
  ];
  if (companies) {
    files.push(
      ["app/api/app/[tenantId]/calls/[...path]/route.ts", adminRoute(answers)],
      ["app/api/t/[slug]/calls/[...path]/route.ts", publicRoute(answers)],
      ["app/(site)/app/calls/page.tsx", renderCompanyCallsPage(answers)],
      ["app/(company)/t/[slug]/book/page.tsx", renderCompanyBookPage(answers)],
      ["app/(company)/t/[slug]/book/manage/[token]/page.tsx", renderCompanyManagePage(answers)],
    );
  } else {
    files.push(
      ["app/api/admin/calls/[...path]/route.ts", adminRoute(answers)],
      ["app/api/calls/[...path]/route.ts", publicRoute(answers)],
      ["app/admin/calls/page.tsx", renderAdminCallsPage(answers)],
      ["app/(site)/book/page.tsx", renderSingleBookPage(answers)],
      ["app/(site)/book/manage/[token]/page.tsx", renderSingleManagePage(answers)],
    );
  }
  return files;
}

// ---------------------------------------------------------------------------
// src/server/booking.ts
// ---------------------------------------------------------------------------

const RATE_LIMITS = `/**
 * How often one visitor may use the booking page's API, on the shared
 * limiter, by the caller's address as the nearest proxy saw it:
 *
 *   read     120 a minute      the page, the times, the manage page
 *   hold      20 in 10 minutes picking times
 *   book      10 an hour       sending the form
 *   manage    60 in 10 minutes cancel, move, the calendar file
 *
 * On top of the package's own caps: 2 times held per visitor, 30 held per
 * business at once, 50 bookings per business a day, and the form's honeypot.
 */
const BOOKING_RATE_LIMITS = {
  read: { limit: 120, windowMs: 60_000 },
  hold: { limit: 20, windowMs: 10 * 60_000 },
  book: { limit: 10, windowMs: 60 * 60_000 },
  manage: { limit: 60, windowMs: 10 * 60_000 },
} as const;

/**
 * The caller as the NEAREST proxy saw it: the last X-Forwarded-For entry (on
 * Vercel, the address its edge saw), an IPv6 address by its /64 (one machine
 * holds a whole /64 to rotate through). Null with no proxy in front (a
 * laptop, the project's own tests): ONE shared "unknown" caller, never unlimited.
 */
function callerKey(req: Request): string | null {
  const entries = (req.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const last = entries.at(-1);
  return last ? networkKeyOf(last) : null;
}

async function bookingRateLimit(req: Request, bucket: RateLimitBucket): Promise<boolean> {
  // No forwarded address (a laptop, a proxy that forwards nothing): ONE shared "unknown" caller, never unlimited.
  const caller = callerKey(req) ?? "unknown";
  return (await limiter.limit({ key: \`booking:\${bucket}:\${caller}\`, policy: BOOKING_RATE_LIMITS[bucket] })).allowed;
}`;

function renderBookingGlue(answers: Answers): string {
  const scope = answers.scope;
  const companies = companiesMode(answers);
  const email = answers.includeEmail;
  const noun = tenantLabel(answers).toLowerCase();
  const pkg = [
    "claimReminder",
    "createBookingAdminHandlers",
    "createBookingPublicHandlers",
    "createIcsBusySource",
    "dueReminders",
    "networkKeyOf",
    "purgeExpiredHolds",
    "releaseReminder",
    ...(email && !companies ? ["bookingEmailTemplate", "bookingEmailVars", "renderBookingTemplate"] : []),
    ...(email && companies ? ["platformBookingEmails"] : []),
    "type BookingEvent",
    "type BookingPermission",
    "type CreateBookingAdminHandlersOptions",
    "type CreateBookingHandlersOptions",
    ...(email ? ["type DueReminder"] : []),
    ...(companies ? ["type HostMembers"] : []),
    "type RateLimitBucket",
  ];
  const imports = [
    `import {\n${pkg.map((name) => `  ${name},`).join("\n")}\n} from "${scope}/booking";`,
    ...(email ? [`import { createEmailSender } from "${scope}/email";`, `import { emailEvents } from "${scope}/email/schema";`] : []),
    ...(companies ? [`import { createPublicCompanySeams, runForEachCompany } from "${scope}/tenancy/server";`] : []),
    `import { db } from "@/db";`,
    `import { env } from "@/env";`,
    ...(email ? [`import { SITE_NAME } from "@/seo";`] : []),
    ...(companies
      ? [
          `import { admitPublic, companyAuthorizer, companyRoutes, resolvePublicTenant, type FeatureHandlerOverrides } from "@/server/company-routes";`,
          `import { companyLinksFor } from "@/server/company-links";`,
        ]
      : []),
    ...(answers.includeCustomers ? [`import { customerOnBookingEvent } from "@/server/customer-activity";`] : []),
    `import { reportError } from "@/server/error-reporter";`,
    ...(email ? [`import { log } from "@/server/logger";`] : []),
    ...(companies ? [`import { bookingHostLimit${email ? ", companyOnTrial" : ""} } from "@/server/plan-gate";`] : []),
    `import { ${companies && email ? "failClosedLimiter, " : ""}limiter } from "@/server/rate-limit";`,
    ...(companies ? [] : [`import { authorizeStaffFor } from "@/server/staff-access";`]),
    ...(companies ? [`import { tenancy } from "@/server/tenancy";`] : []),
  ];

  const base = `
/** This deployment's address, without a trailing slash (links in emails, the feed). */
function appUrl(): string {
  return (env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\\/+$/, "");
}

/** The .ics UID domain: this deployment's host. Keep NEXT_PUBLIC_APP_URL stable once calls are booked. */
function uidDomain(): string {
  try {
    return new URL(appUrl()).hostname || "localhost";
  } catch {
    return "localhost";
  }
}

/**
 * A host's real calendar, read through its secret iCal address: only public
 * addresses, connected to the address that was checked, every redirect
 * re-checked, 5 MB and 5 seconds at most, five minutes' cache.
 */
const busySource = createIcsBusySource();

/** An error the handlers didn't expect: a fixed sentence for the caller, the error in /admin/errors. */
export function reportBookingError(error: unknown, context: { tenantId: string | null; route: string }): void {
  void reportError({ error, source: "route", tenantId: context.tenantId, context: { feature: "booking", route: context.route } });
}
`;

  const mail = email
    ? `
/**
 * EMAIL THROUGH ${scope}/email (Resend). With no RESEND_API_KEY every send is
 * "skipped" and the booking page stops promising an email
 * (\`bookingEmailsConfigured\`). EMAIL_FROM is deferred until deployment; the
 * fallback is a reserved domain that can never receive anything.
 */
const mailer = createEmailSender({
  apiKey: env.RESEND_API_KEY,
  from: env.EMAIL_FROM ?? "calls@example.invalid",${companies ? `
  // No site-wide Reply-To: every message names its own (the ${noun} owner's
  // verified sign-in address, or the person who booked), and one with none
  // gets none — never this site's.` : `
  replyTo: env.EMAIL_REPLY_TO,`}
});

/** Whether a booking email would really leave. The booking page and the calls screen read it. */
export const bookingEmailsConfigured: boolean = mailer.configured;
${
  companies
    ? `
/**
 * A ${noun} ON A FREE TRIAL sends at most 20 booking emails a day: anyone can
 * start a trial, and every ${noun}'s email leaves from this site's one sending
 * domain. Counted on the shared limiter, failing closed.
 */
const TRIAL_EMAIL_POLICY = { limit: 20, windowMs: 24 * 60 * 60_000 } as const;
`
    : ""
}
/** How one email went: "held" is a ${companies ? `trial ${noun}'s` : "day's"} allowance reached. */
type Delivery = "sent" | "skipped" | "failed" | "held";

async function deliver(input: {
  readonly tenantId: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  readonly template: string;
  readonly fromName: string;
  readonly replyTo: string | null;
}): Promise<Delivery> {${
        companies
          ? `
  if (await companyOnTrial(input.tenantId)) {
    const verdict = await failClosedLimiter.limit({ key: \`booking-mail:\${input.tenantId}\`, policy: TRIAL_EMAIL_POLICY });
    if (!verdict.allowed) {
      log.warn({ tenantId: input.tenantId, template: input.template }, "booking: a trial ${noun} reached its 20 booking emails today; this one is held");
      return "held";
    }
  }`
          : ""
      }
  const outcome = await mailer.send({
    to: input.to,
    subject: input.subject,
    text: input.text,
    ...(input.html ? { html: input.html } : {}),
    template: input.template,
    tenantId: input.tenantId,
    fromName: input.fromName,
    replyTo: input.replyTo,
  });
  try {
    await db.insert(emailEvents).values(outcome.log);
  } catch (error) {
    log.error({ err: error instanceof Error ? error.message : String(error), template: input.template }, "booking: an email's delivery couldn't be recorded");
  }
  if (outcome.status === "failed") reportBookingError(outcome.error, { tenantId: input.tenantId, route: "email" });
  return outcome.status;
}
${
  companies
    ? `
/**
 * Where a customer's replies go: the ${noun} OWNER'S sign-in address — the one
 * address here that is verified (they signed in with it). Never the contact
 * email a ${noun} typed into its settings, which nothing checks.
 */
async function ownerAddress(tenantId: string): Promise<string | null> {
  const people = await tenancy.listMemberPeople(tenantId);
  return people.find((person) => person.roleKey === "owner")?.email ?? null;
}

/**
 * THE BOOKING EMAILS, AS A PLATFORM SENDS THEM (${scope}/booking's
 * platformBookingEmails): From "{${noun}} via {this site}", a fixed subject
 * with the ${noun}'s cleaned name, the call type only as quoted text in the
 * body, a meeting link a button only on a known meeting service, replies to
 * the owner's verified address, and "Sent for {${noun}} by {this site}." The
 * confirmation carries the private link (sent now, never queued); the
 * reminder carries none (only its hash is kept). Answers whether the
 * customer's email went (the reminder job retries one that didn't).
 */
export async function sendBookingEmails(event: BookingEvent | DueReminder): Promise<boolean> {
  const profile = await tenancy.companyProfile(event.tenantId);
  if (!profile) return false;
  const links = companyLinksFor(profile.slug);
  const mail = platformBookingEmails(event, {
    baseUrl: appUrl(),
    includeManageLink: event.event !== "booking.reminder",
    manageUrl: (token) => \`\${links.home}/book/manage/\${encodeURIComponent(token)}\`,
    apiBase: \`/api/t/\${encodeURIComponent(profile.slug)}/calls\`,
    bookUrl: \`\${links.home}/book\`,
    adminUrl: links.app("/app/calls"),
    businessName: profile.name,
    appName: SITE_NAME,
    replyTo: await ownerAddress(event.tenantId),
  });
  let customer: Delivery = "sent";
  if (mail.invitee) customer = await deliver({ tenantId: event.tenantId, ...mail.invitee, template: \`booking:\${event.event}\`, fromName: mail.fromName });
  if (mail.host) await deliver({ tenantId: event.tenantId, ...mail.host, template: "booking:host_notice", fromName: mail.fromName });
  return customer === "sent";
}
`
    : `
/**
 * THE BOOKING EMAILS, for the one business: the confirmation (with the
 * private link — sent now, never queued), a move, a cancel, the host's
 * notice, and the reminder (with no link: only its hash is kept), signed by
 * the host and the business. Answers whether the customer's email went (the
 * reminder job retries one that didn't).
 */
export async function sendBookingEmails(event: BookingEvent | DueReminder): Promise<boolean> {
  const mail = bookingEmailVars(event, {
    baseUrl: appUrl(),
    includeManageLink: event.event !== "booking.reminder",
    manageUrl: (token) => \`\${appUrl()}/book/manage/\${encodeURIComponent(token)}\`,
    apiBase: "/api/calls",
    bookUrl: \`\${appUrl()}/book\`,
    adminUrl: \`\${appUrl()}/admin/calls\`,
    businessName: SITE_NAME,
    replyTo: env.EMAIL_REPLY_TO ?? null,
  });
  const send = (key: Parameters<typeof bookingEmailTemplate>[0], to: string, vars: Record<string, string>, replyTo: string | null) => {
    const { subject, body } = renderBookingTemplate(bookingEmailTemplate(key), vars);
    return deliver({ tenantId: event.tenantId, to, subject, text: body, template: \`booking:\${key}\`, fromName: mail.fromName, replyTo });
  };
  let customer: Delivery = "sent";
  if (mail.templateFor.invitee && mail.to.invitee) customer = await send(mail.templateFor.invitee, mail.to.invitee, mail.invitee, mail.replyTo.invitee);
  if (mail.templateFor.host) await send(mail.templateFor.host, mail.to.host, mail.host, mail.replyTo.host);
  return customer === "sent";
}
`
}`
    : `
/**
 * NO EMAIL SENDER: ${answers.projectName} was generated without ${scope}/email,
 * so nobody is emailed about a call — the booking page says so instead of
 * promising one, and the confirmation page's private link is the one to keep.
 * \`create-app add email\` wires Resend in.
 */
export const bookingEmailsConfigured: boolean = false;
`;
  // The customer list first (create-app 0.35: the call on its caller's
  // timeline), then the emails. Both contained by the package.
  const bookingListeners = [...(answers.includeCustomers ? ["await customerOnBookingEvent(event);"] : []), ...(email ? ["await sendBookingEmails(event);"] : [])];
  const onEvent =
    bookingListeners.length > 0 ? `\n    onEvent: async (event) => {\n${bookingListeners.map((line) => `      ${line}`).join("\n")}\n    },` : "";

  const company = companies
    ? `
/** The ${noun}'s active members, as people (tenancy's own list). */
async function teamOf(tenantId: string) {
  return (await tenancy.listMemberPeople(tenantId)).flatMap((person) =>
    person.email ? [{ userId: person.userId, name: person.name?.trim() || person.email, email: person.email }] : [],
  );
}

/**
 * Is this email one of the ${noun}'s own people (an active member with a
 * sign-in)? A host must be: their user id is kept on the host. Anyone else is
 * refused in words ("invite them first").
 */
async function teamMember(tenantId: string, email: string): Promise<{ userId: string } | null> {
  const found = (await teamOf(tenantId)).find((person) => person.email.toLowerCase() === email);
  return found ? { userId: found.userId } : null;
}

/**
 * Which hosts' people are still active members, asked at every slot list,
 * booking and feed: someone who left the ${noun} is off at once, whatever their
 * card says — no times offered, no notices, their feed "not found".
 */
const stillMembers: HostMembers = async (tenantId, userIds) => {
  const members = new Set((await tenancy.listMemberPeople(tenantId)).map((person) => person.userId));
  return new Set(userIds.filter((id) => members.has(id)));
};

/**
 * A ${noun}'s calls, for its own people (/app/calls over /api/app/{${noun} id}/calls):
 * booking.calls.view to read, .calls.manage to confirm, move and cancel,
 * .availability.manage for hours and holidays, .settings.manage for who takes
 * calls and the call types. Another ${noun}'s booking, host or call type is "not
 * found". \`overrides\` is how the project's isolation proof calls it as
 * somebody else.
 */
export function buildBookingAdminHandlers(overrides: FeatureHandlerOverrides = {}) {
  const options: CreateBookingAdminHandlersOptions = {
    db,
    resolveTenant: companyRoutes.resolveTenant,
    authorize: companyAuthorizer(overrides),
    member: teamMember,
    // "Add a person" picks from the team (no typing an exact email).
    listMembers: teamOf,
    hostMembers: stillMembers,
    // Its plan's people taking calls (src/plans.ts); none when the plan doesn't say.
    hostLimit: (tenantId) => bookingHostLimit(tenantId),
    feedUrl: async (token, tenantId) => {
      const profile = await tenancy.companyProfile(tenantId);
      const httpsUrl = \`\${appUrl()}/api/t/\${encodeURIComponent(profile?.slug ?? "")}/calls/v1/feed/\${encodeURIComponent(token)}.ics\`;
      return { httpsUrl, webcalUrl: httpsUrl.replace(/^https?:/, "webcal:") };
    },
    busySource,${onEvent}
    onError: reportBookingError,
  };
  return createBookingAdminHandlers(options);
}

/**
 * The links a ${noun} already sent stay open while its plan is closed — the
 * manage page, cancel, reschedule, the calendar file, a host's feed — so its
 * customers can still cancel or move what they booked. This gate asks only
 * "is it suspended?" (no plan), which closes them too.
 */
const sentLinks = createPublicCompanySeams({ tenancy });

/** The web address in /api/t/{web address}/calls/…, for the links the handlers build. */
function slugInPath(req: Request): string {
  try {
    return decodeURIComponent(new URL(req.url).pathname.split("/")[3] ?? "");
  } catch {
    return "";
  }
}

function publicOptions(slug: string): CreateBookingHandlersOptions {
  const home = companyLinksFor(slug).home;
  return {
    db,
    resolveTenant: resolvePublicTenant,
    // New bookings: not for a suspended ${noun}, nor one whose plan ended — in its own words.
    admit: admitPublic,
    admitExisting: (tenantId, req) => sentLinks.admit(tenantId, req),
    hostMembers: stillMembers,
    busySource,${onEvent}
    rateLimit: bookingRateLimit,
    holdSubject: callerKey,
    uidDomain: uidDomain(),
    manageUrl: (token) => \`\${home}/book/manage/\${encodeURIComponent(token)}\`,
    emailsEnabled: bookingEmailsConfigured,
  };
}

/**
 * A ${noun}'s booking page's API (/t/{web address}/book over
 * /api/t/{web address}/calls): the ${noun} whose web address is in the path, its
 * first-time setup, and whether it takes new bookings. A call type, hold,
 * manage link or feed of another ${noun}'s is "not found" here.
 */
export function buildBookingPublicHandlers() {
  return {
    handle: (req: Request) => createBookingPublicHandlers(publicOptions(slugInPath(req))).handle(req),
  };
}
`
    : `
/** The one business's calls: every booking row of this project is written for it. */
export const BOOKING_TENANT = "primary";

/**
 * THE staff keys the calls are asked against: the package's own four, on the
 * staff ladder (admin, cs_lead, cs_agent — see src/permissions).
 */
const BOOKING_STAFF_KEYS: Readonly<Record<BookingPermission, string>> = {
  "booking.calls.view": "booking.calls.view",
  "booking.calls.manage": "booking.calls.manage",
  "booking.availability.manage": "booking.availability.manage",
  "booking.settings.manage": "booking.settings.manage",
};

/** The calls, for this business's staff (/admin/calls over /api/admin/calls). */
export function buildBookingAdminHandlers() {
  const options: CreateBookingAdminHandlersOptions = {
    db,
    tenantId: BOOKING_TENANT,
    authorize: authorizeStaffFor(BOOKING_STAFF_KEYS, "Sign in to see the calls."),
    feedUrl: (token) => {
      const httpsUrl = \`\${appUrl()}/api/calls/v1/feed/\${encodeURIComponent(token)}.ics\`;
      return { httpsUrl, webcalUrl: httpsUrl.replace(/^https?:/, "webcal:") };
    },
    busySource,${onEvent}
    onError: reportBookingError,
  };
  return createBookingAdminHandlers(options);
}

/** The booking page's API (/book over /api/calls). */
export function buildBookingPublicHandlers() {
  return createBookingPublicHandlers({
    db,
    tenantId: BOOKING_TENANT,
    busySource,${onEvent}
    rateLimit: bookingRateLimit,
    holdSubject: callerKey,
    uidDomain: uidDomain(),
    manageUrl: (token) => \`\${appUrl()}/book/manage/\${encodeURIComponent(token)}\`,
    emailsEnabled: bookingEmailsConfigured,
  });
}
`;

  const reminders = email
    ? `
/**
 * One business's reminders: claimed before sending (at most once), the
 * soonest first, while a whole send and a margin still fit. A send that
 * failed or was held gives its claim back (counted), and is tried again by a
 * later run, three times at most.
 */
async function remindersFor(tenantId: string, deadline: number): Promise<number> {
  const ctx = { db, tenantId };
  let sent = 0;
  for (const due of await dueReminders(ctx, { withinMs: REMINDER_WINDOW_MS, limit: 100 })) {
    if (Date.now() > deadline - EMAIL_SEND_MS - CRON_MARGIN_MS) break;
    if (!(await claimReminder(ctx, due.booking.id))) continue;
    let went = false;
    try {
      went = await sendBookingEmails(due);
    } catch (error) {
      reportBookingError(error, { tenantId, route: "cron" });
    }
    if (went) sent += 1;
    else await releaseReminder(ctx, due.booking.id);
  }
  return sent;
}
`
    : `
/** No email in this project: nothing to remind with. Kept so the job's shape is the same. */
async function remindersFor(_tenantId: string, _deadline: number): Promise<number> {
  void dueReminders;
  void claimReminder;
  void releaseReminder;
  return 0;
}
`;

  return `${imports.join("\n")}

/**
 * The app's side of ${scope}/booking — BOOK A CALL (Tenancy 2b-4c). ${
    companies
      ? `Each ${noun} takes
 * its own calls: its own people take them, in their own hours and time zones,
 * with its own holidays and call types, on its own booking page
 * (/t/{web address}/book). Another ${noun}'s calls are "not found" everywhere.`
      : `One business
 * takes calls: its staff work them at /admin/calls, customers book at /book.`
  }
 */
${base}${RATE_LIMITS}
${mail}${company}
/**
 * THE DAILY JOB'S CLOCK (app/api/cron/booking). The route has 60 seconds; the
 * run ends by 50, timed from the moment it starts.
 */
const CRON_BUDGET_MS = 50_000;
const CRON_MARGIN_MS = 2_000;
/** The longest one email may take to hand over: no reminder is started unless it and the margin fit (so the run ends by 50 s). */
const EMAIL_SEND_MS = 10_000;
/** Calls starting within this get their reminder (the job runs daily, so about a day ahead). */
const REMINDER_WINDOW_MS = 30 * 60 * 60_000;
${reminders}
/**
 * The daily job: abandoned holds older than an hour deleted (they already
 * free their time when they expire; this keeps the table small), then each
 * ${companies ? `active ${noun}'s` : "business's"} reminders for the calls in the next day.${companies ? `
 * The starting ${noun} differs every run; one ${noun}'s failure doesn't stop the
 * rest.` : ""}
 */
export async function runBookingCron() {
  const deadline = Date.now() + CRON_BUDGET_MS;
  const purged = await purgeExpiredHolds(db, { olderThan: new Date(Date.now() - 60 * 60_000) });${
    companies
      ? `
  const companies = await runForEachCompany(tenancy, (tenantId) => remindersFor(tenantId, deadline), {
    timeBudgetMs: Math.max(0, deadline - Date.now() - EMAIL_SEND_MS - CRON_MARGIN_MS),
    concurrency: 2,
    onError: (error, tenantId) => reportBookingError(error, { tenantId, route: "cron" }),
  });
  return {
    purged: purged.deleted,
    reminded: companies.ran.reduce((sum, run) => sum + run.result, 0),
    companies: { ran: companies.ran.length, failed: companies.failed.length, waiting: companies.deferred.length },
  };`
      : `
  return { purged: purged.deleted, reminded: await remindersFor(BOOKING_TENANT, deadline) };`
  }
}
`;
}

// ---------------------------------------------------------------------------
// The cron and the route files
// ---------------------------------------------------------------------------

function renderBookingCron(answers: Answers): string {
  const companies = companiesMode(answers);
  const noun = tenantLabel(answers).toLowerCase();
  return `import { NextResponse } from "next/server";
import { env } from "@/env";
import { runBookingCron } from "@/server/booking";
import { log } from "@/server/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The daily calls job (Tenancy 2b-4c): abandoned holds cleared, and ${companies ? `each active
 * ${noun}'s` : "the"} reminders for tomorrow's calls sent${answers.includeEmail ? "" : " (none in this project: it has no email)"} — each at most once, ending by
 * 50 seconds.
 *
 * SCHEDULED IN vercel.json (daily); refuses every call while CRON_SECRET is unset.
 */
async function handle(request: Request): Promise<Response> {
  const secret = env.CRON_SECRET;
  const provided =
    request.headers.get("x-cron-secret") ??
    request.headers.get("authorization")?.replace(/^Bearer\\s+/i, "");
  if (!secret || provided !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await runBookingCron();
  log.info({ result }, "booking cron: ran");
  return NextResponse.json({ ok: true, ...result });
}

export const GET = handle;
export const POST = handle;
`;
}

function adminRoute(answers: Answers): string {
  const companies = companiesMode(answers);
  const noun = tenantLabel(answers).toLowerCase();
  return `import { buildBookingAdminHandlers } from "@/server/booking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ${companies ? `A ${noun}'s calls: /app/calls calls /api/app/{${noun} id}/calls/v1/…` : "The calls: /admin/calls calls /api/admin/calls/v1/…"} —
 * bookings, the people taking calls, their hours and time off, holidays and
 * call types (${"@adminigloo/booking"}'s BOOKING_ADMIN_ROUTES).
 *
 * ${companies ? `THE ${noun.toUpperCase()} IS THE ONE IN THE PATH, asked on every call; another ${noun}'s booking, host or call type is "not found".` : "On the staff ladder (booking.calls.view to read, and one key per kind of change), asked on every call."} Never cross-origin.
 */
const { handle } = buildBookingAdminHandlers();

export const GET = handle;
export const POST = handle;
`;
}

function publicRoute(answers: Answers): string {
  const companies = companiesMode(answers);
  const noun = tenantLabel(answers).toLowerCase();
  return `import { buildBookingPublicHandlers } from "@/server/booking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ${companies ? `A ${noun}'s booking page API: /t/{web address}/book calls /api/t/{web address}/calls/v1/…` : "The booking page API: /book calls /api/calls/v1/…"} —
 * the call types, open times, holds, the booking, the private manage link
 * (cancel, move, the calendar file) and a host's calendar feed.
 *${companies ? `
 * The web address names the ${noun}. A suspended ${noun}, or one whose plan ended,
 * takes no new booking (it says so by name); the links it already sent keep
 * working while its plan is closed.
 *` : ""}
 * Token routes answer with no-referrer and noindex. A cross-site POST is refused.
 */
const { handle } = buildBookingPublicHandlers();

export const GET = handle;
export const POST = handle;
export const OPTIONS = handle;
`;
}

// ---------------------------------------------------------------------------
// The screens
// ---------------------------------------------------------------------------

function renderCallsAdmin(answers: Answers): string {
  return `"use client";

import { useMemo } from "react";
import { BookingAdmin, createBookingAdminFetchAdapter } from "${answers.scope}/booking-widget/admin";

/**
 * The calls screen (Tenancy 2b-4c), the same for ${companiesMode(answers) ? "every company's /app/calls" : "/admin/calls"}: upcoming
 * and past calls (confirm, move, cancel, how it went), when people can book
 * (the week, time off, holidays), and who takes calls, their calendars and
 * the call types — the package's screen over the routes it is given, so a
 * fix reaches this project with \`pnpm update\`.
 */
export function CallsAdmin(props: { readonly baseUrl: string; readonly bookingPageUrl: string; readonly emailsEnabled: boolean }) {
  const adapter = useMemo(
    () => createBookingAdminFetchAdapter({ baseUrl: props.baseUrl, emailsEnabled: props.emailsEnabled }),
    [props.baseUrl, props.emailsEnabled],
  );
  return <BookingAdmin adapter={adapter} bookingPageUrl={props.bookingPageUrl} title="Calls" />;
}
`;
}

function renderCompanyCallsPage(answers: Answers): string {
  const noun = tenantLabel(answers).toLowerCase();
  return `import { CallsAdmin } from "@/components/CallsAdmin";
import { CompanyGate } from "@/components/CompanyGate";
import { bookingEmailsConfigured } from "@/server/booking";

export const dynamic = "force-dynamic";

/**
 * The ${noun}'s calls (Tenancy 2b-4c): the calls people booked on its booking
 * page, its people's hours and time off, its holidays and its call types —
 * all of them its own, through /api/app/{id}/calls, which checks the person's
 * permission on every call.
 */
export default async function CompanyCallsPage() {
  return (
    <CompanyGate path="/app/calls" permission="booking.calls.view">
      {({ company }) => (
        <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
          <CallsAdmin baseUrl={\`/api/app/\${company.id}/calls\`} bookingPageUrl={\`\${company.publicPath}/book\`} emailsEnabled={bookingEmailsConfigured} />
        </main>
      )}
    </CompanyGate>
  );
}
`;
}

function renderCompanyBookPage(answers: Answers): string {
  const scope = answers.scope;
  const noun = tenantLabel(answers).toLowerCase();
  return `import type { Metadata } from "next";
import { BookingWidget } from "${scope}/booking-widget";
import { PublicCompanyGate, publicCompanyMetadata } from "@/components/PublicCompanyGate";

/** The tab title and link preview are the ${noun}'s: "Book a call · {name}", never this site's name. */
export async function generateMetadata({ params }: { readonly params: Promise<{ readonly slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  return publicCompanyMetadata(slug, "Book a call", { path: "/book" });
}

export const dynamic = "force-dynamic";

/**
 * A ${noun}'s booking page (Tenancy 2b-4c): its customers pick a call type, a
 * day and a time in their own time zone, hold it while they fill in their
 * details, and get a confirmation with calendar links and a private link to
 * move or cancel. The ${noun}'s name, logo and colour head it; a suspended
 * ${noun}, or one whose plan ended, says it isn't taking bookings, by name.
 */
export default async function CompanyBookPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly slug: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  return (
    <PublicCompanyGate slug={slug} path="/book" query={query}>
      {(company) => (
        <section className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold text-ink">Book a call with {company.name}</h1>
          <BookingWidget baseUrl={\`/api/t/\${company.slug}/calls\`} />
        </section>
      )}
    </PublicCompanyGate>
  );
}
`;
}

function renderCompanyManagePage(answers: Answers): string {
  const scope = answers.scope;
  const noun = tenantLabel(answers).toLowerCase();
  return `import type { Metadata } from "next";
import { ManageBooking } from "${scope}/booking-widget";
import { PublicCompanyGate, publicCompanyMetadata } from "@/components/PublicCompanyGate";

/**
 * Never indexed, and never handing its address to the next site: the token in
 * this URL is the customer's whole key to their call. The tab title is the
 * ${noun}'s: "Your call · {name}".
 */
export async function generateMetadata({ params }: { readonly params: Promise<{ readonly slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  return publicCompanyMetadata(slug, "Your call", { noReferrer: true });
}

export const dynamic = "force-dynamic";

/**
 * The page behind the link in every booking email from a ${noun}: the call in
 * plain words, with Reschedule and Cancel while it's still ahead. Read INSIDE
 * the ${noun} whose web address is in the URL — a link from another ${noun}'s
 * email says "not found" here. Nothing is looked up on the server: the widget
 * reads it in the browser, so a link previewer learns nothing and changes
 * nothing.
 */
export default async function CompanyManageCallPage({
  params,
}: {
  readonly params: Promise<{ readonly slug: string; readonly token: string }>;
}) {
  const { slug, token } = await params;
  return (
    <PublicCompanyGate slug={slug} path={\`/book/manage/\${encodeURIComponent(token)}\`}>
      {(company) => <ManageBooking baseUrl={\`/api/t/\${company.slug}/calls\`} token={token} realBookingHref={\`\${company.publicPath}/book\`} />}
    </PublicCompanyGate>
  );
}
`;
}

function renderAdminCallsPage(answers: Answers): string {
  const scope = answers.scope;
  return `import { isDbConfigured } from "${scope}/db";
import { db } from "@/db";
import { CallsAdmin } from "@/components/CallsAdmin";
import { EmptyState, Notice, PageHeader } from "@/components/ui";
import { currentPrincipal } from "@/server/auth";
import { bookingEmailsConfigured } from "@/server/booking";
import { loadStaffPermissions } from "@/server/permissions";

export const dynamic = "force-dynamic";

/**
 * THE CALLS (Tenancy 2b-4c): the calls people booked at /book, the hours and
 * time off of whoever takes them, the holidays and the call types. The
 * package's screen over /api/admin/calls; the page checks the staff key first
 * so someone without it gets a sentence, and the routes check again on every
 * call.
 */
export default async function CallsPage() {
  if (!isDbConfigured(db)) {
    return (
      <>
        <PageHeader title="Calls" />
        <EmptyState title="No database yet">
          Calls are kept in this site&rsquo;s own database. Set DATABASE_URL and run the migrations.
        </EmptyState>
      </>
    );
  }
  const principal = await currentPrincipal();
  const can = principal ? await loadStaffPermissions({ principal }) : null;
  if (!can?.can("booking.calls.view")) {
    return (
      <>
        <PageHeader title="Calls" />
        <Notice tone="warn">You don&rsquo;t have permission to see the calls.</Notice>
      </>
    );
  }
  return <CallsAdmin baseUrl="/api/admin/calls" bookingPageUrl="/book" emailsEnabled={bookingEmailsConfigured} />;
}
`;
}

function renderSingleBookPage(answers: Answers): string {
  const scope = answers.scope;
  return `import type { Metadata } from "next";
import { BookingWidget } from "${scope}/booking-widget";

export const metadata: Metadata = {
  title: "Book a call",
  description: "Pick a time that suits you for a call. Times are shown in your own time zone.",
  alternates: { canonical: "/book" },
};

/**
 * The booking page (Tenancy 2b-4c): a customer picks a call type, a day and a
 * time in their own time zone, holds it while they fill in their details, and
 * gets a confirmation with calendar links and a private link to move or
 * cancel (/book/manage/[token]). Everything on it is ${scope}/booking-widget's
 * <BookingWidget>, talking to /api/calls.
 */
export default function BookPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-10 sm:px-6 sm:py-16">
      <BookingWidget baseUrl="/api/calls" />
    </main>
  );
}
`;
}

function renderSingleManagePage(answers: Answers): string {
  const scope = answers.scope;
  return `import type { Metadata } from "next";
import { ManageBooking } from "${scope}/booking-widget";

/**
 * Never indexed, and never handing its address to the next site: the token in
 * this URL is the customer's whole key to their call (robots.txt keeps
 * /book/manage/ out too).
 */
export const metadata: Metadata = {
  title: "Your call",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export const dynamic = "force-dynamic";

/** The page behind the link in every booking email: the call, with Reschedule and Cancel while it's still ahead. */
export default async function ManageCallPage({ params }: { readonly params: Promise<{ readonly token: string }> }) {
  const { token } = await params;
  return (
    <main className="mx-auto max-w-2xl px-4 py-10 sm:px-6 sm:py-16">
      <ManageBooking baseUrl="/api/calls" token={token} realBookingHref="/book" />
    </main>
  );
}
`;
}
