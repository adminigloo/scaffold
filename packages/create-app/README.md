# @adminigloo/create-app

Generates a Next.js project with auth, tenancy, permissions, tRPC, optional
Stripe and staging/production environments already wired.

```
pnpm dlx @adminigloo/create-app <name> [options]
```

Run `create-adminigloo-app --help` for the flags. Every flag given is used
verbatim and only the rest are prompted for, so a specific project can be
reproduced from a single command — which is the first thing you want when a
generated app misbehaves.

## Quick start (for buyers)

1. **Registry.** The packages are private, on GitHub Packages. Put the scope line
   in the folder you generate into (the generated project carries its own copy):

   ```
   @adminigloo:registry=https://npm.pkg.github.com
   ```

   and export a GitHub token with `read:packages` as `GITHUB_TOKEN` — the
   project's `.npmrc` reads it.

2. **Generate:**

   ```
   pnpm dlx @adminigloo/create-app igloo-back-office --tenant-noun Company --admin full --email
   ```

   For a field-service platform — small service businesses each running their
   own estimates, schedule, invoices and customer messages — add the features:

   ```
   pnpm dlx @adminigloo/create-app igloo-back-office --tenant-noun Company --admin full \
     --estimator --scheduling --invoicing --comms --email --storage --notifications --ai
   ```

   With a `--tenant-noun`, each feature belongs to EACH COMPANY (Tenancy 2a):
   its own screens at `/app`, its own public pages at `/t/{web address}`
   (estimate, booking, quote, visit and invoice pages, branded and in its time
   zone), emails under its own name, its own roles (Crew sees only today's
   route) and crons that serve every company. The project proves in its own
   `pnpm test` that one company can't reach another's rows through any feature
   route. With `--tenant-noun none` the same features run for your one
   business, at `/admin`.

   **Customers who sign up as themselves** (billing 0.5): add
   `--audience consumers` to `--tenant-noun none`. With `--model subscription`
   each person pays for their own plans — several product lines on one bill
   (`definePlans({ lines })` in `src/plans.ts`), gated feature by feature with
   `requireEntitlement(feature)` (src/server/access.ts), reading the person's
   OWN account — nobody can share an account (no /settings/team, /members or
   /invite page, no invitation email, a seat limit of one, and no role, the
   owner included, holds the invite, remove, change-role or hand-over keys),
   and you see who pays for what at `/admin/billing/subscribers` and on the
   dashboard at `/admin` (subscribers by plan and line, monthly vs yearly, MRR
   and ARR, new and cancelled this month, failed payments, free to paid):

   ```
   pnpm dlx @adminigloo/create-app weather-terminal --tenant-noun none --audience consumers \
     --model subscription --admin full --email --marketing --seo --analytics
   ```

   **Plans are not a shop** (create-app 0.39): `--model subscription` sells
   plans and nothing else — Stripe and billing, and no `/products`,
   `/checkout`, `/account/orders`, product builder, licence keys,
   `seed-shop`, or catalog and commerce packages. `--model one-time` and
   `both` keep the shop. In `src/plans.ts`, `free: { features }` is what an
   account with no plan gets (the plan check, the pricing page's Free column
   and the plan chooser read the same one), and a tier can be
   `onSale: "coming"` (shown with its price, never sold) or `onSale: false`
   (sold by hand only). The pricing page, the landing page's plans and
   `/account/billing` draw one `PlanCard`: what each plan includes (never "No
   …"), "Everything in Free, plus:", whole-dollar prices, yearly first, and
   "Most popular" only where the record sets `highlight`.

   **Alerts and files** (Tenancy 2b-1, `--notifications` and `--storage`):
   each company gets a bell in the header and an alerts page (`/app/alerts`)
   for its new visit requests, leads, accepted quotes, invoices opened, paid
   or overdue, emails that didn't go and teammates joining; Alert settings
   where each person picks "In the app" or "In the app and by email", and
   the owner picks who hears about new work (the office emails go to exactly
   those people, one email per lead); and private photos and files on its
   visits, estimates and invoices, with a Files screen (`/app/files`) and a
   storage allowance (`FILES_ALLOWANCE_MB`, 5 GB by default, which assumes
   Vercel Pro: on Hobby, Blob is 1 GB and 2,000 uploads a month for the whole
   site, and past either Vercel stops every file for 30 days). Files need a
   second, private Vercel Blob store beside the public one for logos; the
   generated `DEPLOYMENT.md` gives the steps for both. A single business gets the same in its admin shell (`/admin/alerts`,
   `/admin/files`). The project proves in its own `pnpm test` that one
   company can't see another's alerts or files.

3. **First run**, in the new folder:

   ```
   pnpm install
   pnpm db:generate && pnpm db:migrate
   pnpm db:seed
   pnpm dev
   ```

   Sign in. With no administrator yet, you become one when you open /admin.
   `.env.local` is already there; `/setup` lists what each missing key switches
   off. The generated `README.md` and `DEPLOYMENT.md` take it from there,
   including the Clerk production instance, its webhook and the first
   administrator on a deployed site.

   **On Windows, generate into a short folder** (`C:\sites\my-site`, under
   about 80 characters). pnpm keeps each package several folders deep inside
   `node_modules`, and the Next.js build can't read a file whose full path is
   over 260 characters: it stops with `Module not found: Can't resolve
   '@adminigloo/…-widget/admin'` although the package is installed. The
   generated `.npmrc` already keeps pnpm's folders 20 characters shorter
   (`virtual-store-dir-max-length=40`), enough for most folders; the
   packages' own file names are already short (`admin.js`), so the depth is
   pnpm's and the folder's.

`--help` lists every flag.

## Upgrading a project

Every generated project records the create-app that made it
(`adminigloo.json`). To bring it up to this version, in the project's folder:

```
pnpm dlx @adminigloo/create-app@0.24 upgrade
```

It fetches the create-app that made the project (`npm pack`, through the
project's own `.npmrc`, so `GITHUB_TOKEN` must be set; `--from <folder>` points
it at an unpacked copy instead) to see exactly what that version wrote, so it
can tell a file you changed from one you didn't. Then:

- every `@adminigloo/*` package in `package.json` is raised to the version this
  release needs (your own scripts and dependencies stay);
- this version's new files are written, and every file you never changed is
  rewritten;
- the files this version no longer uses are deleted, if you never changed them;
- each file you DID change gets the new version beside it as `<file>.new`.

`.env.local` is never touched; new variables are listed. On a project nobody
edited, the result is exactly what generating fresh with this version gives.
A change of line endings is never an edit: a file an older create-app wrote
with CRLF, checked out of git as LF, is still yours untouched.

**Nothing is lost without being asked.** An upgrade that would drop tables (a
package this version no longer uses leaves `src/db/schema.ts`, so the next
`pnpm db:generate` writes `DROP TABLE … CASCADE` for each of its tables),
change what an account is (companies, or one person each) or stop a plan
check is refused before it writes anything, and says exactly what it would
lose. Run it again with `--allow-data-loss` to go ahead: every loss is printed
above the steps, the dropped tables by name.

**What still needs a hand edit**, and nothing else: each `<file>.new` (fold
your change in, then replace the file), any retired file you had changed (it
is left, and listed: move your change, then delete it), and any file of your
own that imports one of the retired files (a retired page you kept is still
served at its address until you delete it). Then:

```
pnpm install
pnpm db:generate      # then READ the migration it wrote (drizzle/)
pnpm db:migrate       # only once you have: it can't be undone
pnpm db:seed
pnpm exec tsc --noEmit && pnpm test
```

`add <feature>` refuses a project an older create-app made, and says to run
`upgrade` first: the new feature's files would be written for packages the
project doesn't have yet.

### Switching an answer (create-app 0.39)

`upgrade` can change what a project IS while it brings it up to date:

```
pnpm dlx @adminigloo/create-app upgrade --audience consumers
pnpm dlx @adminigloo/create-app upgrade --set businessModel=both --set feedback=true
```

`--set <answer>=<value>` takes `tenantNoun`, `audience`, `businessModel` (or
`model`), `adminShell` (or `admin`), or any feature on or off
(`feedback=true`, `seo-reports=false`); `--audience <a>` is
`--set audience=<a>`. The project is re-planned with the new answers by the
same rules as a version upgrade — new files written, files you never changed
rewritten, the ones the new answers don't have deleted, `<file>.new` beside
every file you did change — so an untouched project ends byte for byte where
a fresh generation with those answers starts (`.env.local` apart, and
`src/plans.ts`: a switch never rewrites it, since its tiers are the ones
people pay for — the new sample goes beside it as `src/plans.ts.new`). On a
project already at this version only the switch is applied, and nothing is
fetched. `adminigloo.json` records the new answers.

A switch that loses something — a feature or the model switched off (their
tables dropped), companies to one account per person or back, consumers back
to business (each person's plan check, and one person per account) — needs
`--allow-data-loss`, and lists every loss first. A companies project asked for
`--audience consumers` is refused outright: that is a new project.

### Crawlable public pages (create-app 0.39)

There is no `loading.tsx` over the public pages any more: it streamed every
page into hidden blocks, so crawlers read "Loading", a redirect answered 200
with a meta refresh and a missing page answered 200. `pnpm build && pnpm
test:pages` checks, as a crawler, that every page in the sitemap answers a
real 200 with its `<h1>` in the first HTML, a missing page a real 404 and a
signed-in page asked for signed out a real 307 (`PAGES_BASE_URL` points it at a
running site instead of starting one).

### From Tenancy 2a (create-app 0.23) to Tenancy 2b-1 (0.24)

`upgrade` replaces 2a's old inbox (`src/server/notify.ts`,
`src/server/routers/notifications.ts`; in a companies project also
`/admin/inbox`) and old public file storage (`src/server/blob-store.ts`,
`src/server/routers/files.ts`, `app/api/files/route.ts`; in a companies
project also `/admin/files`) with this version's alerts and files, and raises
tenancy, scheduling, the estimator, invoicing, comms, notifications and storage
(and their widgets) to their 2b-1 versions. After it, by hand:

1. **The second Blob store** (with `--storage`). Photos and files are private
   now: in Vercel, Storage → Create → Blob, access **Private**, connected with
   the prefix `BLOB_PRIVATE` (it gives `BLOB_PRIVATE_READ_WRITE_TOKEN`). Keep
   the store you have: it holds the logos. Redeploy. Until then new photos and
   files can't be added, and the screens say so. (On Vercel Hobby, read the
   generated DEPLOYMENT.md's "Photos and files" first: Blob there is 1 GB and
   2,000 uploads a month for the whole site.)
