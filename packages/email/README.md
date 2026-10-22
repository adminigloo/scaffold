# @adminigloo/email

Transactional email with a delivery log. A booking confirmation, an estimate,
an invoice: one `send()` and a row that says what happened to it.

With no API key a send is recorded as **skipped** instead of throwing, so every
feature that sends mail keeps working before anyone has found a credential. Add
the key later and the same code starts delivering.

```ts
import { createEmailSender } from "@adminigloo/email";

const email = createEmailSender({ apiKey: process.env.RESEND_API_KEY, from: process.env.EMAIL_FROM! });
const outcome = await email.send({ to: "sam@example.com", subject: "Your visit is booked", text: "See you Tuesday at 9." });
await db.insert(emailEvents).values(outcome.log); // the delivery log row
```

## What each install gets you

| You install | You get | You wire yourself |
| --- | --- | --- |
| `@adminigloo/email` | `createEmailSender` (Resend built in, or your own transport), the sender-address rules, per-message sender name and reply-to, the delivery webhook check, and the env schema. | The API key (optional), `EMAIL_FROM`, and where the log rows go. |
| `@adminigloo/email/schema` | The `email_events` table (the delivery log). | Your migration. |
| `@adminigloo/email/emails` | The email templates (React Email): subject, markup and plain text. A separate entry so a webhook or a worker that only sends never loads a renderer. | Nothing; never bundle it into a Next.js server component graph (see the entry's comment). |

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
npm install @adminigloo/email     # pnpm add / yarn add work the same
```

## Configuration

| Variable | Required | What it is |
| --- | --- | --- |
| `EMAIL_FROM` | yes | The verified sending address, bare or `Name <address>`. |
| `EMAIL_REPLY_TO` | no | Where replies go when a message doesn't say. Unset: replies go to `EMAIL_FROM`. |
| `RESEND_API_KEY` | no | `re_…`. Without it every send is logged `skipped`. |
| `RESEND_WEBHOOK_SECRET` | no | `whsec_…`, for `verifyDeliveryWebhook`. |

`emailServer` is the zod schema for these; `EMAIL_ENV_GROUP` names the ones
that come as a set. A `from` or `replyTo` that can't become an address fails
at construction, pointing at the variable, not at the first customer who
didn't get a receipt.

## Sending

`email.send(message)` never throws for a delivery problem; it returns an
outcome with `status` (`sent`, `skipped`, `failed`) and `log` (the row to
insert). A message has `to`, `subject`, `text` and/or `html`, and optionally
`template`, `tenantId`, `metadata`, (0.3) `fromName` and `replyTo`, and (0.5)
`headers` and `idempotencyKey`.

### Extra headers and retries (0.5)

- **`headers`** adds message headers, such as RFC 8058's one-click
  unsubscribe pair that Gmail and Yahoo ask bulk senders for:

  ```ts
  await email.send({
    to, subject, text, html,
    headers: {
      "List-Unsubscribe": `<${oneClickUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  });
  ```

  Names are letters, digits and hyphens; each value is one line (a CR or LF
  would start a header you never wrote) of at most 2,000 characters; at most
  20. The headers the message's own fields write (From, To, Cc, Bcc, Subject,
  Reply-To, Sender, Date, Message-ID and the MIME headers) are refused with
  `EmailMessageInvalidError` (`field: "headers"`), on a laptop with no key as
  well, so the mistake is found before it ships.
- **`idempotencyKey`** makes a repeat of the same message a no-op at the
  provider: Resend's `Idempotency-Key`, honoured for 24 hours. Give it the
  same key on every retry of one message (`digest:morning:{person}:{day}`),
  and a retry after a timeout never sends it twice.

A message with neither reaches a custom transport exactly as before.

## Companies (Tenancy 2a)

One site, many businesses, ONE verified sending address. Each message can now
say whose it is:

- **`fromName`** puts the business's name on the site's address:
  `Summit Window Co. <hello@yoursite.com>`. Customers see who wrote to them;
  no company has to verify a domain. The name is cleaned by
  `sanitizeDisplayName` (line breaks and other control characters become
  spaces, runs of spaces collapse, at most 64 characters); commas and quotes
  are kept, and the From header quotes them. A name with nothing left uses the
  sender's own.
- **`replyTo`** sends the customer's reply to the business, not the platform.
  An address that doesn't parse is refused with `EmailMessageInvalidError`
  (`field: "replyTo"`), never silently dropped.
- The log row records the From actually used.

```ts
await email.send({
  to: visit.email,
  subject: "Your visit is booked",
  text,
  tenantId: company.id,
  fromName: company.name,          // from tenancy.companyProfile(id)
  replyTo: company.replyTo,        // the company's contact email, else its owner's
});
```

You rarely call this yourself: `@adminigloo/comms` 0.3 does it for every
feature, from its `identity(tenantId)` seam.

**A foreign host** (your own tenant model) passes the same two fields from
wherever it keeps a business's name and inbox.

## Delivery webhooks

`verifyDeliveryWebhook(body, headers, secret)` checks Resend's signature and
returns the event; `mapDeliveryStatus` turns it into a log status, and
`shouldApplyDeliveryStatus` keeps a late "delivered" from overwriting a
"bounced".

## Not included

- **Logo and colour inside emails.** Emails carry the company's name and
  reply-to; their bodies are plain text.
- **Per-company sending domains.** Every company sends from the site's one
  verified address, under its own name.
- **Payments to companies, plans and billing per company, custom domains,
  impersonation, per-company SEO** (Tenancy 2a: not included anywhere).
- **Per-company boards and widgets for feedback, notifications, files, the
  assistant, analytics, SEO/AEO and book-a-call**: Tenancy 2b.
- **A second provider built in.** Resend is built in; anything else is a
  `send` transport you pass.
