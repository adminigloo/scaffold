/**
 * EACH PERSON'S OWN EMAILS (create-app 0.40, @adminigloo/digest), in a
 * project whose customers are people and that sends email
 * (`--audience consumers --email`) — the review's "Fix in AdminIgloo" item 11:
 *
 *   src/digests.ts                      YOUR emails: the digests (and their
 *                                       SECTIONS) and the alert kinds a person
 *                                       can choose, and the site's time zone.
 *                                       The project's file: an upgrade never
 *                                       rewrites one you changed
 *   src/server/digest.ts                the glue: who may be emailed, how an
 *                                       email leaves (src/server/mail.ts), the
 *                                       signed links, the cron's clock
 *   app/api/email/[...path]/route.ts    the handlers: one-click unsubscribe
 *                                       (RFC 8058), preferences, the staff preview
 *   app/api/cron/digest/route.ts        the daily run, ending by 50 seconds
 *   app/(site)/unsubscribe/page.tsx     the page every email links to: no
 *                                       sign-in, asks first, undo
 *   app/(site)/account/email/page.tsx   the preferences page
 *   src/components/SignUpEmailSlot.tsx  the unticked opt-in beside sign-up (in
 *                                       EVERY project: null without this)
 *   src/server/__tests__/digest.test.ts the proof
 */
import { personEmails, type Answers } from "./answers.js";
import { personalPlans } from "./personal-plans-emit.js";

// ---------------------------------------------------------------------------
// src/digests.ts — the project's own emails
// ---------------------------------------------------------------------------

export function renderDigestRegistry(answers: Answers): string {
  const scope = answers.scope;
  const plans = personalPlans(answers);
  const accountSection = plans
    ? `
/**
 * A SAMPLE SECTION, real enough to ship: what needs the person on their own
 * account — a payment that didn't go through, a free trial's last days, a
 * plan about to end — in the same words as the banner above every page
 * (src/server/plan-gate.ts). Null on every other day, so a person whose
 * account is fine gets nothing from it. Keep it, or replace it with yours.
 */
const yourAccount: DigestSection = {
  key: "account",
  render: async (person) => {
    const said = personalBannerSentence([...(await linePlansOf(personalWorkspaceId(person.userId))).values()]);
    if (said === null) return null;
    const link = \`\${(env.NEXT_PUBLIC_APP_URL ?? "").replace(/\\/+$/, "")}/account/billing\`;
    return {
      title: "Your account",
      text: \`\${said.sentence}\\n\\nYour plan and billing: \${link}\`,
      html: html\`<p style="margin:0 0 10px">\${said.sentence}</p><p style="margin:0"><a href="\${link}">Your plan and billing</a></p>\`,
    };
  },
};
`
    : "";
  return `import { defineEmailKinds, html, type DigestSection } from "${scope}/digest";
${plans ? `import { personalWorkspaceId } from "${scope}/tenancy";\nimport { env } from "@/env";\nimport { linePlansOf, personalBannerSentence } from "@/server/plan-gate";\n` : ""}
/**
 * THE EMAILS A PERSON CAN CHOOSE (create-app 0.40, ${scope}/digest).
 * YOURS TO EDIT: an upgrade never rewrites this file once you've changed it.
 *
 *   digests  at most one a day each, at the person's own hour in their own
 *            zone (7 AM unless they choose another), built from SECTIONS:
 *            each a server function of the person and the day that returns
 *            \`{ title, text, html }\` — or null when it has nothing to say. A
 *            day where every section is null sends nothing.
 *   alerts   sent when something happens, with \`digests.sendAlert(…)\`
 *            (src/server/digest.ts), only to people who chose that kind.
 *
 * EVERY ONE IS OFF until the person ticks it — at sign-up (unticked) or on
 * /account/email — and each has its own unsubscribe. A digest with no
 * sections is offered nowhere and sends nothing.
 *
 * A KEY IS PERMANENT: it is stored on every choice and every send. Rename a
 * title freely; never a key.
 *
 * A SECTION:
 *
 *   const yesterday: DigestSection = {
 *     key: "yesterday",
 *     render: async (person, day) => {
 *       // day.date is "2026-10-21" in the person's zone; day.start and
 *       // day.end are that local day's midnights as instants.
 *       const rows = await resultsFor(person.userId, day);
 *       if (rows.length === 0) return null;
 *       return {
 *         title: "Yesterday's results",
 *         text: rows.map((row) => \`\${row.city}: \${row.high}°\`).join("\\n"),
 *         // The html tag escapes every value; raw() for markup you vouch for.
 *         html: html\`<ul>\${rows.map((row) => html\`<li>\${row.city}: <b>\${row.high}°</b></li>\`)}</ul>\`,
 *       };
 *     },
 *   };
 *
 * See every person's digest for any day, without sending it, at
 * /api/email/v1/preview?person={their id}&digest=morning&day=2026-10-21
 * (staff with "Preview people's emails").
 */

/** The zone for a person whose browser didn't say which is theirs. */
export const SITE_TIME_ZONE = "America/New_York";
${accountSection}
export const EMAIL_KINDS = defineEmailKinds({
  digests: [
    {
      key: "morning",
      title: "Morning summary",
      description: "A short email at the start of your day with what's new for you.",
      sections: [${plans ? "yourAccount" : ""}],
    },
  ],
  // Alert kinds, e.g.:
  //   { key: "price-alerts", title: "Price alerts", description: "When a price crosses the line you set." },
  alerts: [],
});
`;
}

