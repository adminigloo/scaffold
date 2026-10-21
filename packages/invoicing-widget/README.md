# @adminigloo/invoicing-widget

The screens for AdminIgloo invoices: the ledger a business works from, one
invoice worked on (lines, send, payments), and the customer's own invoice page,
opened by its link with no account.

```
<InvoiceView baseUrl="/api/t/{web address}/invoices" token={t} />            the customer's invoice page
<InvoicesLedger baseUrl="/api/app/{company id}/invoices" />                every invoice, filtered, "New invoice"   (./admin)
<InvoiceEditor baseUrl="/api/app/{company id}/invoices" invoiceId={id} />  one invoice: lines, send, payments       (./admin)
```

React (18 or 19) is the only peer. Everything styles itself (no Tailwind, no CSS
import) and follows the host page's light or dark theme.

It talks to `@adminigloo/invoicing` 0.4's handlers (`createInvoicingHandlers`
for the customer's page, `createInvoicingAdminHandlers` for staff) over a small
JSON contract. The contract's types are declared in this package; it does
**not** depend on the server package (`@adminigloo/invoicing` `^0.4.0` is an
optional peer, so an older server warns at install time).

**Alerts and files (Tenancy 2b-1).** No screen or wire change. Behind the same
screens, invoicing 0.4 tells the business when the customer's page reports the
first view, when a recorded payment pays an invoice in full, and when one goes
overdue (`@adminigloo/notifications` shows them in the bell), and an invoice
can carry photos and files (`@adminigloo/storage-widget`'s `<RecordFiles>`
under the editor).

## What each install gets you

| You install | You get | You wire yourself |
| --- | --- | --- |
| `@adminigloo/invoicing-widget` | `<InvoiceView>`: what's owed, the lines, payments so far, the due date in the business's time zone, how to pay (the business's own payment instructions), in the business's colour; prints as a plain invoice. It reports "viewed" once, from the browser, so a mail scanner or link preview never counts. | A public page that renders it, and `createInvoicingHandlers` mounted at one route. |
| `@adminigloo/invoicing-widget/admin` | `<InvoicesLedger>` (every invoice newest first, filtered by status in words, what's owed, "New invoice") and `<InvoiceEditor>` (lines while they can still change, Send or "Mark as sent", the customer's link to copy and preview, the status moves allowed, payments recorded and reversed). | Two staff pages, and `createInvoicingAdminHandlers` mounted behind your sign-in. |

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
npm install @adminigloo/invoicing-widget     # pnpm add / yarn add work the same
```

## Quick start: a Next.js app (companies)

Mount the two handlers as `@adminigloo/invoicing`'s README shows ("Companies"),
then the pages:

```tsx
// app/app/invoices/page.tsx: the ledger
import { InvoicesLedger } from "@adminigloo/invoicing-widget/admin";

export default async function Page() {
  const { company } = await requireCompany("invoices.view");          // your page gate
  return <InvoicesLedger baseUrl={`/api/app/${company.id}/invoices`} invoiceHref="/app/invoices/{id}" />;
}
```

```tsx
// app/app/invoices/[id]/page.tsx: one invoice
import { InvoiceEditor } from "@adminigloo/invoicing-widget/admin";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { company } = await requireCompany("invoices.view");
  return <InvoiceEditor baseUrl={`/api/app/${company.id}/invoices`} invoiceId={(await params).id} backHref="/app/invoices" />;
}
```

```tsx
// app/t/[slug]/invoice/[token]/page.tsx: the customer's page
import { InvoiceView } from "@adminigloo/invoicing-widget";
import { CompanyBrandBar } from "@adminigloo/tenancy-widget";

export default async function Page({ params, searchParams }) {
  const { slug, token } = await params;
  const found = await tenancy.resolvePublicCompany(slug);
  if (!found) notFound();
  const company = publicCompanyToWire(found);
  return (
    <>
      <CompanyBrandBar company={company} />
      <InvoiceView baseUrl={`/api/t/${company.slug}/invoices`} token={token} preview={(await searchParams).preview === "1"} accentColor={company.brandColor} />
    </>
  );
}
```

A single-business project mounts the handlers at fixed routes and passes those.

## Props

**`<InvoiceView>`**: `token` (required), `baseUrl` or `transport`, `preview`
(the business's own "Preview" link: never reports viewed), `accentColor` (a
`#rrggbb` for the accent, readable text worked out for it; default the
business's own colour from the server), plus `theme`, `nonce`, `className`,
`style`, `locale`.

