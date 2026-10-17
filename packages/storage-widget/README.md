# @adminigloo/storage-widget

The photos and files screens for [`@adminigloo/storage`](../storage/README.md):
the photos a crew member takes at the job and the files the office keeps
with a visit, an estimate or an invoice, the company's Files screen, and how
much room is left. Photos are made smaller on the phone before they're sent,
and a photo that doesn't send is never lost.

```
<RecordFiles baseUrl="/api/app/{company}/files" record={{ type: "scheduling.visit", id }} />   one record's photos and files   (./admin)
<FilesManager baseUrl="/api/app/{company}/files" platformName="Igloo Back Office" supportEmail="help@igloo.example" />   the company Files screen   (./admin)
<UsageMeter usage={usage} platformName="Igloo Back Office" supportEmail="help@igloo.example" />                          "Using 120 MB of 5 GB"     (./admin)
```

React (18 or 19) is the only peer. Everything styles itself (no Tailwind, no
CSS import) and follows the host page's light or dark theme.

## What each install gets you

| You install | You get | You wire yourself |
| --- | --- | --- |
| `@adminigloo/storage-widget` | The wire types and `createFilesClient` (entry `.`) | Nothing else: types only |
| `@adminigloo/storage-widget/admin` | `<RecordFiles>`, `<FilesManager>`, `<UsageMeter>`, `shrinkPhoto` | Pages that render them, and `@adminigloo/storage`'s handlers mounted behind your sign-in |
| + `@adminigloo/create-app` (`--storage`) | The Files screen, "Photos and files" on every visit, estimate and invoice, the logo upload in company settings | Nothing |

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

```sh
npm install @adminigloo/storage-widget @adminigloo/storage
```

## Quick start

Mount `@adminigloo/storage`'s handlers (see its README), then render the
screens. They are client components (the bundle carries `"use client"`), so a
server page renders them directly:

```tsx
// app/app/[company]/files/page.tsx
import { FilesManager } from "@adminigloo/storage-widget/admin";

export default async function Page({ params }: { params: Promise<{ company: string }> }) {
  const { company } = await params;
  return (
    <>
      <h1>Files</h1>
      {/* The page has its own heading, so the card doesn't say "Files" again. */}
      <FilesManager baseUrl={`/api/app/${company}/files`} title={false} platformName="Igloo Back Office" supportEmail="help@igloo.example" />
    </>
  );
}
```

```tsx
// on a visit's page, under the visit's own editor
import { RecordFiles } from "@adminigloo/storage-widget/admin";

<RecordFiles
  baseUrl={`/api/app/${company}/files`}
  record={{ type: "scheduling.visit", id: visit.id }}
  hint="Your team sees these; they aren't sent to the customer."
/>
```

## Props

**`<RecordFiles>`**

| Prop | | |
| --- | --- | --- |
| `baseUrl` or `transport` | required | where the handlers are mounted, or your own transport |
| `record` | required | `{ type, id }`: `scheduling.visit`, `estimator.estimate`, `invoicing.invoice`, or a record type of your own (`createStorage({ records })`) |
| `title` | "Photos and files" | the card's heading |
| `hint` | none | one muted line under the heading |
| `backHref` | none | a "Back" link (a same-site path) |
| `locale`, `theme`, `nonce`, `className`, `style` | | dates and sizes, `"auto"`/`"light"`/`"dark"`, a CSP nonce for the injected style |

What it does: the record's label as a subheading; photos as thumbnails and
documents as rows (an iPhone HEIC photo is a row, "iPhone photo (HEIC)", since
a desktop browser can't draw one), each opening in a new tab; "Copy a link
(works for 1 hour)" and "Remove" (after "Remove {name}? It's deleted for
good.") where the person may. On a phone, "Take a photo" (straight to the
camera) and "Add photos or files"; on a desktop, one button and drop on the
card. Each photo is made smaller first (over 1.5 MB or 2048 px becomes a 2048
px JPEG; a HEIC always becomes a JPEG), then sent with a progress bar.

**Your own records.** A record type you registered with
`@adminigloo/storage` (its README, "Files on your own records") works the
same way, and the record's own permissions decide who sees, adds and removes
its files. On a Ridgeline job's page:

```tsx
<RecordFiles baseUrl={`/api/orgs/${org}/files`} record={{ type: "ridgeline.job", id: String(job.id) }} />
```

**No lost photo.** A photo taken with "Take a photo" usually isn't in the
phone's gallery, so the widget keeps it until it is safely added: a dropped
signal is retried once by itself after 3 seconds; a photo that still didn't
go stays as a card with the reason, "Try again" (made smaller again if it was
too big) and "Save to phone"; and leaving the page while one is pending asks
"A photo hasn't been added yet." first. The reason is always in plain words:
when the site itself answers with an error page (a timeout on a slow upload,
say), the card reads "It didn't send. Try again in a minute; the photo is
still here.", never a status code.