// ---------------------------------------------------------------------------
// src/server/digest.ts — the glue
// ---------------------------------------------------------------------------

export function renderDigestGlue(answers: Answers): string {
  const scope = answers.scope;
  return `import { createHmac, randomBytes } from "node:crypto";
import { and, inArray, isNotNull, isNull } from "drizzle-orm";
import { users } from "${scope}/auth/schema";
import {
  createDigestHandlers,
  createDigests,
  parseSignUpChoice,
  SIGN_UP_CHOICE_COOKIE,
  type DigestOutgoing,
  type DigestPerson,
  type DigestRunResult,
  type DigestSendOutcome,
  type PreferencesResponse,
} from "${scope}/digest";
import { digestTables } from "${scope}/digest/schema";
import { personalWorkspaceId } from "${scope}/tenancy";
import { tenants } from "${scope}/tenancy/schema";
import { BRAND } from "@/brand";
import { db } from "@/db";
import { EMAIL_KINDS, SITE_TIME_ZONE } from "@/digests";
import { env } from "@/env";
import { SITE_NAME } from "@/seo";
import { currentPrincipal } from "@/server/auth";
import { reportError } from "@/server/error-reporter";
import { log } from "@/server/logger";
import { sendEmail } from "@/server/mail";
import { loadStaffPermissions } from "@/server/permissions";

/**
 * EACH PERSON'S OWN EMAILS (create-app 0.40): ${scope}/digest over this
 * project's people and its mailer. The emails themselves — the digests, their
 * sections, the alert kinds — are src/digests.ts.
 *
 * WHO MAY BE EMAILED: a person whose account isn't deleted, who has a
 * verified sign-in address, and whose own account isn't suspended or deleted.
 * Nobody else is sent anything, whatever they once chose.
 *
 * HOW AN EMAIL LEAVES: src/server/mail.ts, with the one-click unsubscribe
 * headers and an idempotency key, so a retry after a timeout never sends
 * twice (Resend drops the repeat). With no RESEND_API_KEY every send is
 * "skipped": recorded, never an error, never retried.
 */

/** This site's address, for the links in every email. */
function appUrl(): string {
  return (env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\\/+$/, "");
}

/**
 * What every unsubscribe link is signed with: EMAIL_LINK_SECRET, else one
 * made from CLERK_SECRET_KEY (which a deployment already requires) —
 * HMAC-SHA256(CLERK_SECRET_KEY, "adminigloo:digest:v1") — else, with neither
 * (a laptop, a server nobody has labelled a deployment), a key made when this
 * server starts and written down nowhere. NEVER A KEY IN THIS FILE: it would
 * be the same in every project, and anybody who read it could sign a link
 * that stops, or starts, anybody's emails. Links that one signs stop working
 * when the server restarts. Changing the key retires every link already sent
 * (the preferences page still works).
 */
function linkSecret(): string {
  if (env.EMAIL_LINK_SECRET) return env.EMAIL_LINK_SECRET;
  if (env.CLERK_SECRET_KEY) return createHmac("sha256", env.CLERK_SECRET_KEY).update("adminigloo:digest:v1").digest("hex");
  return randomBytes(32).toString("hex");
}

/** Every digest step that failed: the log, and /admin/errors. */
export function reportDigestError(error: unknown, context: { readonly step: string; readonly kind?: string }): void {
  log.error({ err: error, ...context }, "digest: a step failed");
  void reportError({ error, source: "route", tenantId: null, context: { feature: "digest", ...context } });
}

/** The people among these ids who may be emailed now (see above). */
async function emailablePeople(userIds: readonly string[]): Promise<DigestPerson[]> {
  if (userIds.length === 0) return [];
  const people = await db
    .select({ id: users.id, email: users.email, name: users.displayName })
    .from(users)
    .where(and(inArray(users.id, [...userIds]), isNull(users.deletedAt), isNotNull(users.email)));
  if (people.length === 0) return [];
  const open = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(and(inArray(tenants.id, people.map((person) => personalWorkspaceId(person.id))), isNull(tenants.suspendedAt), isNull(tenants.deletedAt)));
  const active = new Set(open.map((account) => account.id));
  return people.flatMap((person) =>
    person.email && active.has(personalWorkspaceId(person.id)) ? [{ userId: person.id, email: person.email, name: person.name }] : [],
  );
}

/** One email, through the site's mailer. */
async function send(message: DigestOutgoing): Promise<DigestSendOutcome> {
  const outcome = await sendEmail({
    to: message.to,
    subject: message.subject,
    html: message.html,
    text: message.text,
    template: message.template,
    tenantId: personalWorkspaceId(message.userId),
    metadata: { kind: message.kind },
    headers: message.headers,
    idempotencyKey: message.idempotencyKey,
  });
  if (outcome.status === "failed") return { status: "failed", error: outcome.error, retryable: outcome.retryable };
  return outcome.status === "sent" ? { status: "sent" } : { status: "skipped", reason: "no-provider" };
}

/** THE digests: every person's choices, the daily run, the preview, alert emails. */
export const digests = createDigests({
  db,
  // The package's own tables, never a table of the same name somebody else made.
  tables: digestTables,
  kinds: EMAIL_KINDS,
  people: emailablePeople,
  send,
  // src/server/mail.ts sends Resend an Idempotency-Key: a retry is never a second email.
  idempotentSends: true,
  siteName: SITE_NAME,
  siteTimeZone: SITE_TIME_ZONE,
  secret: linkSecret(),
  baseUrl: appUrl(),
  theme: { accent: BRAND.accent },
  onError: (error, context) => reportDigestError(error, context),
});

/** May the person on this request see anybody's digest (staff with "Preview people's emails")? */
async function mayPreview(): Promise<boolean | "signed-out"> {
  const principal = await currentPrincipal();
  if (!principal) return "signed-out";
  const can = await loadStaffPermissions({ principal });
  return can?.can("staff.digest.preview") ?? false;
}

/** The handlers at /api/email: one-click unsubscribe, a person's preferences, the staff preview. */
export function buildDigestHandlers() {
  return createDigestHandlers({
    digests,
    person: async () => (await currentPrincipal())?.userId ?? null,
    staff: mayPreview,
    onError: (error, context) => reportDigestError(error, { step: context.route }),
  });
}

/** The preferences page's first state, read on the server. */
export async function emailPreferencesFor(userId: string): Promise<PreferencesResponse> {
  return { preferences: await digests.preferencesOf(userId), kinds: digests.kinds.offered, siteTimeZone: digests.siteTimeZone };
}

/** The digests a person can tick at sign-up: those with at least one section. */
export function signUpDigests(): { key: string; title: string; description: string }[] {
  return digests.kinds.offered.filter((kind) => kind.type === "digest").map(({ key, title, description }) => ({ key, title, description }));
}

/** The cookie the sign-up page writes (\`<SignUpEmailChoice>\`). */
export const SIGN_UP_EMAIL_COOKIE = SIGN_UP_CHOICE_COOKIE;

/**
 * What a new account ticked at sign-up, applied once (app/welcome): their
 * browser's zone if they have none, each digest only if they never chose it
 * either way. Never fails the sign-up.
 */
export async function applySignUpEmailChoice(userId: string, cookie: string | undefined): Promise<void> {
  const choice = parseSignUpChoice(cookie);
  if (choice === null) return;
  try {
    await digests.applySignUpChoice(userId, choice);
  } catch (error) {
    reportDigestError(error, { step: "sign-up choice" });
  }
}

/**
 * THE DAILY RUN'S CLOCK (app/api/cron/digest). The route has 60 seconds; the
 * run ends by 50, timed from the moment it starts: no email is started unless
 * it (10 seconds at most) and a margin still fit. People it didn't reach are
 * sent by the next run.
 */
const CRON_BUDGET_MS = 50_000;

/** The daily run: each person whose window is open and who has had nothing today. */
export function runDigestCron(): Promise<DigestRunResult> {
  return digests.run({ timeBudgetMs: CRON_BUDGET_MS });
}
`;
}

