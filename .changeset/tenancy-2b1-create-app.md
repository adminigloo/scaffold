---
"@adminigloo/create-app": minor
---

Alerts and files (Tenancy 2b-1): with `--notifications` and `--storage`, every
company — and in a single-business project, the one business — hears about its
work in the app and by email, and keeps photos and files against its visits,
estimates and invoices, privately.

**What each company gets (companies mode)**

- **A bell in the header** with the company's unread alerts, on a phone too,
  and an alerts page at `/app/alerts`: a customer asking for a visit, moving or
  cancelling one, a request about to lapse, a new estimate request, a quote
  accepted, declined or lapsed, an invoice opened, paid or overdue, a
  customer's email that didn't go, a teammate joining or leaving, and storage
  almost full. Each alert opens the right record, through the switch route,
  so an alert about one company opens in that company.
- **Alert settings** at `/app/alerts/settings`: each person chooses, kind by
  kind, "In the app" or "In the app and by email"; the owner chooses who hears
  about new work (visit requests, leads, invoices) — "The owner" (their copy
  at the business email in company settings) or named people plus up to five
  extra addresses. The office emails of scheduling and the estimator now go to
  exactly those people, one email per lead, and an office email that fails is
  sent again by the alerts cron. A crew member hears when a customer moves or
  cancels their own visit, with a link to their day or the visit's photos.
- **Alert emails go out as the company** (through Messages, as the "Team
  alert" message the owner can reword or switch off), and count in the
  company's own TEAM sending allowance (60 an hour, 300 a day), never in the
  allowance its customers' quotes and invoices use.
- **Photos and files** on each visit (`/app/schedule/visits/{id}/files`, from
  the calendar and the crew's day), each estimate ("Other files") and each
  invoice (your team sees these; they aren't sent to the customer), and a
  Files screen at `/app/files` with the company's usage against its allowance
  (`FILES_ALLOWANCE_MB`, 5 GB by default). Who may see a record's files is
  decided by that record's own permissions. Files are private: a person opens
  them through the site's own routes, and a copied link lasts at most an hour
  and stops working when its maker leaves the company, loses access to that
  file (demoted, or a crew member whose visit moved to another crew), or the
  company is suspended. Customers' estimate photos are kept the same way,
  attached to their estimate; staff's own estimate photos are kept apart, so
  strangers filling the customers' share never stop the business adding its
  own. A full company is told where to write for more room (`SUPPORT_EMAIL`).
- **The company logo** is kept as the company's one public file, under an
  address nobody can guess; replacing it deletes the old one, a 2a logo
  included.
- **Proofs in the project's own `pnpm test`**: the isolation test covers the
  alerts and files routes (including the routes where the record decides,
  a correctly signed link for another company, and the public file routes),
  and two new tests walk each company's alerts and files end to end —
  including one person in two companies, and a copied link that stops when its
  maker loses access.
- **Who hears about new work is in the audit log**: each saved list, and an
  outside address added to one (marked sensitive).

**Single-business mode**: the same alerts and files in the admin shell
(`/admin/alerts`, `/admin/alerts/settings`, `/admin/files`, a visit's
`/admin/schedule/visits/{id}/files`), on new staff keys (`staff.alerts.view` /
`.manage`, `staff.files.view` / `.manage`). Without a shell, the staff get the
bell and the office emails keep 2a's lists. Its own `pnpm test` proves a
copied link stops when its maker loses access to the file (moved to a role
that can't see it, removed from the staff, or a crew member whose visit moved
to another crew).

**Setting it up**

- Files need two Vercel Blob stores: a PUBLIC one for logos
  (`BLOB_READ_WRITE_TOKEN`) and a PRIVATE one for photos and files
  (`BLOB_PRIVATE_READ_WRITE_TOKEN`, refused when it equals the public one);
  DEPLOYMENT.md gives both steps. While developing with neither token, files
  are kept in `.data/files` (git-ignored). `/setup` says which is missing, and
  checks the private store is private (at most once an hour, so a reload
  doesn't spend the store's uploads).
- On Vercel Hobby, Blob is 1 GB and 2,000 uploads a month for the whole site;
  the 5 GB default allowance assumes Pro, and DEPLOYMENT.md says what to set
  on Hobby.
- `FILES_LINK_SECRET` (optional; else derived from the Clerk secret key) signs
  copied links.
- Two new daily crons: `/api/cron/alerts` (the clock's alerts, email retries,
  clean-up) and `/api/cron/files` (removed files, an older version's public
  files moved to the private store in batches until none are left, a check of
  the private store).

**Upgrading a Tenancy 2a project**: `create-adminigloo-app upgrade`. It fetches
the create-app that made the project to see which files you changed, raises
every package, writes the new files, rewrites the ones you never changed,
removes the retired ones you never changed, and writes `<file>.new` beside each
file you did change — those are the only hand edits, and it lists them. On an
unedited project the result is exactly a fresh 0.24 generation. `add` now
refuses a project an older create-app made (and says to run `upgrade`) — an
earlier build of the same version too, told apart by the package ranges it
recorded — and raises any package range left behind in an edited
`package.json`. On Windows, `upgrade` starts `npm pack` without Node 24's
DEP0190 warning in your terminal. The README
and DEPLOYMENT.md (§9) have the steps 2b-1 asks of a person: the second Blob
store, and the old Files page's uploads.

**Removed**: the `notifications` and `files` tRPC routers, `notifyStaff`
(`src/server/notify.ts`), `src/server/blob-store.ts` and 0.1's
`/api/files` upload route — replaced by the packages' own handlers and
`src/server/alerts.ts`, `src/server/files.ts`.

**Moved**: `/admin/inbox` → `/admin/alerts` (the old address redirects).

**Windows**: the generated `.npmrc` sets `virtual-store-dir-max-length=40`,
so every package sits 20 characters shallower in `node_modules/.pnpm` — a
project in a long folder no longer fails `next build` with "Module not found:
Can't resolve '@adminigloo/…-widget/admin'" (Windows' 260-character path
limit). DEPLOYMENT.md's troubleshooting and the README say what to do if a
folder is still too long.

**Companies mode's next steps** name each company's own pages
(`/app/schedule/settings`, `/app/estimates/settings`, `/app/estimates`,
`/t/{web address}/book-visit`), never the single business's `/admin` ones.

New pins: notifications 0.2, notifications-widget 0.1, storage 0.2,
storage-widget 0.1, tenancy 0.6, tenancy-widget 0.2.1, scheduling 0.6,
scheduling-widget 0.3, estimator 0.5, estimator-widget 0.4, invoicing 0.4,
invoicing-widget 0.1.1, comms 0.4, comms-widget 0.1.1.
