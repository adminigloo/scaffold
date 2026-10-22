# Which packages run per company

In a project made with a `--tenant-noun` (a "companies" project), each
business that signs up is a company of its own. This page says, for every
package in this repository, whether it already keeps each company's things
apart — or which piece of work will make it so, or why it never needs to.

- **Per company**: every record the package keeps belongs to one company, and
  every screen and route it serves refuses another company's records. Where
  the package publishes its route list, the generated project's own
  `pnpm test` sends every route another company's ids and checks the answer
  (`src/server/__tests__/feature-isolation.test.ts`).
- **Not yet**: named by the piece of work that will make it per company.
  Until then it works for the whole site, as it did before companies.
- **Shared**: not about any one business, on purpose.

The same table lives in
`packages/create-app/src/__tests__/per-company-coverage.test.ts`, which fails
when a package is added without a line here, when a line names a package that
doesn't exist, or when a per-company package's routes aren't in the generated
project's isolation test.

| Package | Where it stands | What that means |
| --- | --- | --- |
| `tenancy` | Per company | Companies themselves: sign-up, the team, roles, switching, company settings, suspending. |
| `tenancy-widget` | Per company | The screens for the above: onboarding, the switcher, the team page, company settings, the operator console. |
| `permissions` | Per company | Each person's role and permissions are held in one company at a time. |
| `trpc` | Per company | The app's own data calls check the company and the role before they run. |
| `auth` | Per company | Sign-in; who someone is, which the company checks then rely on. |
| `testing` | Per company | The checks every project runs, including the one that proves companies can't see each other. |
| `estimator` | Per company | Each company's price book, estimates, quotes and estimate photos. |
| `estimator-widget` | Per company | The estimate screens and the instant-estimate page, for the company you're in. |
| `scheduling` | Per company | Each company's visits, crews, hours and booking page. |
| `scheduling-widget` | Per company | The calendar, today's route and the booking pages, for the company you're in. |
| `invoicing` | Per company | Each company's invoices and payments. |
| `invoicing-widget` | Per company | The invoice screens and the customer's invoice page. |
| `comms` | Per company | Each company's customer messages, sent under its own name. |
| `comms-widget` | Per company | The Messages screen. |
| `email` | Per company | Sends each company's emails under that company's name and reply-to. |
| `notifications` | Per company | Each company's alerts, and each person's choices about them (Tenancy 2b-1). |
| `notifications-widget` | Per company | The bell, the alerts page and Alert settings. |
| `storage` | Per company | Each company's photos and files, kept private, and its logo (Tenancy 2b-1). |
| `storage-widget` | Per company | Photos and files on a record, the Files screen and the storage meter. |
| `feedback` | Per company | Each company's feedback board: its tickets, columns, categories, website keys and its customers' feedback page (Tenancy 2b-2a). The site's own board stays the site's. |
| `feedback-widget` | Per company | The feedback form on a company's feedback page and its own website, and the site's own feedback button. |
| `assistant` | Per company | Each company's AI assistant: what it knows about the business (its profile, answers to common questions, house rules, words), each person's conversations with it, the changes it offers and the month's AI it may use (Tenancy 2b-3). The site's own assistant stays the site's. |
| `assistant-widget` | Per company | The assistant's button and chat on a company's pages, and its settings screen. |
| `ai` | Per company | Each company's AI use is counted and capped by the month, with a ceiling on the whole site's day. |
| `billing` | Per company | Each company's plan and limits — its free trial, seats, storage, online estimates and assistant messages — checked at every checkpoint (billing 0.3). |
| `analytics` | Per company | Each company's website visits: its pages here and its own websites (each with its own address list and a public key), where visitors came from, the pages they read and the AI crawlers that read them, read at /app/website (Tenancy 2b-4a). The site's own numbers stay the site's. |
| `audience` | Per company | Who is left out of each company's visit counts — its own team, and the people, addresses and networks it names — and the cleaning of its past numbers (Tenancy 2b-4a). |
| `seo` | Per company | Each company's public pages get their own title, address and business details for search engines and AI assistants, and a place in the sitemap; its token pages stay out of search (Tenancy 2b-4a, with --seo). The site's own search settings stay the site's. |
| `seo-reports` | Per company | Each company's search check: how search engines and AI assistants read its own pages and websites, as a list of things to fix, with every check kept — reading only its own addresses, never a private one (Tenancy 2b-4b). The site's own checks stay the site's. |
| `aeo` | Per company | Each company's AI mentions: the questions its customers ask, who it is, and whether AI assistants name it — every answer paid from its own month of AI (Tenancy 2b-4b). The site's own stay the site's. |
| `booking` | Per company | Each company's calls: the people on its team who take them, their weekly hours, time off and time zones, its holidays and call types, its booking page and the private links it sends — new bookings close when it's suspended or its plan ends, links it sent stay open (Tenancy 2b-4c). |
| `booking-widget` | Per company | The booking page and manage page at a company's web address, and its calls screen at /app/calls. |
| `stripe` | Per company | Each company's own Stripe account (it connects it at /app/payments) and its customers' card payments on invoices and deposits, recorded only for the company that owns the account (getting paid, part 1). The site's own plan billing stays on the site's own account. |
| `commerce` | Per company | Each company's own store: its checkouts, orders and the store payments that need its owner, paid into its own Stripe account and recorded only for the company that owns it (getting paid, part 2). The site's own storefront orders stay the site's. |
| `catalog` | Per company | Each company's own products (name, price, photo, stock) for its store; the site's own plans and products are kept apart under "*" and only the site sells them. |
| `customers` | Per company | Each company's own customer list: its customers, their emails, phones, addresses and notes, and everything that is theirs — quotes, visits, invoices, calls, orders and messages — on one timeline. The same email in two companies is two customers, and a company's features only ever find or create customers inside it (create-app 0.35). |
| `db` | Shared | the database connection and migration tools every package uses; it keeps no business's records |
| `env` | Shared | reads the site's own settings when it starts; nothing in it belongs to a business |
| `license` | Shared | checks the site's own licence key with the seller; one per site, not per business |
| `observability` | Shared | the site owner's error log and health checks, across every business |
| `digest` | Shared | each person's own email choices and digests, keyed by the person: they follow them, not any one business |
| `create-app` | Shared | the generator itself; it writes the project and is never installed into it |