// ---------------------------------------------------------------------------
// The routes and pages
// ---------------------------------------------------------------------------

export function renderDigestApiRoute(): string {
  return `import { buildDigestHandlers } from "@/server/digest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /api/email/v1/… (create-app 0.40): every email's one-click unsubscribe
 * (RFC 8058 — Gmail's and Yahoo's own Unsubscribe button POSTs here, no
 * sign-in: the link is signed), the signed-in person's preferences, and the
 * staff preview of anybody's digest. The handlers are @adminigloo/digest's.
 */
const { handle } = buildDigestHandlers();

export const GET = handle;
export const POST = handle;
export const PUT = handle;
`;
}

export function renderDigestCron(): string {
  return `import { NextResponse } from "next/server";
import { env } from "@/env";
import { runDigestCron } from "@/server/digest";
import { reportError } from "@/server/error-reporter";
import { log } from "@/server/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The platform kills the function at this limit; the run stops by 50 seconds
// (src/server/digest.ts), so a busy morning ends cleanly and the next run
// sends whoever is still waiting.
export const maxDuration = 60;

/**
 * THE DIGESTS (create-app 0.40): one email per person who chose a digest, per
 * local day, at or after their hour in their zone. A second run sends nobody
 * anything (the ledger); no email provider configured is "skipped", never an
 * error.
 *
 * SCHEDULED IN vercel.json ONCE A DAY, at 15:00 UTC — the only schedule Vercel
 * Hobby accepts, and an hour at or after 7 AM in every US zone, so everybody
 * still gets one a day (in whichever day's window that run falls). On Pro,
 * run it EVERY HOUR (\`5 * * * *\`) and each person's comes within the hour
 * after their own hour, wherever they are (DEPLOYMENT.md). Vercel Cron sends
 * \`Authorization: Bearer $CRON_SECRET\`; anything else can send
 * \`x-cron-secret\`. Refuses every call while CRON_SECRET is unset.
 */
async function handle(request: Request): Promise<Response> {
  const secret = env.CRON_SECRET;
  const provided =
    request.headers.get("x-cron-secret") ??
    request.headers.get("authorization")?.replace(/^Bearer\\s+/i, "");
  if (!secret || provided !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await runDigestCron();
  log.info({ result }, "digest cron: ran");
  if (result.stoppedEarly) {
    // About this run (runtime state): reported, so a list outgrowing a daily
    // run is noticed. Nothing is lost — the next run sends them.
    const waiting = result.digests.reduce((sum, digest) => sum + digest.waiting, 0);
    log.error({ cron: "digest", waiting }, "digest cron: ran out of time");
    void reportError({
      error: new Error(\`The digest cron ran out of time with \${waiting} still waiting. Run it every hour (DEPLOYMENT.md).\`),
      source: "route",
      tenantId: null,
      context: { feature: "digest", route: "cron:digest" },
    });
  }
  return NextResponse.json({ ok: true, ...result });
}

export const GET = handle;
export const POST = handle;
`;
}

