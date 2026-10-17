# @adminigloo/invoicing

Invoices for a business that does the work and then bills for it: line items,
server-owned totals in integer cents, part payments with the status worked out
for you (sent, part paid, paid, overdue), and a private link so a customer can
open their invoice without an account.

```
@adminigloo/invoicing          invoices, lines, payments, the rules; the HTTP handlers; the settings section
@adminigloo/invoicing/schema   the drizzle pgTables
@adminigloo/invoicing/comms    the invoice email (built on @adminigloo/comms)
```

Peers: `drizzle-orm` and `zod`; `@adminigloo/comms` (optional, for `./comms`).
The screens are `@adminigloo/invoicing-widget`.

## What each install gets you

| You install | You get | You wire yourself |
| --- | --- | --- |
| `@adminigloo/invoicing` | `createInvoice`, `listInvoices`, `getInvoice`, lines, payments (record and reverse), status changes, totals and balances, the customer's link (`getInvoiceByToken`), and (0.3) the staff and public HTTP handlers, the permissions, the `invoicing` settings section and a checklist item. | The tables in your migration, two routes, and who may do what (`authorize`). |
| `@adminigloo/invoicing/comms` | `createInvoicingComms`: the invoice email (its templates, sending it in the company's name with a link to the invoice page, then wiping the link from the log). | Comms' senders. |
| `@adminigloo/invoicing-widget` | The ledger, the editor and the customer's invoice page. | The pages that render them. |
| `@adminigloo/invoicing` 0.4 with `@adminigloo/notifications` / `@adminigloo/storage` | Alerts when an invoice is opened, paid in full or goes overdue, and photos and files on an invoice (see "Alerts and files"). | `onEvent` → `alerts.notify`, the daily overdue sweep, `invoicingFileRecords` in `createStorage`. |

## Install

Private, on GitHub Packages, like every `@adminigloo/*` package. In your
project's `.npmrc`:

```
@adminigloo:registry=https://npm.pkg.github.com
```

and a token with `read:packages` in your user-level `~/.npmrc`. Then:

```bash
npm install @adminigloo/invoicing
```

## Tables

Three: `invoices`, `invoice_items`, `invoice_payments`. A drizzle host spreads
the schema in and generates a migration:

```ts
// src/db/schema.ts
export * from "@adminigloo/invoicing/schema";
```

## The rules, in plain words

- Totals are computed on the server from the lines (quantity × unit price,
  discount, tax), in cents. A client never sends a total.
- A draft can be edited; once sent, its lines are fixed. A draft can't take a
  payment ("Send this invoice before recording a payment on it.").
- Payments move the status: part paid, then paid. Reversing a payment moves it
  back. Overdue is worked out from the due date in the business's time zone.
- The customer's link opens a sent invoice only; a draft link shows nothing.
  Opening it doesn't mark it viewed; the page posts `viewed` (so a link-preview
  bot doesn't count).

## Companies (Tenancy 2a)

One deployment, many businesses, each with its own invoices.

**Staff routes: `createInvoicingAdminHandlers`.** The ledger, one invoice,
create, edit lines, send, the customer's link, record or reverse a payment,
and status changes (void), every one scoped to the company in the path and
checked against `invoices.view` / `invoices.manage`
(`invoicingPermissions`). `INVOICING_ADMIN_ROUTES` lists them with their
permission.

**The customer's page: `createInvoicingHandlers`.** Opens an invoice by its
link, scoped to the company the URL names: a link from one company never opens
under another's name (`getInvoiceByToken(db, token, { tenantId })`). A
suspended company's page answers 409 `unavailable` with how to reach it
(`admit`). `INVOICING_PUBLIC_ROUTES` lists them.

**The business: `business(tenantId)`.** Its name, time zone, contact details,
logo and colour, and the `invoicing` settings section (payment instructions,
due days, a footer note) the owner fills in under company settings.

With `@adminigloo/tenancy`:

```ts
import {
  createInvoicingAdminHandlers,
  createInvoicingHandlers,
  invoicingSettingsFragment,
  readInvoicingDetails,
  type InvoicingBusiness,
} from "@adminigloo/invoicing";
import { createInvoicingComms } from "@adminigloo/invoicing/comms";
import { createCompanyRouteSeams, createPublicCompanySeams } from "@adminigloo/tenancy/server";

// The settings section, in the registry tenancy is built with:
//   defineTenantSettings([companySettings, invoicingSettingsFragment, ...])

const business = async (tenantId: string): Promise<InvoicingBusiness | null> => {
  const company = await tenancy.companyProfile(tenantId);
  return company ? { ...company, ...readInvoicingDetails(company.settings.invoicing) } : null;
};
const invoiceUrl = async (token: string, tenantId: string) => {
  const company = await tenancy.companyProfile(tenantId);
  return `${origin}${company?.publicPath ?? ""}/invoice/${token}`;
};

const seams = createCompanyRouteSeams({ tenancy, principal: (req) => getSignedInUser(req) });
const mail = createInvoicingComms({ db, senders, invoiceUrl, business });
export const staffInvoices = createInvoicingAdminHandlers({
  db,
  resolveTenant: seams.resolveTenant,              // /api/app/{id}/invoices/…
  authorize: seams.authorize,
  business,
  invoiceUrl,
  sendInvoiceEmail: (input) => mail.sendInvoice(input),
  detailsHref: "/app/settings#invoicing",
});

const pub = createPublicCompanySeams({ tenancy });
export const customerInvoices = createInvoicingHandlers({
  db,
  resolveTenant: pub.resolveTenant,                // /api/t/{web address}/invoices/…
  admit: pub.admit,
  business,
});
```

**A foreign host** passes its own `resolveTenant(req)`,
`authorize(req, permission, tenantId)` (returning `{ userId }`, `false`, or a
`Response`), `admit(tenantId, req)` (`{ open: true }` or `{ open: false,
message }`) and `business(tenantId)` from its own tables. A single business
passes a fixed `tenantId` instead of `resolveTenant`.

**The checklist item**: `invoicingChecklistItems({ details: href })`, "Tell
customers how to pay you", done once payment instructions are saved.

## The invoice email (`./comms`)

`createInvoicingComms({ db, senders, invoiceUrl, business })`:
`sendInvoice({ tenantId, invoiceId, userId })` emails the customer in the
company's name with its reply-to and the link to its own invoice page;
`ensureTemplates(tenantId)` adds the invoice templates to a company's message
templates; `redactSent()` wipes sent invoice links from the delivery log (a
link in a log is a key to the invoice). The staff handler's `send` route uses
`sendInvoice` when you pass it as `sendInvoiceEmail`; without it, staff copy
the link and send it themselves.

An invoice email that a sending allowance held back (comms 0.3's `allowance`)
answers "Send" with `HELD_MESSAGE` — the company has sent as many emails as
the site allows for now — rather than "the email didn't go".

## Alerts and files (Tenancy 2b-1)

Invoicing 0.4 tells the business when a customer opens an invoice, when one is
paid in full and when one goes overdue, and lets staff keep photos and files on
an invoice. Nothing to migrate.

| Install | What you get |
| --- | --- |
| `@adminigloo/invoicing` alone | `onEvent` (`invoice.viewed`, `invoice.paid`), `listOverdueInvoices`, the alert kinds and their mappers, `invoicingFileRecords` (plain data and functions: you decide what to do with them) |
| with `@adminigloo/notifications` (+ widget) | "Pat Rivera opened invoice INV-2026-0042" in the owner's bell, an email when an invoice goes overdue, and the owner choosing who else hears, in Alert settings |
| with `@adminigloo/storage` (+ widget) | "Photos and files" on an invoice, seen by whoever can see invoices |
| with `@adminigloo/create-app` (`--invoicing --notifications --storage`) | all of it wired, with the overdue sweep in the daily alerts job |

**Events: `onEvent`.** Both handler factories take `onEvent(event)` and
`onEventError(error, event)`:

- `invoice.viewed`, from the customer's page, the FIRST time a customer opens
  a sent invoice (a second view, the business's own preview link and a draft
  tell nobody). The actor is the customer.
- `invoice.paid`, from the staff "record a payment" route, when that payment
  pays the invoice in full (a part payment, a refused payment and a reversal
  tell nobody; a reversal followed by a new full payment is a new event). The
  actor is the staff member.

Each event is `{ id, type, tenantId, invoiceId, occurredAt, actor, data: {
invoice, format } }`: the invoice after the change (number, status, customer,
total, paid, balance, due date, viewed and paid times, in cents and ISO text)
and how this business shows money and dates. Told after the change is saved,
awaited before the handler answers (so a serverless platform doesn't freeze it
half-way), and contained: a listener that throws goes to `onEventError`, and
the payment or the customer's page is unaffected. No link token is ever in an
event.

**The overdue sweep: `listOverdueInvoices(db, tenantId, { now, dueSince,
timeZone, limit })`.** Sent, viewed and part-paid invoices with money still
owed whose due date has passed, oldest due first (200 at most by default), in
one query. "Goes overdue" is an event, so only invoices that went past their
due date in the last 7 days are listed (`dueSince`, a calendar date, default
today minus 7 in `timeZone`): the first run after an upgrade doesn't email the
owner once per old invoice. Older ones are on the invoice list, marked
Overdue. Run it once a day per company and hand each result to
`invoicingOverdueAlert`; its key is the invoice and its due date, so a run
that repeats alerts nobody twice.

**The alert kinds** (`invoicingAlertKinds`), all under "Invoices", all for
people who can see invoices (`invoices.view`), all in the routing group
"Invoices opened, paid or overdue" (`invoices`: the owner, until the owner
chooses others):

| key | label | default | title | body |
| --- | --- | --- | --- | --- |
| `invoicing.invoice.viewed` | "A customer opens an invoice" | in the app | "Pat Rivera opened invoice INV-2026-0042" | "$1,250.00 due Nov 2, 2026" |
| `invoicing.invoice.paid` | "An invoice is paid in full" | in the app | "Invoice INV-2026-0042 is paid: $1,250.00 from Pat Rivera" | none |
| `invoicing.invoice.overdue` | "An invoice goes overdue" | in the app and by email | "Invoice INV-2026-0042 to Pat Rivera is overdue" | "$1,250.00 was due Nov 2, 2026." |

Money is in the business's currency and locale, dates in its time zone.
`invoicingAlertsFor(event, { hrefs: { invoice: "/app/invoices/{id}" } })` maps
an event; `invoicingOverdueAlert(tenantId, invoice, { hrefs, format })` maps
one sweep result. The shapes are declared here (no notifications import),
structurally the same as notifications' own.

```ts
import {
  invoicingAlertsFor,
  invoicingOverdueAlert,
  listOverdueInvoices,
  resolveInvoicingBusiness,
  type InvoicingEvent,
} from "@adminigloo/invoicing";

export async function alertOnInvoicingEvent(event: InvoicingEvent): Promise<void> {
  for (const draft of invoicingAlertsFor(event, { hrefs: { invoice: "/app/invoices/{id}" } })) await alerts.notify(draft);
}

// The daily job, per active company:
const b = resolveInvoicingBusiness(await business(tenantId));
for (const invoice of await listOverdueInvoices(db, tenantId, { timeZone: b.timeZone })) {
  const format = { currency: b.currency, locale: b.locale, timeZone: b.timeZone };
  await alerts.notify(invoicingOverdueAlert(tenantId, invoice, { hrefs: { invoice: "/app/invoices/{id}" }, format }));
}
```

**Photos and files on an invoice: `invoicingFileRecords(db, { invoiceHref })`.**
The invoice as a record `@adminigloo/storage` files belong to: type
`invoicing.invoice` ("Invoice", "Invoices"), seen by `invoices.view`, added
and removed by `invoices.manage`, labelled "Invoice INV-2026-0042 · Pat
Rivera" on the Files screen and opening at `invoiceHref` (`{id}` is the
invoice). Its `find` reads this company's invoices only, in one query.

```ts
const files = createStorage({ /* …, */ records: [...invoicingFileRecords(db, { invoiceHref: "/app/invoices/{id}" })] });
```

**In an app that isn't ours.** Pass `onEvent` to the handlers you already
mount, and send the events wherever your own notices go:

```ts
createInvoicingAdminHandlers({
  db, resolveTenant, authorize, invoiceUrl, business,
  onEvent: async (event) => {
    if (event.type === "invoice.paid") await slack.post(`${event.data.invoice.number} is paid`);
  },
  onEventError: (error) => logger.warn("invoice event listener failed", { error }),
});
```

## Pay now and deposits (0.5)

Customers pay an invoice — or its deposit first — by card from their link.
Pass a `payments` seam (`InvoiceCardPayments`: is this company ready, open a
Checkout Session, close one) and `invoicePageUrl` to `createInvoicingHandlers`,
and `payments` to `createInvoicingAdminHandlers` (voiding an invoice closes its
open Sessions). create-app wires it to @adminigloo/stripe; anything else can
implement the three methods.

- **The amount is the server's.** The deposit (or what's left of it) first,
  then the balance due (`onlinePaymentOption`). The customer picks another
  amount only when the company turned on "let customers pay part", and never
  more than the balance or under 50¢.
