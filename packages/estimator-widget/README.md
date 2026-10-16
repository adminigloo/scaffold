# @adminigloo/estimator-widget

The screens for AdminIgloo's estimator. A customer gets a real price on the
business's website in a minute, from what they can count or measure ("How many
steps go up to the door?"), with or without a photo. The business gets the
lead with the photo and what the photo showed, turns it into a quote, and the
customer accepts it from a link. The owner builds every price from their own
supplies and labor, and sees what each job costs and makes.

```
<EstimateTool baseUrl="/api/estimator" />                     the estimate, inline on a page
<EstimatorProvider config={…}>                                the same, behind a floating button
  <EstimatorButton /><EstimatorModal />
</EstimatorProvider>
<QuoteView baseUrl="/api/estimator" token={t} />              the quote the customer accepts or declines

<EstimatorAdmin baseUrl="/api/admin/estimator" />             everything for the office, in four tabs   (./admin)
<EstimatesQueue … />  <EstimateEditor … />                    leads and quotes; one estimate              (./admin)
<PriceBook … />  <EstimatorSettings … />  <EmbedKeys … />     prices, settings, other websites            (./admin)
```

React (18 or 19) is the only peer. Everything styles itself (no Tailwind, no CSS
import step), follows the host page's light or dark theme, and takes the
business's brand colour.

It talks to `@adminigloo/estimator` 0.3's HTTP handlers (`createEstimatorHandlers`
for the customer pages and other websites, `createEstimatorAdminHandlers` for
staff). Every request and response is a TypeScript type, exported by both
packages (`import type { CalculateResponse, PublicQuote, … } from
"@adminigloo/estimator-widget"`; the server's are the same shapes, from its
`src/wire.ts`). The types are declared again in this package, so it does
**not** depend on the server package, and a marketing site that embeds the
estimate installs nothing but this.

**The widget does no arithmetic.** It sends what the customer answered and
shows what the server worked out: the price, the range, the quantities, and
every sentence that explains them ("3 steps × 7–8 in each (estimated) = 21–24
in rise"). It formats money in the business's currency, and that's all it
does to a number.

## What each install gets you

| You install | You get | You wire yourself |
| --- | --- | --- |
| `@adminigloo/estimator-widget` | `<EstimateTool>` (inline) and the button + dialog: the customer picks what they need, answers the business's questions, adds a photo if they like (the AI's reading pre-fills the count, which they can change), sees the price and why it's a range, and sends it. `<QuoteView>`: the quote page with Accept / Decline and "Print or save as PDF". | A page for each, and the server handlers (`@adminigloo/estimator`) mounted at one route. |
| `@adminigloo/estimator-widget/admin` | `<EstimatorAdmin>` and its parts: the queue (search, filters, archive), the estimate editor (photo, the reading beside what the customer changed, lines re-priced from the price book, send the quote, record a yes or no, invoice, book the visit), the price book with a live test quote and the cost breakdown, settings, and embed keys. | The admin pages, and the staff handlers mounted behind your sign-in with the `authorize` check. |
| `+ @adminigloo/notifications` on the server (Tenancy 2b-1) | The "Lead alerts" panel points to Alert settings, where the owner chooses who hears about new leads, instead of keeping a second list. | `alertsHref` on the staff handlers (`@adminigloo/estimator` 0.5). See [Alerts (Tenancy 2b-1)](#alerts-tenancy-2b-1). |

## Install

The package is private, published to GitHub Packages. The same block works
for npm and pnpm. In your app's **repo** `.npmrc` (commit it: it holds no
secret, the token is read from the environment):

```
@adminigloo:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

`GITHUB_TOKEN` is a GitHub token with `read:packages`, set in your shell and in
CI. Then:

```sh
npm install @adminigloo/estimator-widget     # pnpm add / yarn add work the same
```

**Docker.** A clean image has no token: pass it as a BuildKit secret, never a
build argument (an argument stays in the image's history):

```dockerfile
# syntax=docker/dockerfile:1
COPY package.json package-lock.json .npmrc ./
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm ci
```

```sh
docker build --secret id=npmrc,src=$HOME/.npmrc .
```

## Mount it: a Next.js app

Mount the server's handlers on two catch-all routes (the estimator README has
every option: the photo store, the AI reader, emails, rate limits):

```ts
// app/api/estimator/[...path]/route.ts — the estimate and quote pages talk to this
import { createEstimatorHandlers } from "@adminigloo/estimator";
const estimator = createEstimatorHandlers({ db, tenantId: "primary", photoStore, takeoff, onEvent, rateLimit });
export const GET = estimator.handle;
export const POST = estimator.handle;
export const OPTIONS = estimator.handle;