export function renderUnsubscribePage(): string {
  return `import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardBody, PageHeader, buttonClass } from "@/components/ui";
import { digests } from "@/server/digest";

/**
 * THE PAGE EVERY EMAIL'S UNSUBSCRIBE LINK OPENS (create-app 0.40). No sign-in
 * — the link is signed for one person and one email — and it ASKS FIRST:
 * opening it changes nothing (mail scanners open every link), the button
 * does. Stopping one email leaves every other alone, and there's an undo.
 * Never indexed, and never handing its address to the next site.
 */
export const metadata: Metadata = {
  title: "Unsubscribe",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export const dynamic = "force-dynamic";

const API = "/api/email/v1/unsubscribe";

export default async function UnsubscribePage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly t?: string | string[]; readonly done?: string | string[] }>;
}) {
  const params = await searchParams;
  const token = typeof params.t === "string" ? params.t : "";
  const done = typeof params.done === "string" ? params.done : null;
  const read = digests.readToken(token);
  const action = \`\${API}?t=\${encodeURIComponent(token)}\`;

  if (read === null || done === "invalid") {
    return (
      <main className="mx-auto max-w-lg px-6 py-16">
        <PageHeader title="This link doesn't work" description="It may have been copied only in part, or it is older than this site's current links." />
        <p className="text-sm text-ink-muted">
          <Link href="/account/email" className="text-accent underline underline-offset-2">
            Sign in to choose your emails
          </Link>{" "}
          instead.
        </p>
      </main>
    );
  }

  const name = read.kind.type === "digest" ? \`the \${read.kind.title}\` : read.kind.title;
  if (done === "unsubscribed") {
    return (
      <main className="mx-auto max-w-lg px-6 py-16">
        <PageHeader title="Done" description={\`You won't get \${name} any more. Every other email you chose is unchanged.\`} />
        <Card>
          <CardBody className="flex flex-wrap items-center gap-3">
            <form method="post" action={action}>
              <input type="hidden" name="from" value="page" />
              <input type="hidden" name="action" value="resubscribe" />
              <button type="submit" className={buttonClass("secondary")}>
                Undo: keep sending it
              </button>
            </form>
            <Link href="/account/email" className="text-sm text-accent underline underline-offset-2">
              All your emails
            </Link>
          </CardBody>
        </Card>
      </main>
    );
  }
  if (done === "resubscribed") {
    return (
      <main className="mx-auto max-w-lg px-6 py-16">
        <PageHeader title="It's back on" description={\`You'll get \${name} again.\`} />
        <Link href="/account/email" className="text-sm text-accent underline underline-offset-2">
          All your emails
        </Link>
      </main>
    );
  }
  return (
    <main className="mx-auto max-w-lg px-6 py-16">
      <PageHeader title={\`Stop \${name}?\`} description="Only this email stops. Anything else you chose keeps coming." />
      <Card>
        <CardBody className="flex flex-wrap items-center gap-3">
          <form method="post" action={action}>
            <input type="hidden" name="List-Unsubscribe" value="One-Click" />
            <input type="hidden" name="from" value="page" />
            <button type="submit" className={buttonClass("primary")}>
              Unsubscribe
            </button>
          </form>
          <Link href="/account/email" className="text-sm text-accent underline underline-offset-2">
            Choose all your emails instead
          </Link>
        </CardBody>
      </Card>
    </main>
  );
}
`;
}

