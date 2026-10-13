---
"@adminigloo/create-app": minor
---

Companies (Tenancy 1): every generated project can sign a business owner up,
let them name their company and run their team, and lets the platform owner see
and steer every company. Single-business projects (`--tenant-noun none`) keep
working as they did, now race-free.

**What a generated project gets**

- **Sign-up that works on a deployed site.** The first page request and the
  Clerk webhook both set a new person up (`tenancy.provisionUser`); whichever
  arrives first does it, and 0.21 accounts the webhook race left with nothing
  are repaired on their next visit. Only VERIFIED email addresses are mirrored.
  The webhook claims each event in a ledger first (a retry never runs twice),
  and a deleted Clerk account loses its staff roles and memberships
  (`deprovisionUser`).
- **The company screens**, from `@adminigloo/tenancy-widget`: onboarding
  ("What's your company called?"), the header switcher, the dashboard with its
  setup checklist, the team page (`/settings/team`, both modes), company
  settings, the invitation accept page with a preview of what the link is for,
  and the suspended screen. The pages are thin wrappers; `<CompanyGate>` is the
  one place a company page decides sign-in, onboarding, suspended and
  permission.
- **The operator console** (any admin shell): `/admin/companies` (search,
  detail with activity in plain words, suspend and reactivate, a new owner for
  a company whose owner closed their account, release old web addresses) and
  `/admin/people`, where an administrator gives staff roles — including making
  another administrator.
- **First run that heals itself.** The permission catalog is seeded on every
  deploy, right after the migrations (`pnpm db:seed:deploy`, a new step in
  deploy.yml). `BOOTSTRAP_ADMIN_EMAIL` becomes the administrator whenever none
  exists — /admin retries it — and `pnpm admin:grant <email>` (or the new
  "Admin grant" workflow for production) is the way back in.
- **Proofs in every project's own `pnpm test`**, on an in-process Postgres
  (PGlite, a new devDependency): a two-company isolation test over every tenant
  procedure and every company route, a procedure-scope audit, provisioning in
  both orders, and the per-person permission rules.
- `README.md` for the generated project: quick start, first run and recovery,
  what the mode does and the "Not included" list.

**Fixes a buyer would have hit**

- Generated workflows fail no more at the pnpm step: package.json names
  `packageManager`. `ci.yml` installs the private packages with
  `PACKAGES_READ_TOKEN`, like deploy.yml.
- `NEXT_PUBLIC_APP_URL` falls back to the production domain on production,
  never a per-deployment `*.vercel.app` address.
- Clerk's sign-in and sign-up links stay on the site and land on
  `AFTER_AUTH_PATH`.
- Per-person permission changes follow the rank rules (`admin.setOverride`):
  not on yourself, only below you, only access you hold; `staff.roles.manage`
  is sealed. `staff.tenants.suspend` and `staff.tenants.transfer` are new staff
  keys.
- The header draws Admin only for staff and folds into a "Menu" on a phone;
  /setup is hidden on production except for staff.
- The CLI's next steps no longer tell you to copy `.env.example` over the
  ready-made `.env.local`, split "a deployment refuses to start without" from
  "switches a feature on", always include `pnpm db:seed`, and `add` prints it
  too. SCAFFOLD.md lists every answer.

**Review round 2**

- The emitted isolation test has a "by-id" kind for procedures that take a
  company's row id, and a "tenant-only" procedure must take nothing else a
  company owns (its input is checked, mutations included): a procedure keyed
  by a member's id can no longer pass it while leaking.
- The Clerk webhook records a deletion for someone it has no row for yet, so a
  create Clerk retries afterwards can't bring the account back (or make it the
  first administrator). `admin:grant` takes `--id` when two accounts share an
  address. A failed seed or grant says what happened instead of
  "[object Object]".
- `admin.setOverride` decides a company member's access under the company lock
  and only for someone still on the team.
- DEPLOYMENT.md lists what Vercel needs in both scopes or the build refuses to
  start (generated per project), how to get read access to the private
  packages (a classic token), and the Deployment Protection exception by name.
  README.md's quick start runs in the order it's written; single-business
  projects aren't told about company pages; a companies project with scheduling
  or the estimator says up front that those run for the platform owner until
  Tenancy 2. `add` splits its variables the way a fresh project does.
- Plainer screens: the invitation page, the admin home (its companies tile
  opens /admin/companies), a note on a member's dashboard, the site's name as a
  name ("Igloo Back Office", not "igloo-back-office"), and the first-run
  sentence as it really happens on a laptop.

**Review round 3**

- The isolation test reads every input a "tenant-only" procedure declares —
  optional, nested and in arrays, through `inputFieldsOf` — and refuses any
  other id-like one; a query is also asked with each of A's ids in every text
  input it may be given. A procedure that reads any company's member by an
  OPTIONAL id no longer passes.
- A new emitted test accepts an invitation by its link through the project's
  own route and Clerk wiring: a second verified address is accepted, an
  unverified or unknown one refused. Dropping the verified addresses from
  `src/server/tenancy-handlers.ts` now fails `pnpm test`.
- `admin:grant` against a database it can't reach says "Could not reach the
  database at <host>/<database>…", as `db:seed:deploy` does, instead of
  drizzle's failed query and a stack; a test runs the script to prove it.

**Review round 4**

- A project that can't send mail (no email package, or no `RESEND_API_KEY`)
  doesn't hand the team page's handlers a mailer
  (`invitationEmailsConfigured`), so no invitation is ever held for an email
  that was never going to go. A new emitted test proves through the project's
  own handlers that a skipped, failed or thrown delivery is never followed by
  "We emailed …".
- A "tenant-only" procedure in the isolation test takes nothing beyond the
  company's id and its globals — an optional `email` or `who` is refused like
  an optional `userId`, mutations included — unless its case's `allow` says why
  (the template's own: a number of days, a page size, a simulated state).
  Queries are also asked with company A's addresses, names and web address,
  not only its ids.
- A failed seed or grant says "Could not reach the database" only when a
  network error's code says so; a database that answered and refused a query
  says that, without the query or the address it asked about.

**Removed:** the invitations tRPC router (`src/server/routers/invitations.ts`,
`src/server/invitations.ts`) and the template's invitation components — the
package handlers serve invitations now — and `src/server/bootstrap.ts`
(`@adminigloo/permissions/server`'s `ensureBootstrapAdmin`).
**Moved:** People into admin-minimal; `/admin/tenants` and `/members` redirect
to `/admin/companies` and `/settings/team`.

Not included (Tenancy 2 and later): feature screens on the active company,
public company pages beyond the reserved contact card, plans and billing,
viewing as a customer, custom roles, custom domains, company deletion.