// app/api/admin/estimator/[...path]/route.ts — the staff screens talk to this
import { createEstimatorAdminHandlers } from "@adminigloo/estimator";
const admin = createEstimatorAdminHandlers({ db, tenantId: "primary", authorize, photoStore, onEvent, quoteUrl });
export const GET = admin.handle;
export const POST = admin.handle;
```

Then the pages:

```tsx
// app/estimate/page.tsx — a server page can render it: the package ships as a client bundle
import { EstimateTool } from "@adminigloo/estimator-widget";
export default function Page() {
  return <EstimateTool baseUrl="/api/estimator" bookHref="/book-visit" />;
}

// app/quote/[token]/page.tsx — kept out of search, and no referrer (the token is in the URL)
import { QuoteView } from "@adminigloo/estimator-widget";
export const metadata = { robots: { index: false }, referrer: "no-referrer" };
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <QuoteView baseUrl="/api/estimator" token={token} bookHref="/book-visit" />;
}

// app/admin/estimator/page.tsx — it passes a function, so it's a client page
"use client";
import { EstimatorAdmin } from "@adminigloo/estimator-widget/admin";
export default function Page() {
  return <EstimatorAdmin baseUrl="/api/admin/estimator" estimateHref={(id) => `/admin/estimates/${id}`} />;
}
```

## On another website (an embed key)

The owner makes a key in **Website embed** (`<EmbedKeys>`), names the websites
it may be used on, and copies the snippet it shows — built from your
deployment's own address:

```tsx
import { EstimatorProvider, EstimatorButton, EstimatorModal } from "@adminigloo/estimator-widget";

<EstimatorProvider config={{ baseUrl: "https://summitramps.com/api/estimator", clientKey: "esk_…" }}>
  <EstimatorButton />
  <EstimatorModal />
</EstimatorProvider>
```

or inline: `<EstimateTool baseUrl="https://summitramps.com/api/estimator" clientKey="esk_…" />`.
With `clientKey`, every request carries `x-adminigloo-key`. A key used on a
website it isn't set up for shows "This estimator isn't set up for this website
yet.", with a note for the site owner, instead of an endless spinner.

## `<EstimateTool>`

| Prop | Default | |
| --- | --- | --- |
| `baseUrl` / `clientKey` / `transport` | | Where the handlers are; `transport` wins when given. |
| `productId`, `lockProduct` | | Preselect a product; with `lockProduct`, offer only it. |
| `title`, `intro` | "Get an instant estimate", "A real price in a minute, before anyone drives out." | |
| `bookHref` | | After saving, "Book a visit to measure" links here with `estimate=<id>` added. |
| `accentColor` | the business's setting | A `#rrggbb`, or `null` for the widget's own. |
| `poweredBy` | `false` | Show "Powered by AdminIgloo". Never shown unless you ask. |
| `onSubmitted` | | Called once per saved estimate. |
| `theme`, `locale`, `nonce`, `className`, `style` | | See **Theme**. |

