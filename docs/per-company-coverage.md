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
| `assistant` | Not yet: 2b-3 assistant | The AI assistant is the site's own until then. |
| `assistant-widget` | Not yet: 2b-3 assistant | The assistant's chat and its settings screen, with the assistant. |
| `ai` | Not yet: 2b-3 assistant | AI usage is counted for the whole site until then. |
| `analytics` | Not yet: 2b-4 website | Visit counts are for the whole site until then. |
| `audience` | Not yet: 2b-4 website | Who counts as staff in the visit counts, with analytics. |
| `seo` | Not yet: 2b-4 website | Search-engine settings are the site's own until then. |
| `seo-reports` | Not yet: 2b-4 website | The site checks how search engines read it; the site's own until then. |
| `aeo` | Not yet: 2b-4 website | How AI answer engines read the site; the site's own until then. |
| `booking` | Not yet: 2b-4 website | Book-a-call is the site owner's own until then. |
| `booking-widget` | Not yet: 2b-4 website | The book-a-call page, with booking. |
| `billing` | Not yet: billing | Plans and limits per company come with the billing work. |
| `catalog` | Not yet: billing | What the site sells, and its plans, with billing. |
| `stripe` | Not yet: billing | The site's own Stripe account, with billing. |
| `commerce` | Not yet: getting-paid | A company taking card payments from its own customers comes with the getting-paid work. |
| `db` | Shared | the database connection and migration tools every package uses; it keeps no business's records |
| `env` | Shared | reads the site's own settings when it starts; nothing in it belongs to a business |
| `license` | Shared | checks the site's own licence key with the seller; one per site, not per business |
| `observability` | Shared | the site owner's error log and health checks, across every business |
| `create-app` | Shared | the generator itself; it writes the project and is never installed into it |