2. **The older public files** move by themselves: the files cron
   (`/api/cron/files`) copies the photos and files 2a kept at public addresses
   (customers' estimate photos, and the old Files page's uploads) into the
   private store, a batch every run. `/setup` says how many are left.
3. **The old Files page's uploads** (with `--storage`) belonged to the whole
   site (`tenant_id = '*'`), and no screen lists them now. A single business:
   `update stored_files set tenant_id = 'primary' where tenant_id = '*';` puts
   them back on its Files page. A companies project: `update stored_files set
   tenant_id = '<company id>' where tenant_id = '*';` gives them to one company
   (its id is on /admin/companies), or delete them.
4. **Who hears about new work** (with `--notifications`) is chosen again in
   Alert settings: 2a's per-feature "send new-request alerts to" lists aren't
   read any more.

The generated `DEPLOYMENT.md` (§9, "Upgrading") carries these steps for that
project's own features.

### Feedback per company (Tenancy 2b-2a, create-app 0.26)

With `--feedback` in a companies project, each company works its own board at
`/app/feedback` (settings at `/app/feedback/settings`), and its customers write
to it at `/t/{web address}/feedback` — emailed the team's answer in the
company's name with `--comms`, and alerting the team with `--notifications`.
This site's own board (the in-app button's) stays at `/admin/feedback`, on
staff keys of its own (`staff.feedback.*`). A single business keeps its one
board. `upgrade` removes the retired feedback tRPC router; then run
`pnpm db:generate && pnpm db:migrate` (or feedback's
`sql/upgrade-0.9-to-0.10.sql`) and `pnpm db:seed` for the new staff keys.