export function renderEmailPreferencesPage(answers: Answers): string {
  const scope = answers.scope;
  return `import type { Metadata } from "next";
import Link from "next/link";
import { isDbConfigured } from "${scope}/db";
import { EmailPreferences } from "${scope}/digest/ui";
import { Notice, buttonClass } from "@/components/ui";
import { OperatorOnly } from "@/components/OperatorOnly";
import { db } from "@/db";
import { currentPrincipal } from "@/server/auth";
import { emailPreferencesFor } from "@/server/digest";
import { emailConfigured } from "@/server/mail";

/**
 * YOUR EMAILS (create-app 0.40): every email this site sends you — its
 * digests and its alerts (src/digests.ts) — each with its own box, OFF until
 * you tick it; the hour your digests come; and the zone that hour is in.
 * The screen is ${scope}/digest's; it saves through /api/email/v1/preferences.
 */
export const metadata: Metadata = { title: "Email" };

export const dynamic = "force-dynamic";

export default async function EmailPreferencesPage() {
  const principal = await currentPrincipal();
  if (!principal) {
    return (
      <Notice tone="info" title="Sign in to choose your emails">
        <p>Your email choices are tied to your account.</p>
        <p className="mt-3">
          <Link href="/sign-in?redirect_url=%2Faccount%2Femail" className={buttonClass("primary")}>
            Sign in
          </Link>
        </p>
      </Notice>
    );
  }
  if (!isDbConfigured(db)) {
    return (
      <Notice tone="info" title="This isn't available on this site yet">
        <OperatorOnly>DATABASE_URL isn&apos;t set, so there are no choices to keep. /setup lists what is outstanding.</OperatorOnly>
      </Notice>
    );
  }
  const initial = await emailPreferencesFor(principal.userId);
  return (
    <div className="flex flex-col gap-4">
      {emailConfigured ? null : (
        <OperatorOnly>
          <Notice tone="warn" title="No email is going out yet">
            RESEND_API_KEY isn&apos;t set, so every digest is recorded as skipped and nothing is sent. People can still choose.
          </Notice>
        </OperatorOnly>
      )}
      <EmailPreferences initial={initial} />
    </div>
  );
}
`;
}

/** /account in a project with no plans: there is only the email page. */
export function renderAccountEmailOnlyPage(): string {
  return `import { redirect } from "next/navigation";

/**
 * Your account (create-app 0.40): this site sells no plans, so the account
 * area is your emails — a real redirect there.
 */
export default function AccountPage(): never {
  redirect("/account/email");
}
`;
}

export function renderSignUpEmailSlot(answers: Answers): string {
  const scope = answers.scope;
  if (!personEmails(answers)) {
    return `/**
 * The email opt-in beside sign-up (create-app 0.40). GENERATED in two
 * variants: in a project whose customers are people and that sends email
 * (--audience consumers --email), one UNTICKED box per digest — "Email me the
 * Morning summary" — and this browser's time zone, kept for their first
 * page. Here, nothing.
 */
export function SignUpEmailSlot() {
  return null;
}
`;
  }
  return `import { SignUpEmailChoice } from "${scope}/digest/ui";
import { signUpDigests } from "@/server/digest";

/**
 * The email opt-in beside sign-up (create-app 0.40): one UNTICKED box per
 * digest (src/digests.ts) — "Email me the Morning summary: …" — and this
 * browser's time zone, written to a short-lived cookie the page a new account
 * lands on first applies once (app/welcome). Nothing is sent to anyone who
 * leaves it unticked. GENERATED in two variants; nothing without --email or
 * outside a consumers project.
 */
export function SignUpEmailSlot() {
  return <SignUpEmailChoice digests={signUpDigests()} />;
}
`;
}