**`<InvoicesLedger>`**: `baseUrl` or `transport`; `invoiceHref` (a function, or
a string with `{id}`: "/app/invoices/{id}", so a server page can pass it);
`canManage` (default `true`; `false` for someone who may look but not raise
invoices, a company's viewer: the ledger without "New invoice". The server
refuses the create either way. Pass `can.includes("invoices.manage")`). Each
invoice's page already offers only what the server says the person may do.
`initialFilter` (0.4): the chip to open on — `"overdue"` for a page at
`/app/invoices?status=overdue`; any status of the chips, else All.
`actionsInHeader` (0.4): the host page's header carries **New invoice** —
render `<InvoicesLedgerActions className={…} />` there, beside the title, like
every page's primary action — and the ledger draws none of its own. A
payment's line names its method once: "$810.81 · Check #1042"
(`paymentWords(method, note)`).

```tsx
<PageHeader title="Invoices" actions={canManage ? <InvoicesLedgerActions className={buttonClass("primary")} /> : null} />
<InvoicesLedger baseUrl={…} invoiceHref="/app/invoices/{id}" canManage={canManage} initialFilter={status} actionsInHeader title={false} />
```

**`<InvoiceEditor>`**: `invoiceId` (required), `baseUrl` or `transport`,
`backHref`.

Every component takes `theme` (`"auto"`, `"light"`, `"dark"`), `nonce`,
`className`, `style` and `locale`.

## Theme

`"auto"` follows the host page (a `data-theme` or `dark` class on a parent,
`<body>` or `<html>`, then the background it sits on, then the system), and
follows changes live. Every colour is a custom property on `.aiiw-root`,
declared at zero specificity:

```css
.aiiw-root {
  --aiiw-accent: #0f766e;
  --aiiw-accent-strong: #115e59;
  --aiiw-on-accent: #ffffff;
  --aiiw-font: "Inter", sans-serif;
}
```

Tokens (all `--aiiw-`): `ground surface ink muted line line-strong accent
accent-strong accent-soft accent-ink on-accent ok ok-soft warn warn-soft danger
danger-soft on-danger focus radius radius-sm shadow shadow-lg scrim font`.
`accentColor` sets the accent family for you, with `accent-ink` (text in the
accent) shifted until it reads on the page. Every pair it prints text with
passes WCAG AA in light and dark (a test checks each). `invoicingWidgetCss()`
and `invoicingAdminCss()` return the stylesheets if you render them yourself.

## Transports

`createInvoicePublicClient({ baseUrl, fetch?, headers? })` and
`createInvoicingClient(...)` (admin) are what `baseUrl` builds. Every method
returns `{ ok: true, data }` or `{ ok: false, error }` and never throws: a
failed fetch is `network`, a proxy's HTML page is `bad_response`, a 401 reads
"You've been signed out. Sign in again to keep working.", and the server's own
refusals keep their code and message. Amounts are typed in dollars and percent
and sent as cents and basis points; a value that isn't a number is refused
before anything is sent. The totals on screen are always the server's.

## Not included

- **Choosing how to pay on Stripe's page.** "Pay now" sends the customer to
  Stripe's own secure page (0.2) and back; nothing card-related is drawn here.
- **A customer account** or a list of a customer's invoices.
- **PDF download.** The page prints as a plain invoice.
- **Logo and colour inside the invoice email.** The page carries them.
- **Recurring invoices and overdue reminders to customers.**
- **Plans and billing per company, custom domains, impersonation, per-company
  SEO.**
- **Per-company feedback boards, the assistant, analytics, SEO/AEO and
  book-a-call**: Tenancy 2b-2 to 2b-4.
- **Translations.** The words are English; `locale` changes money and date
  formats.