**`<FilesManager>`**

| Prop | | |
| --- | --- | --- |
| `baseUrl` or `transport` | required | where the handlers are mounted, or your own transport |
| `platformName` | none | who to ask for more room, in the full sentence |
| `supportEmail` | none | the address to write to for more room, shown as a link: "…or write to Igloo Back Office at help@igloo.example for more room." |
| `title` | "Files" | the card's heading; `false` on a page that has its own |
| `logoSettings` | none | where your logo is changed ("company settings"): "Change it in company settings." Without it: "Change it where you set your logo." |
| `locale`, `theme`, `nonce`, `className`, `style` | | as above |

The usage at the top; filters "All", each kind of record ("Visits",
"Estimates", "Invoices"), "Not attached", "Logo"; "Newest first" or "Largest
first"; a table on a desktop and cards on a phone; "Load more"; "Upload a
file" for people who manage files. A file that is removed where it's used
(the logo, an estimate's own photos) says where. Someone who can't add or
remove files is told "Full: ask the owner to make room.", never to delete;
and right after a file is refused because storage is full, the meter says
full too.

**`<UsageMeter>`**: `usage` (`{ usedBytes, fileCount, allowanceBytes }`),
`platformName`, `supportEmail`, `canMakeRoom` (default true). "Using 120 MB
of 5 GB" with a bar; at 90 % "Almost full: delete files you no longer need.";
full, "Full: new files can't be added until you delete some, or ask
{platformName} for more room." (with `supportEmail`, "or write to
{platformName} at {supportEmail}"). With `canMakeRoom={false}`: "Almost full.
The owner can make room." and "Full: ask the owner to make room."

## Theme

The screens read the host page's theme (a `data-theme` or `dark` class on an
ancestor, the page's `color-scheme`, or the background they sit on) and follow
it live. Every colour is a `--aifw-*` custom property at zero specificity, so
one rule re-themes them:

```css
.aifw-root { --aifw-accent: #7c3aed; --aifw-on-accent: #ffffff; }
```

Every pair of colours the screens print text with passes WCAG AA in light and
dark, and every control is at least 44 px tall on a phone.

## The transport

Every screen takes `baseUrl` (the HTTP client is built for you) or your own
`transport` of this shape, for a host that talks to the server another way:

```ts
interface FilesTransport {
  usage(): Promise<Result<UsageWire>>;
  files(q?: { purpose?: string; record?: string; sort?: "newest" | "size"; cursor?: string }): Promise<Result<FileListWire>>;
  upload(file: Blob, name: string): Promise<Result<FileResponse>>;
  file(id: string): Promise<Result<FileResponse>>;
  link(id: string): Promise<Result<FileLinkWire>>;
  remove(id: string): Promise<Result<RemoveResponse>>;
  attachments(record: { type: string; id: string }): Promise<Result<AttachmentsWire>>;
  attach(record: { type: string; id: string }, file: Blob, name: string, onProgress?: (fraction: number) => void): Promise<Result<FileResponse>>;
  contentUrl(id: string): string;
}
```

A call never throws: it answers `{ ok: true, data }` or `{ ok: false, error: {
code, message, status } }`, and the screens show `message` as it is, so
write it for the person reading the screen; keep the status for your logs.

## Not included (Tenancy 2b-1)

- **The feedback board per company, and the complete board** — Tenancy 2b-2.
  It will keep screenshots as these private files and send its alerts through
  these notifications. Until then, feedback screenshots stay on the public
  Blob store as in 2a.
- **The assistant answering customers on a public page.** Each company's assistant is its team's, behind sign-in (Tenancy 2b-3).
- **SEO reports, AI-citation tracking and book-a-call (booking) per company** —
  Tenancy 2b-4b and 2b-4c. Website visits and search basics are per company
  since Tenancy 2b-4a (`--analytics`, `--seo`).
- **Text (SMS) and push alerts.** Alerts come in the app and by email — S9.
- **Plans, limits and billing enforcement** — the billing chunk. In a
  create-app project, each company's storage allowance is one setting for
  everyone (create-app's `FILES_ALLOWANCE_MB`) until then.
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
  storage). In a create-app project, a company's storage refusal is reported
  in create-app's `/admin/errors` once a day.
- **Giving one company more storage than the others** in a create-app
  project: create-app's `FILES_ALLOWANCE_MB` is one number until the billing
  chunk.
- **Checking an address before it gets a company's alert emails.** The owner
  adds up to five per group; the company's team sending allowance bounds what
  they get.
