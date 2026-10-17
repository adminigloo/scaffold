# @adminigloo/notifications

Alerts for each company, for each person in it. When a customer asks for an
estimate, accepts a quote, moves a visit or pays an invoice, the right people
in THAT company get an alert in plain words, linking to the thing: in the bell
in the header, and by email when they choose "In the app and by email". The
owner chooses, in ONE place, who hears about new estimate requests, visit
requests and invoices (with nothing set up, the owner does). A crew member
hears only about their own crew's visits. Nobody gets the same alert twice:
not from a retried request, not from an event handed over twice, not from a
cron that runs again. Alert emails go out under the company's name. Everything
lives in your own database.

The screens (the bell, the alerts page, Alert settings) are
[`@adminigloo/notifications-widget`](../notifications-widget/README.md).

## What each install gets you

| You install | You get | You wire yourself |
| --- | --- | --- |
| `@adminigloo/notifications` alone | The alert tables (any prefix or Postgres schema), the kind registry, `createNotifications` (who gets what, choices, the owner's lists, email copies with retries, cleanup), the HTTP handlers and route table, the permissions, `renderAlertEmail` for sending without comms, `./testing` (`checkHostSeams`) | The tables (drizzle-kit, or the shipped SQL), the instance with your `people` and `email` seams, one catch-all route for the handlers, the cron calls, and the glue from your events to `alerts.notify` |
| `+ @adminigloo/notifications-widget` | `<AlertsBell>`, `<AlertsInbox>`, `<AlertSettings>` | Put the bell in your header and the two pages in your app |
| With `@adminigloo/create-app --notifications` | All of the above, wired: every installed package's alert kinds, the bell in the header, the alerts and settings pages, the office emails routed through Alert settings, the alerts cron, and the isolation proofs | Nothing |

Entries:

| Entry | What it is |
| --- | --- |
| `@adminigloo/notifications` | The registry, `createNotifications`, `createNotificationHandlers`, `NOTIFICATIONS_ADMIN_ROUTES`, `notificationsPermissions`, `notificationsAuditedActions`, `TEAM_ALERT_EMAIL_TEMPLATE`, `renderAlertEmail`, `breakLinks`, the wire types, and 0.1's functions (deprecated) |
| `@adminigloo/notifications/schema` | `defineNotificationTables({ prefix, schema })`, the default `notificationTables`, `notificationsSql(options)` |
| `@adminigloo/notifications/testing` | `checkHostSeams(...)`: check your own sign-in and company seams keep each company's alerts to itself |
| `@adminigloo/notifications/sql/*` | The shipped SQL files: `notifications-0.2.0.sql` and `upgrade-0.1-to-0.2.sql` (the default names) |

## Install

The package is private, published to GitHub Packages. Add the scope to your
project's `.npmrc` (commit this line, it holds no secret):

```
@adminigloo:registry=https://npm.pkg.github.com
```

and your token to your **user-level** `~/.npmrc`, never the repo:

```
//npm.pkg.github.com/:_authToken=<a GitHub token with read:packages>
```

Then:

```sh
npm install @adminigloo/notifications @adminigloo/notifications-widget   # pnpm add / yarn add work the same
```

Peers: `drizzle-orm` 0.45 and `zod` 3.25+ or 4. No other AdminIgloo package
is needed: the company, the person and the permission come from your app.

## Upgrading from 0.1

0.1 was a staff inbox with no company. Its table upgrades in place:

- **drizzle-kit:** regenerate your migration after updating; the default
  tables keep 0.1's names, so it is a set of `add column` statements, new
  indexes and two new tables.
- **No drizzle-kit:** run `sql/upgrade-0.1-to-0.2.sql` (shipped in the
  package): `psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f
  node_modules/@adminigloo/notifications/sql/upgrade-0.1-to-0.2.sql`. It is
  one statement that first checks that the table named `notifications` really
  is AdminIgloo's 0.1 table (exactly 0.1's columns, and 0.1's index on it);
  otherwise it stops with a sentence saying so and changes nothing. Running it
  twice is safe.

**What 0.1's rows become:** the firm-wide staff inbox (`tenant_id = '*'`).
No company's bell shows them. 0.1's functions (`notify(db, …)`,
`listNotifications`, `unreadCount`, `markNotificationRead`, `markAllRead`)
keep working on exactly those rows and are deprecated in favour of the
instance. `cleanup()` never deletes them.

`createNotifications` is new, and **requires `tables`**: pass
`notificationTables` for the 0.1 names.

## Quick start (the template)

`pnpm dlx @adminigloo/create-app my-app --notifications` writes all of this
for you. By hand, in a project built from the template:

```ts
// src/server/alerts.ts
import { createNotifications, defineAlertRegistry } from "@adminigloo/notifications";
import { notificationTables } from "@adminigloo/notifications/schema";
import { schedulingAlertKinds } from "@adminigloo/scheduling";
import { estimatorAlertKinds } from "@adminigloo/estimator";
import { db } from "@/db";

export const ALERT_REGISTRY = defineAlertRegistry([schedulingAlertKinds, estimatorAlertKinds]);

export const alerts = createNotifications({
  db,
  tables: notificationTables,
  registry: ALERT_REGISTRY,
  // The company's ACTIVE members holding `permission` now. A suspended company → [].
  people: async (tenantId, permission) =>
    (await tenancy.listMemberPeople(tenantId, { holding: permission })).map((m) => ({
      userId: m.userId, name: m.name, email: m.email, isOwner: m.roleKey === "owner",
    })),
  // The business email from company settings: where the owner's copies of new work go.
  ownerEmail: async (tenantId) => (await tenancy.companyProfile(tenantId))?.inbox[0] ?? null,
  email: sendTeamAlert,        // your email seam (comms' team_alert template, or renderAlertEmail)
  emailIdempotent: true,       // Resend drops a repeat of the same idempotency key
});
```

```ts
// app/api/app/[tenantId]/alerts/[...path]/route.ts
import { createNotificationHandlers } from "@adminigloo/notifications";
const { handle } = createNotificationHandlers({
  notifications: alerts,
  resolveTenant: companyRoutes.resolveTenant,
  authorize: companyAuthorizer(),
  links: { inbox: "/app/alerts", settings: "/app/alerts/settings", messages: "/app/messages" },
});
export { handle as GET, handle as POST };
export const runtime = "nodejs";
```

Then the glue: each package's event goes through its mapper to
`alerts.notify(...)` (scheduling's `schedulingAlertsFor`, the estimator's
`estimatorAlertsFor`, invoicing's, tenancy's, comms'), the alerts listener
BEFORE the comms listener, so a producer's own office email
(`officeRecipients`) finds the rows it claims. On a member's removal call
`alerts.forget({ tenantId, userId })`; on a role change `alerts.prune({
tenantId, userId, permissions })`.

### Who gets what

- Every kind names a permission: only active members holding it get it.
- A **routed** kind (new estimate requests, visit requests and customer
  changes, invoices) goes to the people the owner chose in Alert settings, and
  with nobody chosen to **the owner**. A list whose people have all left is the
  owner again: never nobody. The owner's email copies go to the business email
  when `ownerEmail` answers one. Up to five extra addresses per list.
- While a list is on "The owner", the owner's own choice for a kind decides
  that business-email copy too: "In the app" means no email for it at the
  business address either. Alert settings says so, on the kind and on the
  list's card.
- A visit change also reaches the crew assigned to it (`schedule.route`), at
  their own crew page.
- Whoever caused it is never alerted about it.
- Each person picks "In the app" or "In the app and by email" per kind; the
  kind's default applies until they do.
- Reads follow what the person may get NOW: someone moved from admin to Crew
  stops seeing the old lead alerts on their next poll.

### Permissions

Spread `notificationsPermissions` into your tenant catalog:

| Key | Who by default | Lets them |
| --- | --- | --- |
| `alerts.view` | owner, admin, member, viewer, crew | See their own alerts and choose how they get them |
| `alerts.manage` | owner, admin | Choose who hears about new work |

## In an app that isn't ours (Ridgeline)

Ridgeline has its own sign-in, its own `users` and roles tables, Prisma
migrations, nodemailer, whole-number company ids, and its own table literally
named `notifications`. This is the whole install, in order. The snippets use
Ridgeline's own `db`, `prisma`, `getSession`, `transporter`, `logger` and
`recordAudit`; every other name is defined in a snippet here.

**1. The database driver.** Use drizzle on node-postgres (`drizzle(pool)` from
`drizzle-orm/node-postgres`) or `neon-serverless`. drizzle's `neon-http` is
NOT supported: it has no interactive transactions (storage's allowance lock
needs one, and both packages share the same db).

```ts
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
export const db = drizzle(new Pool({ connectionString: process.env.DATABASE_URL }));
```

**2. The tables, under your own schema.** Ridgeline keeps package tables in an
`adminigloo` Postgres schema, so nothing collides with its own
`public.notifications`:

```ts
// db/adminigloo-alerts.ts
import { defineNotificationTables } from "@adminigloo/notifications/schema";
export const alertTables = defineNotificationTables({ schema: "adminigloo" });
export const aigAlerts = alertTables.alerts;         // export the tables BY NAME…
export const aigAlertChoices = alertTables.choices;
export const aigAlertRouting = alertTables.routing;
```

**With Prisma, always a schema, never only a prefix.** `prisma migrate`
compares `public` with `schema.prisma`, which has no model for these tables.
Tables under a prefix in `public` (`{ prefix: "aig_" }`) get a `DROP TABLE` in
your next migration, and deploying that deletes every alert, choice and list.
A Postgres schema of their own is invisible to Prisma. A prefix (alone, or
with a schema) is for apps on drizzle-kit or plain SQL.

Pass `tables: alertTables` to `createNotifications`. It is **required**:
there is no default that could quietly point every statement at YOUR
`notifications` table. If you use drizzle-kit, never `export * from
"@adminigloo/notifications/schema"` under a prefix or schema: that line also
exports the default set and drizzle-kit would create (or diff against) a
second `notifications` table.

**3. The SQL, through Prisma's own history.**

```sh
npx prisma migrate dev --create-only --name adminigloo_alerts
```

Paste the output of `notificationsSql({ schema: "adminigloo" })` (print it once
with `node -e 'console.log(require("@adminigloo/notifications").notificationsSql({ schema: "adminigloo" }))'`)
into the new `migration.sql`, then:

```sh
npx prisma migrate dev
```

Every environment gets it the way it gets your own changes. The SQL is one
statement that opens with its guards: if a table of the target name exists
and isn't AdminIgloo's (it lacks any of the package's columns), it stops with
"A table named … already exists and isn't AdminIgloo's …" and creates nothing.

Without Prisma, run it with `psql` in one go, stopping at the first error:

```sh
node -e 'process.stdout.write(require("@adminigloo/notifications").notificationsSql({ schema: "adminigloo" }))' > adminigloo-alerts.sql
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f adminigloo-alerts.sql
```

The shipped files are the same SQL for the default names
(`require.resolve("@adminigloo/notifications/sql/notifications-0.2.0.sql")`
finds them).

**4. Your seams.** `people` from your own tables (whole-number ids as text),
with at least one person per company marked `isOwner` (otherwise a routed
alert goes to everyone who holds its permission, and you are told);
`authorize` from your own session:

```ts
// lib/alerts.ts
import { createNotifications, defineAlertRegistry, type AlertPerson } from "@adminigloo/notifications";
import { alertTables } from "@/db/adminigloo-alerts";
import { ridgelineAlertKinds } from "./alert-kinds"; // step 5
import { sendAlertEmail } from "./alert-email";      // step 7

/** A company's id exactly as Ridgeline stores it: "17", never "017", "0x11" or "17.0". Anything else: null. */
export const companyIdFrom = (text: string | null | undefined): string | null => (text && /^[1-9]\d*$/.test(text) ? text : null);

/** The company's ACTIVE members holding `permission` now. A suspended company has none. */
export const alertsPeople = async (tenantId: string, permission: string): Promise<AlertPerson[]> => {
  const rows = await prisma.membership.findMany({
    where: { companyId: Number(tenantId), active: true, company: { status: "active" }, role: { permissions: { has: permission } } },
    include: { user: true, role: true },
  });
  return rows.map((m) => ({ userId: String(m.userId), name: m.user.name, email: m.user.email, isOwner: m.role.key === "owner" }));
};

export const alerts = createNotifications({
  db,
  tables: alertTables,
  registry: defineAlertRegistry([ridgelineAlertKinds]),
  people: alertsPeople,
  email: sendAlertEmail,
  onError: (error, context) => logger.error({ err: error, ...context }, "alerts"),
});

/** A member of THIS company, which isn't suspended, holding THIS permission. */
export const authorize = async (req: Request, permission: string, tenantId: string) => {
  const session = await getSession(req);                 // your own sign-in
  if (!session) return new Response("Sign in", { status: 401 });
  const member = await prisma.membership.findFirst({
    where: { userId: session.userId, companyId: Number(tenantId), active: true, company: { status: "active" } },
    include: { role: true },
  });
  if (!member) return new Response("Not a member", { status: 403 });
  return member.role.permissions.includes(permission) ? { userId: String(session.userId) } : false;
};
```

`authorize` must name the person (`{ userId }`): alerts are per person, and a
bare `true` is refused "Sign in again to see your alerts." It must check the
permission it is asked about, not only membership: the handlers ask it once
per permission to decide which alerts a person may see.

`Number(tenantId)` is safe here only because `resolveTenant` (step 6) hands
over nothing but the id as stored. The package keeps a company's alerts
under the exact text it is given; if "017" were let through, `Number` would
authorise it as company 17 and every look-alike would be a second set of
alerts and choices.

**5. Your own alerts.** Ridgeline's events are its own, so it declares its own
kinds of alert, once, in a fragment:

```ts
// lib/alert-kinds.ts
import { defineAlertKinds } from "@adminigloo/notifications";

export const ridgelineAlertKinds = defineAlertKinds({
  routings: [
    // One card in Alert settings: who hears about new jobs (nobody picked: the owner).
    { key: "ridgeline-jobs", label: "New jobs booked online", permission: "jobs.view" },
  ],
  kinds: [
    {
      key: "ridgeline.job.booked",          // PERMANENT: stored on every alert and every choice
      label: "A customer books a job",      // what Alert settings shows
      category: "Jobs",                     // the heading it is listed under
      audience: {
        permission: "jobs.view",            // only active members holding it get it
        routing: "ridgeline-jobs",          // …the people the owner picked for this card
        assigned: { permission: "jobs.view" }, // …and the techs on the job
      },
      defaultChannel: "email",              // "in_app" or "email", until the person chooses
    },
    {
      key: "ridgeline.job.cancelled",
      label: "A customer cancels a job",
      category: "Jobs",
      audience: { permission: "jobs.view" }, // no routing: everyone holding jobs.view
      defaultChannel: "in_app",
    },
  ],
});
```

The rules are checked when the file loads; a bad kind throws
`InvalidAlertKindError` naming what is wrong. A kind's `key` is two to four
lower-case parts joined by dots, each starting with a letter
(`ridgeline.job.booked`), at most 64 characters, and never changes once
alerts exist. A `label` is at most 80 characters, a `category` at most 40, a
list's `key` 2 to 32 lower-case letters, digits or dashes. A kind that names a
`routing` needs that list declared. Optional: `description`, `email: false`
(only ever "In the app"), `order`.

Then, where the thing happens, right after it is saved:

```ts
import { alerts } from "@/lib/alerts";

const report = await alerts.notify({
  tenantId: String(job.companyId),
  kind: "ridgeline.job.booked",
  title: `${job.customerName} booked ${job.serviceName}`, // one line, 1 to 200 characters, plain text
  body: job.notes ?? null,                                 // plain text, up to 2000 characters, or null
  href: `/jobs/${job.id}`,                                 // a path on THIS site, or null
  dedupeKey: `ridgeline.job.booked:${job.id}`,             // from the fact: the same booking never alerts twice
  subject: { type: "ridgeline.job", id: String(job.id) },
  actorUserId: session ? String(session.userId) : null,    // never alerted about their own change; null for a customer
  assignedUserIds: job.techIds.map(String),                // who `audience.assigned` means for this job
  replyTo: job.customerEmail ?? null,                      // a reply to the email copy goes to the customer
});
if (report.problems.length > 0) logger.warn({ problems: report.problems }, "alerts");
```

`notify` never throws. A draft it refuses (an unknown kind, a title with a
line break, an `href` that isn't a path on this site) is skipped and named in
`report.problems`, so log them. An `href` starts with a single `/` and has no
`//` at the start, no backslash and no spaces. The `dedupeKey` (1 to 200
characters) is what makes a retried request, or a job saved twice, one alert:
build it from the thing that happened, never from the time.

**6. Mount the handlers next to your server actions.**

```ts
// lib/alerts-handlers.ts
import { createNotificationHandlers } from "@adminigloo/notifications";
import { alerts, authorize, companyIdFrom } from "./alerts";

export const handlers = createNotificationHandlers({
  notifications: alerts,
  // The company from the path, exactly as stored (never a query, never a look-alike).
  resolveTenant: (req) => companyIdFrom(new URL(req.url).pathname.split("/")[3]),
  authorize,
  links: { inbox: "/alerts", settings: "/alerts/settings" },
  audit: (event) => recordAudit(event), // who changed who hears about new work (below)
});
```

```ts
// app/api/alerts/[company]/[...path]/route.ts
import { handlers } from "@/lib/alerts-handlers";
export const GET = (req: Request) => handlers.handle(req);
export const POST = (req: Request) => handlers.handle(req);
export const runtime = "nodejs";
```

A POST is taken only from this site's own pages: the browser's own
`Sec-Fetch-Site: same-origin`, or an `Origin` equal to the site's. A page on
another subdomain of your domain is refused too. `audit` hears about every
change to who hears about new work, after it is saved; one that adds an
outside address is `alerts.routing.address-added`. Spread
`notificationsAuditedActions` into your audit vocabulary for their labels.

**7. Email through nodemailer**, with the package's own rendering so what a
customer typed is never markup in a staff email:

```ts
// lib/alert-email.ts
import { renderAlertEmail, type AlertEmailMessage, type AlertEmailOutcome } from "@adminigloo/notifications";

const APP_URL = process.env.APP_URL ?? "https://app.ridgeline.example";

export async function sendAlertEmail(m: AlertEmailMessage): Promise<AlertEmailOutcome> {
  let message;
  try {
    const company = await prisma.company.findUniqueOrThrow({ where: { id: Number(m.tenantId) } }); // the alert's own company
    const mail = renderAlertEmail(m, {
      businessName: company.name,
      link: m.href ? new URL(m.href, APP_URL).href : null,
      settingsLink: new URL("/alerts/settings", APP_URL).href,
    });
    message = { from: `${company.name} <alerts@ridgeline.example>`, to: m.to, replyTo: m.replyTo ?? undefined, subject: mail.subject, text: mail.text, html: mail.html };
  } catch (error) {
    return { status: "failed", error: String(error), retryable: true }; // nothing has gone yet: try again later
  }
  try {
    await transporter.sendMail(message);
    return { status: "sent" };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    // Refused before the message went (the mail server's name, or its sign-in): safe to try again.
    if (code === "EDNS" || code === "EAUTH") return { status: "failed", error: String(error), retryable: true };
    throw error; // anything else may have gone already: it isn't sent again
  }
}
// nodemailer has no idempotency key: leave emailIdempotent unset (false).
```

Why `emailIdempotent` stays false: SMTP can't drop a repeat. So a send that
was cut off mid-way, or a seam that threw (the mail server may have taken the
message just before the connection dropped), is never tried again; it is
marked "It may not have gone, and it isn't sent again so nobody gets two."
Answer `{ status: "failed", retryable: true }` only for a failure you know
happened before the message went, as above. With Resend, set it to true and
the alerts cron retries those too, safely.

**8. Files** are `@adminigloo/storage`'s; see its README.

**9. The cron** (any scheduler that can call a route with a bearer secret):

```ts
// app/api/cron/alerts/route.ts
import { alerts } from "@/lib/alerts";

export async function GET(req: Request) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) return new Response("Not allowed", { status: 401 });
  const active: { id: number }[] = await prisma.company.findMany({ where: { status: "active" }, select: { id: true } });
  const sent = await alerts.deliverPendingEmails({ tenantIds: active.map((company) => String(company.id)) }); // REQUIRED: only these companies' emails go
  const cleaned = await alerts.cleanup(); // read alerts after 30 days, any after 180
  return Response.json({ sent, cleaned });
}
export const runtime = "nodejs";
```

`tenantIds` is required: a suspended company's waiting emails must not go.
Before each retry the person is checked again; someone removed, demoted or
taken off a list since gets nothing.

**10. Check your install.** Your sign-in and your company routing are what
keep one company's alerts from another. Run this against YOUR seams and show
the business owner a passing list:

```ts
// tests/alerts-install.test.ts
import { expect, it } from "vitest";
import { checkHostSeams } from "@adminigloo/notifications/testing";
import { alertsPeople, authorize } from "@/lib/alerts";
import { handlers } from "@/lib/alerts-handlers";
import { sessionCookieFor } from "./helpers"; // your own: a signed-in session cookie for a user

it("keeps each company's alerts to itself", async () => {
  // User 4021: a member of company 17 (not 18), and of company 19, which is suspended.
  const cookie = await sessionCookieFor("4021");
  const result = await checkHostSeams({
    handlers,
    companyA: "17",
    companyB: "18",
    member: { userId: "4021" },
    request: (company, path, init) =>
      new Request(`https://ridgeline.test/api/alerts/${company}/${path}${init?.query ? `?${new URLSearchParams(init.query)}` : ""}`, {
        method: init?.method ?? "GET",
        headers: { cookie, "sec-fetch-site": "same-origin", "content-type": "application/json" },
        ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      }),
    people: alertsPeople,
    // Both of these, or their two lines fail as "Not checked: pass …".
    authorize,
    suspendedCompany: "19",
  });
  for (const check of result.checks) console.log(`${check.name}: ${check.ok ? "passed" : `FAILED (${check.detail})`}`);
  expect(result.ok).toBe(true);
});
```

`request` may also be `async` (and await the cookie itself). It checks that
the member sees their alerts in A, can't read B's, can't reach B's by naming A
in the address, can't open A at a look-alike address ("017" for 17), that a
request from another website is refused, that your `people` keeps to the
company it is asked about, that your `authorize` refuses a permission the
member doesn't hold, and that a suspended company gets no alerts. Leave out
`authorize` or `suspendedCompany` and that line FAILS, "Not checked: pass
…", so the list is never all passed about a promise nobody checked. It
writes nothing.

## Not included (Tenancy 2b-1)

- **The feedback board per company, and the complete board** — Tenancy 2b-2.
  It will keep screenshots as these private files and send its alerts through
  these notifications. Until then, feedback screenshots stay on the public
  Blob store as in 2a.
- **The assistant answering customers on a public page.** Each company's assistant is its team's, behind sign-in (Tenancy 2b-3).
- **Website analytics, SEO/AEO and book-a-call (booking) per company** —
  Tenancy 2b-4.
- **Text (SMS) and push alerts.** Alerts come in the app and by email — S9.
- **Plans, limits and billing enforcement** — the billing chunk. Each
  company's storage allowance is one setting for everyone
  (`FILES_ALLOWANCE_MB`) until then; the seam the billing chunk fills is
  there.
- **Stripe Connect** (customers paying a company by card).
- **Custom domains.**
- **Virus scanning of uploads.** Files are checked for their type and size
  only.
- **Uploads over 4 MB, and uploads straight from the browser to storage.**
  Phone photos are made smaller before they're sent; other files over 4 MB are
  refused with a plain sentence.
- **Serving files straight from S3 or R2 by presigned link.** Every private
  file is sent through the site's own route.
- **Thumbnails.** Photos are shown at their (shrunk) size.
- **Turning a kind of alert off.** Each kind comes in the app, or in the app
  and by email; who gets the work alerts is the owner's choice.
- **Alerts from your other companies in the bell.** The bell shows the
  company you're working in.
- **A daily or weekly digest of alerts.**
- **Customers seeing files** (photos on their quote or invoice page).
- **Editing the wording of the team alert email** beyond the Messages screen
  (it is the `team_alert` message there).
- **Carrying 2a's per-feature alert address lists over.** With alerts
  installed, the people (and extra addresses) are chosen again in Alert
  settings; the old lists are no longer read.
- **Alert settings in a single-business project without an admin shell.** Its
  staff get the bell; the office emails keep 2a's lists.
- **A transactional outbox.** Alerts are written right after the change they
  report (D8); the events package (S2) brings the outbox.
- **Crew alerts when the office moves, reassigns or cancels their visit.**
  Only a customer's change alerts the crew.
- **An alert when a customer opens a quote** (invoices only).
- **A history of cron runs, and an alert when a cron fails.**
- **Alerts for the platform owner** (a new company, a company out of
  storage). A company's storage refusal is reported in `/admin/errors` once a
  day.
- **Giving one company more storage than the others.** `FILES_ALLOWANCE_MB`
  is one number until the billing chunk.
- **Checking an address before it gets a company's alert emails.** The owner
  adds up to five per group; the company's team sending allowance bounds what
  they get.
