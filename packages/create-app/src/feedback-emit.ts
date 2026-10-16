/**
 * The Tenancy 2b-2a renderers: `src/server/feedback.ts`, the glue between the
 * project and @adminigloo/feedback's handlers, and `app/api/cron/feedback`.
 *
 * Two boards exist in a companies project, one in a single-business one:
 *
 *   each company's own   /app/feedback over /api/app/{id}/feedback (its staff),
 *                        and /t/{web address}/feedback over
 *                        /api/t/{web address}/feedback (its customers)
 *   this site's own      /admin/feedback over /api/admin/feedback (the site's
 *                        staff), fed by the feedback button the template
 *                        mounts on the site's own pages — "*", FEEDBACK_PLATFORM_BOARD
 *
 * and the keyed intake (/api/igloo) serves both: a website key names the board
 * its tickets land on.
 *
 * In its own module because emit.ts is long enough already (the
 * features-emit.ts precedent). The generator's rules apply: no emitted `if`
 * about an answer — the file is written per mode and per feature set — and
 * the `if`s that ARE emitted are about runtime data (which board a request or
 * an event is for), each saying so.
 */

import { privateFeedbackScreenshots } from "./alerts-files-emit.js";
import { tenantLabel, type Answers } from "./answers.js";
import { companiesMode } from "./tenancy-emit.js";

/** The public-store screenshots, the limits, the staff keys and names, the error report, this site's own board: both modes. */
function shared(answers: Answers): string {
  const companies = companiesMode(answers);
  const noun = tenantLabel(answers).toLowerCase();
  return `/**
 * Screenshots in the PUBLIC Vercel Blob store, when BLOB_READ_WRITE_TOKEN is
 * set — a runtime configuration check, not a feature switch. Each is kept
 * under a random name nobody can guess, and deleted by the feedback cron if
 * no report used it within a day. Without the token the upload route answers
 * "can't be kept here yet" and the report goes without its screenshot, which
 * the widget says. The token is passed explicitly so the one place this app
 * reads its environment stays src/env.ts.
 *
 * Used for THIS SITE'S OWN board${companies ? (privateFeedbackScreenshots(answers) ? `; a ${noun}'s screenshots are kept PRIVATELY instead
 * (src/server/files.ts, \`feedbackScreenshotStore\`)` : `, and for a ${noun}'s (this project has no private file
 * storage, --storage, to keep them in)`) : ""}. DEPLOYMENT.md says where they go.
 */
