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
