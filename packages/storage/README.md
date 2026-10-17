# @adminigloo/storage

A company's photos and files, kept privately in your own database and the
store you choose. Each file has a row (who added it, what it is, what it's
attached to, how big it is) and its bytes sit in a private store that never
hands out an address: a file is opened only through the company's signed-in
screens or a link that lasts at most an hour and stops working the moment the
person who made it leaves. A file on a visit, an estimate or an invoice
follows that record's own permissions, so a crew member sees their own
visits' photos and nothing else. Every upload is checked for what it really is
(from its bytes) and its size, and against the company's storage allowance.
Deleting a file deletes its bytes. The screens are
[`@adminigloo/storage-widget`](../storage-widget/README.md).

## What each install gets you

| You install | You get | You wire yourself |
| --- | --- | --- |
| `@adminigloo/storage` | `createStorage` (store, list, open, remove, attach, usage, signed links, the purge and the move to private), `createStorageHandlers` (the company's signed-in routes), `createStorageLinkHandlers` (signed links and public files), `storagePermissions`, the store adapters (`./vercel-blob`, `./s3`, `./local`, `./testing`), the shipped SQL, `checkHostSeams`, and the "Files" alert kinds | The tables (drizzle or the shipped SQL), two stores, your sign-in and company check (`authorize`, `resolveTenant`), the routes, and a daily cron |
| + `@adminigloo/storage-widget` | `<RecordFiles>` (a visit's, an estimate's or an invoice's photos and files, with the phone camera), `<FilesManager>` (the company Files screen), `<UsageMeter>` | Pages that render them |
| + `@adminigloo/create-app` (`--storage`) | All of it wired: the logo uploaded in company settings, photos and files on visits, estimates and invoices, the estimator's customer photos kept privately with their estimate, the Files screen with "Using X of Y", local-disk files in development, the files cron, and the isolation proof over every file route | Nothing: set `BLOB_PRIVATE_READ_WRITE_TOKEN` and `BLOB_READ_WRITE_TOKEN` (two different stores) in production |

What is **not** included is listed at the end.

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
npm install @adminigloo/storage drizzle-orm zod      # pnpm add / yarn add work the same
```

`drizzle-orm` (0.45) and `zod` (3.25 or 4) are peers. The package never
imports a store's SDK: the Vercel Blob adapter is handed yours, and the
S3-compatible one signs its own requests.

## Quick start (the template)

A project made with `create-app --storage` has all of this already. By hand,
in a project on the template:

```ts
// src/server/files.ts
import * as vercelBlob from "@vercel/blob";
import { createStorage, storageTables, STORAGE_BUILT_IN_PURPOSES } from "@adminigloo/storage";
import { createVercelBlobStore } from "@adminigloo/storage/vercel-blob";
import { db } from "@/db";

export const files = createStorage({
  db,
  tables: storageTables, // required: see "Your own table names" below
  stores: {
    // TWO stores: a Vercel Blob store is private or public as a whole.
    private: createVercelBlobStore({ sdk: vercelBlob, token: process.env.BLOB_PRIVATE_READ_WRITE_TOKEN!, access: "private" }),
    public: createVercelBlobStore({ sdk: vercelBlob, token: process.env.BLOB_READ_WRITE_TOKEN!, access: "public" }),
  },
  purposes: STORAGE_BUILT_IN_PURPOSES,
  allowanceBytes: () => 5120 * 1024 * 1024, // 5 GB a company
  signing: {
    secret: process.env.FILES_LINK_SECRET!, // at least 32 characters
    // Asked on EVERY open of a link: the company still active, the person who
    // made it still a member, and still allowed to open THIS file now.
    stillValid: async ({ tenantId, userId, mayView }) =>
      (await isActiveCompany(tenantId)) &&
      (await isActiveMember(tenantId, userId)) &&
      (await mayView((permission) => hasPermission(tenantId, userId, permission))),
  },
  urls: {
    content: (t, id) => `/api/app/${t}/files/v1/admin/files/${encodeURIComponent(id)}/content`,
    publicBase: "https://app.example.com/api/files",
  },
});
```

`sdk: vercelBlob` is `@vercel/blob`'s own namespace, as it is: `VercelBlobSdk`
names exactly what the adapter sends, and a test compiles @vercel/blob 2.8's
declarations against it.

```ts
// app/api/app/[company]/files/[...path]/route.ts — the signed-in routes
import { createStorageHandlers } from "@adminigloo/storage";
const handlers = createStorageHandlers({ storage: files, resolveTenant, authorize });
export const runtime = "nodejs";
export const GET = (req: Request) => handlers.handle(req);
export const POST = (req: Request) => handlers.handle(req);

// app/api/files/[...path]/route.ts — signed links and the logo, no sign-in
import { createStorageLinkHandlers } from "@adminigloo/storage";
const links = createStorageLinkHandlers({ storage: files });
export const runtime = "nodejs";
export const GET = (req: Request) => links.handle(req);
export const HEAD = (req: Request) => links.handle(req);
```

The tables, if you use drizzle-kit: add `export { storedFiles } from
"@adminigloo/storage/schema";` to your schema and run `drizzle-kit push`.
Without drizzle-kit, run `sql/storage-0.2.0.sql` (or `storageSql()`) in one
go:

```sh
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f node_modules/@adminigloo/storage/sql/storage-0.2.0.sql
```

Each shipped file is ONE statement, so its guard's refusal stops all of it
however it is run (plain `psql -f` included). A script can find the files by
name: `require.resolve("@adminigloo/storage/sql/storage-0.2.0.sql")`.

### Purposes and records

A **purpose** is what a file is for, and decides where it goes:

| Purpose | Who sees it | Kept | Types | Up to |
| --- | --- | --- | --- | --- |
| `attachment` | the record's own permissions | privately | photos (JPEG, PNG, WebP, GIF, HEIC) or PDFs | 4 MB |
| `library` | `files.view` | privately | the same | 4 MB |
| `company.logo` | anyone (it goes on emails and customer pages); on the Files screen, `files.view` | publicly, at an unguessable address | PNG, JPEG, WebP | 1 MB, never refused for a full company |

A package can add its own: the estimator's `estimatorPhotoPurpose` keeps a
customer's estimate photo privately with its estimate, is never refused
because the company is full (it is a lead), and may never use more than a
fifth of the allowance (so strangers can't fill the room the crew's photos
need).

A share like that fifth is for uploads from the public: files stored with no
`addedBy` (a customer's). A file a signed-in person adds to such a purpose
(`addedBy` set, as with `purposeStore(...).put({ ..., addedBy })`) is an
ordinary file: it is never stopped by the share and doesn't count toward it,
and it is refused like any other file when the company is full. So customers
filling their fifth can't stop the crew adding photos to their own
estimates.

A **record type** is a kind of thing a file can be attached to. Each package
brings its own, and its own permissions decide:

```ts
records: [
  ...schedulingFileRecords(db, { visitHref: "/app/schedule/visits/{id}/files" }),   // @adminigloo/scheduling
  ...estimatorFileRecords(db, { estimateHref: "/app/estimates/{id}" }),             // @adminigloo/estimator
  ...invoicingFileRecords(db, { invoiceHref: "/app/invoices/{id}" }),               // @adminigloo/invoicing
],
```

Who may do what with a file, in order:

1. `files.manage`: open and remove any file of the company, including one
   attached to something that was removed.
2. One of the record's manage permissions: open, add and remove.
3. One of the record's view permissions: open.
4. The record's `assigned` permission AND being assigned to it (a crew member
   on their own visit): open and add, and remove a file they added there
   within a day.
5. Anyone else: "That file isn't here." (404), never "forbidden", so an id
   from another company or another crew says nothing.

`files.view` alone opens no record's files: a member who can't see invoices
can't see an invoice's attachments by way of the Files screen either.

### The allowance

`allowanceBytes(tenantId)` answers each company's room (`null`: no limit).
An upload is checked before its bytes are stored and again under a
per-company lock before its row is written. `onUsage` hears every store
(`stored`), every refusal because the company is full (`refused`) and every
refusal because a purpose's share is used up (`share_full`); turn them into
alerts with `storageAlertKinds` and `storageUsageAlert` (almost full at 90 %,
once a month; full, once a day; "customers' photos couldn't be added", once a
day), for the people who manage files. Pass `supportEmail` with
`platformName` and the alert says where to write: "Delete files you no
longer need in Files, or write to Igloo Back Office at help@igloo.example for
more room." Someone who can't remove files is told to ask the owner, never to
delete.

## Upgrading from 0.1

Run `sql/upgrade-0.1-to-0.2.sql` (it opens with a check that the table is
AdminIgloo's 0.1 table and refuses otherwise). It adds the new columns and
indexes and changes no data. Then:

- **Every 0.1 file, and every photo the 2a estimator kept (2a stored them
  through 0.1's `storeFile`), is upgraded as a PUBLIC file and stays at its old
  public address until it is moved.** `storage.moveToPrivate({ purpose:
  "estimator.photo" })` copies each into the private store, rewrites its row
  (same id, so every link and every estimate pointing at it still works) and
  deletes the public copy. Run it from your files cron until it reports
  `moved: 0`. create-app's files cron does.
- 0.1's firm-wide files (`tenant_id = '*'`) belong to no company, so no
  company's Files screen lists them. To give them to a business: `update
  stored_files set tenant_id = '<id>' where tenant_id = '*';` (a single
  business: its id). They are public files until moved: list their purpose
  (0.1's `library.file`) in `moveToPrivate` too.
- A 0.1 file whose name has a `%` in it ("May%20invoice.pdf", "100%_done.pdf")
  opens and deletes like any other. Only an encoded `.`, `/`, `\` or `%` in a
  stored key is refused, before anything is read or deleted.
- `BlobStore` is a new shape (`put`, `get`, `delete`, and an optional private
  check). 0.1's two-method adapter is now `BlobStoreV1`; 0.1's functions
  (`storeFile`, `listFiles`, `getFile`, `deleteFile`) still take it, on the
  default table, and are deprecated: each names the instance method that
  replaces it.
- The package no longer depends on `@adminigloo/db`.

## In an app that isn't ours (Ridgeline)

Ridgeline runs its own sign-in, its own roles and its own tables (one of them
already named `stored_files`, for its invoices' PDFs), on node-postgres with
Prisma migrations. In this order:

**1. The driver.** Pass drizzle over your own pool: `drizzle(pool)` from
`drizzle-orm/node-postgres`, or `drizzle-orm/neon-serverless`. Drizzle's
`neon-http` driver is **not** supported: it has no transactions, and the
allowance check needs one.

```ts
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
export const aigDb = drizzle(new Pool({ connectionString: process.env.DATABASE_URL }));
```

**2. Your own table names.** Keep the package's tables in a Postgres schema
of their own, and pass them as `tables`. `tables` is REQUIRED: there is no
default that could point at your own `stored_files`.

```ts
import { defineStorageTables } from "@adminigloo/storage";
export const aigStorage = defineStorageTables({ schema: "adminigloo" });
```

**With Prisma, use a schema, never only a prefix.** A prefixed table
(`{ prefix: "aig_" }`) sits in `public`, which `prisma migrate dev` compares
with your schema.prisma: with no model for it, the next migration Prisma
writes DROPS it, and every file record with it. A schema of its own is
invisible to Prisma. A prefix is for a drizzle-kit or plain-SQL host.

Under a prefix or a schema, export the table **by name** from your drizzle
schema (`export const aigStoredFiles = aigStorage.files;`), never `export *
from "@adminigloo/storage/schema"`: that line also exports the default set,
named `stored_files`, which is your own table's name.

**3. The SQL, in Prisma's own history,** so every environment gets it and
`prisma migrate`'s drift check stays clean:

```sh
npx prisma migrate dev --create-only --name adminigloo_files
# paste the output of storageSql({ schema: "adminigloo" }) into the new migration.sql
npx prisma migrate dev
```

```ts
import { storageSql } from "@adminigloo/storage";
console.log(storageSql({ schema: "adminigloo" }));
```

The SQL opens with a guard: run against a table of yours with the same name,
it stops with "A table named stored_files already exists and isn't
AdminIgloo's. Pass a prefix or a schema." and creates nothing. The whole file
is one statement, so nothing after the guard can run on its own, whatever
runs it. By hand, run it in one go: `psql "$DATABASE_URL" -1 -v
ON_ERROR_STOP=1 -f <file>`.

**4. Your seams.** The company comes from your route, the person and the
permission from your session. Integer ids are fine: pass them as strings,
written ONE way only. `Number("017")` is 17, so a `resolveTenant` that
passed "017" through would let a member upload under /api/orgs/017, /0017, …
each with its own files nobody else sees and its own allowance. Take the id
only as you write it, and answer null for anything else.

```ts
// "17" only: never "017", "17.0" or "1e1".
const resolveTenant = (req: Request) => new URL(req.url).pathname.match(/^\/api\/orgs\/([1-9]\d*)\/files\//)?.[1] ?? null;

const authorize = async (req: Request, permission: string, tenantId: string) => {
  const user = await getSessionUser(req);                       // yours
  if (!user) return new Response("Sign in first", { status: 401 });
  // A suspended company is refused here too.
  const member = await prisma.membership.findFirst({ where: { orgId: Number(tenantId), userId: user.id, active: true, org: { suspended: false } } });
  if (!member) return new Response("Not part of this company", { status: 403 });
  return roleGrants(member.role).includes(permission) ? { userId: String(user.id) } : false; // roleGrants: yours, the permissions a role holds
};
```

`authorize` is asked for each permission a route or a record needs
(`files.view`, `files.manage`, `schedule.view`, …): answer `{ userId }` when
the person holds it, `false` when they don't, and your own `Response` for
"signed out" or "not a member" (it is returned as it is).

**5. Mounting next to your server actions.** Two catch-all routes, on the
Node runtime:

```ts
// app/api/orgs/[org]/files/[...path]/route.ts
const handlers = createStorageHandlers({
  storage: aigFiles,
  resolveTenant,
  authorize,
  // "Added by" on the Files screen: the names of the people who added files (absent: left blank).
  names: async (_tenantId, userIds) =>
    new Map((await prisma.user.findMany({ where: { id: { in: userIds.map(Number) } } })).map((u) => [String(u.id), u.name])),
  // Where your logo is changed, for the logo's "removed where it's used" (absent: names no page).
  logoSettings: "Organization settings",
});
export const runtime = "nodejs";
export const GET = (req: Request) => handlers.handle(req);
export const POST = (req: Request) => handlers.handle(req);

// app/api/files/[...path]/route.ts — signed links and public files
const links = createStorageLinkHandlers({ storage: aigFiles });
export const runtime = "nodejs";
export const GET = (req: Request) => links.handle(req);
export const HEAD = (req: Request) => links.handle(req);
```

**6. Your stores: two buckets.** On R2 (or any S3-compatible server), one
PRIVATE bucket with NO anonymous access, and one public bucket for logos.
(MinIO's `mc anonymous set public` also lets anyone list the bucket: never on
the private one. MinIO's own downloads have stopped; SeaweedFS's S3 gateway
works the same way.) For development, files on this machine's disk.

`region` is "auto" unless you say (R2's). On AWS S3 pass the bucket's region
(`region: "us-east-1"`); a MinIO or SeaweedFS server with a region set wants
that one.

On R2, a bucket is readable by anyone only at its r2.dev address or a custom
domain, never at the S3 address the adapter talks to. So give the private
bucket's r2.dev address as `publicUrlToCheck` and the files cron's check asks
it too; without it, `checkPrivateStore()` passes with a `note` saying that
couldn't be checked (show it on your setup page).

```ts
import { createS3CompatibleStore } from "@adminigloo/storage/s3";
import { createLocalDiskStore } from "@adminigloo/storage/local";

const r2 = { endpoint: `https://${process.env.R2_ACCOUNT}.r2.cloudflarestorage.com`, accessKeyId: process.env.R2_KEY!, secretAccessKey: process.env.R2_SECRET! };
const stores =
  process.env.NODE_ENV === "production"
    ? {
        private: createS3CompatibleStore({ ...r2, bucket: "ridgeline-files", access: "private", publicUrlToCheck: process.env.R2_FILES_DEV_URL }), // "https://pub-….r2.dev"
        public: createS3CompatibleStore({ ...r2, bucket: "ridgeline-logos", access: "public", publicBaseUrl: "https://logos.ridgeline.example" }),
      }
    : {
        // Development only: a serverless host's disk is thrown away between requests.
        private: createLocalDiskStore({ dir: ".data/files/private", access: "private" }),
        public: createLocalDiskStore({ dir: ".data/files/public", access: "public" }),
      };

export const aigFiles = createStorage({
  db: aigDb,
  tables: aigStorage,
  stores,
  records: [jobFiles],   // yours (step 7), and the record types of the AdminIgloo packages you install
  allowanceBytes: () => 5 * 1024 ** 3,
  signing: {
    secret: process.env.FILES_LINK_SECRET!,
    // Asked on EVERY open of a link: the company still active, the person who
    // made the link still an active member of it, and still allowed to open
    // THIS file (mayView runs the file's own rule again with what they hold
    // now, so someone moved to a role that can't see it stops opening it).
    stillValid: async ({ tenantId, userId, mayView }) => {
      const member = await prisma.membership.findFirst({
        where: { orgId: Number(tenantId), userId: Number(userId), active: true, org: { suspended: false } },
      });
      return member !== null && (await mayView((permission) => roleGrants(member.role).includes(permission)));
    },
  },
  urls: { content: (t, id) => `/api/orgs/${t}/files/v1/admin/files/${encodeURIComponent(id)}/content`, publicBase: "https://app.ridgeline.example/api/files" },
});
```

Private files are always sent by your own route (never a redirect to the
bucket), with headers that keep a file from ever running as a page, so your
site's own content security rules need nothing for them. Every upload, link
and remove must come from your app's own address: a page on another of your
subdomains (www., a blog) is refused like any other site.

**7. Files on your own records.** A record type is what a file can be
attached to; its own permissions decide who sees, adds and removes its files.
Ridgeline's jobs:

```ts
import type { StorageRecordType } from "@adminigloo/storage";

export const jobFiles: StorageRecordType = {
  type: "ridgeline.job",        // permanent: it is stored on every file row
  label: "Job",
  pluralLabel: "Jobs",          // the Files screen's filter
  view: ["jobs.view"],          // any one of these sees the job's files
  manage: ["jobs.manage"],      // any one of these adds and removes them
  // optional: someone holding this sees and adds files on the jobs they're assigned to, and nothing else
  // assigned: { permission: "jobs.crew" },
  // The jobs of THIS company among ids, in one query. An id that isn't this company's is left out.
  async find({ tenantId, ids }) {
    const jobs = await prisma.job.findMany({ where: { orgId: Number(tenantId), id: { in: ids.map(Number) } }, include: { crew: true } });
    return new Map(
      jobs.map((job) => [
        String(job.id),
        { label: `Job · ${job.customerName}`, href: `/jobs/${job.id}`, assignedUserIds: job.crew.map((c) => String(c.userId)) },
      ]),
    );
  },
};
```

Then a job's page shows its photos and files with
[`<RecordFiles record={{ type: "ridgeline.job", id }} />`](../storage-widget/README.md),
and the Files screen lists them under "Jobs".

**8. The cron** (any scheduler with your bearer check), daily or more often:

```ts
await aigFiles.purgeDeleted();                                   // bytes of removed files whose store failed
await aigFiles.moveToPrivate({ purpose: "estimator.photo" });    // only if you upgraded from 0.1
const check = await aigFiles.checkPrivateStore();                // a "private" bucket anyone can read
if (!check.ok) reportToYourself(check.reason);
```

(`reportToYourself` is yours: your error log, an email to you.)

**9. Check your install.** On your machine your seams decide who sees what,
and the package's own tests can only fake them. Run this test file with YOUR
seams, against two of your companies, a member of the first who holds
`files.view`, and one who holds no files permission, and show the business
owner the passing list:

```ts
// tests/adminigloo-files.test.ts
import { checkHostSeams } from "@adminigloo/storage/testing";

// A request to the files routes, signed in with a session cookie of yours.
function requestAs(cookie: string) {
  return (tenantId: string, path: string, init?: { method?: string; query?: Readonly<Record<string, string>>; body?: unknown }) => {
    const url = new URL(`https://app.ridgeline.example/api/orgs/${tenantId}/files/${path}`);
    for (const [k, v] of Object.entries(init?.query ?? {})) url.searchParams.set(k, v);
    return new Request(url, {
      method: init?.method ?? "GET",
      headers: { cookie, "sec-fetch-site": "same-origin", ...(init?.body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  };
}

test("files stay inside each company", async () => {
  const office = await sessionCookieFor("301"); // yours: however your tests sign someone in
  const tech = await sessionCookieFor("305");
  const result = await checkHostSeams({
    handlers,                 // the ones you mounted in step 5
    storage: aigFiles,
    companyA: "17",
    companyB: "42",
    member: { userId: "301" }, // a member of 17 holding files.view, not of 42
    request: requestAs(office),
    withoutFiles: { userId: "305", request: requestAs(tech) }, // a member of 17 with no files permission
    suspendedCompany: "58",    // optional: a suspended company of yours
  });
  for (const line of result.checks) console.log(`${line.ok ? "passed" : "FAILED"}: ${line.name}${line.ok ? "" : ` (${line.detail})`}`);
  expect(result.ok).toBe(true);
});
```

The request builder may be async too (`request: async (...) => …`). It stores
one small file in each company, asks for each from the other (with the
company named in the address's query string, and with A's id written another
way, "017"), checks that the member without files permissions is refused,
that a link opens for its maker and for nobody who isn't a member (or can't
open the file), that a suspended company's files can't be reached, and that
no answer carries a storage key, and removes the files. A line it couldn't
check fails, and says what to pass.

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
- **Plans, limits and billing enforcement** — the billing chunk. The
  package asks `allowanceBytes(tenantId)` for each company; in a create-app
  project that answers one setting for everyone (create-app's
  `FILES_ALLOWANCE_MB`) until then.
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
  chunk. (With the package alone, `allowanceBytes` already takes the
  company.)
- **Checking an address before it gets a company's alert emails.** The owner
  adds up to five per group; the company's team sending allowance bounds what
  they get.