const publicScreenshots: FeedbackScreenshotStore | undefined = env.BLOB_READ_WRITE_TOKEN
  ? {
      put: async (input) => {
        const blob = await put(\`feedback/\${input.filename}\`, new Blob([input.bytes as Uint8Array<ArrayBuffer>], { type: input.contentType }), {
          access: "public",
          contentType: input.contentType,
          token: env.BLOB_READ_WRITE_TOKEN,
        });
        return { url: blob.url, fileId: null };
      },
      remove: async (input) => {
        await del(input.url, { token: env.BLOB_READ_WRITE_TOKEN });
      },
    }
  : undefined;

/** What a test swaps on the intake: where screenshots go. */
export interface FeedbackIntakeOverrides {
  readonly screenshots?: FeedbackScreenshotStore;
}

/**
 * The staff key each feedback permission is checked against on THIS SITE'S
 * OWN board: one key per job (D12), never the shell's staff.dashboard.view.
 *
 *   staff.feedback.view      the board, a ticket and its conversation
 *   staff.feedback.manage    reply, move, assign, archive
 *   staff.feedback.settings  columns, categories, website keys
 */
export const FEEDBACK_STAFF_KEYS: Readonly<Record<FeedbackPermission, string>> = {
  "feedback.view": "staff.feedback.view",
  "feedback.manage": "staff.feedback.manage",
  "feedback.settings.manage": "staff.feedback.settings",
};

/**
 * Who someone on the team is, in words: the name a reporter sees on a reply.
 * Their DISPLAY NAME only — never their sign-in address, which would go to
 * every customer they answer (review M4). No display name: the package uses
 * the business's own name (\`feedbackTeamName\`).
 */
async function staffName(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const [row] = await db.select({ name: users.displayName }).from(users).where(eq(users.id, userId)).limit(1);
  return row?.name?.trim() || null;
}

/** Someone with no display name, in the picker. */
const NO_NAME = "A teammate with no name set";

/** Someone a ticket can be assigned to: their user id and the name the card shows. */
interface FeedbackPerson {
  readonly id: string;
  readonly name: string;
}

/**
 * THIS SITE'S OWN board's people (feedback 0.11): everyone holding a
 * firm-wide staff role, not a deleted account — the assignee picker, the
 * "Assigned to" filter, and the check that an assignee is one of them. By
 * the name they set — never their sign-in address (review M4's rule: an
 * address in a name ends up where names go).
 */
async function staffPeople(): Promise<FeedbackPerson[]> {
  const rows = await db
    .selectDistinct({ id: users.id, name: users.displayName })
    .from(principalRole)
    .innerJoin(users, eq(users.id, principalRole.principalId))
    .where(and(eq(principalRole.scope, "staff"), eq(principalRole.tenantId, FIRM_WIDE), isNull(users.deletedAt)));
  return rows.map((row) => ({ id: row.id, name: row.name?.trim() || NO_NAME }));
}

/** An error the handlers didn't expect: a fixed sentence for the caller, the error in /admin/errors. */
export function reportFeedbackError(error: unknown, context: { tenantId: string | null; route: string }): void {
  void reportError({
    error,
    source: "route",
    tenantId: context.tenantId,
    context: { feature: "feedback", route: context.route },
  });
}

/**
 * How often the public may write to a feedback form: the package's counts
 * (FEEDBACK_INTAKE_LIMITS — per form and visitor, per visitor across every
 * form here, and a ${companies ? `${noun}'s feedback page's` : "keyless form's"} day), on the app's shared limiter (Upstash
 * when configured, in memory per server otherwise). A request with no
 * forwarded address is counted as one shared visitor, never let through
 * uncounted.
 */
export const feedbackRateLimit = createFeedbackRateLimit(async (key, policy) => (await limiter.limit({ key, policy })).allowed);

/**
 * THIS SITE'S OWN board, for its staff (/admin/feedback over
 * /api/admin/feedback): the board the feedback button on this site's own
 * pages feeds. Never a ${companies ? `${noun}'s` : "customer's"} board: the board is fixed.
 */
export function buildPlatformFeedbackAdminHandlers() {
  return createFeedbackAdminHandlers({
    db,
    tenantId: FEEDBACK_PLATFORM_BOARD,
    authorize: authorizeStaffFor(FEEDBACK_STAFF_KEYS, "Sign in to see the feedback board."),
    staffName: (userId) => staffName(userId),
    teamName: (tenantId) => feedbackTeamName(tenantId),
    listPeople: () => staffPeople(),
    onError: reportFeedbackError,
  });
}

/**
 * The screenshots nobody sent a report with, deleted (review M2): run by
 * /api/cron/feedback. An upload no report used within a day goes, its stored
 * file first.
 */
export async function sweepFeedbackScreenshots(): Promise<{ readonly removed: number; readonly failed: number }> {
  return sweepFeedbackUploads(db, {
    store: (tenantId) => screenshotsFor(tenantId),
    timeBudgetMs: 40_000,
    onError: (error, context) => reportFeedbackError(error, { tenantId: context.tenantId, route: "sweep" }),
  });
}`;
}

export function renderFeedbackGlue(answers: Answers): string {
  return companiesMode(answers) ? renderCompanies(answers) : renderSingle(answers);
}

function renderSingle(answers: Answers): string {
  const scope = answers.scope;
  return `import { users } from "${scope}/auth/schema";
import { FIRM_WIDE } from "${scope}/permissions";
import { principalRole } from "${scope}/permissions/schema";
import {
  createFeedbackAdminHandlers,
  createFeedbackHandlers,
  createFeedbackRateLimit,
  FEEDBACK_PLATFORM_BOARD,
  sweepFeedbackUploads,
  type FeedbackPermission,
  type FeedbackScreenshotStore,
} from "${scope}/feedback";
import { del, put } from "@vercel/blob";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { env } from "@/env";
import { SITE_NAME } from "@/seo";
import { reportError } from "@/server/error-reporter";
import { limiter } from "@/server/rate-limit";
import { authorizeStaffFor } from "@/server/staff-access";

/**
 * The app's side of ${scope}/feedback for this single business (Tenancy
 * 2b-2a): ONE board — this site's own — fed by the feedback button the app
 * mounts on its pages (and any other site holding one of its website keys),
 * worked by the site's staff at /admin/feedback. The package's own handlers,
 * so a fix reaches this project with \`pnpm update\`.
 */

${shared(answers)}

/** Where this board's screenshots go: the public store (the only board here). */
function screenshotsFor(_tenantId: string): FeedbackScreenshotStore | undefined {
  return publicScreenshots;
}

/** The name on a reply when the person who wrote it has no display name: this site's. */
export async function feedbackTeamName(_tenantId: string): Promise<string> {
  return SITE_NAME;
}

/**
 * The widget's intake by website key (/api/igloo): every key here names this
 * site's own board. Always open — there is no business here to be suspended.
 */
export function buildFeedbackIntakeHandlers(overrides: FeedbackIntakeOverrides = {}) {
  return createFeedbackHandlers({
    db,
    screenshots: overrides.screenshots ?? ((tenantId) => screenshotsFor(tenantId)),
    rateLimit: feedbackRateLimit,
    onError: reportFeedbackError,
  });
}
`;
}

function renderCompanies(answers: Answers): string {
  const scope = answers.scope;
  const noun = tenantLabel(answers).toLowerCase();
  const alerts = answers.includeNotifications;
  const comms = answers.includeComms;
  const privateShots = privateFeedbackScreenshots(answers);
  const pkgImports = [
    "createFeedbackAdminHandlers",
    "createFeedbackHandlers",
    "createFeedbackRateLimit",
    "ensureFeedbackBoard",
    ...(comms ? ["FEEDBACK_EMAIL_TEMPLATES"] : []),
    "FEEDBACK_PLATFORM_BOARD",
    ...(privateShots ? ["FEEDBACK_TICKET_RECORD"] : []),
    ...(comms ? ["feedbackReporterEmailFor"] : []),
    "sweepFeedbackUploads",
    "type FeedbackAdmission",
    ...(alerts || comms ? ["type FeedbackEvent"] : []),
    "type FeedbackPermission",
    "type FeedbackScreenshotStore",
  ];
  const imports = [
    `import { users } from "${scope}/auth/schema";`,
    `import { FIRM_WIDE } from "${scope}/permissions";`,
    `import { principalRole } from "${scope}/permissions/schema";`,
    `import { tenantMembers } from "${scope}/tenancy/schema";`,
    ...(comms ? [`import { commsTemplates, sendNow } from "${scope}/comms";`] : []),
    `import {\n${pkgImports.map((name) => `  ${name},`).join("\n")}\n} from "${scope}/feedback";`,
    `import { del, put } from "@vercel/blob";`,
    `import { and, eq, isNull } from "drizzle-orm";`,
    `import { db } from "@/db";`,
    `import { env } from "@/env";`,
    `import { SITE_NAME } from "@/seo";`,
    ...(alerts ? [`import { alertOnFeedbackEvent } from "@/server/alerts";`] : []),
    ...(comms ? [`import { commsSenders } from "@/server/comms-senders";`] : []),
    `import { admitPublic, companyAuthorizer, companyRoutes, resolvePublicTenant, type FeatureHandlerOverrides } from "@/server/company-routes";`,
    ...(comms ? [`import { companyLinks } from "@/server/company-links";`] : []),
    `import { reportError } from "@/server/error-reporter";`,
    ...(privateShots ? [`import { feedbackScreenshotStore } from "@/server/files";`] : []),
    `import { limiter } from "@/server/rate-limit";`,
    `import { authorizeStaffFor } from "@/server/staff-access";`,
    `import { tenancy } from "@/server/tenancy";`,
  ];

  const companyShots = privateShots
    ? `/**
 * A ${noun}'s screenshots, kept PRIVATELY (review M3) through the files
 * instance (src/server/files.ts): on their ticket once the report arrives, so
 * the ticket's permissions decide who opens them — the ${noun}'s own people
 * with feedback.view, through its signed-in files route. Never a public
 * address. Without the private store (BLOB_PRIVATE_READ_WRITE_TOKEN), a
 * ${noun}'s feedback takes no screenshots rather than keeping them publicly.
 */
const privateScreenshots: FeedbackScreenshotStore | undefined = feedbackScreenshotStore
  ? {
      put: async (input) => {
        const stored = await feedbackScreenshotStore!.put({
          tenantId: input.tenantId,
          bytes: input.bytes,
          contentType: input.contentType,
          filename: input.filename,
        });
        return { url: stored.url, fileId: stored.fileId };
      },
      attach: async (input) => {
        await feedbackScreenshotStore!.attach({ tenantId: input.tenantId, fileId: input.fileId, record: { type: FEEDBACK_TICKET_RECORD, id: input.ticketId } });
      },
      remove: async (input) => {
        if (input.fileId) await feedbackScreenshotStore!.delete({ tenantId: input.tenantId, fileId: input.fileId });
      },
    }
  : undefined;

/**
 * Where a board's screenshots go (runtime data: whose board it is, not a
 * feature switch): this site's own board, the public store; a ${noun}'s, its
 * private files.
 */
function screenshotsFor(tenantId: string): FeedbackScreenshotStore | undefined {
  return tenantId === FEEDBACK_PLATFORM_BOARD ? publicScreenshots : privateScreenshots;
}`
    : `/**
 * Where a board's screenshots go: the public store, for this site's own board
 * and a ${noun}'s alike — this project was generated without private file
 * storage (--storage). DEPLOYMENT.md says so.
 */
function screenshotsFor(_tenantId: string): FeedbackScreenshotStore | undefined {
  return publicScreenshots;
}`;

  const intakeEvent = alerts
    ? `/**
 * What the intake tells the team: a new ticket, a reporter's answer — as
 * alerts to everyone who can see the ${noun}'s board (Tenancy 2b-1's alerts).
 * Inside an arrow on purpose: alerts.ts and this module load in a chain, and
 * nothing here reads it at load.
 */
async function onFeedbackIntakeEvent(event: FeedbackEvent): Promise<void> {
  // THIS SITE'S OWN board has no ${noun} people to alert (runtime data: whose
  // board the ticket is on, not a feature switch).
  if (event.tenantId === FEEDBACK_PLATFORM_BOARD) return;
  await alertOnFeedbackEvent(event);
}
`
    : "";

  const staffEvent = comms
    ? `/**
 * What the team's changes tell the REPORTER: the team's reply, and their
 * ticket moving to another column — an email, when the reporter left an
 * address, sent AS THE ${noun.toUpperCase()} through comms (its name on the From, its
 * reply-to; Tenancy 2a, D8), logged in its Messages, worded by its own
 * templates (added if absent, never over an owner's edit). With no email
 * service set up, comms logs it as skipped. Never throws: the change it
 * announces already happened.
 */
async function onFeedbackStaffEvent(event: FeedbackEvent): Promise<void> {
  try {
    const profile = await tenancy.companyProfile(event.tenantId);
    if (!profile) return;
    const email = feedbackReporterEmailFor(event, {
      businessName: profile.name,
      feedbackUrl: (await companyLinks(event.tenantId)).feedback,
    });
    if (!email) return;
    await ensureFeedbackEmailTemplates(event.tenantId);
    await sendNow(
      db,
      { tenantId: email.tenantId, to: email.to, templateKey: email.templateKey, vars: email.vars, idempotencyKey: email.idempotencyKey },
      commsSenders,
    );
  } catch (error) {
    reportFeedbackError(error, { tenantId: event.tenantId, route: \`email:\${event.type}\` });
  }
}

/** A ${noun}'s two reporter emails, added if absent — never over an owner's edit. */
export async function ensureFeedbackEmailTemplates(tenantId: string): Promise<void> {
  await db
    .insert(commsTemplates)
    .values(FEEDBACK_EMAIL_TEMPLATES.map((t) => ({ tenantId, key: t.key, channel: "email", subject: t.subject, body: t.body })))
    .onConflictDoNothing({ target: [commsTemplates.tenantId, commsTemplates.key] });
}
`
    : "";
  // Without alerts the intake tells nobody; without messages (comms, which
  // sends as the company) the team's changes email nobody — so the builders
  // below get no `onEvent` at all, rather than an emitted `if`.
  const intakeOnEvent = alerts ? "\n    onEvent: onFeedbackIntakeEvent," : "";
  const staffOnEvent = comms ? "\n    onEvent: onFeedbackStaffEvent," : "";

  const setup = `/**
 * A ${noun}'s first-time setup for feedback (D11): its board's default columns
 * and categories${comms ? ", and its two reporter emails (the team replied, the ticket\n * moved), so the owner can read and reword them in Messages before the first\n * one goes" : ""}. Insert-if-absent: running it twice writes nothing.
 */
export async function setupFeedbackFor(tenantId: string): Promise<void> {
  await ensureFeedbackBoard(db, tenantId);${comms ? "\n  await ensureFeedbackEmailTemplates(tenantId);" : ""}
}`;

  return `${imports.join("\n")}

/**
 * The app's side of ${scope}/feedback in a COMPANIES project (Tenancy 2b-2a):
 *
 *   each ${noun}'s own board   /app/feedback, over /api/app/{${noun} id}/feedback —
 *                          the id in the PATH decides, asked on every call
 *                          (feedback.view to look, feedback.manage to work
 *                          tickets, feedback.settings.manage to change the
 *                          board); a ticket of another ${noun} is "not found"
 *   its customers' page    /t/{web address}/feedback, over
 *                          /api/t/{web address}/feedback — the web address
 *                          decides; a suspended ${noun}, or one whose plan
 *                          ended, takes no NEW ticket, while its customers can
 *                          still read and answer the ones they have. No
 *                          screenshots there.
 *   its own website        a website key (made in its feedback settings) on
 *                          /api/igloo names its board
 *   this site's own board  /admin/feedback, for the site's staff — the board
 *                          the feedback button on this site's own pages feeds
 *
 * IMPORT ORDER: company-routes → company-setup → this module → company-routes
 * is a cycle by design, safe while every cross-module use happens INSIDE a
 * function (the builders run when a route file calls them).
 */

${shared(answers)}

${companyShots}

/**
 * Does a ${noun}'s board email the reporter when its team replies or moves a
 * ticket (feedback 0.11)? Written per variant: ${comms ? "yes — this project has messages (comms), which send in the " + noun + "'s name" : "no — this project was generated without messages (comms)"}.
 * The board's reply box reads it, so it never promises an email that won't go.
 */
export const FEEDBACK_EMAILS_REPORTERS = ${comms ? "true" : "false"};

/**
 * The name on a reply when the person who wrote it has no display name
 * (review M4): the ${noun}'s, as its customers know it ("Green Acres"); this
 * site's own on this site's own board (runtime data: whose board it is).
 */
export async function feedbackTeamName(tenantId: string): Promise<string | null> {
  if (tenantId === FEEDBACK_PLATFORM_BOARD) return SITE_NAME;
  return (await tenancy.companyProfile(tenantId))?.name ?? null;
}

${intakeEvent}${staffEvent}${setup}

/**
 * A ${noun}'s people a ticket can be assigned to (feedback 0.11): its active
 * members, not a deleted account — the assignee picker, the "Assigned to"
 * filter, and the check that an assignee is one of THIS ${noun}'s (anyone
 * else's id is refused). This site's own board's are its staff (runtime data:
 * whose board it is).
 */
async function companyPeople(tenantId: string): Promise<FeedbackPerson[]> {
  if (tenantId === FEEDBACK_PLATFORM_BOARD) return staffPeople();
  const rows = await db
    .select({ id: users.id, name: users.displayName })
    .from(tenantMembers)
    .innerJoin(users, eq(users.id, tenantMembers.userId))
    .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.status, "active"), isNull(users.deletedAt)));
  return rows.map((row) => ({ id: row.id, name: row.name?.trim() || NO_NAME }));
}

/**
 * A ${noun}'s board, for its own people, one ${noun} per request.
 * \`overrides.principal\` is how the project's isolation proof calls it as
 * somebody else.
 */
export function buildFeedbackAdminHandlers(overrides: FeatureHandlerOverrides = {}) {
  return createFeedbackAdminHandlers({
    db,
    resolveTenant: companyRoutes.resolveTenant,
    authorize: companyAuthorizer(overrides),
    staffName: (userId) => staffName(userId),
    teamName: (tenantId) => feedbackTeamName(tenantId),
    listPeople: (tenantId) => companyPeople(tenantId),${staffOnEvent}
    onError: reportFeedbackError,
  });
}

/**
 * A ${noun}'s public feedback page's routes: the ${noun} whose web address is in
 * the path, its first-time setup, and whether it takes new tickets
 * (\`admitPublic\`, the same gate every /t page's routes use). No website key,
 * and so no screenshots (the package refuses an upload with no key).
 */
export function buildFeedbackPublicHandlers() {
  return createFeedbackHandlers({
    db,
    resolveTenant: resolvePublicTenant,
    admit: admitPublic,
    rateLimit: feedbackRateLimit,${intakeOnEvent}
    onError: reportFeedbackError,
  });
}

/**
 * Is this board taking new tickets? THIS SITE'S OWN always is (runtime data:
 * the board a key names, not a feature switch); a ${noun}'s is asked of
 * \`admitPublic\` — suspended, or its plan ended, means no new ticket.
 */
async function admitIntake(tenantId: string, req: Request): Promise<FeedbackAdmission> {
  if (tenantId === FEEDBACK_PLATFORM_BOARD) return { open: true };
  return admitPublic(tenantId, req);
}

/**
 * The widget's intake by website key (/api/igloo): a key names its board —
 * this site's own (the in-app button) or a ${noun}'s (its own website).
 */
export function buildFeedbackIntakeHandlers(overrides: FeedbackIntakeOverrides = {}) {
  return createFeedbackHandlers({
    db,
    admit: admitIntake,
    screenshots: overrides.screenshots ?? ((tenantId) => screenshotsFor(tenantId)),
    rateLimit: feedbackRateLimit,${intakeOnEvent}
    onError: reportFeedbackError,
  });
}
`;
}

/** `app/api/cron/feedback/route.ts` (review M2): the sweep of screenshots nobody sent. Both modes. */
export function renderFeedbackCron(): string {
  return `import { NextResponse } from "next/server";
import { env } from "@/env";
import { log } from "@/server/logger";
import { sweepFeedbackScreenshots } from "@/server/feedback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The daily feedback tidy-up (Tenancy 2b-2a review M2): a screenshot is
 * uploaded before its report is sent, so a person who closes the form, or a
 * script that uploads without reporting, leaves one behind. Every screenshot
 * no report used within a day is deleted here — the stored file, then its
 * row — for every board at once, within 40 seconds; what's left waits for
 * tomorrow.
 *
 * SCHEDULED IN vercel.json; refuses every call while CRON_SECRET is unset.
 */
async function handle(request: Request): Promise<Response> {
  const secret = env.CRON_SECRET;
  const provided =
    request.headers.get("x-cron-secret") ??
    request.headers.get("authorization")?.replace(/^Bearer\\s+/i, "");
  if (!secret || provided !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const swept = await sweepFeedbackScreenshots();
  log.info({ ...swept }, "feedback cron: screenshots nobody sent, deleted");
  return NextResponse.json({ ok: true, screenshots: swept });
}

export const GET = handle;
export const POST = handle;
`;
}

/**
 * DEPLOYMENT.md's "Feedback screenshots" section (review M3): where each
 * board's screenshots go in THIS project, and what keeps them tidy. Empty
 * without feedback.
 */
export function renderDeploymentFeedback(answers: Answers): string {
  if (!answers.includeFeedback) return "";
  const companies = companiesMode(answers);
  const noun = tenantLabel(answers).toLowerCase();
  const lines = [
    "",
    "### Feedback screenshots",
    "",
    "- **This site's own feedback button** (its board is /admin/feedback): screenshots go to the PUBLIC Blob store " +
      "(`BLOB_READ_WRITE_TOKEN`), each under a random address nobody can guess. Without the token, reports arrive " +
      "without screenshots.",
  ];
  if (companies) {
    lines.push(
      privateFeedbackScreenshots(answers)
        ? `- **A ${noun}'s feedback** (from its own website): screenshots are kept PRIVATELY in the private Blob store ` +
            `(\`BLOB_PRIVATE_READ_WRITE_TOKEN\`), on their ticket, and open only for the ${noun}'s people who can see its ` +
            `board, through the signed-in files route. Without the private store, a ${noun}'s feedback takes no screenshots.`
        : `- **A ${noun}'s feedback** (from its own website): screenshots go to the same PUBLIC Blob store, under random ` +
            `addresses — this project was generated without private file storage (\`--storage\`). Add it to keep them private.`,
      `- **A ${noun}'s feedback page** (/t/{web address}/feedback) takes no screenshots at all.`,
    );
  }
  lines.push(
    "- **Screenshots nobody sent** (the person closed the form) are deleted after a day by `/api/cron/feedback` " +
      "(vercel.json; it needs `CRON_SECRET`).",
    "",
  );
  return lines.join("\n");
}
