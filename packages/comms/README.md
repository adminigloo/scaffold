# @adminigloo/comms

Templated email (and SMS) for a business: message templates with
`{{variable}}` placeholders the owner can edit, a delivery log of everything
sent, and a queue of messages to send later (a reminder the day before a
visit) with a cron that drains it. Provider-agnostic: you pass the function
that sends, so Resend, SMTP or anything else works.

`@adminigloo/scheduling/comms` is built on it: the visit emails are comms
templates, and the reminder is a queued message.

```
@adminigloo/comms          templates, sendNow, the queue, runDueMessages, the sender types
@adminigloo/comms/schema   the drizzle pgTables
```

Peers: `drizzle-orm` (^0.45) and `zod` (^3.25 or ^4).

## Install

Private, on GitHub Packages, like every `@adminigloo/*` package. In your
project's `.npmrc`:

```
@adminigloo:registry=https://npm.pkg.github.com
```

and a token with `read:packages` in your user-level `~/.npmrc`. Then:

```bash
npm install @adminigloo/comms
```

## Tables

Three, in your database: `comms_templates`, `comms_messages` (the delivery
log) and `comms_scheduled` (the queue). A drizzle host spreads the schema in
and generates a migration:

```ts
// src/db/schema.ts
export * from "@adminigloo/comms/schema";
```

A host on Prisma or plain SQL generates the SQL with drizzle-kit from
`./node_modules/@adminigloo/comms/dist/schema.js` (the scheduling README's
"Schema and migration" shows the config, the Prisma steps and the DDL).
**Without these tables nothing is sent**, and a feature built on comms says
so in its error.

## Senders

`CommsSenders` is yours to build: `{ email?: (message) => Promise<result> }`.
A channel with no sender logs each message as `skipped` instead of throwing,
so features keep working before mail is set up.

The email sender gets an `OutboundEmail`: `to`, `subject`, `body` (plain
text), `html` (the same text as escaped HTML, links clickable and wrapped),
and `idempotencyKey` when there is one. It returns the provider's id. A throw,
or a result with `error`, `ok: false` or `status: "failed"`, is logged as a
failure.

```ts
// Resend
import { Resend } from "resend";
import type { CommsSenders } from "@adminigloo/comms";

const resend = new Resend(process.env.RESEND_API_KEY);
export const senders: CommsSenders = {
  email: (m) =>
    resend.emails.send(
      { from: process.env.MAIL_FROM!, to: m.to, subject: m.subject, text: m.body, html: m.html },
      { idempotencyKey: m.idempotencyKey },
    ),
};
```

```ts
// SMTP, through nodemailer
import nodemailer from "nodemailer";
import type { CommsSenders } from "@adminigloo/comms";

const transport = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: 587,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  // Short timeouts: a relay that accepts the connection and never answers
  // would otherwise hold the send (and whatever request is waiting on it).
  connectionTimeout: 5_000,
  greetingTimeout: 5_000,
  socketTimeout: 10_000,
});

export const senders: CommsSenders = {
  email: async (m) => {
    const info = await transport.sendMail({ from: process.env.MAIL_FROM, to: m.to, subject: m.subject, text: m.body, html: m.html });
    return { messageId: info.messageId };
  },
};
```

## Sending

```ts
import { enqueueMessage, sendNow, upsertTemplate } from "@adminigloo/comms";

await upsertTemplate(db, { tenantId, key: "welcome", subject: "Welcome, {{name}}", body: "Hi {{name}}, …" });

await sendNow(db, { tenantId, to: "pat@example.com", templateKey: "welcome", vars: { name: "Pat" } }, senders);

await enqueueMessage(db, {
  tenantId, to: "pat@example.com", templateKey: "reminder", vars: { when: "Tue 9:00 AM" },
  sendAt: new Date("2026-11-02T14:00:00Z"),
  refType: "visit", refId: visit.id,            // so cancelScheduled can withdraw it
  dedupeKey: `visit:${visit.id}:reminder:1`,    // queue it once
});
```

Every send, sent, skipped or failed, is a row in `comms_messages`.

## The cron

Queued messages go out when you run `runDueMessages`. Call it from a route on
a schedule, protected by a secret:

```ts
import { runDueMessages } from "@adminigloo/comms";

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return new Response("Not found", { status: 404 });
  return Response.json(await runDueMessages(db, senders, { timeBudgetMs: 20_000 }));
}
```

Once a day is enough for "the day before" messages; every 15 minutes makes
them land closer to their time. A row more than 48 hours late is expired, not
sent. Failed sends retry with backoff (5, 10, 20, 40 minutes), then end
`failed`. `beforeSend(row)` lets a feature re-check each message against live
data just before it goes (`"send"`, `"skip"`, or new `to` / `vars`).
Scheduling's cron route shows the whole thing, in the scheduling README.

## Companies (Tenancy 2a)

One deployment, many businesses, each sending in its own name.

**Who a company's messages come from: `identity(tenantId)`.** Pass it with the
senders. comms asks it once per company per drain (once per message for
`sendNow`) and sends the email with the company's name on the site's one
verified address and its reply-to; every text starts with that name. With
`@adminigloo/tenancy`:

```ts
import { createEmailSender } from "@adminigloo/email";

const email = createEmailSender({ apiKey: process.env.RESEND_API_KEY, from: process.env.EMAIL_FROM! });
const senders = {
  // Each message carries tenantId, fromName and replyTo; hand them to @adminigloo/email.
  email: async (m) => {
    const out = await email.send({ to: m.to, subject: m.subject, text: m.body, html: m.html, tenantId: m.tenantId, fromName: m.fromName, replyTo: m.replyTo });
    if (out.status === "failed") throw out.error;
    return out.status === "sent" ? { messageId: out.messageId } : { status: "skipped" };
  },
  identity: async (tenantId: string) => {
    const company = await tenancy.companyProfile(tenantId);
    return company ? { name: company.name, replyTo: company.replyTo } : null;
  },
};
```

A **foreign host** returns `{ name, replyTo }` from its own business table.
If `identity` throws, that message is logged `failed` with "couldn't read who
this business sends as" and retried: a company's email never goes out under
the platform's name, where the customer's reply would reach the wrong business.
A `replyTo` that isn't an email address is dropped (the sender's default
applies), never sent broken. Without `identity`, 0.2's behaviour: every message
under the sender's defaults.

`OutboundEmail` now carries `tenantId`, `fromName` and `replyTo`;
`OutboundSms` carries `tenantId`. The log records `from_name` and `reply_to`
for every email.

**The cron, per company.** `runDueMessages(db, senders, { tenantIds })` drains
only those companies' queued messages (an empty list drains none), and
everything the run writes — the clean-up of stuck messages included — stays
inside them, with counts that are theirs alone: one company's "Send what's due
now" never moves another company's messages. The companies TAKE TURNS: every
company's oldest due message is claimed, then every company's second, and so
on, so when `limit` or `timeBudgetMs` ends a run, one company's backlog of
hundreds never holds back another company's single reminder. With tenancy,
pass the active ones, so a suspended company's reminders wait (and expire
after `maxLatenessMs`):

```ts
const tenantIds = await tenancy.activeCompanyIds();
return Response.json(await runDueMessages(db, senders, { tenantIds, timeBudgetMs: 20_000 }));
```

**The staff console's routes: `createCommsAdminHandlers`.** Status (which
channels are set up), the templates (read, edit, turn on or off), recent
messages, and "send due messages now", each scoped to the company in the
path. `@adminigloo/comms-widget`'s `<MessagesConsole>` talks to it.

```ts
import { COMMS_ADMIN_ROUTES, createCommsAdminHandlers } from "@adminigloo/comms";
import { createCompanyRouteSeams } from "@adminigloo/tenancy/server";

const seams = createCompanyRouteSeams({ tenancy, principal: (req) => getSignedInUser(req) });
const messages = createCommsAdminHandlers({
  db,
  senders,
  resolveTenant: seams.resolveTenant,   // the id in /api/app/{id}/messages/…
  authorize: seams.authorize,           // signed in, a member, not suspended, holds the key
});
// app/api/app/[tenantId]/messages/[...path]/route.ts
export const GET = messages.handle;
export const POST = messages.handle;
```

A foreign host passes its own `resolveTenant(req)` and
`authorize(req, permission, tenantId)` returning `{ userId }`, `false` (the
handler's own 403), or a `Response` to send as is.

The console's status counts queued messages that MISSED their run
(`scheduled.behind`: due over an hour ago and still waiting) beside the ones the
job never reached at all (`scheduled.late`, over 26 hours), so an owner hears
when the site sends more than its job keeps up with.

**A sending allowance per business: `allowance`.** On a platform where anyone
can sign up a company, every company's mail leaves from your one domain, and
one company sending thousands of messages could get it throttled for all of
them. Pass `allowance({ tenantId, channel, to, templateKey })` with the
senders: it is asked right before a message would leave (never for one that
wasn't going out), `false` holds it — logged `failed` with
`ALLOWANCE_HELD_MESSAGE` ("held: …"), and a queued message is retried later —
and a throw lets it through, so a broken limiter stops nobody's mail.
create-app counts it on the app's limiter: 100 an hour and 500 a day per
company, 20 and 100 in its first week.

**A message's own reply-to.** `sendNow(db, { …, replyTo })` sends that one
message's replies somewhere else — a notice to a business's office replies to
the customer it is about. Ignored unless it is an email address.

Permissions (`commsPermissions`): `comms.view` (see the templates and the log)
and `comms.manage` (edit, turn on or off, send due now). `COMMS_ADMIN_ROUTES`
lists every route with its permission, for a host's own tests.

## Upgrading from 0.2

Two new columns on the delivery log. A drizzle host regenerates its migration;
anyone else runs:

```sql
alter table comms_messages add column if not exists from_name text, add column if not exists reply_to text;
```

Nothing else changes: `identity` and `tenantIds` are optional, and without
them 0.3 sends exactly as 0.2 did.

## Not included

- **Logo and colour inside emails.** Emails carry the company's name and
  reply-to; their bodies are plain text.
- **Emailing customers about a time-zone correction** made in company settings.
- **Payments to companies, plans and billing per company, custom domains,
  impersonation, per-company SEO.**
- **Per-company boards and widgets for feedback, notifications, files, the
  assistant, analytics, SEO/AEO and book-a-call**: Tenancy 2b.
- **Per-company sending domains or phone numbers.** One verified address and
  one SMS sender for the site, each message in its company's name.
