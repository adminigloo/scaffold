---
"@adminigloo/create-app": minor
---

Company features (Tenancy 2a): in a project made with a `--tenant-noun`, the
estimator, scheduling, invoicing and messages now belong to EACH COMPANY, not
to the platform. A single-business project (`--tenant-noun none`) keeps them
on its one business, at today's paths.

**What each company gets (companies mode)**

- **Its own area at `/app`**: the schedule (`/app/schedule`, today's route at
  `/app/schedule/today`, schedule settings), estimates (`/app/estimates`, one
  estimate's page, estimate settings with the website embed key), the price
  book (`/app/price-book`), invoices (`/app/invoices` and one invoice's page)
  and messages (`/app/messages`). Each page shows the company the person has
  switched to and checks their role in it; each talks to routes that name the
  company in their path (`/api/app/{company id}/…`), so a tab still showing one
  company never acts on another.
- **Its own public pages at `/t/{web address}`**: the instant estimate, the
  booking page, and the quote, manage-your-visit and invoice pages behind its
  emails — headed by the company's name, logo and colour, in its time zone. A
  suspended company's pages say plainly it isn't taking requests online, and
  its routes refuse. The company's home page lists them.
- **Its own emails**: every customer email carries the company's name (on the
  site's one verified sending address) and its reply-to, links only to its own
  pages, and its office notices go to its own addresses — never to the platform
  owner. Links in office emails go through `/app/switch/{web address}`, which
  opens the right company first.
- **Its own roles**: owners and admins manage everything; members work
  estimates, the schedule and invoices; a new **Crew** role (from scheduling)
  opens only today's route; viewers read. The features' permission keys are
  company keys, and the header and dashboard show each person only what their
  role opens. The price book, estimate settings and schedule settings are
  read-only for a role that can't change them, rather than offering Save
  buttons the server would refuse — and so, for a viewer, are the schedule
  (no Accept, dragging or New visit), the estimates and each estimate (no New
  estimate, no Send quote or edits) and the invoices (no New invoice).
- **Its own setup**: a new company gets its first schedule settings (online
  booking off), its estimate settings' zone and every email template, the
  moment it is created; its setup checklist gains each feature's steps
  (services and booking, crews and hours, prices, estimate settings, how
  customers pay, the website embed). Business name, time zone, contact, logo
  and colour are set once in company settings and read by every feature.
- **Crons that serve every company**: the scheduling and estimator crons run
  for every active company (a suspended one is skipped, one company's failure
  doesn't stop the rest), and the comms drain sends only active companies'
  messages.
- **Proofs in the project's own `pnpm test`**: every feature route —
  private and public — refuses another company's ids (driven from the
  packages' route tables, with a negative control), the crons serve every
  active company, and each company's email goes out under its own name.

**Both modes**

- Invoicing and messages run on their packages' own handlers and the new
  `@adminigloo/invoicing-widget` and `@adminigloo/comms-widget` screens.
  REMOVED: the `invoicing` and `comms` tRPC routers and the copied
  `/admin/invoices`, `/invoice/[token]` and `/admin/comms` pages (replaced by
  thin pages over the widgets). A single business's ledger and Messages now
  have their own staff keys (`staff.invoices.view` / `.manage`,
  `staff.comms.view` / `.manage`) instead of the admin shell's; someone with
  only the `.view` key isn't offered "New invoice" or Edit.
- MOVED: in a companies project, the feature screens moved from `/admin` to
  `/app`, and the public pages from `/estimate`, `/book-visit`, `/quote`,
  `/visit` and `/invoice` to `/t/{web address}/…`. The platform's own header,
  sitemap and llms.txt no longer list a booking or estimate page; `/admin` is
  the operator console.
- New pins: tenancy 0.5, tenancy-widget 0.2, scheduling 0.5,
  scheduling-widget 0.2, estimator 0.4, estimator-widget 0.3, invoicing 0.3,
  invoicing-widget 0.1, comms 0.3, comms-widget 0.1, email 0.3.

**Upgrading a companies project made before 2a**: its feature rows were
written under the fixed `primary` business; the generated README gives the SQL
that moves them into one company.

**After review**

- A company's public pages live outside the site's header and footer (their
  own route group), and their tab titles and link previews are the company's.
- The comms drain lets companies take turns, has room for more, and reports
  a run that stops early; DEPLOYMENT.md says plainly that once a day is not
  enough for many companies, and how to run it every 15 minutes.
- Each company's email is held to a sending allowance (100 an hour, 500 a
  day; 20 and 100 in its first week), reported to /admin/errors.
- "Turn into an invoice" asks the invoice permission in both modes; photo
  reading has a site-wide daily ceiling; the crons start at a different
  company every run and report companies they didn't reach; scheduling's
  cron takes at most 25 expiries per company a run.
- Estimate settings offers a button and a page frame for the company's own
  website; notices are shown once; a company reads no environment variable
  names; a crew member joining a company with one free crew is put on it;
  invoices fall back to the same starting zone as the rest; a single
  business's invoices carry the details saved in its Schedule or Estimate
  settings; the invitation names the site.
- The isolation proof now plants rows every list route can leak, mixes one
  company's rows with another's, and checks each role is refused what it
  doesn't hold; the cron proof shows companies taking turns; the email proof
  shows the allowance.
