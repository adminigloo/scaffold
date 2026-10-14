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

## Not included

- **Payments to companies** (Stripe Connect: a customer paying a company's
  invoice by card). Invoices are paid however the payment instructions say;
  staff record the payment.
- **Logo and colour inside the email.** The email carries the company's name
  and reply-to; its body is plain text. The invoice PAGE carries the colour.
- **Editable invoice details and per-feature identity in single-business
  mode.** A single business's invoices are signed with the site's name.
- **Recurring invoices, reminders for overdue invoices, credit notes,
  multi-currency within one company.**
- **Plans and billing per company, custom domains, impersonation, per-company
  SEO.**
- **Per-company boards and widgets for feedback, notifications, files, the
  assistant, analytics, SEO/AEO and book-a-call**: Tenancy 2b.