// ---------------------------------------------------------------------------
// DEPLOYMENT.md
// ---------------------------------------------------------------------------

export function renderDeploymentDigest(answers: Answers): string {
  if (!personEmails(answers)) return "";
  return `
### Each person's emails and the morning digest

Every person chooses their own emails at **/account/email** — each digest and
alert kind in src/digests.ts, OFF until they tick it (at sign-up, unticked, or
there) — and the hour their digests come in their own zone (7 AM, from their
browser at sign-up; \`SITE_TIME_ZONE\` in src/digests.ts when it didn't say).
**Add your digest's sections in src/digests.ts**: a digest with no section is
offered nowhere and sends nothing.

- **The cron.** \`/api/cron/digest\` sends one email per person per local day,
  at or after their hour, and a second run sends nobody anything. vercel.json
  runs it once a day at 15:00 UTC (Vercel Hobby's only schedule, at or after 7
  AM in every US zone). **On Pro, run it every hour** (\`5 * * * *\`) so each
  person's comes within the hour after their own. It needs \`CRON_SECRET\`.
  Each run stops by 50 seconds; with Resend's default of 2 emails a second
  that is about 70 people a run, and a run that leaves people waiting reports
  it at /admin/errors (the next run sends them) — at that size, run it hourly
  and ask Resend to raise the rate.
- **No email provider.** Without \`RESEND_API_KEY\` every digest is recorded as
  "skipped": nothing goes, nothing is an error, nothing is retried.
- **Unsubscribe.** Every email carries RFC 8058's one-click headers (Gmail's
  and Yahoo's own Unsubscribe button) and a link to /unsubscribe, which works
  without signing in and stops that one email. The links are signed with
  \`EMAIL_LINK_SECRET\` (32+ characters), else a key made from
  \`CLERK_SECRET_KEY\`: rotating either retires the links already sent.
- **The preview.** Staff with "Preview people's emails" see anybody's digest
  for any day, exactly as it would go and never sent:
  \`/api/email/v1/preview?person={their id}&digest=morning&day=2026-10-21\`
  (\`&format=json\` for the parts).
`;
}

// ---------------------------------------------------------------------------
// src/server/__tests__/digest.test.ts — the proof
// ---------------------------------------------------------------------------