What the customer sees, in order: the products as chips (skipped with one); the
product's questions exactly as the server sends them, empty to start (a
stepper for a count, a number with its unit, size chips that fill the width
and length; "More ways to measure" holds the rest); the photo; options with
their price ("+$120"); the price, 300 ms after the last change, with how it was
worked out, what was assumed ("Based on an estimated step height of 7–8 in.
Measure one step and enter it for a tighter estimate.") and why it's a range;
then their details and **Send me this estimate**.

**The photo.** The browser shrinks it before anything is sent (768 px on the
long edge, JPEG 0.8, from the business's settings): about 600 image tokens a
reading instead of 4,800, and a second to upload on a weak connection. The
shrunk photo is shown back at once. For a product the AI reads (a ramp: the
steps), the reading appears beside the photo ("We counted 3 steps up,
including the last one onto the porch or landing."), the count goes into the
same stepper marked "From your photo", and **Change the count** in the reading
takes them to it. The badge goes the moment the customer changes it; a count
LOWER than the photo's asks, under the count, "Did you count the step up onto
the porch or landing? 2 steps and the porch is 3." (the value stays theirs). A
count they already typed is never overwritten. A measured job is never read: what they typed goes with the
photo, and the server keeps the photo without calling the AI. If reading is
paused or off, the server's sentence says so and the photo is still kept. Up to
three photos.

**Spam.** A hidden honeypot field and the form's fill time go with the
estimate. A customer faster than the server's floor (autofill) waits it out
("Sending…") instead of being turned away.

## `<QuoteView>`

The page behind the link in the quote email: the business's name, the quote
number, who it's for, the lines with their details, the subtotal, discount,
sales tax and total, how long it's good for, the business's footer, and
**Accept this quote** / **Decline**, each confirmed on the page (an optional
name and note). An answer names the version on screen (`version`), so it only
ever binds the customer to the quote they are looking at. A quote that changed
meanwhile (sent again with new prices, expired, already answered in another
tab, being revised) is read again and shown as it is now, with the server's
sentence ("This quote changed since you opened it. Here's the new one; check it
before you accept."). After accepting, `bookHref` becomes "Pick a time for the
work". **Print or save as PDF** prints a clean page without the buttons.

## The staff screens (`./admin`)

Every admin component takes `baseUrl` (the staff handlers) or `transport`, the
theme props and `accentColor`. Each reads the status once and shows what's
left to set up at the top; inside `<EstimatorAdmin>` the notices show once for
all four tabs. A section the signed-in person has no permission for shows the
server's sentence in its place, never a blank panel. Costs, supply prices,
labor rates and margins appear only for people the server lets see them.

- **`<EstimatesQueue>`** (`onOpen`, `estimateHref`, `pollOnFocus`): search,
  Leads / Drafts / Sent / Accepted / Declined / Expired / Invoiced / All /
  Archived with counts, where it came from, "Load more", **New estimate**.
- **`<EstimateEditor>`** (`estimateId`, `backHref` or `onBack`, `onChange`,
  `onOpenEstimate`): the customer, their photos (opened large; staff can add
  their own), each line with the product's own questions, options, "Set the price
  myself", the working the customer saw, and the AI's reading beside "The
  customer changed: steps 3 → 4"; totals; and the actions the server offers right
  now: Send quote (it says exactly what the customer gets, and, before it goes,
  every line still priced at an assumption: "Line 1 is priced at 3 steps, 7.5 in
  each (estimated), 23 ft of ramp…"), Send again, Revise,
  Customer said yes / no, Reopen, Copy quote link, Archive, Duplicate, Make an
  invoice, Book the visit. Every change is saved and answered with the whole
  estimate, so the totals on screen are always the server's.
- **`<PriceBook>`**: products (how each is measured, on the website or staff
  only, priced or by quote, reorder, retire, restore) and the supplies library
  (what each costs you, from whom, used by which products; changing a cost says
  which prices it moves; on a phone each supply is a card). Each product shows
  its price at an everyday answer ("3 steps: $6,921.46, margin 28.57%"). The
  product editor builds the price from supplies (how many, per what: "per ft of
  ramp", "per resting landing", "once per job"; **Bought whole** rounds 5.25
  posts up to 6, on by default for a supply sold each), labor (hours per unit,
  setup hours, the rate; hours at a $0 rate are called out), waste, markup or
  target margin, the minimum and the range rule, plus options; beside it (below
  it on a phone, with the price and margin kept in a bar at the bottom of the
  screen), **Test a quote**: exactly what the customer is asked and sees, with
  your cost, price and margin. A new product starts **off** your website, and
  an empty price book offers **Load a sample catalog**, only on a click, whose
  products also arrive off the website. A supply fed from your own price list
  (`upsertComponentByRef` on the server) shows "Price from your list", its cost
  read-only.
- **`<EstimatorSettings>`**: until the business has saved its settings, one
  **Get started** form (name, phone, email, sales tax, hourly labor rate, saved
  together): the estimate page is closed and no quote can be sent until then.
  After that: business details, time zone and brand colour (shown
  on a light and a dark page), quote validity and follow-up, tax, currency,
  default labor rate and contingency, lead alerts (or, with alerts installed,
  the way to Alert settings), instant estimates on/off,
  photos and the AI's daily limit, with what readings have cost.
- **`<EmbedKeys>`** (`embedBaseUrl`): keys for other websites, shown once, the
  snippet, "Test this key", the websites each works on, revoke.

## Theme

Every component takes `theme`: `"auto"` (default), `"light"` or `"dark"`. Auto
follows the host page: `data-theme` on the nearest parent, `<body>` or
`<html>`; then a `dark` / `light` class; then `color-scheme`; then the
background the widget sits on; then, only where the page allows a dark canvas,
the visitor's system setting. It follows changes live. Before hydration,
`"auto"` can only use the system setting; a page whose own theme differs from
it switches once when the page hydrates. Pass `theme="light"` or `"dark"` when
your page has one fixed theme.

Every colour is a `--aiew-*` custom property declared at zero specificity, so
one ordinary rule re-themes everything:

```css
.aiew-root {
  --aiew-accent: #7c3aed;     /* buttons, the selected chip's border */
  --aiew-accent-ink: #6d28d9; /* the accent as text: links, a selected chip's label */
  --aiew-font: "Inter", sans-serif; /* default: your page's font */
}
```

Tokens: `ground surface ink muted faint line line-strong accent accent-strong
accent-soft accent-ink on-accent ok ok-soft warn warn-soft danger danger-soft
on-danger focus radius radius-sm shadow shadow-lg scrim font`. Every pair the
widget prints passes WCAG AA in light and dark.

**The business's colour.** `accentColor` (or the brand colour in Settings)
sets the accent for both themes at once: the colour itself on buttons, white or
near-black text on it (whichever reads better), a hover shade, a soft tint, and
the colour as text stepped darker (light) or lighter (dark) until it reads at
4.5:1. Any colour an owner picks stays readable (a test sweeps 216 of them).
`brandTokens(hex, theme)` is the pure function behind it.

**Styles** are added in the browser, once, as `<style id="aiew-styles">` (and
`aiew-admin-styles` for the staff screens) when a component mounts. On a
server-rendered page that is AFTER the first paint: the markup shows unstyled
for a moment. Render the stylesheet on the server instead, in the page's head
(or anywhere before the widget); a component that finds the id adds nothing:

```tsx
import { estimatorWidgetCss } from "@adminigloo/estimator-widget";
import { estimatorAdminCss } from "@adminigloo/estimator-widget/admin"; // staff pages only

<style id="aiew-styles" nonce={nonce}>{estimatorWidgetCss()}</style>
<style id="aiew-admin-styles" nonce={nonce}>{estimatorAdminCss()}</style>
```

### Content-Security-Policy

A page with a strict CSP needs, for the widget:

| Directive | Add | Why |
| --- | --- | --- |
| `style-src` | `'nonce-…'` (and pass the same `nonce` to every component, or render the tags above with it) | the `<style>` tags; a brand colour (`accentColor`, or the one in Settings) is an inline `style` attribute: a server-rendered page that uses one also needs `style-src-attr 'unsafe-inline'` |
| `img-src` | `'self' data:` and your photo store's host (e.g. `https://*.public.blob.vercel-storage.com`) | a photo's preview before it is sent is a `data:` image; a kept photo is shown from your store |
| `connect-src` | `'self'`, or the estimator's origin when the widget runs on another website | every call goes to `baseUrl` |

So, on the business's own site with photos on Vercel Blob:

```
img-src 'self' data: https://*.public.blob.vercel-storage.com; style-src 'self' 'nonce-…'; connect-src 'self'
```

## Transports

Every component takes `baseUrl` **or** `transport`. `createEstimatorClient({
baseUrl, clientKey?, fetch?, headers? })` and `createEstimatorAdminClient(...)`
are what `baseUrl` builds for you. Each method returns `{ ok: true, data }` or
`{ ok: false, error }` and never throws: a failed fetch is `network`, a proxy's
HTML page is `bad_response`, and the server's refusals keep their code, message
and issues.

A host on tRPC or server actions can pass its own object answering in the wire
types. The simplest is the client with your own `fetch`:

```ts
import { createEstimatorClient } from "@adminigloo/estimator-widget";

const transport = createEstimatorClient({
  baseUrl: "/api/estimator",
  // e.g. forward through a server action, or add a header
  fetch: (url, init) => fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string>), "x-app": "web" } }),
});

<EstimateTool transport={transport} />;
```

or a tRPC-backed object (each method answers `{ ok, data | error }`):

```ts
const transport: EstimatorPublicTransport = {
  config: () => trpc.estimator.config.query().then((data) => ({ ok: true, data })),
  calculate: (body) => trpc.estimator.calculate.mutate(body).then((data) => ({ ok: true, data })),
  // … photo, takeoff, submit, quote, acceptQuote, declineQuote
};
```

**For the staff screens, mount `createEstimatorAdminHandlers`** behind your own
`authorize` rather than re-implementing it: the screens read the handler's wire
shapes and refusal codes.

`EstimatorTransport` (0.1's class) still works, deprecated, as a thin wrapper
over the new client.

## The photo in the browser

`fitWithin(width, height, maxEdge)` and `resizePhoto(file, { maxEdgePx,
quality })` are exported. `resizePhoto` decodes with `createImageBitmap`
(phone orientation honoured) or an `<img>` from a `data:` URL, draws on a
white canvas (`OffscreenCanvas` where there is one, so a transparent PNG isn't
black) no larger than the limit, never upscales, and answers `{ blob, base64, width, height, mediaType: "image/jpeg" }`.
A file that isn't a photo is refused in the browser: "That file isn't a photo we
can read. Try a JPEG or PNG."

## Accessibility

Real buttons, radios and labels. Product, option and size chips are radio
groups (arrow keys move and choose). The price and the photo reading are
announced as they change; errors are linked to their fields. The dialog is
labelled, traps focus, closes with Escape or a click outside, gives focus back
to the button, and stops the page scrolling behind it. Colour is never the only
signal. Every target is at least 44px, and everything works at 390px without the
page scrolling sideways. Reordering uses buttons, never a drag.

## Companies (Tenancy 2a)

The same screens serve every company on a site. Point each at its company's
routes:

```tsx
// app/t/[slug]/estimate/page.tsx: the company's instant estimate
const found = await tenancy.resolvePublicCompany(slug);
if (!found) notFound();
const company = publicCompanyToWire(found);
if (company.status === "suspended") return <CompanyUnavailable company={company} />;     // @adminigloo/tenancy-widget
return <EstimateTool baseUrl={`/api/t/${company.slug}/estimator`} accentColor={company.brandColor} />;
```

```tsx
// app/app/estimates/page.tsx: staff (a server page: pass a string, not a function)
<EstimatorAdmin baseUrl={`/api/app/${company.id}/estimator`} estimateHref="/app/estimates/{id}" />
```

- **Your website, no code.** Give `<EmbedKeys>` the company's public estimate
  page (`publicPageUrl`, a path is completed with the page's own address) and
  its colour (`buttonColor`): it leads with a button and a page frame, each one
  line of HTML that Wix, Squarespace, WordPress or any site takes in an
  "Embed" or "Custom code" block — no key, no developer — and folds the keyed
  React snippet under "For developers", saying it needs a React site and this
  private package.
- **Notices once.** `notices={false}` on any staff screen leaves the notices to
  the screen above it (Estimate settings mounts `<EstimatorSettings>` and then
  `<EmbedKeys>`).
- **A sample for the owner's trade.** The price book's "Load a sample catalog"
  asks which: lawn care, cleaning or wheelchair ramps.
- **Pattern hrefs.** `estimateHref` on `<EstimatesQueue>`, `<EstimateEditor>`
  and `<EstimatorAdmin>` takes a function OR a string whose `{id}` is replaced
  with the encoded id, because a server page can't hand a function to a client
  component. Without `onOpenEstimate`, opening another estimate from the editor
  (a duplicate) navigates there.
- **Company-owned fields read-only.** When the server says the business
  details come from the company (`managedByCompany`), `<EstimatorSettings>`
  shows the name, contact details, time zone and brand colour as text under
  "These come from your company settings." with the link, and the first-run
  form asks only for what is still the estimator's (tax rate, labor rate).
- **The site's ceiling.** With a ceiling on photo-reading spend, the daily
  budget's hint says "Up to $x.xx a day on this site.", the input's `max` is the
  ceiling, and a budget above it is refused before saving.
- **The closed message.** When the server answers `estimates_closed`,
  `<EstimateTool>`, `<EstimatorModal>` and `<QuoteView>` show the server's
  sentence (with how to reach the business) instead of a fixed one.
- **The logo.** `<EstimateTool>` and `<QuoteView>` show the business's logo
  beside its name when the server sends one.
- **`#embed`** on the admin page scrolls to the website embed keys and focuses
  their heading (the setup checklist links there).
- **Read-only for a role that can look but not change.** `<PriceBook>`,
  `<EstimatorSettings>`, `<EmbedKeys>`, `<EstimatesQueue>` and
  `<EstimateEditor>` take `canManage` (default `true`). With `false`, the
  price book shows its products and supplies with no add, edit, reorder,
  retire, restore or sample button; estimate settings show every value in a
  disabled form (and, before the first save, say the owner or an admin has to
  make it); website keys are listed with no way to make, edit or revoke one;
  the queue lists every estimate with no "New estimate"; and an estimate is
  shown in full — customer, photos, lines, totals, the office's notes, what's
  linked — under "You can see this estimate. Your role can't change it.", with
  no action, no edit and no photo added or removed. The server refuses those
  changes either way; this only stops offering buttons that would fail. A
  server page passes the person's permission:

  ```tsx
  <PriceBook baseUrl={`/api/app/${company.id}/estimator`} canManage={can.includes("estimator.pricebook.manage")} />
  <EstimatorSettings baseUrl={`/api/app/${company.id}/estimator`} canManage={can.includes("estimator.settings.manage")} />
  <EstimatesQueue baseUrl={`/api/app/${company.id}/estimator`} estimateHref="/app/estimates/{id}" canManage={can.includes("estimator.estimates.manage")} />
  <EstimateEditor baseUrl={`/api/app/${company.id}/estimator`} estimateId={id} canManage={can.includes("estimator.estimates.manage")} />
  ```
- **The website snippets scroll by keyboard.** Each snippet box (wider than a
  phone, so it scrolls sideways) takes focus and is named by the line above
  it, so someone without a mouse can read the whole line they copy.

A foreign host passes the same props from its own business record.

## Alerts (Tenancy 2b-1)

When the server says who gets lead alerts is chosen in Alert settings
(`EstimatorSettingsWire.alertRecipients`, from the staff handlers'
`alertsHref`), `<EstimatorSettings>`'s "Lead alerts" panel shows "Who gets
lead alerts is chosen in Alert settings." with **Open Alert settings** (no link
when the server names no place), and no form on the page sends the old
`leadNotifyEmails` list. Two places to choose the same people is how a lead
gets emailed twice, or never. Without it, the address list as in 0.3.

Nothing to pass: the panel follows the server.

```ts
// the staff handlers, on the server
createEstimatorAdminHandlers({ /* … */ alertsHref: "/app/alerts/settings" });
```

A customer's estimate photo is still added through `<EstimateTool>` and shown
in the editor's Photos panel; with `@adminigloo/storage` on the server it is
kept privately with its estimate, and the other files on an estimate are
`@adminigloo/storage-widget`'s `<RecordFiles>` (this package doesn't import
it).

### Not included (Tenancy 2b-1)

- **The feedback board per company, and the complete board** — Tenancy 2b-2.
  It will keep screenshots as these private files and send its alerts through
  these notifications. Until then, feedback screenshots stay on the public
  Blob store as in 2a.
- **The AI assistant per company** — Tenancy 2b-3.
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

## Not included

- **A script tag or iframe for sites that aren't React** (WordPress, Wix,
  Squarespace). The embed is a React component.
- **More than one product per estimate from the website.** Staff add lines in
  the editor.
- **Photo readings for areas and lengths.** A size guessed from a photo without
  a scale isn't a number to price from; those photos are still kept for the
  business.
- **Payments or deposits on accept**, and e-signature (accepting records the
  name typed and when).
- **SMS.** Staff can copy the quote link and text it themselves.
- **PDF files.** The quote page prints cleanly ("Print or save as PDF").
- **Currency conversion.** One currency per business, shown as set.
- **What Tenancy 2b-1 leaves out**: see
  [Not included (Tenancy 2b-1)](#not-included-tenancy-2b-1). (These screens
  serve each company since 0.3: see [Companies](#companies-tenancy-2a).)
- **Payments to companies, plans and billing per company, custom domains,
  impersonation, per-company SEO and search indexing of company pages.**