### The complete feedback board (feedback 0.11, create-app 0.27)

Every board — each company's and this site's own — has search and filters
(status, priority, category, who it's assigned to, where it came from, when it
was sent; Mine, Unassigned and Critical in one click), kept in the page's
address and remembered per browser, with "Showing X of Y". The team files
tickets with **New ticket** (or the **+** on a column), and the ticket panel
edits the title, priority, category and assignee — picked from the company's
members, or this site's staff — with an activity trail. The settings pages
render `@adminigloo/feedback/admin`'s screens (columns, categories, website
keys); `src/components/FeedbackSettings.tsx` is gone. `upgrade` removes it;
then `pnpm db:generate && pnpm db:migrate` (additions only).

Not included yet: saved views per person, custom fields, custom domains.

### Epics on the feedback boards (feedback 0.12, create-app 0.28)

Each company's epics are at `/app/feedback/epics` (and `/app/feedback/epics/{id}`),
this site's own board's at `/admin/feedback/epics` — the bigger pieces of work
tickets are grouped under, each with its progress (done, in progress, waiting,
not started, counted by the board's columns), who leads it and when it's due.
The pages are a few lines around `@adminigloo/feedback/epics`' `FeedbackEpics`
and `FeedbackEpic`, on the board's own keys (`feedback.view` to look,
`feedback.manage` to change; `staff.feedback.*` on this site's own board), with
a nav entry each. On the boards, each card shows its epic, the toolbar filters
by epic ("No epic" too), and the ticket panel and New ticket pick one. The
isolation proof plants an epic per company and drives every epic route from
the package's table. `upgrade` adds the pages; then `pnpm db:generate && pnpm
db:migrate` (additions only).

Not included: sprints, swimlanes by epic, saved views per person.

### An AI assistant per company (Tenancy 2b-3, create-app 0.29)

With `--assistant` in a companies project, every page of a company's area
(`/app/…`) has an "Ask the assistant" button (`app/(site)/app/layout.tsx` over
the generated `src/components/AssistantLauncherSlot.tsx`), over
`/api/app/{id}/assistant`. Its owners and admins write what it knows at
`/app/assistant` — the business in their own words, answers to common
questions (asked word for word, answered with those words and no AI), house
rules and words — and see the month's AI use. It looks things up through the
installed features' own reads with the asker's own permissions
(`src/server/assistant-tools.ts`: the schedule, overdue invoices, the price
book) and asks before it changes anything (the one change it offers: saving an
answer). With `--ai` it answers on Claude Haiku 4.5 (`ASSISTANT_MODEL`), each
company has a month of questions (`ASSISTANT_MONTHLY_MESSAGES` /
`ASSISTANT_MONTHLY_CENTS`, or "AI assistant messages a month" on its plan when
you sell plans), the whole site stops for the day at `AI_SITE_DAILY_CENTS`, and
every question is recorded in `ai_usage`; without `--ai` the settings work and
the chat says it isn't switched on. This site's own assistant stays at
`/admin/assistant` (its chat at `/admin/assistant/chat`), on `staff.assistant.*`.
A single business keeps one assistant, with the feature tools on its staff keys.
`upgrade`: then run `pnpm db:generate` and replace the assistant statements with
`@adminigloo/assistant/sql/upgrade-0.8-to-0.9.sql`, and `pnpm db:seed` for the
new keys.

`--ai` also changed: Claude Haiku 4.5 by default, answers capped at 2,000
tokens, usage recorded through `@adminigloo/ai/server`, and `/api/ai/chat`
checks the company's month (`AI_CHAT_MONTHLY_CENTS`) and the site's day too.

Not included: the assistant answering customers on a public page, changing
records beyond saving an answer, vector search (keyword only unless you add
the optional table).

### Website visits and search basics per company (Tenancy 2b-4a, create-app 0.30)

`--analytics` (it brings `@adminigloo/audience`) and `--seo`, or later
`create-app add analytics` / `add seo`:

- **Each company's website numbers** at `/app/website` (`analytics.view`; in
  the company nav): visits to its pages here (`/t/{web address}`, the beacon
  `<PublicCompanyGate>` mounts) and to its own website (it adds the website
  there and pastes one line; `/api/w/v1/beacon.js` posts to
  `/api/w/v1/collect?site={its key}`, counted only from that website's own
  addresses), where they came from — search engines, AI assistants by name,
  other sites — the pages read, the AI crawlers that read its pages, and the
  "left out" line with "count everyone". Each website shows whether its line
  is working ("No visits yet. Paste the line, then open your site once", then
  "Counting — last visit …"), with paste steps for WordPress, Wix, Squarespace
  and anything else. Its own team is left out of its numbers automatically;
  owners and admins (`audience.manage`) add a team member's email, everyone
  at an email domain, an office internet connection or a monitoring tool —
  found only among the company's own members and invitations, never another
  company's people — and "leave this device out" links open each website with
  that phone or computer left out from then on. The routes are `/api/app/{id}/website` and
  `/api/app/{id}/audience`, and the isolation proof drives
  `ANALYTICS_ADMIN_ROUTES`, `ANALYTICS_PUBLIC_ROUTES` and
  `AUDIENCE_ADMIN_ROUTES` as another company, plus A's site key pasted on B's
  website (nothing counted). A project that sells plans gets "websites of your
  own counted" on each plan (1 / 3 / unlimited, checked when one is added,
  under a per-company lock so adds sent at once can't pass it); a closed plan
  keeps the numbers readable and stops counting. A website can't have an
  address another of the company's websites has, nor — once deployed — the
  app's own address or localhost.
- **This site's own numbers** at `/admin/analytics` (`staff.analytics.view`,
  `staff.analytics.manage`, `staff.audience.manage`), from the beacon every
  `(site)` page mounts (`src/components/SiteAnalyticsSlot.tsx`, generated in
  two variants), signed-in screens not counted, its staff left out. A single
  business (`--tenant-noun none`) is one site, the way adminigloo.com counts
  its own.
- **Search basics** (`--seo`): `src/seo.ts`, `app/robots.ts` and
  `app/sitemap.ts` on `@adminigloo/seo` from one path list; robots.txt names
  the AI crawlers. With companies, each company's public pages get their own
  title, canonical address and LocalBusiness details from its company
  settings, and the pages of every company taking requests are in the
  sitemap — the estimate page once its estimator is set up; token pages
  (`/t/{*}/quote`, `/visit`, `/invoice`) stay out, and nothing is indexed off
  production. Without `--seo`, company pages stay out of search as before.
- **A company that isn't taking requests** — suspended, or (when you sell
  plans) its trial ended or it has no plan — has pages that say so
  (`<PublicCompanyGate>` asks the plan's standing as well as the status): no
  widget, no visit counter, no crawler log, noindex, out of the sitemap.
- `AUDIENCE_SECRET` is optional (made from `CLERK_SECRET_KEY` otherwise); the
  daily tidy-up is `/api/cron/analytics` (`CRON_SECRET`).
- `add analytics` on an upgraded project: then `pnpm db:generate && pnpm
  db:migrate` (the `analytics_*` and `aig_audience_*` tables) and `pnpm
  db:seed` for the new keys.
- The site's `openGraph.locale` is `en_US` now (it was `en_GB`); change it in
  `src/seo.ts` / `app/layout.tsx` with the rest of the copy.

Upgrading a project that already has analytics 0.2 (adminigloo.com is one):
move `@adminigloo/audience` to `^0.2.0` in the same change as
`@adminigloo/analytics` `^0.3.0` — analytics 0.3 needs audience 0.2 — and run
`@adminigloo/analytics/sql/upgrade-0.2-to-0.3.sql` (one nullable column, one
index and the `analytics_websites` table; safe to run twice) before the new
code takes traffic. Audience 0.2 changes no tables. A host that gives an
audience its `listUsers` must return only that tenant's own people (see the
audience README).

Not included: SEO reports and AI-citation tracking per company (Tenancy 2b-4b),
book-a-call per company (2b-4c), Google Search Console, crawler counts for a
company's own website (crawlers don't run the pasted line).

### Not included (Tenancy 2b-1)

What a generated project does NOT do yet, so nobody sells it as doing so. The
generated `README.md` carries the same lists (single-business projects leave
out the items that are only about companies).

- **Sprints and swimlanes by epic on the feedback board.** Its epics, filters, search, New ticket, editing and settings screens are here (feedback 0.12), and so are the board per company, its alerts and its private screenshots (Tenancy 2b-2a).
- **The assistant answering customers on a public page.** Each company's assistant is its team's, behind sign-in (Tenancy 2b-3).
- **SEO reports, AI-citation tracking and book-a-call (booking) per company** —
  Tenancy 2b-4b and 2b-4c. Website visits and search basics are per company
  since Tenancy 2b-4a (`--analytics`, `--seo`).
- **Text (SMS) and push alerts.** Alerts come in the app and by email — S9.
- **Plans, limits and billing enforcement** — the billing chunk. Each
  company's storage allowance is one setting for everyone
  (`FILES_ALLOWANCE_MB`) until then; the seam the billing chunk fills is
  there.
- **Card payouts to anyone but the company itself**, and **SMS** payment links. (Customers pay invoices and deposits by card into the company's own Stripe account.)
- **Custom domains.**
- **Virus scanning of uploads.** Files are checked for their type and size
  only.
- **Uploads over 4 MB, and uploads straight from the browser to storage.**
  Phone photos are made smaller before they're sent; other files over 4 MB
  are refused with a plain sentence.
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

### Not included (Tenancy 2a)

Still true after Tenancy 2b-1. (2a's "per-company boards", "payments to
companies", "plans" and "custom domains" items are restated in the list
above.)

- **Impersonation** ("view as this company") from the operator console, and
  platform-wide feature reports (all companies' visits, estimates, invoices)
  in `/admin`.
- **Search indexing of company pages**, and per-company SEO.
- **Logo and colour inside emails.** Emails carry the company's name and
  reply-to; their bodies are plain text.
- **Emailing customers about a time-zone correction** made in company
  settings. Visits keep their clock times and reminders are re-queued silently.
- **A scheduling embed** (a script for the company's own website). The
  booking page's address is shown to copy. The estimator gives each company a
  button and a page frame for its website; its keyed React component needs a
  React site and access to the private package registry.
- **Payment instructions and per-feature identity in single-business mode.**
  A single business's invoices carry the name, contact and time zone saved in
  its Schedule or Estimate settings (else the site's name); how customers pay
  is left blank.
- **Per-company custom roles and per-person permission changes.** Crew is a
  fixed role scheduling adds.
- **Moving a pre-2a companies project's feature rows** (written under the
  fixed `"primary"` business) into a company. The emitted README gives the SQL
  for one company; nothing does it automatically.
- **Sending from a company's own domain.** Every company's email leaves from
  this site's one verified domain, under the company's name, held to a sending
  allowance (100 an hour and 500 a day; 20 and 100 in its first week).
- **Rules on what a company may call itself.** Nothing stops a company naming
  itself after another business; suspend it from the operator console.
- **A suspended company's customer links.** While a company is suspended, all
  of its public pages, its customers' invoice, quote and visit links included,
  say it isn't taking requests online and how to reach it.

---

## The rules

These governed the scaffold from the beginning and lived in nobody's head but
ours. Violating one is worse than not shipping. Each is followed by the failure
it exists to prevent, because a rule with no failure attached is one the next
person negotiates away.

### 1. Conditionals are allowed in the generator and forbidden in the artifact

`emit.ts` branches on `answers` constantly, and that is correct — it is the only
place that knows what was asked for. **No emitted file may contain an `if`
asking whether a feature was installed.**

Absence is a generated array with no entry in it, or an overlay directory that
was not copied. Never a flag, never a `null` some page has to remember to test.

A generated project carrying `if (features.stripe)` is a template with extra
steps. The branch is dead code in every project that answered one way, so
nothing exercises it, and the moment one client edits around it the two halves
rot independently. `src/nav.ts` is the shape to copy: it emits `SITE_LINKS`,
`APP_LINKS` and `FOOTER_LINKS` as lists, consumers map over them, and
`APP_LINKS` is simply `[]` in a project generated with `--admin none`.

The bug that earned this its own heading: `AuthHeader` linked to `/admin`
unconditionally, so every signed-in user of a `--admin none` project saw a link
to a 404 — in the very file that had been introduced to stop exactly that.

### 2. Overlays are strictly additive

An overlay ADDS files. It never rewrites one the base template owns, and
`OverlayCollisionError` fails the build rather than trusting anybody to
remember.

This is what makes the combination space tractable: overlays compose because
they cannot interfere. It is also why an overlay cannot patch a link into the
base header — the header is a base file — and therefore why the nav is
generated instead.

`OverlayCollisionError` proves that no two overlays write the same path. That is
**not** the same as proving a given combination typechecks and builds, and the
failure mode of additive overlays is precisely the combination nobody generated.
The nightly [generator matrix](../../.github/workflows/generator-matrix.yml)
exists for that, and its six combinations are chosen to cover the corners nobody
produces by hand.

### 3. Base modules are runtime npm dependencies; the admin panel is copied source

The base packages are installed and upgraded. The admin shell is copied into the
project, because every client restyles it.

Copied source stops receiving upstream fixes the moment it is copied, so only
**presentation** goes in an overlay. Routers, permission checks and audit calls
stay in the runtime packages, which is what lets a security fix reach every
project without a re-copy.

`SCAFFOLD.md` records the generator version for this reason: a year later, the
only way to tell a deliberate edit from a stale default is to diff against the
version that produced it.

### 4. Everything must boot with no credentials

A missing key degrades to a documented no-op **with a real return value**. Never
a throw. Never an early return that callers have to remember to check.

`createEmailSender` is the pattern: with no `RESEND_API_KEY` a send is recorded
as outcome `'skipped'` and written to `email_events` anyway, so the feature
works end to end on a laptop and the rows a person debugging "why did they never
get the email" needs are the ones a provider dashboard by definition lacks.
Copy that shape.

The rate limiter is the same idea pointing the other way: with no Upstash pair
it counts in one process's memory, and it says so on the limiter rather than
pretending the two cases are equivalent.

The thing that must never degrade quietly is a **live key outside production**.
That throws at boot and no environment variable turns the check off.

**And it must build with them.** The rule above is half a promise, and for five
releases only that half was checked: every harness run and every CI job
generated a project with no credentials, so every code path that exists *because*
a key is present was untested. What that hid was a `--email` project that could
not run `next build` at all once Clerk keys were in `.env.local` — `/setup/email`
declared `force-static`, prerendering happens at build time where no proxy has
run, and the header in `app/(site)/layout.tsx` reads a session it can only reach
through one. With no keys the header returned before the read and the build was
green. A degradation path that is only ever exercised in its degraded state is
not a tested path; `scripts/verify-generated.mjs` now builds twice, and
`assertNoPrerenderedAuthRoutes` refuses the shape at generation.

### 5. The firm owns the tenant table; Clerk is identity only

Clerk owns credentials and sessions. It owns nothing else. The local `user` row,
the tenant, the membership, the role template and every permission assignment
live in our database, and the permission engine reads them from there.

**Never read Clerk's `has()`. Never configure a Clerk Plan. Never enable Clerk
Billing.** Not as a shortcut, not for one check, not behind a flag.

The reason is specific and it is a security failure rather than an architectural
preference. `has()` answers from Clerk's own plan and feature model. Enabling
Billing makes permission visibility **plan-gated**: a permission the firm's
tables grant starts returning `false` because a subscription lapsed, a plan was
renamed in a dashboard by someone who did not know it was load-bearing, or a
webhook was late. The application would then deny access that its own database
says is allowed, silently, with no row anywhere recording the decision — and the
audit log would show nothing at all, because nothing in our code made a choice.
The two-layer engine in `@adminigloo/permissions` is the only authority on what
a principal may do.

### 6. These are published packages, and every export is a permanent API commitment

Prefer a smaller surface. An export is far easier not to add than to remove.

Add a changeset for every package you touch. `@clerk/break-check` runs on every
pull request and posts a table of what the public type surface gained and lost,
so a `patch` that quietly deletes an exported type is visible before it ships
rather than in a client's build afterwards.

---

## How a project is assembled

In order, all of it planned in memory before a single file is written, so a
failure halfway through leaves an empty directory rather than a half-generated
project that looks complete enough to start editing:

| Source | What it contributes |
| --- | --- |
| `template/` | Every file every project gets. Token substitution only — `__SCOPE__`, `__PROJECT_NAME__`, `__TENANT_LABEL_PLURAL__`. Deliberately not a templating language: a template that can branch is a template that will grow branches. |
| `overlays/*` | Directories copied in whole when the answers select them. Additive; see rule 2. `answers.ts` decides which, in `overlayNamesFor`. |
| `emit.ts` | Files whose CONTENT depends on the answers: `package.json`, `src/env.ts`, `src/db/schema.ts`, `src/nav.ts`, `src/server/_app.ts`, the audit registry, the landing page, the comms senders and queue hooks (`src/server/comms-senders.ts`, `src/server/comms-hooks.ts`) who hears about a visit (`src/server/scheduling-notify.ts`), and the estimator's glue — who hears about an estimate, where its photo is kept, what reads it, what an accepted quote becomes (`src/server/estimator-notify.ts`, `src/server/estimator-services.ts`, `src/server/estimator-features.ts`). Strings here interpolate `answers` directly, because this is the generator and rule 1 permits it. |
| `manifest.ts` | `adminigloo.json`, then `SCAFFOLD.md` **from** it. |

## `adminigloo.json`

Written into every generated project. It records the answers, the installed
packages with their ranges, the overlays applied, the capabilities the project
expects to have, and which environment variables block boot as against which
merely change documented behaviour.

Before it existed, "what is enabled here?" was answerable only by reading
`package.json` and walking the directory tree — so every tool that needed to
know re-derived it, and they drifted.

Two properties matter more than the contents:

- **Nobody hand-maintains it.** The file says so itself, in a `//` key, because
  JSON has no comments and people open this file.
- **Every field is derived.** That is what lets the manifest be rebuilt from the
  answers and compared against the copy on disk, which is the only way drift
  becomes something a tool can find. One hand-written field anywhere would end
  that for the whole file — which is why there is nowhere in it to record a
  forked module. Forking is legitimate and worth writing down, and no tool can
  infer it, so it goes in `SCAFFOLD.md` under a heading that says plainly which
  part a person owns.

`SCAFFOLD.md` is generated **from** the manifest rather than alongside it. Both
files state the same facts; deriving each separately from `answers` is two
implementations of one truth, and the day somebody adds a question and updates
one renderer, the human-readable copy is the one people believe.

## Versions

`versions.ts` hardcodes the version of each base package a new project installs,
and `versions.test.ts` fails the build if it drifts from the workspace. That
test is the only reason a hardcoded list is safe: a caret range on a `0.x`
version means `>=0.x.0 <0.(x+1).0`, so leaving a package at `^0.1.0` after it
ships `0.2.0` makes every new project install the old one. It resolves, it
builds, and the feature the release added is simply absent.

Shared third-party versions live in the workspace catalog in
`pnpm-workspace.yaml`, in two blocks: the default catalog is the single version
this workspace builds and tests against, and the `peers` catalog is the wider
range published packages promise their consumers. `catalog.test.ts` requires the
ranges `emit.ts` writes into a generated project to match the default catalog
exactly — the generated project is not a workspace member, so nothing else
would notice it falling behind.