export function renderDigestTest(answers: Answers): string {
  const scope = answers.scope;
  return `import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { users } from "${scope}/auth/schema";
import { signUnsubscribe } from "${scope}/digest";
import { digestSends, digestSubscriptions } from "${scope}/digest/schema";
import { db } from "@/db";
import { seedPermissions } from "@/permissions/seed";
import { applySignUpEmailChoice, buildDigestHandlers, digests, runDigestCron } from "@/server/digest";
import { tenancy } from "@/server/tenancy";

/**
 * EACH PERSON'S OWN EMAILS, PROVED (create-app 0.40) on this project's own
 * schema and glue — the people who may be emailed, the mailer's headers, the
 * handlers at /api/email — with a test digest in place of src/digests.ts's,
 * so the proof holds whatever sections you write:
 *
 *   - two people in different zones each get ONE email, for their own day
 *   - running the cron again sends nobody anything
 *   - nothing until a person ticks a digest
 *   - no email provider: "skipped", never "failed", never reported
 *   - one-click unsubscribe by the header's POST and by the page's link, one
 *     email stopped and every other left alone
 *   - another person's signed link is refused, and so is one signed with
 *     any key written in src/server/digest.ts
 *   - the preview is staff only, and never sends
 */
vi.mock("@/db", async () => {
  const { createAppPglite } = await import("@/test/pglite");
  return { db: (await createAppPglite()).db };
});

vi.mock("@/digests", async () => {
  const { defineEmailKinds, html } = await import("${scope}/digest");
  return {
    SITE_TIME_ZONE: "America/New_York",
    EMAIL_KINDS: defineEmailKinds({
      digests: [
        {
          key: "morning",
          title: "Morning summary",
          description: "The test digest.",
          sections: [
            {
              key: "today",
              render: (person: { timeZone: string }, day: { date: string }) => ({
                title: "Today",
                text: \`It is \${day.date} in \${person.timeZone}.\`,
                html: html\`<p>It is \${day.date} in \${person.timeZone}.</p>\`,
              }),
            },
          ],
        },
      ],
      alerts: [{ key: "price-alerts", title: "Price alerts", description: "The test alert kind." }],
    }),
  };
});

/** What the mailer was handed, and what it answers. */
const mail = vi.hoisted(() => ({
  sent: [] as Array<{ to: string; subject: string; text: string; headers?: Record<string, string>; idempotencyKey?: string }>,
  answer: "sent" as "sent" | "skipped" | "failed",
}));
vi.mock("@/server/mail", () => ({
  emailConfigured: true,
  sendEmail: async (email: { to: string; subject: string; text: string; headers?: Record<string, string>; idempotencyKey?: string }) => {
    if (mail.answer !== "skipped") mail.sent.push(email);
    return mail.answer === "failed" ? { status: "failed", error: "refused", retryable: false } : { status: mail.answer };
  },
}));

/** Who is signed in on a request, and whether they hold the preview key. */
const who = vi.hoisted(() => ({ userId: null as string | null, staff: false }));
vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  currentPrincipal: async () => (who.userId ? { userId: who.userId } : null),
}));
vi.mock("@/server/permissions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/permissions")>()),
  loadStaffPermissions: async () => ({ can: (key: string) => who.staff && key === "staff.digest.preview" }),
}));
/** What reached /admin/errors. */
const reported = vi.hoisted(() => [] as string[]);
vi.mock("@/server/error-reporter", () => ({ reportError: async () => void reported.push("error") }));

vi.useFakeTimers({ toFake: ["Date"] });

async function person(tag: string): Promise<string> {
  const email = \`\${tag}@example.test\`;
  const [row] = await db.insert(users).values({ externalId: \`ext_\${tag}\`, email, displayName: tag }).returning();
  await tenancy.provisionUser({ userId: row!.id, email });
  return row!.id;
}

const fx = {} as { ann: string; bo: string; cy: string };
const BASE = "http://localhost:3000";

beforeAll(async () => {
  await seedPermissions(db, { log: () => {} });
  fx.ann = await person("ann");
  fx.bo = await person("bo");
  fx.cy = await person("cy");
});

beforeEach(async () => {
  await db.delete(digestSends);
  await db.delete(digestSubscriptions);
  mail.sent.length = 0;
  mail.answer = "sent";
  reported.length = 0;
  who.userId = null;
  who.staff = false;
  // 12:30 UTC: 7:30 AM in Chicago and 9:30 PM in Tokyo — both on October 21.
  vi.setSystemTime(new Date("2026-10-21T12:30:00Z"));
  await digests.savePreferences(fx.ann, { timeZone: "America/Chicago", deliveryHour: 7, choices: { morning: true, "price-alerts": true } });
  await digests.savePreferences(fx.bo, { timeZone: "Asia/Tokyo", deliveryHour: 7, choices: { morning: true } });
});

describe("two people in different zones", () => {
  it("each gets one email, for their own local day, at or after their own hour", async () => {
    const result = await runDigestCron();
    expect(result.digests[0]).toMatchObject({ key: "morning", subscribed: 2, sent: 2 });
    const texts = mail.sent.map((email) => [email.to, email.text.split("\\n").find((line) => line.startsWith("It is"))]);
    expect(texts.sort()).toEqual([
      ["ann@example.test", "It is 2026-10-21 in America/Chicago."],
      ["bo@example.test", "It is 2026-10-21 in Asia/Tokyo."],
    ]);
  });

  it("the next morning in Tokyo comes before the next morning in Chicago", async () => {
    await runDigestCron();
    mail.sent.length = 0;
    vi.setSystemTime(new Date("2026-10-21T23:00:00Z")); // 8 AM Oct 22 in Tokyo, 6 PM Oct 21 in Chicago
    await runDigestCron();
    expect(mail.sent.map((email) => email.to)).toEqual(["bo@example.test"]);
  });
});

describe("the replay", () => {
  it("running the cron again sends nobody anything", async () => {
    await runDigestCron();
    const again = await runDigestCron();
    expect(mail.sent).toHaveLength(2);
    expect(again.digests[0]).toMatchObject({ due: 0, sent: 0 });
  });
});

describe("nothing until a person says yes", () => {
  it("someone who never ticked a digest gets none", async () => {
    await runDigestCron();
    expect(mail.sent.some((email) => email.to === "cy@example.test")).toBe(false);
  });

  it("the sign-up opt-in ticks only what was ticked, and keeps the browser's zone", async () => {
    const cookie = encodeURIComponent(JSON.stringify({ v: 1, tz: "America/Denver", d: ["morning"] }));
    await applySignUpEmailChoice(fx.cy, cookie);
    expect(await digests.preferencesOf(fx.cy)).toMatchObject({ timeZone: "America/Denver", choices: { morning: true, "price-alerts": false } });
  });
});

describe("no email provider configured", () => {
  it("is skipped: never failed, never reported, never sent again", async () => {
    mail.answer = "skipped";
    const result = await runDigestCron();
    expect(result.digests[0]).toMatchObject({ skipped: 2, failed: 0 });
    expect(reported).toEqual([]);
    mail.answer = "sent";
    vi.setSystemTime(new Date("2026-10-21T14:30:00Z"));
    await runDigestCron();
    expect(mail.sent).toHaveLength(0);
  });
});

describe("one-click unsubscribe", () => {
  it("every email carries List-Unsubscribe and List-Unsubscribe-Post, and an idempotency key", async () => {
    await runDigestCron();
    const ann = mail.sent.find((email) => email.to === "ann@example.test")!;
    expect(ann.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(ann.headers?.["List-Unsubscribe"]).toBe(\`<\${digests.oneClickUrl(fx.ann, "morning")}>\`);
    expect(ann.idempotencyKey).toBe(\`digest:morning:\${fx.ann}:2026-10-21\`);
  });

  it("by the header: the provider's POST stops that one email and leaves the others", async () => {
    const response = await buildDigestHandlers().handle(
      new Request(digests.oneClickUrl(fx.ann, "morning"), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      }),
    );
    expect(response.status).toBe(200);
    expect((await digests.preferencesOf(fx.ann)).choices).toEqual({ morning: false, "price-alerts": true });
    await runDigestCron();
    expect(mail.sent.map((email) => email.to)).toEqual(["bo@example.test"]);
  });

  it("by the link: the unsubscribe page's form, signed out", async () => {
    const token = digests.unsubscribeToken(fx.bo, "morning");
    const response = await buildDigestHandlers().handle(
      new Request(\`\${BASE}/api/email/v1/unsubscribe?t=\${token}\`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click&from=page",
      }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("/unsubscribe?t=");
    expect((await digests.preferencesOf(fx.bo)).choices.morning).toBe(false);
    expect((await digests.preferencesOf(fx.ann)).choices.morning).toBe(true);
  });

  it("another person's signed link is refused, and nobody's choice changes", async () => {
    const annToken = digests.unsubscribeToken(fx.ann, "morning");
    const forged = \`\${Buffer.from(\`\${fx.bo}\\nmorning\`).toString("base64url")}.\${annToken.split(".")[1]}\`;
    const response = await buildDigestHandlers().handle(
      new Request(\`\${BASE}/api/email/v1/unsubscribe?t=\${encodeURIComponent(forged)}\`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      }),
    );
    expect(response.status).toBe(400);
    expect((await digests.preferencesOf(fx.bo)).choices.morning).toBe(true);
    expect((await digests.preferencesOf(fx.ann)).choices.morning).toBe(true);
  });

  it("is never signed with a key anybody can read: one written in src/server/digest.ts signs nothing here", async () => {
    // With neither EMAIL_LINK_SECRET nor CLERK_SECRET_KEY (the unit tests
    // never load a key), a key in the file would be every project's, and
    // anyone could sign a link that stops or starts anybody's emails.
    const source = readFileSync(fileURLToPath(new URL("../digest.ts", import.meta.url)), "utf8");
    const written = [...source.matchAll(/"([^"\\\\\\n]{8,})"/g)].map((match) => match[1]!);
    expect(written.length).toBeGreaterThan(0);
    for (const key of written) expect(digests.readToken(signUnsubscribe(key, fx.ann, "morning")), key).toBeNull();
  });
});

describe("the preview", () => {
  const url = () => \`\${BASE}/api/email/v1/preview?person=\${fx.bo}&digest=morning&day=2026-10-19\`;

  it("is staff only", async () => {
    expect((await buildDigestHandlers().handle(new Request(url()))).status).toBe(401);
    who.userId = fx.ann;
    expect((await buildDigestHandlers().handle(new Request(url()))).status).toBe(403);
  });

  it("renders any person's digest for a chosen day, and never sends it", async () => {
    who.userId = fx.ann;
    who.staff = true;
    const response = await buildDigestHandlers().handle(new Request(url()));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("It is 2026-10-19 in Asia/Tokyo.");
    expect(mail.sent).toHaveLength(0);
    expect(await db.select().from(digestSends)).toHaveLength(0);
  });
});

describe("alert emails", () => {
  it("go only to people who chose the kind, once per key", async () => {
    const alert = { kind: "price-alerts", dedupeKey: "k1", subject: "It moved", text: "It moved.", html: (await import("${scope}/digest")).html\`<p>It moved.</p>\` };
    expect(await digests.sendAlert({ userId: fx.bo, ...alert })).toEqual({ status: "not-subscribed" });
    expect(await digests.sendAlert({ userId: fx.ann, ...alert })).toEqual({ status: "sent" });
    expect(await digests.sendAlert({ userId: fx.ann, ...alert })).toEqual({ status: "duplicate" });
  });
});
`;
}
