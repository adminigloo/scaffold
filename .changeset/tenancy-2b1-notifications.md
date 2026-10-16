---
"@adminigloo/notifications": minor
---

Alerts per company and per person (Tenancy 2b-1).

- **One row per alert per person, per company,** with a key built from the
  fact (a lead, a visit change, an invoice's due date), so a retried request,
  an event handed over twice or a cron that runs again never alerts anyone
  twice.
- **The kind registry:** each package declares its own alerts and their words
  (`defineAlertKinds`), and the project composes them
  (`defineAlertRegistry`); a bad or duplicate key is refused when it is
  defined.
- **Who gets what:** the kind's permission; for new estimate requests, visit
  requests and invoices the people the owner chose in Alert settings, and the
  owner with nothing chosen (the owner's copies at the business email when
  there is one; never nobody); crew on their own visits; never whoever caused
  it.
- **Two channels:** "In the app" or "In the app and by email", per person per
  kind, each kind with its default.
- **Email copies with retries:** the alerts cron (`deliverPendingEmails`,
  `tenantIds` required) sends what failed in the request, companies taking
  turns, with backoff, and checks the person again first (removed, demoted or
  dropped from a list: nothing sent). With a provider that has no idempotency
  key (SMTP), a send that was cut off, or whose email seam threw, is never
  tried again, so nobody gets two.
- **A producer's own office email:** `claimEmails` hands the office addresses
  still owed (once), and `releaseClaim` gives a failed one back to the cron.
- **Reads follow the reader's permissions now:** the bell's list, its count
  and every mark show only what the person may get today.
- **Housekeeping:** `forget` on a removal, `prune` on a role change, `cleanup`
  (read alerts after 30 days, any after 180).
- **`renderAlertEmail`** for a host without comms (everything a customer typed
  escaped, links broken), and `TEAM_ALERT_EMAIL_TEMPLATE`.
- **Handlers, route table, permissions (`alerts.view`, `alerts.manage`) and
  the wire** for `@adminigloo/notifications-widget`, including where each
  person's emails go (the business email for the owner's copies of new work)
  and which kinds the owner's own "In the app" choice keeps out of that
  mailbox. A POST is taken only from the site's own pages (a sibling
  subdomain is refused too), and every change to who hears about new work is
  handed to an `audit` seam (`notificationsAuditedActions`; an outside address
  added is its own, sensitive, entry).
- **Table names are yours:** a prefix or a Postgres schema
  (`defineNotificationTables`); `createNotifications` requires `tables`, so it
  can never point at a host's own `notifications` table. Shipped SQL
  (`notificationsSql`, `sql/notifications-0.2.0.sql`) and the 0.1 upgrade
  (`sql/upgrade-0.1-to-0.2.sql`, exported as `./sql/*`), each ONE statement
  that refuses, and then creates nothing, over a table that isn't
  AdminIgloo's (it lacks any of the package's columns), however it is run:
  `psql -f`, a Prisma migration, a script. Prisma projects use a schema (the
  SQL says so when there is none).
- **`./testing`:** `checkHostSeams` checks a host's own sign-in and company
  routing keep each company's alerts to itself, that a company can't be
  opened at a look-alike id ("017" for 17), that `authorize` checks the
  permission, and that a suspended company gets nothing. Leave out
  `authorize` or `suspendedCompany` and its line fails, "Not checked: pass
  …", rather than the list passing without it.
- **No `@adminigloo/db`:** importing the schema no longer loads the Neon
  driver.

0.1's functions (`notify(db, …)`, `listNotifications`, `unreadCount`,
`markNotificationRead`, `markAllRead`) keep working on 0.1's rows (the
firm-wide inbox) and are deprecated.