- **Deposits**: per invoice (`POST v1/admin/invoices/{invoice}/deposit`: the
  company's usual, none, a percent in basis points, or a fixed amount in cents)
  or the company's usual percent (Invoices settings). A percent is of the
  total, rounded to the nearest cent; deposit then balance comes to the total
  exactly.
- **The webhook** calls `handleInvoiceCardEvent(db, tenantId, event)` with the
  company YOU resolved from the Stripe account (never from metadata). It
  records a payment only for a checkout of that company, for that checkout's
  invoice, in exactly its amount and currency, keyed on the PaymentIntent
  (`checkout.session.completed` and `payment_intent.succeeded` for one payment
  are recorded once). Anything else is refused and given to `onAlert`. A full
  refund is a reversal; a part refund or a dispute flags the payment.
  `INVOICE_CARD_EVENT_TYPES` is the event list to enable.

## Upgrading from 0.4

Run `sql/upgrade-0.4-to-0.5.sql` before deploying (safe twice): the deposit
columns, the payment flag and `invoice_checkouts`. Every 0.4 row stays as it
was; existing invoices ask no deposit until the company sets one. Without the
`payments` seam 0.5 answers as 0.4 did, with `pay: null`.

## Upgrading from 0.3

No database change. `onEvent` is optional; without it 0.4 answers exactly as
0.3 did. The optional `@adminigloo/comms` peer is now `^0.4.0`.

## Not included

- **Selling products per company** (a company's own shop and its orders):
  getting paid, part 2. **SMS** receipts or payment links.
- **A partial refund on the ledger.** It flags the payment; the owner adjusts
  the invoice. A dispute that is lost is reversed by the owner.
- **A fixed-amount default deposit.** The company's default is a percent; a
  fixed deposit is set on the invoice.
- **Logo and colour inside the email.** The email carries the company's name
  and reply-to; its body is plain text. The invoice PAGE carries the colour.
- **Editable invoice details and per-feature identity in single-business
  mode.** A single business's invoices are signed with the site's name.
- **Recurring invoices, reminders to customers about overdue invoices,
  credit notes, multi-currency within one company.** (The business itself is
  told when an invoice goes overdue: see Alerts and files.)
- **Plans and billing per company, custom domains, impersonation, per-company
  SEO.**
- **Per-company feedback boards, the assistant, analytics, SEO/AEO and
  book-a-call**: Tenancy 2b-2 to 2b-4 (listed below).

### Not included (Tenancy 2b-1)

- **The feedback board per company, and the complete board** — Tenancy 2b-2.
  It will keep screenshots as these private files and send its alerts through
  these notifications. Until then, feedback screenshots stay on the public
  Blob store as in 2a.
- **The assistant answering customers on a public page.** Each company's assistant is its team's, behind sign-in (Tenancy 2b-3).
- **SEO reports, AI-citation tracking and book-a-call (booking) per company** —
  Tenancy 2b-4b and 2b-4c. Website visits and search basics are per company
  since Tenancy 2b-4a (`--analytics`, `--seo`).
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
