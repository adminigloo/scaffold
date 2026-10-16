---
"@adminigloo/feedback": minor
---

A feedback board for each company (Tenancy 2b-2a).

- **Every staff function takes the company and only touches its rows.**
  `listBoardData(db, tenantId, …)`, `moveTicket(db, tenantId, …)`,
  `createStatus(db, tenantId, …)`, `listCategories(db, tenantId)`,
  `addTicketMessage(db, tenantId, …)` and the rest: another company's ticket,
  column, category or website key, asked for by id, is "not found". The
  signatures changed on purpose — a 0.9 call that compiled and read every
  company's board would be worse than a type error. Messages are reached
  through their ticket's company.
- **Columns and categories per company.** `feedback_statuses` and
  `feedback_categories` have a company column (existing rows become `'*'`,
  the platform's own board — `FEEDBACK_PLATFORM_BOARD`), unique on (company,
  key). A company's board gets the default columns AND categories the first
  time it's used (`ensureFeedbackBoard`): idempotent, race-safe, and a column
  the owner deleted never comes back.
- **Ticket numbers count per company**: each company starts at FB-00001,
  race-safe through the (company, number) unique index. Numbers now count past
  FB-99999 (0.9 compared them as text).
- **The intake takes the company from the request** (`resolveTenant`), so a
  company's public feedback page needs no website key; a key sent under
  another company's address is "not found". `admit(tenantId, req)` closes a
  suspended or plan-ended company to NEW tickets (409 `feedback_closed` with
  the company's sentence, and `closed` in config) while its reporters can
  still read and reply. Plain-sentence errors (`{ error, code }`), and a
  screenshot's stored name no longer carries the company id.
- **`createFeedbackAdminHandlers({ db, resolveTenant | tenantId, authorize, staffName, onEvent })`**:
  the board, the ticket panel (report, messages, reply, assign, move,
  archive, read), columns, categories and website keys over fetch, with
  `FEEDBACK_ADMIN_ROUTES` / `FEEDBACK_PUBLIC_ROUTES` (the routes as data, 2a's
  shape) for an isolation proof. Staff names come from the server, never the
  browser. New `createTicket`, `getTicket`, `listClientKeys`,
  `listColumnsWithCounts`; `revokeClientKey(db, tenantId, id)`.
- **`feedbackPermissions`**: `feedback.view` (owner, admin, member, viewer),
  `feedback.manage` (owner, admin, member), `feedback.settings.manage` (owner,
  admin); crew none.
- **Alerts**: `feedbackAlertKinds` (a customer sends feedback; a customer
  answers) to everyone who can see the board, and `feedbackAlertsFor`.
- **Reporter emails**: `FEEDBACK_EMAIL_TEMPLATES` and
  `feedbackReporterEmailFor` for the team's reply and a ticket moving, from the
  new `staff.replied` and `ticket.moved` events. Events now all carry the
  company; `reporter.replied` carries the reply's id.
- **`./board`**: `FeedbackWorkspace` (the board, toolbar and ticket panel
  connected to the staff routes by a base URL) and `FeedbackAdminClient`, so a
  company's page and the platform's page use the same component.
- **Shipped SQL**: `sql/feedback-0.10.0.sql` and
  `sql/upgrade-0.9-to-0.10.sql` (exported as `@adminigloo/feedback/sql/*`).
  See "Upgrading from 0.9" in the README.
- Tests run on PGlite (a real Postgres) instead of a fake database.

Not included yet (2b-2b): server-side filters and search, a "new ticket"
button for staff, column and category editors as package screens, epics.

After review:

- **Upgrading from 0.9 keeps your own board whole.** 0.9 had one board, so
  `sql/upgrade-0.9-to-0.10.sql` puts every 0.9 website key and ticket on `'*'`,
  your own site's board — whatever company id 0.9's issue-key script filed them
  under — so your feedback button keeps working and no company's board shows
  reports never sent to it. It moves them only on a 0.9 database; run again
  later, it moves nothing. The company column on columns and categories has no
  default after the upgrade (an insert that forgets the company fails).
- **The open door on a company's feedback page, held to a size.** A hidden
  field (`website`) a person never fills refuses a scripted report;
  `createFeedbackRateLimit` (with `FEEDBACK_INTAKE_LIMITS`) counts per form and
  visitor, per visitor across every company, and a feedback page's whole day,
  and counts a request with no address as one shared visitor. A refusal says
  why in its own words (`FeedbackRateLimitDecision.message`).
- **Screenshots.** A company's keyless feedback page takes none. The bytes
  must really be a PNG, JPEG or WebP image. A report keeps only screenshots
  THIS board's upload route stored (new `feedback_uploads` table), so no other
  store's address and no other company's picture; `sweepFeedbackUploads`
  deletes the ones no report used within a day. New `screenshots` seam (put,
  attach, remove; per board if a function), with `feedbackScreenshotPurpose`
  and `feedbackFileRecords` for keeping them privately on their ticket with
  @adminigloo/storage.
- **A reply never shows a sign-in address as its sender**: an address-like or
  missing name is the business's name (`teamName`).
- A report keeps only a category the board offers its customers.