## When a company is deleted

Staff delete a company from its page in the operator console (typing its web
address again; one still paying for a plan needs "delete it anyway" and a
reason). Everything it kept goes in one transaction, and one audit row records
who, when, its name and what went. Every per-company package says how its
rows go — `FORGET_COVERAGE` in the same test file checks it:

- **Its own `forgetTenant`**: every package above that keeps a table with a
  company column — `permissions`, `estimator`, `scheduling`, `invoicing`,
  `comms`, `email`, `notifications`, `storage` (and the files' bytes, after the
  transaction), `feedback`, `assistant`, `ai`, `billing`, `analytics`,
  `audience`, `seo-reports`, `aeo`, `booking`, `stripe`, `commerce`, `catalog`
  and `customers`. A generated project's `src/server/forget-company.ts` calls
  each one it installed, and its `forget-company.test.ts` plants a row in every
  table with a company column (read from the database) and fails, naming the
  table, when one is missed — or when another company's rows go too.
- **Tenancy itself**: the team, invitations and address history. The company's
  row stays, emptied, and so do its old web addresses, so they are never given
  to another business.
- **Nothing to forget**: the screens (`*-widget`), `trpc`, `testing`, `auth`
  (a person's account is theirs; a current company pointing at a deleted one is
  cleared) and `seo` (its words live in the company's settings, which are
  emptied).

Kept on purpose: the site's audit log (the deletion is one of its rows) and
its error log.
