# Tenancy 2a (company features): the contract

Tenancy 1 gave a business owner a company: onboarding, a team, roles, settings,
a switcher and an operator console. The field-service features were still the
PLATFORM's: pinned to one fixed tenant (`"primary"`), gated by staff keys under
`/admin`, with one public `/estimate` and one `/book-visit` and one email
identity. Tenancy 2a moves scheduling, the estimator, invoicing and messages
(comms) into each company: its own private screens, its own public pages at
`/t/<web-address>/…`, its own emails, its own crons, its own roles, proved
isolated route by route.

Six builders work from this document, mostly in parallel. None of them can see
another's code until the end:

| Builder | Owns | Sections |
| --- | --- | --- |
| **Tenancy builder** | `packages/tenancy` 0.5.0, `packages/tenancy-widget` 0.2.0 | 2, 3, 4, 5, 13.1 |
| **Scheduling builder** | `packages/scheduling` 0.5.0, `packages/scheduling-widget` 0.2.0 | 2, 3, 6, 13.2 |
| **Estimator builder** | `packages/estimator` 0.4.0, `packages/estimator-widget` 0.3.0 | 2, 3, 7, 13.3 |
| **Messages builder** | `packages/email` 0.3.0, `packages/comms` 0.3.0, `packages/comms-widget` 0.1.0 (new) | 2, 3, 8, 9, 13.4 |
| **Invoicing builder** | `packages/invoicing` 0.3.0, `packages/invoicing-widget` 0.1.0 (new) | 2, 3, 10, 13.5 |
| **create-app builder** | `packages/create-app` 0.23.0, the template and overlays, `scripts/verify-generated.mjs`, the e2e fixture and spec | 2, 3, 11, 12, 13.6, 14 |

The create-app builder starts once the other five have built their packages
into `dist/` (section 16). Every builder reads sections 0–3 and 15–17.

Section 3 (the shared shapes) and the **wire regions** (sections 6.9, 7.9, 9.6,
10.8) belong to two builders at once: the package that serves a route and the
widget (or the create-app wiring) that calls it. If you change a name or a shape
there, the other half breaks and neither of you will notice, so don't. Section
2 (decisions) binds everyone. Where something here is ambiguous, pick the
reading that best serves the acceptance bar in section 0, leave a `// CONTRACT:`
comment where you made the call, and list it in your hand-off.

---

## 0. The acceptance bar

The founder's bar, in his words: *"Business owners aren't devs. If a business
owner is told by their dev that it works, they deploy it and sell it to a
customer; they need to trust that it's actually doing what is needed."*

The goal: the founder generates **"Igloo Back Office"**, a multi-tenant SaaS for
small service businesses (lawn care, ramps, cleaning):

```
pnpm dlx @adminigloo/create-app igloo-back-office --tenant-noun Company --admin full \
  --estimator --scheduling --invoicing --comms --email --storage --ai
```

and installs every package the way a client would. Tenancy 2a is done when this
scenario runs end to end with no developer filling gaps. Section 13 holds it as
package tests, section 12 as the emitted proofs, and section 14 as a browser
test.

1. **Each company sets itself up, inside its own area.** Two lawn-care
   companies, Green Acres and Summit Lawn, sign up. Each owner, in THEIR
   company area (`/app/…`, never `/admin`), sets up:
   - the estimator price book (or loads the sample, on purpose) and estimate
     settings (tax, quote rules);
   - scheduling services, crews and hours;
   - invoice details (how customers pay them).

   Business name, time zone, contact, logo and brand colour come from the
   company profile, set once in `/settings/company`. They are never re-typed
   per feature: the feature settings screens show them read-only, with a link.
2. **Each company has public pages.** At `/t/<web-address>/estimate` and
   `/t/<web-address>/book-visit`, plus the quote, manage-visit and invoice token
   pages, and an embed snippet for the company's own website. They carry the
   company's name, logo and colour, and show times in its time zone. A
   suspended company's public pages say plainly it isn't taking requests.
3. **One company's customer stays in that company.** A customer of Green Acres
   gets an estimate, books a visit, receives a quote and an invoice. Every email
   shows Green Acres' name and reply-to address, links to Green Acres' pages,
   and lands only in Green Acres' queues. Summit sees none of it, in any screen,
   route, export or email.
4. **Company roles.** Owner and admin manage everything. A member works
   estimates, the schedule and invoices. A crew member sees only today's route.
   A viewer reads. The package permission fragments (`schedule.*`,
   `estimator.*`, `invoices.*`, `comms.*`) are in the company permission catalog
   with these defaults.
5. **Crons serve every company.** The scheduling, estimator and comms crons
   process EVERY active company, skip suspended ones, and one company's failure
   doesn't stop the others.
6. **The setup checklist grows.** Each feature adds its items: prices, estimate
   settings, services, crew hours, invoice details, website embed.
7. **The platform owner keeps `/admin`** as the operator console: companies,
   suspend and reactivate, people and staff roles. Looking into a company is
   Tenancy 1's company detail (members, activity). No impersonation.
8. **`--tenant-noun none` keeps working**: a single business with the same
   features, at today's paths, on the fixed business id.
9. **Proven.** The emitted isolation proof covers the feature ROUTE HANDLERS
   (the fetch handlers, not just tRPC): company B gets not-found, or nothing of
   A's, for every company-A id through every private and public route. A browser
   scenario with two companies walks steps 1–5.

### The founder's rules (non-negotiable)

- Forms ask for what people know, in plain words. Never "tenant", "slug", an id
  or a template key. Say "web address", "company" (whichever noun the project
  uses), "crew", "messages".
- Any AI only observes; code does the maths; spend as little as possible. (2a
  adds a per-company ceiling on the estimator's photo-reading budget: D14.)
- Never raise legal, privacy or consent topics, in code, comments, copy or docs.

### Hard rules (all builders)

- No commits, pushes or publishes, and no `changeset version` or release. Write
  changeset FILES (section 15.3). Don't edit any `version` field, except the two
  new widget packages, which are already at `0.0.0` and stay there.
- No dev server on port 3000. No real databases: PGlite only.
- Match the repo's style: thorough why-comments, decision-record comments where
  a choice was made, zod at every boundary, `tenantId` on every query, instants
  as `timestamptz`, errors with an own `readonly name`.
- create-app generator rules (`packages/create-app/README.md`):
  - **No runtime conditionals in emitted code.** No emitted `if` asks whether a
    feature or a mode is installed. Two variants of one file, chosen by the
    generator, are fine. A runtime filter on a generated list (a nav link's
    permission) is fine and says so in a comment.
  - Overlays are strictly additive.
  - `--tenant-noun none` keeps a single-business mode that works.
- UI a buyer needs ships as package components with a transport, so fixes flow
  by npm. Emitted pages are thin wrappers.
- Work only in `C:\Users\dalli\scaffold-t2a` (branch `feat/tenancy-2a`). Don't
  touch `C:\Users\dalli\scaffold`, any other `scaffold-*` worktree, or any
  `adminIgloo` folder.

### The workspace is ready (done by the architect)

- **Two new packages**, at `0.0.0`, each with `package.json` (React the only
  peer, plus its server package as an OPTIONAL peer `^0.3.0`), `tsconfig.json`,
  `tsup.config.ts` (entries `index` and `admin`, the `"use client"` banner),
  `src/index.ts`, `src/admin/index.ts`, `src/version.ts` and a smoke test:
  - `packages/invoicing-widget` (`INVOICING_WIRE_VERSION = "v1"`), with
    devDependency `@adminigloo/invoicing` (workspace; used ONLY by the wire
    parity test and the copied-helper agreement test);
  - `packages/comms-widget` (`COMMS_WIRE_VERSION = "v1"`), with devDependency
    `@adminigloo/comms` (workspace; same restriction).
  - Untracked leftovers of an earlier attempt (`dist/` and `node_modules/` in
    both folders) were deleted first; nothing tracked was touched.
- **`@adminigloo/invoicing`:** new entry `./comms` (skeleton `src/comms.ts`,
  builds), tsup entry added, optional peer `@adminigloo/comms ^0.3.0`,
  devDependencies `@adminigloo/comms` (workspace) and
  `@electric-sql/pglite ^0.5.8`, and a `vitest.config.ts` with PGlite timeouts.
- **`@adminigloo/comms`:** devDependency `@electric-sql/pglite ^0.5.8` and a
  `vitest.config.ts` with PGlite timeouts.
- `pnpm install --offline` has run and the lockfile is updated. **Don't install
  anything.** If something is truly missing, stop and say so in your hand-off.
- `e2e/` (outside the workspace) has its own `node_modules` installed offline;
  Playwright 1.63 is there and Chromium 1243 is cached.
- `comms`, `invoicing`, `invoicing-widget` and `comms-widget` build, typecheck
  and test green. Every other package's `dist/` is present from the worktree's
  setup.
- **Baselines** (this worktree, before any 2a code):

  | Package | Tests |
  | --- | --- |
  | tenancy | 306/306 |
  | tenancy-widget | 230/231 — `release.test.ts` fails: it reads the Tenancy 1 changesets, which `changeset version` consumed. The tenancy builder rewrites it for 2a (5.6). |
  | scheduling | 310/310 |
  | scheduling-widget | 212/212 |
  | estimator | 317/317 |
  | estimator-widget | 239/239 |
  | invoicing | 70/70 |
  | comms | 101/101 |
  | email | 173/173 |
  | permissions | 74/74 |
  | trpc | 92/92 |
  | testing | 153/153 |
  | create-app | 1661/1661 |
  | invoicing-widget, comms-widget | 1/1 each (smoke) |

- If you change a package that another imports from `dist`, rebuild it:
  `pnpm --filter @adminigloo/<name> build`. Build order:
  `email → comms → invoicing → scheduling → estimator → tenancy → the widgets →
  create-app`. (On Windows a tsup DTS build sometimes fails right after an
  install; run that package's build again.)

### Prior art (lift the best)

- **This repo.**
  - `packages/tenancy/src/server/handlers.ts`: a company route names its
    company in the path; `TENANCY_ROUTES` as data the tests read back.
  - `packages/scheduling/src/admin-handlers.ts`: the `resolveTenant` /
    `authorize` seams, `SCHEDULING_ADMIN_ROUTE_PERMISSIONS`, the second
    `may()` ask.
  - `packages/estimator/src/handlers.ts`: one factory for the business's own
    page and the keyed embed; `admin-handlers.ts`: the second
    `estimator.costs.view` ask that only strips.
  - `packages/create-app/src/tenancy-proofs-emit.ts`: the emitted isolation
    proof, `ISOLATION_BODIES`, "nothing of A", the snapshot before and after.
  - `packages/scheduling/src/settings.ts`: the zone change that keeps wall
    clocks and re-queues reminders; `lockSettingsShared`.
  - `create-app/overlays/invoicing-admin/app/admin/invoices/page.tsx` and
    `overlays/comms-admin/app/admin/comms/page.tsx`: the ledger and the
    Messages console, as copied source. Their behaviour moves into the two new
    widgets.
- **Riddler Go** (`C:\Users\dalli\riddler-go`): `lib/organizations/*`, the
  public `/[org]` pages and their "this business isn't taking bookings" state.
- **Ask Lou** (`C:\Users\dalli\askLou\SquireSolutions`): per-company email
  identity (a company name on the platform's sending address, the company's
  reply-to).

### What this chunk answers

| Finding / promise | Where |
| --- | --- |
| CA-20, TB-08, SR-16 (one staff key gates every feature) | D9, D12, 11.4: tenant keys in companies mode; one staff key per job in single mode |
| T1 14.2 "Feature routes are still pinned" | D1–D4, sections 6–11 |
| T1 14.2 "Public company pages" | D1, D7, 11.3 `/t/[slug]/…` |
| SR-22 for features (T1: "Feature packages' two-tenant tests are Tenancy 2") | D16, section 12, 13.x two-company tests |
| The fixed-tenant leak class (`"primary"` in emitted code) | D12: a generator test greps a companies project for every fixed-tenant constant |
| Single sender identity | D8, sections 8–9 |

---

## 1. What changes, in one page

| Package | Before | After |
| --- | --- | --- |
| `@adminigloo/tenancy` 0.5.0 | Four fixed roles; public lookup hides suspended companies; no feature seams | `defineTenantRoles` (packages add roles: crew); `resolvePublicCompany` (with status); `companyProfile`; `activeCompanyIds` + `runForEachCompany`; `createCompanyRouteSeams` and `createPublicCompanySeams`; `listMemberPeople`; settings/profile/branding events; `RoleKey` widened |
| `@adminigloo/tenancy-widget` 0.2.0 | Role keys fixed at four | Any role key the server offers; `<CompanyBrandBar>` and `<CompanyUnavailable>` for public pages |
| `@adminigloo/scheduling` 0.5.0 | Business basics in its own settings; one email identity's links | `company` seam (basics overlaid; zone converged by the re-zone); `admit` (suspension); async per-company links and staff inbox; `SCHEDULING_CREW_ROLE`; route tables; checklist items |
| `@adminigloo/scheduling-widget` 0.2.0 | Platform-styled picker | `accentColor`; closed-state message; company-owned fields read-only in settings; "invite them on the Team page" |
| `@adminigloo/estimator` 0.4.0 | Basics in its own settings | `company` seam; `admit` on both the slug and the embed-key paths; AI budget ceiling; async links and inbox; route tables; checklist items |
| `@adminigloo/estimator-widget` 0.3.0 | Function-only hrefs | `{id}` pattern hrefs (server pages can pass them); company-owned fields read-only; closed message |
| `@adminigloo/email` 0.3.0 | One From, one Reply-To per process | Per-message `fromName` and `replyTo` |
| `@adminigloo/comms` 0.3.0 | Senders know nothing of the tenant; staff tRPC console | `identity(tenantId)` seam; `OutboundEmail.tenantId/fromName/replyTo`; log columns `from_name`, `reply_to`; `runDueMessages({ tenantIds })`; `createCommsAdminHandlers`; `commsPermissions`; route tables |
| `@adminigloo/comms-widget` 0.1.0 (new) | none | `./admin`: `<MessagesConsole>` |
| `@adminigloo/invoicing` 0.3.0 | Functions only; UI in a tRPC router + copied pages; token read not scoped | `createInvoicingAdminHandlers` + `createInvoicingHandlers`; wire; `invoicingPermissions`; `invoicingSettingsFragment`; token reads scoped to a company; `./comms` (the invoice email); route tables; checklist item |
| `@adminigloo/invoicing-widget` 0.1.0 (new) | none | `.`: `<InvoiceView>`; `./admin`: `<InvoicesLedger>` |
| `@adminigloo/create-app` 0.23.0 | Features on `"primary"` under `/admin` in both modes | Companies mode: `/app/…`, `/api/app/{id}/…`, `/t/{slug}/…`, `/api/t/{slug}/…`, per-company setup, identity, crons, roles, checklist, proofs. Single mode: today's paths and business; invoicing and comms move onto the package handlers and widgets |

Not changed: `permissions`, `trpc`, `auth`, `testing`, `observability`, `db`.
(If a builder finds it truly needs one, stop and say so.)

---

## 2. Decisions (binding on every builder)

Each is a decision record. Copy the reasoning into the code comment at the
place it is enforced.

**D1. The company area is `/app/…`; public pages are `/t/{web-address}/…`.**

| What | Path | Decides the company by |
| --- | --- | --- |
| Private pages | `/app/schedule`, `/app/schedule/today`, `/app/schedule/settings`, `/app/estimates`, `/app/estimates/[id]`, `/app/estimates/settings`, `/app/price-book`, `/app/invoices`, `/app/invoices/[id]`, `/app/messages`; `/app` redirects to `/dashboard` | the session's ACTIVE company (Tenancy 1, D3) |
| Private APIs | `/api/app/{tenantId}/schedule/…`, `…/estimator/…`, `…/invoices/…`, `…/messages/…` | the id in the PATH, authorised per request |
| Public pages | `/t/{slug}`, `/t/{slug}/estimate`, `/t/{slug}/quote/[token]`, `/t/{slug}/book-visit`, `/t/{slug}/visit/[token]`, `/t/{slug}/invoice/[token]` | the web address in the path |
| Public APIs | `/api/t/{slug}/schedule/…`, `…/estimator/…`, `…/invoices/…` | the web address in the path |
| Estimator embed | `/api/estimator/…` (and the 0.2 alias `/api/estimator/embed/…`) | the embed KEY only; no key → "needs a key" |
| Email-link switch | `/app/switch/{slug}?next=/app/…` | membership, then the active pointer is moved |

Tenancy 1's `/dashboard`, `/settings/company`, `/settings/team`,
`/onboarding` and `/invite/[token]` stay where they are.

Why `/app` and not the alternatives:
- **`/c/{slug}/schedule` (the company in every private URL).** Tenancy 1 chose
  the pointer for pages (D3) and shipped `/dashboard` and `/settings/*` on it;
  two models in one product means two gates and two kinds of bugs. A slug in a
  private URL also changes when the owner renames the company.
- **No prefix (`/schedule`, `/estimates`).** These collide with the
  single-business mode's public `/estimate` and `/book-visit`, and with the
  marketing site. One prefix is one robots rule, one place for a company nav,
  and one thing to grep.
- **Inside `/admin`.** `/admin` is the platform owner's operator console
  (bar item 7). A company owner is not staff, and mixing the two is exactly
  CA-20.
- `app` and `t` are already in `RESERVED_SLUGS`, so no company can take them as
  a web address.

**D2. A private API names its company in the path; a page renders the active
company; a link in an email switches first.**
- This is Tenancy 1's D3, extended to the features. The page hands
  `company.id` to the widget's `baseUrl` (`/api/app/${company.id}/schedule`),
  so a tab still showing Green Acres acts on Green Acres even after the person
  switched to Summit in another tab.
- An email to the office can't know which company its reader has active.
  Every private link in an email is
  `{appUrl}/app/switch/{slug}?next={path}`. That route checks membership
  (`setActiveCompany`, which answers `not_found` for a stranger), moves the
  pointer, and redirects to `next`. `next` must start with `/app/` or be
  `/dashboard`; anything else goes to `/dashboard`. A stranger, or a signed-out
  reader after signing in, lands on `next` with whatever company is theirs,
  never on someone else's data. A GET that moves the pointer is safe to be
  triggered from another site: it can only ever select a company the person
  already belongs to.

**D3. Every field-service feature is a pair of PACKAGE HTTP handlers (private
and public) plus a PACKAGE widget, in BOTH modes.**
- Scheduling and the estimator already are. Invoicing and comms are not: their
  UI is a tRPC router plus pages copied into the project. 2a moves them onto
  handlers (`createInvoicingAdminHandlers`, `createInvoicingHandlers`,
  `createCommsAdminHandlers`) and two new widgets (`invoicing-widget`,
  `comms-widget`).
- The tRPC routers `invoicing` and `comms` are RETIRED in both modes
  (`ROUTER_SCOPES` loses their rows), and the copied pages `admin/invoices`,
  `invoice/[token]` and `admin/comms` are replaced by thin pages over the new
  widgets (single mode) or by the company area's pages (companies mode).
- Why both modes: two implementations of one ledger drift, and a fix must
  reach every project by `npm update` (README rule 3). It also makes the
  isolation proof uniform: every feature route is a fetch handler with a route
  table (D16).

**D4. Features never import tenancy. They take structural SEAMS.**
- `scheduling`, `estimator`, `invoicing` and `comms` must stay installable in a
  foreign host (T1 14.3: "pass your own tenant id … and your own permission
  check"). So each declares, in its own types, the few seams 2a needs:

  | Seam | Shape | Who supplies it in companies mode |
  | --- | --- | --- |
  | `resolveTenant(req)` | existing | `createCompanyRouteSeams` (private) / `createPublicCompanySeams` (public) |
  | `authorize(req, permission, tenantId)` | existing | `createCompanyRouteSeams` |
  | `company(tenantId)` | `<Pkg>Company \| null` (3.2) | `tenancy.companyProfile` |
  | `admit(tenantId, req)` | `<Pkg>Admission` (3.3) | `createPublicCompanySeams` |
  | link builders | `(…, tenantId) => string \| Promise<string>` | generated `src/server/company-links.ts` |
  | `staffEmails` | `readonly string[] \| ((tenantId) => …)` | `companyProfile(…).inbox` |
  | `identity(tenantId)` (comms) | `SenderIdentity \| null` | `companyProfile` |

- Without a seam, each package behaves exactly as today. Single-business mode
  passes none of the new ones.
- Type names are package-prefixed (`SchedulingCompany`, `EstimatorCompany`,
  …) so a generated file importing two packages never has two `CompanyFacts`.

**D5. The company's basics are the company profile's. Features read them; only
scheduling writes, and only its time zone.**
- Name, contact email and phone, logo and brand colour are OVERLAID on read:
  every settings read in a feature with a `company` seam takes them from the
  profile, whatever the feature's own row says. Nothing is copied, so nothing
  drifts.
- The **time zone** is different for scheduling, because scheduling stores
  each visit twice: as a wall clock (what the customer was shown) and as
  instants computed in the zone (what notice, cutoffs, reminders and expiry
  run on). Overlaying a new zone onto old instants would move every reminder by
  the offset. So scheduling CONVERGES: when the profile's zone differs from the
  zone its row holds, it runs its own zone change (`updateSchedulingSettings`
  with `{ timeZone }`), which keeps every visit at its clock time, re-derives
  the instants under the settings lock and re-queues reminders. Customers are
  not emailed about it (`notify: false`).
- It converges at three moments, so a crash between them costs nothing:
  1. right after the owner saves company settings (tenancy's
     `company.settings.updated` event, D11's listener);
  2. on every scheduling request that reads settings (`resolveSchedulingSettings`);
  3. in the scheduling cron, per company.
  The check is an in-memory compare; the write happens only on a mismatch, and
  is idempotent under the settings lock.
- A profile with no time zone yet (`null`) leaves the feature's own zone as it
  is. The checklist's "Add your business details" item asks for it.
- The estimator and invoicing only DISPLAY dates in the zone, so they overlay.

**D6. Feature settings screens show company-owned fields read-only, and saves
drop them.**
- `settings-get` reports `managedByCompany: { href }`. The widget renders the
  business name, time zone and contact (and, for the estimator, the colour)
  as read-only text with "These come from your company settings" and a link to
  `href` (`/settings/company#details`).
- `settings-update` removes `businessName`, `timeZone`, `contactEmail`,
  `contactPhone` (and `brandColor` for the estimator) from the patch before
  saving. A body that sends only those changes nothing and answers 200 with the
  settings as they are. It never 422s: the widget never sends them, and a
  refusal would only break an old client.

**D7. Suspension on the public side: the pages say it; the APIs refuse it.**
- Tenancy 1's `resolveCompanyBySlug` hides suspended companies (null), which
  would make their pages 404. 2a adds `resolvePublicCompany`, which returns the
  company WITH its status. The emitted `PublicCompanyGate` renders
  `<CompanyUnavailable>` for a suspended one: "{Name} isn't taking requests
  online right now." plus how to reach them. No widget mounts, so no request is
  made.
- The APIs are the second line, for an embed on the company's own website, a
  page loaded before the suspension, or a direct call. Each public handler
  takes `admit(tenantId, req)`, asked after the tenant is known (from the web
  address OR from an embed key) and before any other work. A closed company
  answers the package's existing closed code (`booking_closed`,
  `estimates_closed`, invoicing `unavailable`) with the admission's message.
  The widgets render that message as their closed state.
- Every public route, token routes included, is refused while closed. A
  customer with a booked visit at a suspended company calls them, as the
  message says.
- Private APIs are refused by membership (Tenancy 1's gate answers
  `company-suspended`); the members see Tenancy 1's suspended screen.

**D8. A company's emails go out as the company.**
- **From:** `"{Company name}" <EMAIL_FROM's address>`. The platform's verified
  sending domain is the only address Resend will send from, so the company's
  NAME goes on it, never another address.
- **Reply-To:** the company's contact email, else its owner's sign-in address.
  Never the platform's `EMAIL_REPLY_TO` while the company has either: a
  customer's "I need to reschedule" must reach the business, not the platform
  owner. (Only a company with no contact email AND no live owner falls back to
  the sender's default, and its log rows show `reply_to` empty.)
- **Staff notices** (new lead, new request, customer changed a visit) go to the
  feature's saved addresses (`staffNotifyEmails`, `leadNotifyEmails`), else to
  the company's INBOX (its contact email, else its owner's address). NEVER to
  `BOOTSTRAP_ADMIN_EMAIL`, which is the single-business fallback and would send
  Green Acres' leads to the platform owner.
- **SMS** (when a project wires it): the company name is the sender name every
  text starts with.
- **Links** in every email go to the company's pages (`/t/{slug}/…`) or the
  switch route (D2).
- comms resolves the identity per message (`identity(tenantId)`), passes it to
  the sender, and RECORDS it in the delivery log (`from_name`, `reply_to`), so
  the owner can see in Messages what their customers saw, and the proofs can
  assert it on rows.

**D9. Company roles: packages can add roles; scheduling adds Crew.**
- Tenancy 1's four roles are fixed in a type. 2a adds `defineTenantRoles(extra)`
  so a package can contribute a role spec, and the project composes the set.
  Scheduling exports `SCHEDULING_CREW_ROLE` (`crew`, "Crew member", rank 5).
  A generic tenancy never names a field-service role itself.
- Extra ranks must sit strictly between 0 and admin (30) and must not tie a
  core rank, so the owner and admins manage them, and the rank guard (D5 of
  T1) keeps its meaning.
- The wire's `RoleKey` widens to
  `"owner" | "admin" | "member" | "viewer" | (string & {})`. The widget already
  takes role names, descriptions and ranks from the server (`TeamWire.roles`);
  it now accepts any well-formed key.
- Crew's ONLY grant is `schedule.route`. It does not get `tenant.view`. So the
  company dashboard's gate becomes membership-only (its contents are already
  filtered by permission), and a crew member lands there to one card: Today's
  route.
- Default grants in companies mode:

  | Key | owner | admin | member | crew | viewer |
  | --- | --- | --- | --- | --- | --- |
  | `schedule.route` | ✓ | ✓ | ✓ | ✓ | |
  | `schedule.view` | ✓ | ✓ | ✓ | | ✓ |
  | `schedule.manage` | ✓ | ✓ | ✓ | | |
  | `schedule.resources.manage` | ✓ | ✓ | | | |
  | `estimator.view` | ✓ | ✓ | ✓ | | ✓ |
  | `estimator.estimates.manage` | ✓ | ✓ | ✓ | | |
  | `estimator.costs.view`, `estimator.pricebook.manage`, `estimator.settings.manage` | ✓ | ✓ | | | |
  | `invoices.view` | ✓ | ✓ | ✓ | | ✓ |
  | `invoices.manage`, `invoices.payments.record` | ✓ | ✓ | ✓ | | |
  | `invoices.payments.reverse` | ✓ | ✓ | | | |
  | `comms.view` | ✓ | ✓ | ✓ | | ✓ |
  | `comms.manage` | ✓ | ✓ | | | |
  | Tenancy's keys | as Tenancy 1 | | | none | |

**D10. Crons iterate active companies, each in its own try/catch.**
- `runForEachCompany(tenancy, work, options)` (tenancy server) lists
  `activeCompanyIds()` (org, not suspended, not deleted), runs `work` for each
  with a small concurrency and a time budget, catches each failure separately,
  and reports `{ companies, ran, failed, deferred }`. Suspended companies are
  not in the list, so they are skipped by construction.
- The start rotates by hour (`floor(now / 1h) mod n`), so a budget that runs
  out never starves the same companies every day.
- The comms drain is ONE call with `tenantIds: activeCompanyIds()`: it claims
  only those companies' rows, and its per-row isolation already keeps one bad
  row from stopping the rest. A suspended company's queued reminders wait; after
  `maxLatenessMs` (48 h) they expire instead of going out late.

**D11. Per-company setup is idempotent: on `company.created`, and lazily before
a company's first feature request.**
- What a company gets, once: scheduling's first settings (its zone, an address
  required, one service, ONLINE BOOKING OFF; no crew), the estimator's unsaved
  settings row (zone only; the price book empty), and every feature's email
  templates for that company (insert-if-absent, never over an owner's edit).
- It runs from tenancy's `onEvent` (`company.created`), and again, memoised per
  process, before the first feature request for that company. The second is
  what makes it survive a crash after the company committed.
- It runs ONLY for a real company: after `authorize` passed (private), after
  the web address resolved (public), after an embed key verified (embed). An
  anonymous request with a made-up id never writes a row.

**D12. Single-business mode keeps the fixed business and the staff ladder.**
- `--tenant-noun none` keeps `"primary"`, the staff keys, `/admin/schedule`,
  `/admin/estimates`, `/admin/estimator`, `/admin/invoices`, `/admin/comms` and
  the public `/estimate`, `/quote/[token]`, `/book-visit`, `/visit/[token]`,
  `/invoice/[token]`. The same package handlers and widgets mount there.
- Invoicing and comms gain one staff key per job, on scheduling's pattern
  (`staff.invoices.view`, `staff.invoices.manage`, `staff.comms.view`,
  `staff.comms.manage`), replacing `staff.dashboard.view` (CA-20's last two).
- **A companies project contains no fixed tenant.** No emitted file of a
  companies project may contain `"primary"`, `SCHEDULING_TENANT`,
  `ESTIMATOR_TENANT`, `INVOICING_TENANT` or `COMMS_TENANT`. A generator test
  greps for them. This is the single cheapest guard against the leak class 2a
  exists to close.

**D13. Public token reads are scoped to the company the URL names.**
- `getVisitByToken` and `getQuoteByToken` already take a tenant. Invoicing's
  `getInvoiceByToken(db, token)` does not: under `/t/green-acres/invoice/{a
  Summit token}` it would show Summit's invoice with Green Acres' branding. 2a
  adds a tenant to `getInvoiceByToken` and `markInvoiceViewed` (an optional
  third argument; the handlers always pass it).
- Every public route of every feature resolves its token INSIDE the company,
  and answers `not_found` otherwise.

**D14. The estimator's photo reading has a per-company ceiling.**
- Every company's photo reading spends the PLATFORM's AI key. A company owner
  could otherwise raise their own daily budget to $1,000.
- `aiBudgetCeilingCents` (handlers option): the effective budget is
  `min(the company's setting, the ceiling)`, and a save above the ceiling is
  refused with "This site allows up to {$x.xx} a day of photo reading per
  business." Companies mode passes `ESTIMATOR_AI_CEILING_CENTS = 100` ($1 a day),
  a generated constant with a why-comment. Single mode passes nothing.

**D15. Settings-registry fragments: only invoicing contributes one.**
- The registry (T1 D13) holds FLAT, scalar fields an owner fills once.
  Invoicing's details are exactly that (`invoicingSettingsFragment`: how
  customers pay you, days until due, a footer note), and invoicing has no
  settings table to put them in.
- Scheduling's settings are lists (services, crews, hours) with their own
  screen; the estimator's are a business's quote rules beside its price book.
  Neither fits flat fields, and both already have tested settings screens. What
  they share with every feature is the basics, which they READ from the
  `company` fragment (D5). That is the T1 promise ("the owner fills them in
  once") kept without moving list-shaped data into jsonb.
- comms contributes none: its identity comes from the company profile (D8).

**D16. The isolation proof drives the fetch handlers, from route tables the
packages publish.**
- Each package exports its routes as DATA (`*_ADMIN_ROUTES`,
  `*_PUBLIC_ROUTES`, shape in 3.1): method, path, permission, what each
  parameter names (`{visit}`, `{quote-token}`), and an example query or body
  that reaches the row lookup. The package's own tests prove each row routes to its kind and each
  example reaches the lookup (404 on an empty tenant).
- The emitted test plants rows of every entity in company A, then calls every
  route as B: with A's company id (403), with B's id and A's row ids (404), and
  under B's web address with A's tokens (404). Everything B gets back must say
  nothing of A, and A's rows must be unchanged. A route or an entity the test
  has no plan for fails it by name.

**D17. Public company pages stay out of search in 2a.** `/t/` keeps
`robots: noindex` and the robots.txt disallow. Token pages are always noindex
and `no-referrer`. A company's SEO is listed as not included.

---

## 3. Shared shapes (every builder)

Declared in EACH package that uses them, structurally identical, never imported
across packages (D4).

### 3.1 Route tables

```ts
/**
 * One route of a feature's handler, as data. The tests read it back; the
 * emitted isolation proof (create-app section 12) drives every row.
 */
export interface <Pkg>Route<K extends string = string> {
  readonly kind: K;
  readonly method: "GET" | "POST";
  /** Relative to the handler's mount, e.g. "v1/admin/visits/{visit}/accept". */
  readonly path: string;
  /** The permission `authorize` is asked for (private routes); null on public routes. */
  readonly permission: string | null;
  /** Query parameters to send: literal values, or a placeholder like "{resource}". */
  readonly query?: Readonly<Record<string, string>>;
  /** A minimal valid JSON body for a POST: enough to get past the body's zod schema to the row lookup. Placeholders allowed in string values. */
  readonly body?: unknown;
}
```

- **Placeholders** are `{entity}` with a lowercase entity name. The same
  placeholder means the same kind of row everywhere. Entities:

  | Package | Entities |
  | --- | --- |
  | scheduling | `resource`, `visit`, `time-off`, `visit-token` |
  | estimator | `product`, `supply`, `attachment`, `option`, `option-value`, `estimate`, `line`, `photo`, `key`, `quote-token` |
  | invoicing | `invoice`, `item`, `payment`, `invoice-token` |
  | comms | `template-key` |

- A placeholder IN THE PATH means "this route reads that row": the proof
  expects `404 not_found` for another company's row. A placeholder only in the
  query or body means "the row is a reference": the proof expects any answer
  below 500 that says nothing of the other company.
- Route kinds, paths and permissions must match the router exactly. The
  package test (13.x "route table") calls `handle` once per row and asserts it
  routed to that kind.
- Exported names: `SCHEDULING_ADMIN_ROUTES`, `SCHEDULING_PUBLIC_ROUTES`,
  `ESTIMATOR_ADMIN_ROUTES`, `ESTIMATOR_PUBLIC_ROUTES`,
  `INVOICING_ADMIN_ROUTES`, `INVOICING_PUBLIC_ROUTES`, `COMMS_ADMIN_ROUTES`.
  Each is `readonly <Pkg>Route<…RouteKind>[]`, frozen. The existing
  `SCHEDULING_ADMIN_ROUTE_PERMISSIONS` and `ESTIMATOR_ADMIN_ROUTE_PERMISSIONS`
  stay, and a test asserts they agree with the tables.

### 3.2 The company seam

```ts
/** The business as its customers know it, from the host's company profile. */
export interface <Pkg>Company {
  readonly name: string;
  /** IANA. null: not set yet (the feature keeps its own). */
  readonly timeZone: string | null;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
  readonly logoUrl: string | null;
  /** "#rrggbb", or null. */
  readonly brandColor: string | null;
}
/** Option on a package's handlers and comms listener. A throw is reported (onError) and treated as null for that request. */
company?: (tenantId: string) => <Pkg>Company | null | Promise<<Pkg>Company | null>;
```

`tenancy.companyProfile(tenantId)` returns a superset (4.3), so the generated
wiring passes `(id) => tenancy.companyProfile(id)` directly.

### 3.3 Admission (public handlers)

```ts
export type <Pkg>Admission = { readonly open: true } | { readonly open: false; readonly message: string };
/**
 * Is this business taking requests from the public right now? Asked once per
 * request, after the tenant is known (from resolveTenant OR an embed key) and
 * before any other work. Default: always open.
 */
admit?: (tenantId: string, req: Request) => <Pkg>Admission | Promise<<Pkg>Admission>;
```

Closed answers (status 409, the message from the admission):

| Package | Code |
| --- | --- |
| scheduling | `booking_closed` |
| estimator | `estimates_closed` |
| invoicing | `unavailable` |

### 3.4 Link builders

Every link a package builds for a tenant may now be async, because the host
looks up the company's web address:

```ts
type <Pkg>Link<A extends unknown[]> = (...args: A) => string | Promise<string>;
```

Existing sync callers keep compiling (a string is a valid return).

### 3.5 Copy shared by the private seams

The four private handlers answer these through `authorize`'s `Response`
(created by `createCompanyRouteSeams`, 4.6), with `{ error: { code, message } }`:

| Case | Status | code | message |
| --- | --- | --- | --- |
| signed out | 401 | `forbidden` | "You've been signed out. Sign in again to keep working." |
| not a member (or a made-up id) | 403 | `forbidden` | "You're not part of this {noun}." |
| suspended | 403 | `forbidden` | "This {noun} is suspended. Contact support to restore it." |
| member without the permission | 403 (the handler's own `false` answer) | `forbidden` | the handler's existing sentence |

`forbidden` because every feature widget already knows it, and 401 is read as
"signed out" by status alone.

---

## 4. `@adminigloo/tenancy` 0.5.0 (tenancy builder)

Everything here is additive. Tenancy 1's behaviour, routes and wire are
unchanged except the `RoleKey` widening (4.1) and the new wire type in 4.9.

### 4.1 Roles a project composes (root, `roles.ts`; client-safe)

```ts
export interface TenantRoleTemplate { readonly key: string; readonly name: string; readonly description: string; readonly rank: number }   // unchanged

export interface TenantRoleSet {
  /** The four core templates plus the project's extras, highest rank first. */
  readonly templates: readonly TenantRoleTemplate[];
  readonly keys: readonly string[];
  has(key: string): boolean;
  rankOf(key: string): number | undefined;
  /** `canManageTemplate` on this set's ranks. An unknown key on either side denies. */
  canManage(actorKey: string, targetKey: string): boolean;
  /** Every key an invitation or a role change may carry: all but "owner", highest rank first. */
  readonly assignable: readonly string[];
}

/** The core four plus `extra`. Throws InvalidTenantRoleError on a bad spec. */
export function defineTenantRoles(extra?: readonly TenantRoleTemplate[]): TenantRoleSet;
/** defineTenantRoles([]): exactly Tenancy 1's roles. */
export const DEFAULT_TENANT_ROLES: TenantRoleSet;
export class InvalidTenantRoleError extends Error { readonly name = "InvalidTenantRoleError" }
```

`defineTenantRoles` refuses, at definition time:
- a key not matching `/^[a-z][a-z0-9_]{1,31}$/`, a core key, or a duplicate;
- a rank that isn't an integer with `1 <= rank <= 29`, that equals 10 or 20 (a
  tie with a core role), or that another extra already has;
- a name outside 1–40 characters, or a description outside 1–200.

The why-comment says: extras rank below admin so the owner and admins manage
them; a tie would mean two roles that can't manage each other, which nobody
would guess from the team page.

`TENANT_ROLE_TEMPLATES`, `templateRank` and `canManageTemplateKey` stay as they
are (core only), with a comment pointing at `TenantRoleSet` for projects with
extra roles.

**Service changes (`./server`):**
- `CreateTenancyServiceOptions.roles?: TenantRoleSet` (default
  `DEFAULT_TENANT_ROLES`). `TenancyService.roles` exposes it.
- D10 of Tenancy 1 (the self-seed in `createCompany`) seeds `roles.templates`,
  not the shipped constant.
- Every place that lists or checks role keys reads the set instead of a
  literal list:
  - `db.ts` `ROLE_KEYS` / `asRoleKey` → `roles.has`;
  - `team.ts` `ASSIGNABLE` → `roles.assignable`;
  - `context.ts` `roleOptions` → `roles.templates` (DB names and ranks still
    win over the shipped ones, as today);
  - the handlers' `roleKey` zod: any string matching the key pattern; then
    `owner` → `owner_must_transfer`, a key not in the set → `400 invalid` with
    the issue "Pick one of the roles listed." on `roleKey`.
- Rank decisions keep using DB ranks (`role_template.rank`), so a crew member
  (5) is managed by admins (30) and owners (40), and manages nobody.

**Wire (`wire.ts` and the widget's `types.ts`, both copies):**

```ts
/**
 * A role's key. The core four always exist; a project may add more (Crew,
 * with scheduling), so any lowercase key is valid on the wire. The server
 * sends each role's name, description and rank (TeamWire.roles).
 */
export type RoleKey = "owner" | "admin" | "member" | "viewer" | (string & {});
```

### 4.2 Public lookup with status

```ts
export interface PublicCompany {   // gains timeZone
  readonly id: string; readonly name: string; readonly slug: string;
  readonly logoUrl: string | null; readonly brandColor: string | null; readonly onBrandColor: "#ffffff" | "#111111" | null;
  readonly contactEmail: string | null; readonly contactPhone: string | null;
  readonly timeZone: string | null;
}
resolvePublicCompany(slug: string): Promise<{
  readonly company: PublicCompany;
  /** The address asked for, when it was an OLD one (a page redirects to the current). */
  readonly retiredSlug: string | null;
  readonly status: "active" | "suspended";
} | null>;
```

- Like `resolveCompanyBySlug` (T1 6.12), but a suspended company is returned
  with `status: "suspended"` instead of null, through a current or a retired
  address. Unknown, deleted, or `kind = 'personal'` → null.
- `resolveCompanyBySlug` is reimplemented as `resolvePublicCompany(slug)`
  filtered to `active`. Its behaviour is unchanged (T1's tests stay green).
- One query for a current address; a second only for a retired one.

### 4.3 The company profile (server-internal, no permission check)

```ts
export interface CompanyProfile {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  /** "/t/" + slug. */
  readonly publicPath: string;
  readonly kind: "org" | "personal";
  readonly status: "active" | "suspended";
  readonly timeZone: string | null;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
  readonly address: {
    readonly line1: string | null; readonly line2: string | null; readonly city: string | null;
    readonly region: string | null; readonly postalCode: string | null; readonly country: string | null;
  };
  readonly logoUrl: string | null;
  readonly brandColor: string | null;
  readonly onBrandColor: "#ffffff" | "#111111" | null;
  /** Where a customer's reply goes: the contact email, else the owner's sign-in address; null only when neither exists. */
  readonly replyTo: string | null;
  /** Where the company's own notices go when a feature has none saved: [contact email] or [owner's address] or []. */
  readonly inbox: readonly string[];
  /** Every registry fragment's parsed values (registry.parse), e.g. settings.invoicing.paymentInstructions. */
  readonly settings: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

companyProfile(tenantId: string): Promise<CompanyProfile | null>;   // null: unknown or deleted id
```

- ONE query: `tenants` left-joined to `users` on `owner_user_id` (for the
  owner's address; a deleted owner contributes null). Settings parse problems
  are reported through `onEventError`, never thrown (T1 6.6).
- No permission check, like `readSettings`: it is for server code that has
  already decided whom it serves (a handler after `authorize`, a cron, the
  comms identity). Its comment says so.
- `CompanyProfile` is structurally a `SchedulingCompany`, `EstimatorCompany`
  and `InvoicingBusiness`'s base (3.2), so the generated wiring passes
  `(id) => tenancy.companyProfile(id)` straight in.

### 4.4 Members as people (server-internal)

```ts
listMemberPeople(tenantId: string): Promise<readonly {
  readonly userId: string; readonly name: string | null; readonly email: string | null;
  readonly roleKey: RoleKey | null; readonly roleName: string;
}[]>;
```

Active members only, ordered by name then email. For scheduling's "who opens
this crew's route" picker (`listPeople`): the company's own people, never the
site's whole user table. (Single mode's picker lists every user of the site; in
companies mode that would show Summit's people to Green Acres.)

### 4.5 Every active company, for crons

```ts
activeCompanyIds(): Promise<readonly string[]>;
// companies mode: kind 'org', not suspended, not deleted, ordered by id.
// personal mode: kind 'personal', not suspended, not deleted (no 2a caller uses it).

export interface CompanyRunOptions {
  /** Companies run at once. Default 4. */
  readonly concurrency?: number;
  /** Stop STARTING companies after this many ms; the rest are reported `deferred`. Default: no budget. */
  readonly timeBudgetMs?: number;
  /** Told about each company's failure (the run goes on). */
  readonly onError?: (error: unknown, tenantId: string) => void;
  readonly now?: () => Date;
}
export interface CompanyRunReport<T> {
  readonly companies: number;
  readonly ran: readonly { readonly tenantId: string; readonly result: T }[];
  /** The message only: never a stack, never a row. */
  readonly failed: readonly { readonly tenantId: string; readonly error: string }[];
  readonly deferred: readonly string[];
}
export function runForEachCompany<T>(
  tenancy: Pick<TenancyService, "activeCompanyIds">,
  work: (tenantId: string) => Promise<T>,
  options?: CompanyRunOptions,
): Promise<CompanyRunReport<T>>;
```

- Each company's `work` runs in its own try/catch. A throw goes to `failed`
  (`error instanceof Error ? error.message : String(error)`, cut to 300
  characters) and to `onError`, and the next company starts.
- Order: the ids rotated so the run starts at index
  `floor(now / 3_600_000) mod n` (D10).
- `activeCompanyIds` failing (the database is down) rejects the whole run: a
  cron that can't list companies has nothing to isolate.

### 4.6 The private route seams

```ts
export interface CompanyRouteSeams {
  /** The company id in the path after `prefix`, if it has the shape of an id (1–128 of [A-Za-z0-9_-]); never looked up here. */
  readonly resolveTenant: (req: Request) => string | null;
  /**
   * Signed in → a live member of this company → not suspended → holds the
   * permission. Memoised per Request (a route that asks twice pays once).
   */
  readonly authorize: (req: Request, permission: string, tenantId: string) =>
    Promise<{ readonly userId: string } | false | Response>;
}
export function createCompanyRouteSeams(options: {
  readonly tenancy: TenancyService;
  readonly principal: (req: Request) => Promise<{ readonly userId: string } | null>;
  /** Where the id sits: the segment right after this. Default "/api/app/". */
  readonly prefix?: string;
}): CompanyRouteSeams;
```

`authorize`, in order:
1. `principal(req)`; null → `Response` 401 (3.5).
2. `loadTenantPermissions` through the service's loaders (the membership gate):
   null → `explainTenantDenial`; `company-suspended` → `Response` 403
   "suspended"; anything else → `Response` 403 "not part of" (3.5).
3. `set.can(permission)` → `{ userId }`, else `false` (the handler's own 403).

The memo is a `WeakMap<Request, Promise<{ userId; set } | Response>>` keyed on
the request object, so two calls in one request (scheduling's `may()`, the
estimator's costs ask) cost one resolution, and nothing outlives the request.
Every `Response` carries `cache-control: no-store`.

### 4.7 The public seams

```ts
export interface PublicCompanySeams {
  /** The company a `{prefix}{slug}/…` request names (a current or retired address, active or suspended); unknown → null. */
  readonly resolveTenant: (req: Request) => Promise<string | null>;
  /** Open for an active company; closed, with a plain sentence, for a suspended or unknown one. */
  readonly admit: (tenantId: string, req: Request) => Promise<{ readonly open: true } | { readonly open: false; readonly message: string }>;
}
export function createPublicCompanySeams(options: {
  readonly tenancy: TenancyService;
  /** Default "/api/t/". */
  readonly prefix?: string;
}): PublicCompanySeams;
```

- The slug is the first segment after `prefix`, `decodeURIComponent`'d and
  lowercased; a segment failing the slug pattern → null with no query.
- `resolveTenant` caches its answer on the Request (WeakMap), and `admit` reads
  that cache first, so a slug-addressed request costs ONE tenancy query.
  `admit` for a tenant reached through an embed key does its own lookup
  (`companyProfile`); an unknown or deleted id is closed.
- The closed message: "{Name} isn't taking requests online right now." followed,
  when the company has a contact, by " Call {phone} or email {email}."
  (whichever exist). For an unknown id: "This business isn't taking requests
  online right now."

### 4.8 Events

`TenancyEvent` gains three types, emitted after commit through `onEvent`
(T1 D17):

```ts
| { readonly type: "company.settings.updated"; readonly tenantId: string; readonly section: string; readonly changed: readonly string[]; readonly by: string }
| { readonly type: "company.profile.updated"; readonly tenantId: string; readonly changed: readonly ("name" | "slug")[]; readonly by: string }
| { readonly type: "company.branding.updated"; readonly tenantId: string; readonly by: string }
```

- `company.settings.updated` from `updateSettings` (the same `changed` list as
  its audit row); `company.profile.updated` from `updateCompanyProfile` when
  something changed; `company.branding.updated` from `updateBranding`,
  `setLogo` and `removeLogo`.
- D5's convergence listens for `company.settings.updated` with
  `section === "company"` and `"timeZone"` in `changed`.

### 4.9 Copy, wire and helpers

- `companySettings`' `timeZone` field help becomes: "Dates and times your
  customers see use this. Visits already booked keep their clock times."
- New wire type (both copies, inside the region), and its server helper:

  ```ts
  export interface PublicCompanyWire {
    name: string; slug: string; publicPath: string;
    logoUrl: string | null; brandColor: string | null; onBrandColor: "#ffffff" | "#111111" | null;
    contactEmail: string | null; contactPhone: string | null;
    status: "active" | "suspended";
  }
  ```

  `publicCompanyToWire(found: { company: PublicCompany; status: "active" | "suspended" }): PublicCompanyWire`
  in `./server`. The id is NOT on the wire.

### 4.10 Exports added

- Root: `defineTenantRoles`, `DEFAULT_TENANT_ROLES`, `InvalidTenantRoleError`;
  types `TenantRoleSet`, `PublicCompanyWire`.
- `./server`: `createCompanyRouteSeams`, `createPublicCompanySeams`,
  `runForEachCompany`, `publicCompanyToWire`; types `CompanyProfile`,
  `CompanyRouteSeams`, `PublicCompanySeams`, `CompanyRunOptions`,
  `CompanyRunReport`.
- `TenancyService` gains `roles`, `resolvePublicCompany`, `companyProfile`,
  `listMemberPeople`, `activeCompanyIds`.
- `barrel.test.ts` is updated to match.

---

## 5. `@adminigloo/tenancy-widget` 0.2.0 (tenancy builder)

### 5.1 Roles

- `ROLE_KEYS` / `roleKeyOrNull` accept any string matching
  `/^[a-z][a-z0-9_]{1,31}$/`. The invite select, role selects and words read
  each role's name and description from `TeamWire.roles` (they already do).
- A role key the server sends with no row in `roles` shows its key, humanised
  ("crew" → "Crew"), never a blank.

### 5.2 `<CompanyBrandBar>` (entry `.`)

```ts
interface CompanyBrandBarProps {
  company: PublicCompanyWire;
  /** The company's public home; the name links there. Default company.publicPath; null = no link. */
  homeHref?: string | null;
  /** Show the contact line (email · phone). Default true. */
  showContact?: boolean;
  locale?; theme?; nonce?; className?; style?;
}
```

- A header row: the logo (at most 40 px high, `alt=""` because the name is
  beside it) or an initials badge filled with the brand colour in
  `onBrandColor` text; then the name, linked to `homeHref` (not a heading: the
  page owns its `h1`); then the contact line with `mailto:` and `tel:` links.
- A 3 px bottom border in the brand colour when there is one. This is the
  company's public face: here, unlike the company's own screens (T1 8.2), the
  company's colour is the point.
- Server-renderable (`renderToStaticMarkup`), no state, no fetch.

### 5.3 `<CompanyUnavailable>` (entry `.`)

```ts
interface CompanyUnavailableProps { company: PublicCompanyWire; locale?; theme?; nonce?; className?; style? }
```

- Heading (`h1`): "{Name} isn't taking requests online right now".
- Body: "Please get in touch with them directly." then the contact links when
  there are any. Nothing about why. No other actions.

### 5.4 Wire parity, tests

- The wire region gains `PublicCompanyWire` and the widened `RoleKey`; the
  parity test stays byte-for-byte.
- Tests: a role key like `crew` round-trips through the client parser; the team
  page renders a Crew row and offers Crew in the invite select when the server
  lists it; both new components render under SSR with and without a logo,
  colour and contact; the initials badge's text passes AA on its colour.

### 5.5 Exports

`.` adds `CompanyBrandBar`, `CompanyUnavailable`, their props types, and the
`PublicCompanyWire` type.

### 5.6 The release test

`src/__tests__/release.test.ts` reads Tenancy 1's changesets, which
`changeset version` consumed (the baseline's one failure). Rewrite it for 2a:
the peer is `@adminigloo/tenancy ^0.5.0` (optional), and
`.changeset/tenancy-2a-tenancy.md` and `.changeset/tenancy-2a-tenancy-widget.md`
exist, each `minor`.

---

## 6. `@adminigloo/scheduling` 0.5.0 and `@adminigloo/scheduling-widget` 0.2.0 (scheduling builder)

Every new option is optional; a host passing none of them gets 0.4's behaviour,
byte for byte. Single-business create-app projects pass none of them.

### 6.1 Types (root)

```ts
export interface SchedulingCompany {          // 3.2
  readonly name: string; readonly timeZone: string | null;
  readonly contactEmail: string | null; readonly contactPhone: string | null;
  readonly logoUrl: string | null; readonly brandColor: string | null;
}
export type SchedulingAdmission = { readonly open: true } | { readonly open: false; readonly message: string };   // 3.3

/** Settings gain one flag: the business's basics come from the host's company profile. */
export interface SchedulingSettings extends SchedulingSettingsValues {
  tenantId: string; saved: boolean; updatedAt: Date | null;
  /** True when a `company` seam supplied the name, contact and zone (D5). */
  managedByCompany: boolean;
}

/** The Crew role a project adds to its company roles (create-app passes it to defineTenantRoles). */
export const SCHEDULING_CREW_ROLE = {
  key: "crew",
  name: "Crew member",
  description: "Opens their own crew's route for the day on a phone and marks each stop started or done. Sees nothing else.",
  rank: 5,
} as const;
```

`schedulingPermissions["schedule.route"].defaultFor` becomes
`["owner", "admin", "member", "crew"]`. The comment says: a `defaultFor` naming a
template the project never seeds grants nothing, so a project without the crew
role is unaffected.

### 6.2 `resolveSchedulingSettings` (root)

```ts
export interface ResolveSchedulingSettingsOptions {
  readonly company?: (tenantId: string) => SchedulingCompany | null | Promise<SchedulingCompany | null>;
  readonly now?: Date;
  readonly onEvent?: SchedulingEventListener;
  readonly onEventError?: (error: unknown, event: SchedulingEvent) => void;
  /** Told when the company seam throws; that read then uses the stored settings. */
  readonly onError?: (error: unknown) => void;
}
export function resolveSchedulingSettings(
  db: SchedulingDb,
  tenantId: string,
  options?: ResolveSchedulingSettingsOptions,
): Promise<SchedulingSettings>;
```

In order:
1. `settings = await getSchedulingSettings(db, tenantId)` (`managedByCompany:
   false`).
2. No `company` option, or it answers null (or throws: report, then this
   step) → return `settings`.
3. **Converge the zone (D5).** If `company.timeZone` is a valid zone, differs
   from `settings.timeZone`, AND the tenant has a stored row (`settings.saved`):
   `settings = await updateSchedulingSettings(db, tenantId, { timeZone },
   { now, notify: false, actor: { type: "system", id: null }, onEvent,
   onEventError })`. That is 0.4's own zone change: the exclusive settings lock,
   every pending/confirmed/in-progress visit kept at its clock time with
   re-derived instants and `sequence + 1`, and `visit.rescheduled` (`via:
   "time_zone"`, `notify: false`) emitted after commit, so the comms listener
   re-queues reminders. With no stored row, the zone is overlaid in memory only
   (nothing stored depends on a zone yet, and an insert here would turn online
   booking on by the column default).
4. **Overlay (D5).** Return `{ ...settings, businessName: company.name,
   contactEmail: company.contactEmail, contactPhone: company.contactPhone,
   timeZone: (the converged or overlaid zone), managedByCompany: true }`.

Re-entrance is safe and must be tested: the events in step 3 reach the comms
listener, which calls this function again; by then the row holds the company's
zone, so step 3 is a no-op.

### 6.3 Public handlers (`createSchedulingHandlers`)

New options:

```ts
company?: (tenantId: string) => SchedulingCompany | null | Promise<SchedulingCompany | null>;
admit?: (tenantId: string, req: Request) => SchedulingAdmission | Promise<SchedulingAdmission>;
/** Widened: may be async (the host looks the company's web address up). */
manageUrl: (token: string, tenantId: string) => string | Promise<string>;
/** Told about an unexpected error (the answer is still a plain 500) and about a company seam that threw. */
onError?: (error: unknown, context: { tenantId: string | null; route: string }) => void;
```

`handle(req)`, in order (0.4's order with two steps inserted):
1. OPTIONS; the cross-site check; route matching (unchanged).
2. `resolveTenant` / `tenantId` (unchanged); none → 404.
3. **`admit(tenantId, req)`**; closed → `409 { error: { code: "booking_closed",
   message } }` with the token-route headers when it is one. Before the rate
   limit and before any scheduling query.
4. The rate limit (unchanged).
5. **Settings through `resolveSchedulingSettings`** with `company`, `now`,
   `onEvent`, `onEventError`.
6. Dispatch (unchanged; `manageUrl` awaited, including the `.ics` route).

The config route's `businessName`, `contactEmail`, `contactPhone` and
`timeZone` therefore come from the company when the seam is given.

### 6.4 Staff handlers (`createSchedulingAdminHandlers`)

New options:

```ts
company?: (tenantId: string) => SchedulingCompany | null | Promise<SchedulingCompany | null>;
/** Where the owner changes the company-owned fields (D6), e.g. "/settings/company#details". Default null. */
companySettingsHref?: string | null;
onError?: (error: unknown, context: { tenantId: string | null; route: string }) => void;
```

- Every route reads settings through `resolveSchedulingSettings` (it read
  `getSchedulingSettings` at the top of `dispatch`).
- `settings-get` answers `SettingsWire` with `managedByCompany: { href:
  companySettingsHref ?? null }` when `settings.managedByCompany`, else null.
- `settings-update`, when `settings.managedByCompany`: drops `businessName`,
  `timeZone`, `contactEmail` and `contactPhone` from the body before
  `updateSchedulingSettings` (D6). A body left empty saves nothing and answers
  the current settings.
- `listPeople` and `onCrewMemberChange` are unchanged as seams; companies mode
  passes `listMemberPeople` and no `onCrewMemberChange` (11.8).

### 6.5 The comms listener (`./comms`)

```ts
export interface SchedulingCommsOptions {
  // …0.4's options, with these changes:
  company?: (tenantId: string) => SchedulingCompany | null | Promise<SchedulingCompany | null>;
  manageUrl: (token: string, tenantId: string) => string | Promise<string>;
  bookUrl?: string | ((tenantId: string) => string | null | Promise<string | null>);
  adminUrl?: string | ((tenantId: string) => string | null | Promise<string | null>);
  /** Staff notices when the business saved no staffNotifyEmails. A function answers per tenant (D8). */
  staffEmails?: readonly string[] | ((tenantId: string) => readonly string[] | Promise<readonly string[]>);
}
```

- `onEvent` and `beforeSend` read settings through `resolveSchedulingSettings`
  (with `company`), so `{{businessName}}`, the contact lines and every date in
  the email are the company's.
- A link function that throws or answers null leaves that line empty (the
  template's whole-line variables fold away), and is reported through
  `onError` with step `links`. The email still goes.
- `staffEmails` as a function is called once per event that sends a staff
  notice.

### 6.6 Checklist items (root; structural, no tenancy import)

```ts
export interface SchedulingChecklistItem {
  readonly key: string; readonly title: string; readonly description: string;
  readonly actionLabel: string; readonly href: string; readonly order: number;
  readonly permission?: string;
  isDone(ctx: { readonly db: unknown; readonly tenantId: string }): Promise<boolean>;
}
export function schedulingChecklistItems(hrefs: { readonly booking: string; readonly crews: string }): readonly SchedulingChecklistItem[];
```

| key | order | permission | title | description | actionLabel | href | done when |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `schedule.booking` | 40 | `schedule.resources.manage` | "Choose what customers can book" | "Your services and how long each takes. Then switch online booking on." | "Set up booking" | `{booking}` | the tenant has a settings row with `public_booking_enabled = true` |
| `schedule.crews` | 50 | `schedule.resources.manage` | "Add your crew and their hours" | "Customers can only book times when a crew is working." | "Add a crew" | `{crews}` | an active crew with `hours_configured = true` |

Each `isDone` is one `select … limit 1` on `ctx.db` (cast to `SchedulingDb`),
filtered by `ctx.tenantId`.

### 6.7 Route tables (root; shape 3.1)

`SCHEDULING_ADMIN_ROUTES` (paths relative to the mount; `{…}` placeholders):

| kind | method | path | permission | query / body |
| --- | --- | --- | --- | --- |
| `calendar` | GET | `v1/admin/calendar` | `schedule.view` | query `resources={resource}` |
| `crew-day` | GET | `v1/admin/crew-day` | `schedule.route` | query `resource={resource}` |
| `health` | GET | `v1/admin/status` | `schedule.view` | |
| `people` | GET | `v1/admin/people` | `schedule.resources.manage` | |
| `progress` | POST | `v1/admin/visits/{visit}/progress` | `schedule.route` | `{ status: "in_progress" }` |
| `suggest` | GET | `v1/admin/suggest` | `schedule.view` | query `minutes=60&resource={resource}` |
| `visit-create` | POST | `v1/admin/visits` | `schedule.manage` | `{ resourceId: "{resource}", date: "2031-03-03", startTime: "09:00", customerName: "Isolation Probe" }` |
| `visit-get` | GET | `v1/admin/visits/{visit}` | `schedule.view` | |
| `accept` | POST | `v1/admin/visits/{visit}/accept` | `schedule.manage` | `{}` |
| `decline` | POST | `v1/admin/visits/{visit}/decline` | `schedule.manage` | `{}` |
| `status` | POST | `v1/admin/visits/{visit}/status` | `schedule.manage` | `{ status: "confirmed" }` |
| `reschedule` | POST | `v1/admin/visits/{visit}/reschedule` | `schedule.manage` | `{ date: "2031-03-04", startTime: "10:00" }` |
| `assign` | POST | `v1/admin/visits/{visit}/assign` | `schedule.manage` | `{ resourceId: "{resource}" }` |
| `details` | POST | `v1/admin/visits/{visit}/details` | `schedule.manage` | `{ notes: "probe" }` |
| `expire` | POST | `v1/admin/expire` | `schedule.manage` | `{}` |
| `settings-get` | GET | `v1/admin/settings` | `schedule.view` | |
| `settings-update` | POST | `v1/admin/settings` | `schedule.resources.manage` | `{ slotStepMinutes: 30 }` |
| `resources-list` | GET | `v1/admin/resources` | `schedule.view` | |
| `resource-create` | POST | `v1/admin/resources` | `schedule.resources.manage` | `{ name: "Probe crew" }` |
| `resource-update` | POST | `v1/admin/resources/{resource}` | `schedule.resources.manage` | `{ name: "Renamed crew" }` |
| `resource-deactivate` | POST | `v1/admin/resources/{resource}/deactivate` | `schedule.resources.manage` | `{}` |
| `resource-reactivate` | POST | `v1/admin/resources/{resource}/reactivate` | `schedule.resources.manage` | `{}` |
| `availability-get` | GET | `v1/admin/resources/{resource}/availability` | `schedule.view` | |
| `availability-set` | POST | `v1/admin/resources/{resource}/availability` | `schedule.resources.manage` | `{ weekly: [] }` |
| `time-off-add` | POST | `v1/admin/resources/{resource}/time-off` | `schedule.resources.manage` | `{ from: "2031-03-03", to: "2031-03-03" }` |
| `time-off-remove` | POST | `v1/admin/resources/{resource}/time-off/{time-off}/remove` | `schedule.resources.manage` | `{}` |

`SCHEDULING_PUBLIC_ROUTES`:

| kind | method | path | query / body |
| --- | --- | --- | --- |
| `config` | GET | `v1/config` | |
| `slots` | GET | `v1/slots` | query `manage={visit-token}` |
| `request` | POST | `v1/request` | `{ slotId: "probe", service: "visit", name: "Isolation Probe", email: "probe@isolation.test", fillMs: 5000 }` |
| `visit` | GET | `v1/visit/{visit-token}` | |
| `reschedule` | POST | `v1/visit/{visit-token}/reschedule` | `{ slotId: "probe" }` |
| `cancel` | POST | `v1/visit/{visit-token}/cancel` | `{}` |
| `ics` | GET | `v1/visit/{visit-token}/ics` | |

If an example turns out not to reach the lookup (a refusal before it), change
the example, not the expectation, and note it in the hand-off.

### 6.8 Peer

`@adminigloo/comms` peer becomes `^0.3.0` (optional, as before): generated
projects install comms 0.3.

### 6.9 Wire (both copies: `scheduling/src/wire.ts` and `scheduling-widget/src/types.ts`)

`SettingsWire` gains one field, at the end:

```ts
  /** The name, zone and contact come from the company profile (Tenancy 2a): show them read-only, linking here. null = editable here. */
  managedByCompany: { href: string | null } | null;
```

Nothing else in the wire changes.

### 6.10 `@adminigloo/scheduling-widget` 0.2.0

- **`accentColor?: string | null`** on `<VisitPicker>` and `<ManageVisit>`:
  undefined or null → the stylesheet's accent; a `#rrggbb` → that accent, with
  the text colour on it, the strong and soft shades and the focus ring derived
  for contrast (copy estimator-widget's `accentTokens` maths; never import it).
  Below 3:1 against the page, the derived `accent-ink` is darkened or lightened
  until links and focus read (the estimator's rule).
- **Closed by the business.** When `config()` (or any public call) answers
  `booking_closed` with a server message, the picker shows that message as its
  closed state, with no retry button. `<ManageVisit>` does the same for its
  visit load.
- **`<SchedulingSettings>`:**
  - with `settings.managedByCompany`, the Business card shows the name, time
    zone, contact email and phone as read-only text, under "These come from
    your company settings." with a link "Change them in company settings" to
    `managedByCompany.href` (no link when null). Its Save sends none of them;
    the zone-change notice and the "email upcoming customers" question are not
    rendered;
  - `inviteHref?: string | null`: when given, the crew-person picker's hint is
    "Not listed? Invite them on the Team page." linking to it, in place of the
    sign-in hint;
  - deep links: opening with `#booking`, `#crews` or `#hours` scrolls to and
    focuses that card's heading (checklist links depend on it).
- The admin components are otherwise unchanged; their `baseUrl` simply carries
  the company id (`/api/app/{id}/schedule`).

---

## 7. `@adminigloo/estimator` 0.4.0 and `@adminigloo/estimator-widget` 0.3.0 (estimator builder)

Every new option is optional; a host passing none gets 0.3's behaviour.

### 7.1 Types (root)

```ts
export interface EstimatorCompany { /* exactly 3.2's fields */ }
export type EstimatorAdmission = { readonly open: true } | { readonly open: false; readonly message: string };

export interface EstimatorSettings extends EstimatorSettingsValues {
  tenantId: string; saved: boolean; sampleLoadedAt: Date | null; updatedAt: Date | null;
  /** The company's logo when a company seam supplied the basics; null otherwise. */
  logoUrl: string | null;
  /** True when a `company` seam supplied the name, contact, zone and colour (D5). */
  managedByCompany: boolean;
  /** The ceiling that applied to aiDailyBudgetCents, when one did (D14). */
  aiBudgetCeilingCents: number | null;
}
```

### 7.2 `resolveEstimatorSettings` (root)

```ts
export function resolveEstimatorSettings(
  db: EstimatorDb,
  tenantId: string,
  options?: {
    readonly company?: (tenantId: string) => EstimatorCompany | null | Promise<EstimatorCompany | null>;
    readonly aiBudgetCeilingCents?: number;
    readonly onError?: (error: unknown) => void;
  },
): Promise<EstimatorSettings>;
```

- Reads `getEstimatorSettings`. Never writes (the estimator stores no instants
  computed from the zone).
- With a company: `businessName`, `contactEmail`, `contactPhone`,
  `brandColor` and `logoUrl` are the company's; `timeZone` is the company's
  when set, else the stored one; `managedByCompany: true`.
- With a ceiling: `aiDailyBudgetCents = min(stored, ceiling)`,
  `aiBudgetCeilingCents = ceiling`.
- `estimatorReady` is unchanged (`saved && businessName`). With a company the
  name is always there, so readiness means "the owner saved estimate settings
  once" (the tax rate and quote rules): the gate EST-R02 wanted.

### 7.3 Public handlers (`createEstimatorHandlers`)

New options: `company`, `admit` (3.3), `aiBudgetCeilingCents?: number`.

`handle(req)`, in order:
1. OPTIONS, then "who is asking" (unchanged): a key → verify, origin,
   tenant from the key; no key → cross-site check, then
   `resolveTenant`/`tenantId`.
2. **`admit(tenantId, req)`** for BOTH paths; closed → `409 { error: { code:
   "estimates_closed", message } }` with CORS for a keyed request. Before the
   route and the rate limit.
3. Route, rate limit (unchanged).
4. **Settings through `resolveEstimatorSettings`** (company, ceiling).
5. Dispatch. `PublicConfig` gains `logoUrl` (7.9). The photo-reading budget
   check (`runPhotoTakeoff`) receives the ceilinged settings, so the ceiling
   holds where the money is spent.

### 7.4 Staff handlers (`createEstimatorAdminHandlers`)

New options: `company`, `companySettingsHref?: string | null`,
`aiBudgetCeilingCents?: number`. Widened: `quoteUrl: (token, tenantId) =>
string | Promise<string>`, `links.bookVisitUrl` may return a Promise.

- Every route reads settings through `resolveEstimatorSettings`.
- `settings-get`: `EstimatorSettingsWire` with `managedByCompany: { href }` and
  `aiBudgetCeilingCents`.
- `settings-update`, when managed: drops `businessName`, `contactEmail`,
  `contactPhone`, `timeZone` and `brandColor` (D6). With a ceiling, an
  `aiDailyBudgetCents` above it answers `400 invalid` with the issue on
  `aiDailyBudgetCents`: "This site allows up to {$x.xx} a day of photo reading
  per business." (`formatMoney` in the settings' currency).
- `status` (`AdminStatus`) reports the ceiling beside the budget, so the
  settings screen can say it.

### 7.5 The comms listener (`./comms`)

```ts
export interface EstimatorCommsOptions {
  // …0.3's options, with these changes:
  company?: (tenantId: string) => EstimatorCompany | null | Promise<EstimatorCompany | null>;
  quoteUrl: (token: string, tenantId: string) => string | Promise<string>;
  adminEstimateUrl?: (estimateId: string, tenantId: string) => string | Promise<string>;
  bookUrl?: (estimate: EstimateSnapshot, tenantId: string) => string | null | Promise<string | null>;
  staffEmails?: readonly string[] | ((tenantId: string) => readonly string[] | Promise<readonly string[]>);
}
```

Settings through `resolveEstimatorSettings` with `company`; links and staff
recipients as scheduling's (6.5).

### 7.6 Checklist items (root; structural)

```ts
export function estimatorChecklistItems(hrefs: { readonly priceBook: string; readonly settings: string; readonly embed: string }): readonly EstimatorChecklistItem[];
// EstimatorChecklistItem: the same shape as SchedulingChecklistItem (6.6), declared here.
```

| key | order | permission | title | description | actionLabel | href | done when |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `estimator.prices` | 60 | `estimator.pricebook.manage` | "Add the work you sell and its prices" | "Build your price book, or load the sample to start from. Customers only see prices for what you add." | "Open the price book" | `{priceBook}` | an active product shown in the estimator |
| `estimator.settings` | 70 | `estimator.settings.manage` | "Set your tax rate and quote rules" | "Instant estimates stay closed until you save these once." | "Estimate settings" | `{settings}` | settings saved (`saved_at` set) |
| `estimator.embed` | 90 | `estimator.settings.manage` | "Put the estimator on your own website" | "Make a key for your website and paste the snippet. Skip this if customers only use your page here." | "Get the snippet" | `{embed}` | a key that isn't revoked |

### 7.7 Route tables (root; shape 3.1)

`ESTIMATOR_ADMIN_ROUTES` has exactly one row per kind of
`ESTIMATOR_ADMIN_ROUTE_PERMISSIONS`, with the method and path `route()` matches
and that kind's permission. Path parameters map to placeholders by segment:

| Path shape | Placeholders |
| --- | --- |
| `products/:id…` | `{product}` |
| `products/:id/supplies/:sub…` | `{product}`, `{attachment}` |
| `options/:id…` | `{option}` |
| `option-values/:id…` | `{option-value}` |
| `supplies/:id…` | `{supply}` |
| `estimates/:id…` | `{estimate}` |
| `estimates/:id/items/:sub…` | `{estimate}`, `{line}` |
| `estimates/:id/photos/:sub/remove` | `{estimate}`, `{photo}` |
| `keys/:id…` | `{key}` |

Body references: `supply-attach` `{ supplyId: "{supply}", quantityMilli: 1000 }`;
`products-reorder` `{ ids: ["{product}"] }`; `estimate-create` names no row
(`{ customerName: "Isolation Probe" }`); `line-add` `{ productId: "{product}" }`
or a free line, whichever reaches the estimate lookup first. Every other POST
example is the smallest body its schema accepts.

`ESTIMATOR_PUBLIC_ROUTES`:

| kind | method | path | body |
| --- | --- | --- | --- |
| `config` | GET | `v1/config` | |
| `options` | POST | `v1/options` | `{ productId: "{product}" }` |
| `calculate` | POST | `v1/calculate` | `{ productId: "{product}", quantity: 1 }` |
| `photo` | POST | `v1/photo` | a 1×1 JPEG, base64, `mediaType: "image/jpeg"` |
| `takeoff` | POST | `v1/takeoff` | `{ productId: "{product}", imageBase64: (the same JPEG), mediaType: "image/jpeg" }` |
| `submit` | POST | `v1/submit` | `{ name: "Isolation Probe", email: "probe@isolation.test", items: [{ productId: "{product}", quantity: 1 }], fillMs: 5000 }` |
| `quote` | GET | `v1/quote/{quote-token}` | |
| `accept` | POST | `v1/quote/{quote-token}/accept` | `{ version: 1, name: "Isolation Probe" }` |
| `decline` | POST | `v1/quote/{quote-token}/decline` | `{ version: 1 }` |

### 7.8 Peer

`@adminigloo/comms` peer becomes `^0.3.0` (optional).

### 7.9 Wire (both copies: `estimator/src/wire.ts` and `estimator-widget/src/types.ts`)

```ts
// PublicConfig gains, at the end:
  /** The business's logo (from its company profile), or null. */
  logoUrl: string | null;
// EstimatorSettingsWire gains, at the end:
  /** The name, contact, zone and colour come from the company profile: read-only here, linking to href. null = editable here. */
  managedByCompany: { href: string | null } | null;
  /** The most a day of photo reading may cost on this site, in cents; null = no ceiling. */
  aiBudgetCeilingCents: number | null;
```

`QuoteResponse.quote` gains `logoUrl: string | null` the same way.

### 7.10 `@adminigloo/estimator-widget` 0.3.0

- **Pattern hrefs** (a server page can't pass a function to a client
  component; T1's `detailHref` precedent):
  - `<EstimatesQueue estimateHref>` accepts `string | ((id) => string)`; a
    string is a pattern whose `{id}` is replaced with the encoded id.
  - `<EstimateEditor>` gains `estimateHref?: string | ((id) => string)` (same
    rule). When `onOpenEstimate` is absent, opening another estimate (a
    duplicate) navigates with `window.location.assign(href)`.
- **`<EstimatorSettings>`:** with `managedByCompany`, the business fields
  (name, contact, time zone, brand colour) are read-only text under "These come
  from your company settings." with the link; with `aiBudgetCeilingCents`, the
  budget field's hint says "Up to {$x.xx} a day on this site." and the input's
  `max` is the ceiling. The first-run form asks only for what is still the
  estimator's (tax rate, labor rate).
- **Closed by the business:** `estimates_closed` with a server message is
  shown as that message in `<EstimateTool>`, `<EstimatorModal>` and
  `<QuoteView>` (they show a fixed sentence today).
- **Logo:** `<EstimateTool>` and `<QuoteView>` show `logoUrl` beside the
  business name when the config/quote carries one (max 32 px high, `alt=""`).
- **Deep link:** `<EmbedKeys>` has `id="embed"` and focuses its heading on
  `#embed`.

---

## 8. `@adminigloo/email` 0.3.0 (messages builder)

```ts
export interface EmailMessage {
  // …0.2's fields, plus:
  /**
   * The display name on THIS message's From. The address stays EMAIL_FROM's:
   * the verified sending domain is the only one the provider sends from (D8).
   * Cleaned by sanitizeDisplayName; empty after cleaning → the sender's own name.
   */
  readonly fromName?: string | null | undefined;
  /**
   * Reply-To for THIS message, in place of EMAIL_REPLY_TO. Bare or named.
   * Unparseable → EmailMessageInvalidError("replyTo"): a reply that goes
   * nowhere is worse than a refused send the caller logs.
   */
  readonly replyTo?: string | null | undefined;
}

/** Control characters removed, whitespace runs collapsed, trimmed, cut to `max` (default 64) at a character boundary; null when nothing is left. */
export function sanitizeDisplayName(value: string | null | undefined, max?: number): string | null;
```

- `send` formats the From as `formatSenderAddress({ name: cleaned ??
  from.name, email: from.email })`. A company named `Green Acres, LLC` is quoted
  by `formatSenderAddress`, never split into two addresses.
- The log entry's `fromAddress` is the From actually used.
- No schema change. Tests: a named From on the default address; a comma in the
  name quoted; CR/LF stripped; an empty name falls back; a per-message
  Reply-To replaces the default and a bad one throws; with neither, 0.2's
  output exactly.

---

## 9. `@adminigloo/comms` 0.3.0 and `@adminigloo/comms-widget` 0.1.0 (messages builder)

### 9.1 Sender identity (root)

```ts
/** Who a tenant's messages come from (D8). */
export interface SenderIdentity {
  /** The From display name for email; the sender name every text starts with. */
  readonly name: string | null;
  /** Where replies go. */
  readonly replyTo: string | null;
}

interface CommsDeliveryConfig {
  email?: EmailSender;
  defaultEmailSubject?: string;
  /**
   * Asked once per message (once per tenant per drain) before sending. null →
   * the sender's own defaults. A THROW fails the message ("couldn't read who
   * this business sends as"), retried by the queue: sending a company's email
   * under the platform's reply-to is the one outcome worse than a delay.
   */
  identity?: (tenantId: string) => SenderIdentity | null | Promise<SenderIdentity | null>;
}

export interface OutboundEmail {
  // …0.2's fields, plus:
  readonly tenantId: string;
  readonly fromName: string | null;
  readonly replyTo: string | null;
}
export interface OutboundSms {
  // …0.2's fields, plus:
  readonly tenantId: string;
}
```

- `replyTo: null` (or an identity whose `replyTo` fails comms' own email
  check) means "the sender's default"; the log row's `reply_to` is then null,
  so the owner can see it in Messages. (The company settings fragment already
  validates the address; the check is belt and braces.)
- SMS: `identity.name`, when set, is the sender name `enforceCompliance` puts
  in front of the text, in place of `smsCompliance.senderName`. Compliance
  config is still required to send any SMS.

### 9.2 Schema: two log columns

```ts
// comms_messages gains:
/** The From display name this email went out under (D8); null = the sender's default, or not an email. */
fromName: text("from_name"),
/** The Reply-To it carried; null = the sender's default. */
replyTo: text("reply_to"),
```

Written by `deliver` for email messages, from the identity actually passed to
the sender. Upgrade SQL (README "Upgrading from 0.2"):

```sql
alter table comms_messages add column if not exists from_name text, add column if not exists reply_to text;
```

### 9.3 The drain, by tenant

```ts
export interface RunDueOptions {
  // …0.2's options, plus:
  /**
   * Claim only these tenants' rows (D10: the active companies). Undefined: every
   * tenant (0.2). An empty array claims nothing. The 0.1.x-row cleanup and the
   * stale-claim reclaim stay global: they move rows, they never send.
   */
  tenantIds?: readonly string[];
}
```

The due-row select adds `inArray(commsScheduled.tenantId, tenantIds)`. The
identity is cached per tenant for the run (a Map), so a drain of 200 rows for 3
companies asks 3 times.

### 9.4 Permissions (root)

```ts
export const commsPermissions = {
  "comms.view": {
    label: "See messages",
    description: "The emails and texts this company sends: their wording, and what went to whom and when.",
    category: "Messages",
    defaultFor: ["owner", "admin", "member", "viewer"],
  },
  "comms.manage": {
    label: "Edit messages",
    description: "Change the wording of the emails customers get, switch one off or on, and send what's due now.",
    category: "Messages",
    defaultFor: ["owner", "admin"],
  },
} as const satisfies Record<string, CommsPermissionDefinition>;   // structural, like scheduling's
export type CommsPermission = keyof typeof commsPermissions;
```

### 9.5 Staff handlers (root): `createCommsAdminHandlers`

```ts
export type CommsAuthorizeResult = boolean | { userId?: string | number | null } | Response;
export interface CommsDelivery { readonly emails: boolean; readonly emailsOffReason: string | null }

export interface CreateCommsAdminHandlersOptions {
  db: CommsDb;
  senders: CommsSenders;
  tenantId?: string;
  resolveTenant?: (req: Request) => string | null | Promise<string | null>;
  authorize: (req: Request, permission: CommsPermission, tenantId: string) => CommsAuthorizeResult | Promise<CommsAuthorizeResult>;
  /** Before templates are listed: add this tenant's templates if absent (comms' defaults and every feature's), never over an edit. */
  ensureTemplates?: (tenantId: string) => Promise<void>;
  /** "Send due now" runs through the cron's own hooks. */
  beforeSend?: RunDueOptions["beforeSend"];
  /** Run in a `finally` after "Send due now" (the features' link scrub). */
  afterRun?: () => Promise<void>;
  /** Is email really leaving, and if not, why (the console's banner). Default: emails on when `senders.email` exists. */
  delivery?: (tenantId: string) => CommsDelivery | Promise<CommsDelivery>;
  onError?: (error: unknown, context: { tenantId: string | null; route: string }) => void;
  now?: () => Date;
}
export function createCommsAdminHandlers(options: CreateCommsAdminHandlersOptions): { handle(req: Request): Promise<Response> };
export const COMMS_ADMIN_ROUTES: readonly CommsRoute<CommsAdminRouteKind>[];
```

The scheduling handler mechanics apply: routing by the suffix after
`/v1/admin/`, 405 with `allow` on a wrong method, `404 not_found` on an unknown
path, no CORS ever, the same-site check on every POST (`403 cross_site`
"This request came from another site, so it was refused."), JSON bodies capped
at 32 KB, `cache-control: no-store`, `{ error: { code, message, issues? } }`,
an unexpected error a `500 internal` with a fixed sentence and the error to
`onError`. `authorize`'s `Response` is returned as it is; `false` →
`403 forbidden` "You don't have permission to do that."

| kind | method | path | permission | body → 200 |
| --- | --- | --- | --- | --- |
| `status` | GET | `v1/admin/status` | `comms.view` | → `CommsStatusWire` |
| `templates` | GET | `v1/admin/templates` | `comms.view` | → `TemplatesWire` (after `ensureTemplates`) |
| `template-save` | POST | `v1/admin/templates/{template-key}` | `comms.manage` | `TemplateBody` → `{ template: TemplateWire }` |
| `template-active` | POST | `v1/admin/templates/{template-key}/active` | `comms.manage` | `ActiveBody` → `{ template: TemplateWire }` |
| `messages` | GET | `v1/admin/messages?limit=` | `comms.view` | → `MessagesWire` (limit 1–200, default 100) |
| `run-due` | POST | `v1/admin/run-due` | `comms.manage` | `{}` → `RunDueWire` |

- `template-save` UPDATES an existing template of this tenant (subject and
  body; the channel never changes here). A key the tenant doesn't have →
  `404 not_found`. An email template with an empty subject → `400 invalid`
  "An email needs a subject." on `subject`. (The console edits; it doesn't
  create keys nobody sends.)
- `run-due` drains ONLY this tenant's due rows (`tenantIds: [tenantId]`,
  `timeBudgetMs: 20_000`, `beforeSend`), then `afterRun` in a `finally`.
- `status`: `emails`/`emailsOffReason` from `delivery`; `fromName`/`replyTo`
  from `senders.identity?.(tenantId)` (a throw → both null); `scheduled.pending`
  is this tenant's pending rows, `scheduled.late` those more than 26 hours past
  their `sendAt` (the cron not running).

### 9.6 Wire (both copies: `comms/src/wire.ts` and `comms-widget/src/types.ts`, inside `// WIRE:BEGIN` / `// WIRE:END`)

```ts
export type Instant = string;
export type CommsErrorCode = "invalid" | "not_found" | "forbidden" | "cross_site" | "rate_limited" | "internal";
export interface WireIssue { path: (string | number)[]; message: string }
export interface WireErrorBody { error: { code: CommsErrorCode; message: string; issues?: WireIssue[] } }

export interface TemplateWire {
  key: string;
  channel: "email" | "sms";
  subject: string | null;
  body: string;
  active: boolean;
  updatedAt: Instant;
  /** The {{placeholders}} its subject and body use, in first-seen order. */
  variables: string[];
}
export interface TemplatesWire { templates: TemplateWire[] }
export interface TemplateBody { subject: string | null; body: string }   // subject ≤ 300, body 1..20000
export interface ActiveBody { active: boolean }

export type MessageStatus = "sent" | "skipped" | "failed" | "cancelled" | "expired";
export interface MessageWire {
  id: string;
  at: Instant;
  channel: "email" | "sms";
  to: string;
  templateKey: string | null;
  subject: string | null;
  status: MessageStatus;
  /** Why it was skipped, cancelled, expired or failed, in the log's words; null when sent. */
  note: string | null;
  /** Placeholders that rendered blank. */
  blanks: string[];
  fromName: string | null;
  replyTo: string | null;
}
export interface MessagesWire { messages: MessageWire[] }

export interface RunDueWire {
  sent: number; skipped: number; failed: number; retrying: number; cancelled: number; expired: number;
  stoppedEarly: boolean;
}
export interface CommsStatusWire {
  emails: boolean;
  emailsOffReason: string | null;
  fromName: string | null;
  replyTo: string | null;
  scheduled: { pending: number; late: number };
}
```

The message BODY is not on the wire (the console shows subject, recipient,
status and note; a body can carry a customer's details the list doesn't need).

### 9.7 `@adminigloo/comms-widget` 0.1.0

Entries: `.` (wire types, `COMMS_WIRE_VERSION`, `createCommsClient`) and
`./admin` (`<MessagesConsole>` and its transport). Copy the transport, theme,
style-injection and dialog pieces from scheduling-widget (never import). CSS
prefix `aicw-`, root class `.aicw-root`, tokens `--aicw-*`, the booking token
set, AA in light and dark (tested).

```ts
export interface CommsTransport {
  status(): Promise<Result<CommsStatusWire>>;
  templates(): Promise<Result<TemplatesWire>>;
  saveTemplate(key: string, body: TemplateBody): Promise<Result<{ template: TemplateWire }>>;
  setActive(key: string, body: ActiveBody): Promise<Result<{ template: TemplateWire }>>;
  messages(q?: { limit?: number }): Promise<Result<MessagesWire>>;
  runDue(): Promise<Result<RunDueWire>>;
}
export function createCommsClient(options: { baseUrl: string; fetch?: typeof fetch; headers?: Record<string, string> }): CommsTransport;

interface MessagesConsoleProps {
  baseUrl?: string; transport?: CommsTransport;
  /** Show the Edit and Send-due-now controls. The server still refuses; this only avoids offering them. Default true. */
  canManage?: boolean;
  locale?; theme?; nonce?; className?; style?;
}
```

The screen, top to bottom:
1. **How your emails go out:** "Your customers see emails from {fromName} and
   their replies go to {replyTo}." When email is off: `emailsOffReason`, in a
   warn notice. When `scheduled.late > 0`: "{n} scheduled messages are late:
   the daily job that sends them hasn't run. Ask whoever set up your site to
   check it."
2. **Messages your customers get:** templates grouped by what they're about,
   from the key's first word: `visit_*` → "Visits", `estimate_*` / `quote_*` /
   `lead_*` → "Estimates", `invoice_*` → "Invoices", anything else → "Other".
   Each shows a plain label from its key ("visit_reminder" → "Visit
   reminder"), On/Off, and an Edit button opening the subject and body with the
   placeholders listed as "Filled in for you: {{name}}, {{date}} …". Saving
   shows the server's issues on their fields. Switching one off confirms:
   "Turn off "{label}"? Customers won't get it until you turn it back on."
3. **What went out:** the delivery log, newest first: when, to whom, which
   message, status in words (Sent, Skipped, Failed, Cancelled, Expired), the
   note, and "Sent as {fromName}" when set. A table at ≥ 768 px, cards below.
4. **Send what's due now** (manage only): the outcome in one sentence listing
   every non-zero count ("Sent 3 · failed 1 · 2 will retry."), never "Sent 3"
   alone (the 0.2 page's rule).

Never throws; `role="status"` for outcomes; 44 px targets under 640 px; SSR-safe.

---

## 10. `@adminigloo/invoicing` 0.3.0 and `@adminigloo/invoicing-widget` 0.1.0 (invoicing builder)

### 10.1 Token reads scoped to a company (D13)

```ts
export function getInvoiceByToken(db: InvoicingDb, token: string, options?: { readonly tenantId?: string }): Promise<PublicInvoice | null>;
export function markInvoiceViewed(db: InvoicingDb, token: string, options?: { readonly tenantId?: string }): Promise<boolean>;
```

With `tenantId`, the select and the update add `eq(invoices.tenantId,
tenantId)`. The handlers ALWAYS pass it. Without it, 0.2's behaviour (for a
single-tenant host), and the doc comment says so.

### 10.2 Permissions (root)

```ts
export const invoicingPermissions = {
  "invoices.view": { label: "See invoices", description: "Invoices, their lines and payments.", category: "Invoices", defaultFor: ["owner", "admin", "member", "viewer"] },
  "invoices.manage": { label: "Raise and send invoices", description: "Create invoices, edit their lines until money is against them, move them along, copy a customer's link and email it to them.", category: "Invoices", defaultFor: ["owner", "admin", "member"] },
  "invoices.payments.record": { label: "Record payments", description: "Record a payment against an invoice: cash, check, card or other. The status follows the money.", category: "Invoices", defaultFor: ["owner", "admin", "member"] },
  "invoices.payments.reverse": { label: "Reverse payments", description: "Undo a recorded payment by adding a reversal. The record of both stays.", category: "Invoices", defaultFor: ["owner", "admin"] },
} as const satisfies Record<string, InvoicingPermissionDefinition>;   // structural
export type InvoicingPermission = keyof typeof invoicingPermissions;
```

### 10.3 The settings fragment (root, D15)

```ts
/** For the host's company settings registry (tenancy's defineSettingsFragment accepts it as is). Structural: no tenancy import. */
export const invoicingSettingsFragment = {
  key: "invoicing",
  label: "Invoices",
  description: "What your invoices tell customers about paying you.",
  order: 40,
  viewPermission: "tenant.view",
  editPermission: "tenant.edit",
  schema: z.object({
    paymentInstructions: z.preprocess(blankToNull, z.string().trim().max(1000).nullable()).default(null),
    dueDays: z.number().int().min(0).max(365).default(14),
    footer: z.preprocess(blankToNull, z.string().trim().max(500).nullable()).default(null),
  }),
  fields: [
    { key: "paymentInstructions", kind: "textarea", label: "How customers pay you", help: "Shown on every invoice and in the invoice email. For example: Pay by check to Green Acres LLC, or call us to pay by card.", width: "full" },
    { key: "dueDays", kind: "number", label: "Invoices are due after this many days", help: "0 means due as soon as they get it.", min: 0, max: 365, step: 1, width: "half" },
    { key: "footer", kind: "textarea", label: "A note at the bottom of every invoice (optional)", width: "full" },
  ],
} as const;

export interface InvoicingDetails { readonly paymentInstructions: string | null; readonly dueDays: number; readonly footer: string | null }
/** The fragment's values from a stored blob; anything unparseable reads as the defaults. */
export function readInvoicingDetails(stored: unknown): InvoicingDetails;
```

### 10.4 The business seam

```ts
/** The business on an invoice: the company basics (3.2) and its invoice details. */
export interface InvoicingBusiness extends InvoicingDetails {
  readonly name: string; readonly timeZone: string | null;
  readonly contactEmail: string | null; readonly contactPhone: string | null;
  readonly logoUrl: string | null; readonly brandColor: string | null;
  /** ISO 4217, default "USD"; BCP 47, default "en-US". */
  readonly currency?: string; readonly locale?: string;
}
business?: (tenantId: string) => InvoicingBusiness | null | Promise<InvoicingBusiness | null>;
```

Without the seam (or null): name "", zone "UTC", USD/en-US, the fragment's
defaults. The generated wiring maps `companyProfile(id)` plus
`readInvoicingDetails(profile.settings.invoicing)` (companies) or constants
(single mode, 11.9).

### 10.5 Handlers (root)

```ts
export type InvoicingAuthorizeResult = boolean | { userId?: string | number | null } | Response;
export type InvoicingAdmission = { readonly open: true } | { readonly open: false; readonly message: string };
export interface InvoicingDelivery { readonly emails: boolean; readonly emailsOffReason: string | null }

export interface CreateInvoicingAdminHandlersOptions {
  db: InvoicingDb;
  tenantId?: string;
  resolveTenant?: (req: Request) => string | null | Promise<string | null>;
  authorize: (req: Request, permission: InvoicingPermission, tenantId: string) => InvoicingAuthorizeResult | Promise<InvoicingAuthorizeResult>;
  business?: (tenantId: string) => InvoicingBusiness | null | Promise<InvoicingBusiness | null>;
  /** The customer's page for a token (absolute). Required: the ledger's "Copy link" and the email both use it. */
  invoiceUrl: (token: string, tenantId: string) => string | Promise<string>;
  /** Emails the invoice (the ./comms sender, 10.6). Absent → "Send" marks it sent and says to copy the link. */
  sendInvoiceEmail?: (input: { readonly tenantId: string; readonly invoiceId: string; readonly userId: string | null }) =>
    Promise<{ readonly status: "sent" | "skipped" | "failed" | "no-email"; readonly message: string }>;
  delivery?: (tenantId: string) => InvoicingDelivery | Promise<InvoicingDelivery>;
  /** Where the owner fills in invoice details (the checklist and the status notice link here). */
  detailsHref?: string | null;
  onError?: (error: unknown, context: { tenantId: string | null; route: string }) => void;
  now?: () => Date;
}
export interface CreateInvoicingHandlersOptions {
  db: InvoicingDb;
  tenantId?: string;
  resolveTenant?: (req: Request) => string | null | Promise<string | null>;
  admit?: (tenantId: string, req: Request) => InvoicingAdmission | Promise<InvoicingAdmission>;
  business?: CreateInvoicingAdminHandlersOptions["business"];
  rateLimit?: (req: Request, bucket: "read" | "viewed") => boolean | Promise<boolean>;
  onError?: CreateInvoicingAdminHandlersOptions["onError"];
  now?: () => Date;
}
export function createInvoicingAdminHandlers(options: CreateInvoicingAdminHandlersOptions): { handle(req: Request): Promise<Response> };
export function createInvoicingHandlers(options: CreateInvoicingHandlersOptions): { handle(req: Request): Promise<Response> };
export const INVOICING_ADMIN_ROUTES: readonly InvoicingRoute<InvoicingAdminRouteKind>[];
export const INVOICING_PUBLIC_ROUTES: readonly InvoicingRoute<InvoicingPublicRouteKind>[];
```

Mechanics as comms' (9.5). The public handler adds `referrer-policy:
no-referrer` and `x-robots-tag: noindex` on every route (each carries the
token), and allows no CORS. Package errors map: `InvoicingError.code` →
`409` with that code and the error's own sentence; a zod failure → `400
invalid` with issues; "not in this tenant" (null/false from the package) →
`404 not_found` "That invoice isn't here.".

**Staff routes** (`{base}/v1/admin/…`):

| kind | method | path | permission | body → 200 |
| --- | --- | --- | --- | --- |
| `status` | GET | `v1/admin/status` | `invoices.view` | → `InvoicingStatusWire` |
| `list` | GET | `v1/admin/invoices?status=&cursor=` | `invoices.view` | → `InvoiceListWire` (50 a page) |
| `create` | POST | `v1/admin/invoices` | `invoices.manage` | `CreateInvoiceBody` → 201 `InvoiceResponse` |
| `get` | GET | `v1/admin/invoices/{invoice}` | `invoices.view` | → `InvoiceResponse` |
| `item-add` | POST | `v1/admin/invoices/{invoice}/items` | `invoices.manage` | `ItemBody` → `InvoiceResponse` |
| `item-update` | POST | `v1/admin/items/{item}` | `invoices.manage` | `ItemPatchBody` → `InvoiceResponse` |
| `item-remove` | POST | `v1/admin/items/{item}/remove` | `invoices.manage` | `{}` → `InvoiceResponse` |
| `status-set` | POST | `v1/admin/invoices/{invoice}/status` | `invoices.manage` | `StatusBody` → `InvoiceResponse` |
| `send` | POST | `v1/admin/invoices/{invoice}/send` | `invoices.manage` | `{}` → `SendResponse` |
| `link` | GET | `v1/admin/invoices/{invoice}/link` | `invoices.manage` | → `InvoiceLinkWire` |
| `payment-record` | POST | `v1/admin/invoices/{invoice}/payments` | `invoices.payments.record` | `PaymentBody` → `InvoiceResponse` |
| `payment-reverse` | POST | `v1/admin/payments/{payment}/reverse` | `invoices.payments.reverse` | `ReverseBody` → `InvoiceResponse` |

- **`create`**: the body's `dueDate` is a calendar date (`YYYY-MM-DD`); the
  handler stores the instant at 23:59:59.999 of that date in the business's
  zone (code does the maths). Absent → today in that zone plus `dueDays`, at
  the same time. `taxRateBp` and `discount` default 0; lines are cents.
- **`get`**: `InvoiceDetailWire.can` comes from asking `authorize` once more
  for each of `invoices.manage`, `invoices.payments.record`,
  `invoices.payments.reverse` (only `true`/object counts; the answers never
  become the response), the estimator's costs-ask pattern.
- **`item-update` / `item-remove`**: the line must belong to an invoice of THIS
  tenant (the package functions already take the tenant); otherwise 404. The
  response is the whole invoice the line belongs to.
- **`send`**: a draft is moved to `sent` first (`setInvoiceStatus`, its own
  rules: no lines → `invoice_has_no_lines`); a `sent`/`viewed`/`partial`
  invoice is just emailed again; `paid`/`void` → `409 transition_not_allowed`
  "A paid or void invoice can't be sent.". Then `sendInvoiceEmail`. Delivery
  and its sentence:

  | delivery | message |
  | --- | --- |
  | `sent` | "Emailed to {email}." |
  | `no-email` | "This invoice has no customer email. Copy the link and send it yourself." |
  | `skipped` | "This site doesn't send email yet. Copy the link and send it yourself." |
  | `failed` | "The email didn't go. Copy the link and send it yourself, or try again." |

  A throw from `sendInvoiceEmail` is `failed` (reported to `onError`); the
  status move has already committed and stays.
- **`link`**: `{ url: invoiceUrl(token), previewUrl: url + "?preview=1" }`.
  The token never appears in any other admin response.
- **`payment-record`**: `recordPayment` with `recordedBy` = the authorised
  user. A draft is refused (`payment_refused`, the package's own sentence).

**Public routes** (`{base}/v1/…`):

| kind | method | path | body → 200 |
| --- | --- | --- | --- |
| `invoice` | GET | `v1/invoice/{invoice-token}` | → `PublicInvoiceResponse` |
| `viewed` | POST | `v1/invoice/{invoice-token}/viewed` | `{}` → `{ viewed: boolean }` |

`resolveTenant`, then `admit` (closed → `409 unavailable` with the message),
then the rate limit, then `getInvoiceByToken(db, token, { tenantId })`; null
(unknown, another company's, or a draft) → `404 not_found` "This invoice isn't
available. It may have been replaced; contact the business." `viewed` is a POST
fired by the page, never by the GET (a link preview must not count).

### 10.6 The invoice email (`./comms`)

```ts
export const INVOICING_COMMS_REF_TYPE = "invoice";
export const INVOICE_EMAIL_TEMPLATES: ReadonlyArray<{ key: "invoice_sent"; subject: string; body: string }>;

export interface InvoicingCommsOptions {
  db: InvoicingDb;           // the comms tables live in the same database
  senders: CommsSenders;
  invoiceUrl: (token: string, tenantId: string) => string | Promise<string>;
  business?: (tenantId: string) => InvoicingBusiness | null | Promise<InvoicingBusiness | null>;
  sendTimeoutMs?: number;    // default 10000, as scheduling's
  onError?: (error: unknown, context: { invoiceId: string; step: string }) => void;
}
export interface InvoicingComms {
  /** For the admin handlers' sendInvoiceEmail. Never throws. */
  sendInvoice(input: { readonly tenantId: string; readonly invoiceId: string; readonly userId: string | null }):
    Promise<{ readonly status: "sent" | "skipped" | "failed" | "no-email"; readonly message: string }>;
  /** Insert the template for a tenant if absent; how many were added. */
  ensureTemplates(tenantId: string): Promise<number>;
  /** After a drain, and right after each send: replace invoice tokens in the delivery log with ":token". */
  redactSent(): Promise<number>;
}
export function createInvoicingComms(options: InvoicingCommsOptions): InvoicingComms;
```

`invoice_sent`:

```
Subject: Invoice {{invoiceNumber}} from {{businessName}}

Hi {{customerName}},

Here's invoice {{invoiceNumber}} for {{total}}{{dueLine}}.

See it here: {{invoiceUrl}}

{{paymentInstructions}}

Questions? Just reply to this email{{phoneLine}}.

{{businessName}}
```

- `dueLine` is ", due {date}" (the date in the business's zone, its locale) or
  empty; `phoneLine` is " or call {phone}" or empty; `total` is formatted in
  the business's currency and locale; `customerName` falls back to "there".
- Sent with `sendNow` (idempotency key `invoice:{id}:sent:{sentCount}` where
  `sentCount` is how many `invoice_sent` messages this invoice already has in
  the log, so a double click is one email and a deliberate resend is another).
- The token in the link is the invoice's permanent `view_token`, so it is
  replaced with `:token` in the delivery log right after the send, exactly as
  scheduling scrubs manage links; `redactSent` also sweeps the last 14 days of
  `invoice_sent` rows for a 43+-character token shape left by a crashed send.
- No customer email on the invoice → `no-email`, nothing logged.

### 10.7 Checklist item (root; structural)

```ts
export function invoicingChecklistItems(hrefs: { readonly details: string }): readonly InvoicingChecklistItem[];
```

| key | order | permission | title | description | actionLabel | href | done when |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `invoices.details` | 80 | `tenant.edit` | "Tell customers how to pay you" | "Shown on every invoice and in the invoice email." | "Add invoice details" | `{details}` | `readInvoicingDetails(ctx.settings.invoicing).paymentInstructions !== null` |

(`ctx.settings` is the checklist context's parsed registry values, T1 5.4.)

### 10.8 Wire (both copies: `invoicing/src/wire.ts` and `invoicing-widget/src/types.ts`, inside the markers)

```ts
export type Instant = string;
export type DateString = string;   // "YYYY-MM-DD"
export type InvoicingErrorCodeWire =
  | "invalid" | "not_found" | "forbidden" | "cross_site" | "rate_limited" | "unavailable" | "transition_not_allowed" | "internal"
  | "estimate_already_invoiced" | "estimate_not_convertible" | "discount_exceeds_subtotal" | "invoice_not_editable"
  | "invoice_has_no_lines" | "invalid_status_transition" | "payment_refused" | "reversal_refused" | "invoice_number_conflict";
export interface WireIssue { path: (string | number)[]; message: string }
export interface WireErrorBody { error: { code: InvoicingErrorCodeWire; message: string; issues?: WireIssue[] } }

export type InvoiceStatusWire = "draft" | "sent" | "viewed" | "partial" | "paid" | "void" | "overdue";
export type StoredInvoiceStatusWire = "draft" | "sent" | "viewed" | "partial" | "paid" | "void";
export type SettableInvoiceStatusWire = "draft" | "sent" | "viewed" | "void";
export type PaymentMethodWire = "card" | "cash" | "check" | "ach" | "other";

/** How to show money and dates for this business. */
export interface MoneyFormatWire { currency: string; locale: string; timeZone: string }

export interface InvoiceSummaryWire {
  id: string; number: string; status: InvoiceStatusWire;
  customerName: string | null;
  total: number; amountPaid: number; balanceDue: number;   // cents
  dueDate: Instant | null; createdAt: Instant;
}
export interface InvoiceListWire { invoices: InvoiceSummaryWire[]; nextCursor: string | null; format: MoneyFormatWire }

export interface InvoiceLineWire { id: string; description: string; quantity: number; unitPrice: number; total: number }
export interface InvoicePaymentWire {
  id: string; amount: number; method: PaymentMethodWire; reference: string | null; paidAt: Instant;
  /** A reversal row names the payment it undoes; `reversed` marks a payment that has been undone. */
  reversesPaymentId: string | null; reversed: boolean; reason: string | null;
}
export interface InvoiceDetailWire {
  id: string; number: string; status: InvoiceStatusWire; storedStatus: StoredInvoiceStatusWire;
  customerName: string | null; customerEmail: string | null; customerPhone: string | null; billingAddress: string | null;
  subtotal: number; discount: number; taxRateBp: number; taxAmount: number; total: number;
  amountPaid: number; balanceDue: number; overpaid: number;
  dueDate: Instant | null; notes: string | null; fromEstimate: boolean;
  sentAt: Instant | null; viewedAt: Instant | null; paidAt: Instant | null; createdAt: Instant;
  lines: InvoiceLineWire[]; payments: InvoicePaymentWire[];
  editable: boolean; nextStatuses: SettableInvoiceStatusWire[];
  can: { manage: boolean; record: boolean; reverse: boolean };
}
export interface InvoiceResponse { invoice: InvoiceDetailWire; format: MoneyFormatWire }

export interface CreateInvoiceBody {
  customerName: string;                       // 1..200
  customerEmail?: string | null; customerPhone?: string | null; billingAddress?: string | null;
  taxRateBp?: number; discount?: number;      // basis points; cents
  dueDate?: DateString | null; notes?: string | null;
  items: { description: string; quantity: number; unitPrice: number }[];   // 1..200
}
export interface ItemBody { description: string; quantity: number; unitPrice: number }
export interface ItemPatchBody { description?: string; quantity?: number; unitPrice?: number }
export interface StatusBody { status: SettableInvoiceStatusWire }
export interface PaymentBody { amount: number; method: PaymentMethodWire; reference?: string | null }
export interface ReverseBody { reason: string }   // 1..500
export interface SendResponse extends InvoiceResponse { delivery: "sent" | "skipped" | "failed" | "no-email"; message: string }
export interface InvoiceLinkWire { url: string; previewUrl: string }
export interface InvoicingStatusWire {
  emails: boolean; emailsOffReason: string | null;
  /** Payment instructions are filled in. */
  detailsComplete: boolean; detailsHref: string | null;
  format: MoneyFormatWire;
}

// public
export interface BusinessWire {
  name: string; logoUrl: string | null; brandColor: string | null;
  contactEmail: string | null; contactPhone: string | null;
  paymentInstructions: string | null; footer: string | null;
}
export interface PublicInvoiceWire {
  number: string; status: InvoiceStatusWire; customerName: string | null;
  subtotal: number; discount: number; taxRateBp: number; taxAmount: number; total: number;
  amountPaid: number; balanceDue: number;
  dueDate: Instant | null; issuedAt: Instant;
  lines: { description: string; quantity: number; unitPrice: number; total: number }[];
  payments: { amount: number; method: PaymentMethodWire; paidAt: Instant }[];
}
export interface PublicInvoiceResponse { invoice: PublicInvoiceWire; business: BusinessWire; format: MoneyFormatWire }
```

`PublicInvoiceWire` is 0.2's `PublicInvoice` projection, unchanged in what it
leaves out (no references, recorders, internal ids, estimate link or contact
details).

### 10.9 `@adminigloo/invoicing-widget` 0.1.0

Copy the transport, theme, style-injection, dialog and accent pieces from
scheduling-widget / estimator-widget (never import). CSS prefix `aiiw-`, root
`.aiiw-root`, tokens `--aiiw-*`, AA in light and dark (tested). Money is shown
with `Intl.NumberFormat(format.locale, { style: "currency", currency })`;
dates in `format.timeZone`. A person types dollars and a percent; the widget
sends cents and basis points (`Math.round`), and refuses a value that isn't a
number before sending.

```ts
export interface InvoicingTransport {            // ./admin
  status(): Promise<Result<InvoicingStatusWire>>;
  list(q?: { status?: InvoiceStatusWire; cursor?: string }): Promise<Result<InvoiceListWire>>;
  create(body: CreateInvoiceBody): Promise<Result<InvoiceResponse>>;
  get(id: string): Promise<Result<InvoiceResponse>>;
  addItem(id: string, body: ItemBody): Promise<Result<InvoiceResponse>>;
  updateItem(itemId: string, body: ItemPatchBody): Promise<Result<InvoiceResponse>>;
  removeItem(itemId: string): Promise<Result<InvoiceResponse>>;
  setStatus(id: string, body: StatusBody): Promise<Result<InvoiceResponse>>;
  send(id: string): Promise<Result<SendResponse>>;
  link(id: string): Promise<Result<InvoiceLinkWire>>;
  recordPayment(id: string, body: PaymentBody): Promise<Result<InvoiceResponse>>;
  reversePayment(paymentId: string, body: ReverseBody): Promise<Result<InvoiceResponse>>;
}
export interface InvoicePublicTransport {        // .
  invoice(token: string): Promise<Result<PublicInvoiceResponse>>;
  viewed(token: string): Promise<Result<{ viewed: boolean }>>;
}
```

**`<InvoicesLedger>`** (`./admin`):

```ts
interface InvoicesLedgerProps {
  baseUrl?: string; transport?: InvoicingTransport;
  /** Where one invoice opens: a pattern with {id}, or a function. Default "?invoice={id}" on this page. */
  invoiceHref?: string | ((id: string) => string);
  locale?; theme?; nonce?; className?; style?;
}
```

- A notice when `detailsComplete` is false: "Add how customers pay you, so
  every invoice says it." linking to `detailsHref`; and the email notice from
  `emailsOffReason`.
- "New invoice": customer name (required), customer email (optional), lines
  (description, quantity, price in dollars; "+ Add line", remove), tax %,
  discount $, due date (a date input; empty = "due after your usual {dueDays}
  days", from the status), a live "Subtotal before discount and tax" preview
  (the server's totals are the truth), "Create invoice" → opens it.
- Filters: All, Draft, Sent, Viewed, Partly paid, Overdue, Paid, Void (words,
  not keys). Table ≥ 768 px (Number, Customer, Total, Paid, Status as a word
  badge), cards below; "Load more".

**`<InvoiceEditor>`** (`./admin`):

```ts
interface InvoiceEditorProps {
  baseUrl?: string; transport?: InvoicingTransport;
  invoiceId: string;
  /** "Back to invoices". Default: no back link. */
  backHref?: string;
  locale?; theme?; nonce?; className?; style?;
}
```

- Header: number, status in words, "Back to invoices".
- Customer (name, email); lines (editable while `editable`: add, change,
  remove; "On a sent invoice, a change replaces the line; the customer's page
  shows the new one."); totals.
- **Send** (manage): "Send to {email}" or "Mark as sent" when there's no email;
  the answer's `message` shown; **Copy link** (manage) via `link()`, copying
  `url`, with "Preview" opening `previewUrl` in a new tab.
- "Move to" with `nextStatuses` in words (Void asks to confirm: "Void invoice
  {number}? It stays in your records and can't be changed after.").
- Payments (record: amount $, method in words, reference; reverse with a
  required reason in a dialog). Overpaid shows "{amount} overpaid: refund or
  credit it."
- Every write disables only its control, announces in one `role="status"`
  region, shows the server's sentence on refusal, and re-renders from the
  response. Never throws.

**`<InvoiceView>`** (`.`, the customer's page):

```ts
interface InvoiceViewProps {
  baseUrl?: string; transport?: InvoicePublicTransport;
  token: string;
  /** The business's preview (?preview=1): never reports a view. */
  preview?: boolean;
  /** The business's colour for the accent (as estimator-widget's accentColor). */
  accentColor?: string | null;
  locale?; theme?; nonce?; className?; style?;
}
```

- Loads `invoice(token)`; on success, and unless `preview`, fires `viewed`
  once (a ref latch), never on the GET.
- Shows: the business (logo, name, contact), "Invoice {number}", status in
  words ("Paid", "Overdue since {date}", "Due {date}"), the customer name,
  lines, subtotal, discount, tax ("Tax (8.25%)"), total, paid, balance due,
  payments, then "How to pay" with `paymentInstructions` and the `footer`.
- `not_found` → "This invoice isn't available. It may have been replaced;
  contact the business." `unavailable` → the server's message.
- Print-friendly: a `@media print` block hides nothing but the accent chrome.

Exports: `.` → `InvoiceView`, `InvoiceViewProps`, `createInvoicePublicClient`,
`InvoicePublicTransport`, `INVOICING_WIRE_VERSION`, the public wire types;
`./admin` → `InvoicesLedger`, `InvoiceEditor`, their props, `createInvoicingClient`,
`InvoicingTransport`, `injectInvoicingAdminStyles`, `INVOICING_WIRE_VERSION`,
the staff wire types.

---

## 11. create-app 0.23.0: the wiring plan (create-app builder)

A file-by-file plan. Every new or changed emitted file obeys the generator
rules: no emitted `if` about a feature or a mode, overlays only add, pages are
thin wrappers around package components. "Companies" means `tenantNoun !==
"none"`; "single" means `"none"`.

### 11.1 Answers, packages, versions

**`versions.ts`** (each with its why-comment):

| Package | Version |
| --- | --- |
| `tenancy` | `0.5.0` |
| `tenancy-widget` | `0.2.0` |
| `scheduling` | `0.5.0` |
| `scheduling-widget` | `0.2.0` |
| `estimator` | `0.4.0` |
| `estimator-widget` | `0.3.0` |
| `invoicing` | `0.3.0` |
| `invoicing-widget` | `0.1.0` (new entry) |
| `comms` | `0.3.0` |
| `comms-widget` | `0.1.0` (new entry) |
| `email` | `0.3.0` |

**`answers.ts`**
- `packagesFor`: `invoicing-widget` with `--invoicing`; `comms-widget` with
  `--comms`.
- `overlayNamesFor`, per feature `f` in (estimator, scheduling, invoicing,
  comms):
  - `f` (files both modes share; omit the push when the overlay is empty);
  - single: `f-single`, and `f-admin` when there is an admin shell (today's
    pages, unchanged condition);
  - companies: `f-companies` (no shell condition: the company area is not
    `/admin`).
- The README's answer and capability tables follow.

### 11.2 The overlays, re-cut

Today's `scheduling`, `estimator`, `invoicing` and `comms` overlays hold
single-mode files. Move them:

| From | To |
| --- | --- |
| `overlays/scheduling/**` except `src/server/scheduling-config.ts` and its test | `overlays/scheduling-single/**` |
| `overlays/estimator/**` except `src/server/estimator-config.ts` and its test | `overlays/estimator-single/**` |
| `overlays/invoicing/**` | retired (D3): `invoice/[token]` and the tRPC router are replaced (11.9). `src/invoice-link.ts` and its test are deleted: the ledger gets the customer link and its preview from the `link` route, and an estimate's linked invoice now points at the STAFF page (`/admin/invoices/{id}` single, `/app/invoices/{id}` companies), which needs no token |
| `overlays/invoicing-admin/app/admin/invoices/page.tsx` | rewritten thin (11.9) |
| `overlays/comms/src/server/routers/comms.ts` | retired (D3) |
| `overlays/comms/app/api/cron/comms/route.ts` | becomes emitted (11.12) |
| `overlays/comms-admin/app/admin/comms/page.tsx` | rewritten thin (11.9) |

The `*-config.ts` modules stay shared, holding only what both modes use (the
pure decisions: first settings, rate limits, delivery status, path
constants). **Everything naming the fixed business moves out of them into a
single-only file** (`SCHEDULING_TENANT`, `ESTIMATOR_TENANT`, the staff-key
maps, the crew STAFF role): D12's grep must find none of it in a companies
project.

New `-companies` overlays hold the pages and route files of 11.3–11.4. Files
whose content depends on other answers are emitted (11.5).

### 11.3 Companies mode: pages (`overlays/<f>-companies/`, plus `companies`)

Every private page is a server component calling `CompanyGate` itself (T1
12.2: never in a layout), with the permission in the table; the widget gets
`baseUrl={`/api/app/${company.id}/<feature>`}` and nothing else it could get
wrong. Titles use `PageHeader`.

| Page | Gate permission | Renders |
| --- | --- | --- |
| `app/(site)/app/page.tsx` | (none) | `redirect("/dashboard")` |
| `app/(site)/app/schedule/page.tsx` | `schedule.view` | `<ScheduleCalendar baseUrl bookingPageUrl={absolute /t/{slug}/book-visit} initialDate>` |
| `app/(site)/app/schedule/today/page.tsx` | `schedule.route` | `<CrewDay baseUrl>` |
| `app/(site)/app/schedule/settings/page.tsx` | `schedule.view` | `<SchedulingSettings baseUrl bookingPageUrl inviteHref="/settings/team">` |
| `app/(site)/app/estimates/page.tsx` | `estimator.view` | `<EstimatesQueue baseUrl estimateHref="/app/estimates/{id}">` |
| `app/(site)/app/estimates/[id]/page.tsx` | `estimator.view` | `<EstimateEditor baseUrl estimateId backHref="/app/estimates" estimateHref="/app/estimates/{id}">` |
| `app/(site)/app/estimates/settings/page.tsx` | `estimator.view` | `<EstimatorSettings baseUrl>` then `<EmbedKeys baseUrl>` |
| `app/(site)/app/price-book/page.tsx` | `estimator.view` | `<PriceBook baseUrl>` |
| `app/(site)/app/invoices/page.tsx` | `invoices.view` | `<InvoicesLedger baseUrl invoiceHref="/app/invoices/{id}">` |
| `app/(site)/app/invoices/[id]/page.tsx` | `invoices.view` | `<InvoiceEditor baseUrl invoiceId backHref="/app/invoices">` |
| `app/(site)/app/messages/page.tsx` | `comms.view` | `<MessagesConsole baseUrl canManage={can.includes("comms.manage")}>` |
| `app/(site)/app/switch/[slug]/route.ts` | — | D2: signed out → `/sign-in?redirect_url=…`; else `resolvePublicCompany(slug)` (any status) → `setActiveCompany` (a `not_found` is ignored) → `redirect(safeNext)` |

Each page is in the overlay of the feature it shows (`app/schedule/**` in
`scheduling-companies`, and so on). `app/(site)/app/page.tsx` and the switch
route are in `companies`.

**Public pages** (`overlays/<f>-companies/app/(site)/t/[slug]/…`), each a
server component wrapped in the emitted `PublicCompanyGate` (11.5):

| Page | Renders inside the gate |
| --- | --- |
| `t/[slug]/book-visit/page.tsx` | `<VisitPicker baseUrl={`/api/t/${slug}/schedule`} service estimateId accentColor={company.brandColor}>` |
| `t/[slug]/visit/[token]/page.tsx` | `<ManageVisit baseUrl token bookHref={`${company.publicPath}/book-visit`} accentColor>`; metadata noindex + `referrer: no-referrer`; `dynamic = "force-dynamic"` |
| `t/[slug]/estimate/page.tsx` | `<EstimateTool baseUrl={`/api/t/${slug}/estimator`} bookHref={estimateBookHref(company.publicPath)} accentColor>` |
| `t/[slug]/quote/[token]/page.tsx` | `<QuoteView baseUrl token bookHref={…} accentColor>`; noindex, no-referrer |
| `t/[slug]/invoice/[token]/page.tsx` | `<InvoiceView baseUrl={`/api/t/${slug}/invoices`} token preview={searchParams.preview === "1"} accentColor>`; noindex, no-referrer |

`estimateBookHref(publicPath)` comes from the emitted
`src/server/estimator-features.ts` (11.5): `(p) => \`${p}/book-visit\`` with
scheduling, `() => undefined` without. Two variants, no `if`.

**Changed T1 pages (`overlays/companies/`):**
- `app/(site)/dashboard/page.tsx`: the gate permission becomes NONE (D9: a crew
  member holds no `tenant.view`). It renders the company name, the
  `<SetupChecklist>` (already empty for someone who can do none of its items),
  and the company's `APP_LINKS` as cards, filtered by permission (11.11).
- `app/(site)/t/[slug]/page.tsx`: inside `PublicCompanyGate`; the brand bar,
  then one button per public page this project has, from the generated
  `PUBLIC_COMPANY_PAGES` list in `src/tenancy.ts` (`[{ path: "/estimate",
  label: "Get an instant estimate" }, { path: "/book-visit", label: "Book a
  visit" }]`, each present only with its feature). Still noindex (D17).

### 11.4 Companies mode: API routes

Each a two-line file over a builder from 11.5:
`const { handle } = buildXHandlers(); export const GET = handle; export const POST = handle;`
(plus `OPTIONS` on the public and embed routes), `runtime = "nodejs"`,
`dynamic = "force-dynamic"`.

| Route file | Builder |
| --- | --- |
| `app/api/app/[tenantId]/schedule/[...path]/route.ts` | `buildSchedulingAdminHandlers()` |
| `app/api/t/[slug]/schedule/[...path]/route.ts` | `buildSchedulingPublicHandlers()` |
| `app/api/app/[tenantId]/estimator/[...path]/route.ts` | `buildEstimatorAdminHandlers()` |
| `app/api/t/[slug]/estimator/[...path]/route.ts` | `buildEstimatorPublicHandlers()` |
| `app/api/estimator/[...path]/route.ts` | `buildEstimatorEmbedHandlers()` (no `tenantId`, no `resolveTenant`: keyed requests only) |
| `app/api/estimator/embed/[...path]/route.ts` | re-exports the one above (0.2's address) |
| `app/api/app/[tenantId]/invoices/[...path]/route.ts` | `buildInvoicingAdminHandlers()` |
| `app/api/t/[slug]/invoices/[...path]/route.ts` | `buildInvoicingPublicHandlers()` |
| `app/api/app/[tenantId]/messages/[...path]/route.ts` | `buildCommsAdminHandlers()` |
| `app/api/cron/scheduling/route.ts`, `…/estimator/route.ts`, `…/comms/route.ts` | 11.12 |

### 11.5 Companies mode: emitted server modules

**`src/server/company-routes.ts`** (new, companies only):

```ts
import { createCompanyRouteSeams, createPublicCompanySeams } from "<scope>/tenancy/server";
export const companyRoutes = createCompanyRouteSeams({ tenancy, principal: requestPrincipal });   // prefix "/api/app/"
export const publicCompanies = createPublicCompanySeams({ tenancy });                           // prefix "/api/t/"

/** What a test swaps (12.1). */
export interface FeatureHandlerOverrides { readonly principal?: (req: Request) => Promise<{ userId: string } | null> }

/** The private handlers' authorize: the seam, then (only once it passed) the company's first-time setup (D11). */
export function companyAuthorizer(overrides?: FeatureHandlerOverrides): CompanyRouteSeams["authorize"];
/** The public handlers' resolveTenant: the seam, then setup for a real company. */
export async function resolvePublicTenant(req: Request): Promise<string | null>;
/** The public handlers' admit, embed key path included: setup for a real company, then the seam. */
export async function admitPublic(tenantId: string, req: Request): Promise<{ open: true } | { open: false; message: string }>;
```

`companyAuthorizer(overrides)` builds a seams object with `overrides.principal`
when given (so a test can be B), and memoises per process otherwise.

**`src/server/company-links.ts`** (new, companies only): absolute links on this
deployment for a company, from `NEXT_PUBLIC_APP_URL` and the company's
CURRENT web address (`companyProfile(tenantId).slug`, read per call):

```ts
export interface CompanyLinks {
  readonly home: string;                                  // {app}/t/{slug}
  readonly estimate: string; readonly bookVisit: (estimateId?: string) => string;
  readonly manageVisit: (token: string) => string; readonly quote: (token: string) => string;
  readonly invoice: (token: string) => string;
  /** A private page, through the switch route (D2): {app}/app/switch/{slug}?next={path}. */
  readonly app: (path: `/app/${string}` | "/dashboard") => string;
}
export async function companyLinks(tenantId: string): Promise<CompanyLinks>;   // throws for an unknown company
```

Tokens go into one encoded path segment and nowhere else (the single mode's
`schedulingLinks` comment, carried).

**`src/server/company-setup.ts`** (new, companies only):

```ts
/** Each installed feature's first-time setup for one company. GENERATED: one entry per installed feature. */
const SETUPS: readonly { readonly name: string; readonly run: (tenantId: string) => Promise<void> }[] = [/* … */];
/** Memoised per company per process; forgotten on failure; refuses a company that isn't real (companyFor is null). */
export function ensureCompanySetup(tenantId: string): Promise<void>;
/** tenancy's onEvent: company.created → setup; company.settings.updated with timeZone → syncSchedulingCompany (with scheduling). Never throws. */
export async function onCompanyEvent(event: TenancyEvent): Promise<void>;
```

The setups (each insert-if-absent, never over an owner's edit):

| Feature | Setup |
| --- | --- |
| scheduling | under `pg_advisory_xact_lock(hashtext('scheduling-setup:' \|\| id))`: when no settings row, `updateSchedulingSettings(tx, id, firstSchedulingSettings({ timeZone: profile.timeZone ?? env.SCHEDULING_TIME_ZONE, businessName: profile.name }))` (online booking OFF, address required, one service). No crew: the checklist asks for one. Then the visit email templates. |
| estimator | the unsaved settings row with the zone (`profile.timeZone ?? firstEstimatorTimeZone(hints)`), then the estimate email templates. The price book stays empty. |
| invoicing | the `invoice_sent` template. |
| comms | `seedDefaultTemplates(db, id)`. |

**`src/server/tenancy.ts`** (companies variant) gains:
- `roles: TENANT_ROLES` (from `src/permissions/roles.ts`, 11.7);
- `onEvent: (event) => import("./company-setup").then((m) => m.onCompanyEvent(event))`.
  The DYNAMIC import is deliberate and commented: company-setup imports the
  feature glue, which imports this module; a static import would be a load-time
  cycle in which one side reads the other half-initialised.

**`src/components/PublicCompanyGate.tsx`** (new, companies only), a server
component:

```tsx
export async function PublicCompanyGate(props: {
  readonly slug: string;
  /** The path after /t/{slug}, for the old-address redirect, e.g. "/book-visit". */
  readonly path: string;
  readonly children: (company: PublicCompanyWire) => ReactNode;
}): Promise<ReactNode>
```

1. `resolvePublicCompany(slug)`; null → `notFound()`.
2. A retired address → `permanentRedirect(company.publicPath + path)` (query
   kept).
3. Renders `<CompanyBrandBar company>` then, for a suspended company,
   `<CompanyUnavailable company>`; for an active one, `children(company)`.
   (A runtime STATE, not a feature switch.)

**Feature glue, companies variants** (same file names as single mode, the
generator writes the variant):

| File | Exports (companies variant) |
| --- | --- |
| `src/server/scheduling.ts` | `schedulingMaps` (as today); `schedulingCompany = (id) => tenancy.companyProfile(id)`; `buildSchedulingAdminHandlers(overrides?)` (`resolveTenant: companyRoutes.resolveTenant`, `authorize: companyAuthorizer(overrides)`, `company`, `companySettingsHref: "/settings/company#details"`, `maps`, `onEvent`, `delivery: (id) => schedulingDelivery(id)`, `listPeople: (_req, id) => tenancy.listMemberPeople(id)`, NO `onCrewMemberChange`); `buildSchedulingPublicHandlers()` (`resolveTenant: resolvePublicTenant`, `admit: admitPublic`, `company`, `manageUrl: async (t, id) => (await companyLinks(id)).manageVisit(t)`, `maps`, `onEvent`, `emailsEnabled`, `requesterKey: clientIpKey`, `rateLimit` keyed `scheduling:{tenantId}:{bucket}:{ip}`); `setupSchedulingFor(id)`; `syncSchedulingCompany(id)` (= `resolveSchedulingSettings` with the company and `onSchedulingEvent`) |
| `src/server/scheduling-notify.ts` | the comms listener with `company`, async `manageUrl`, `bookUrl: async (id) => (await companyLinks(id)).bookVisit()`, `adminUrl: async (id) => (await companyLinks(id)).app("/app/schedule")`, `staffEmails: async (id) => (await tenancy.companyProfile(id))?.inbox ?? []` (D8: never BOOTSTRAP_ADMIN_EMAIL); `SCHEDULING_EMAILS_ENABLED`; `ensureSchedulingEmailTemplates(id)`; `schedulingDelivery(tenantId)` (its counts filtered to that company) |
| `src/server/estimator.ts` | `buildEstimatorAdminHandlers(overrides?)`, `buildEstimatorPublicHandlers()`, `buildEstimatorEmbedHandlers()` (each with `company`, `admit` on the public two, `aiBudgetCeilingCents: ESTIMATOR_AI_CEILING_CENTS`, the photo store, takeoff, `quoteUrl` via `companyLinks`, `embedBaseUrl: {app}/api/estimator`, rate limits keyed with the tenant); `setupEstimatorFor(id)` |
| `src/server/estimator-config.ts` (shared) | gains `ESTIMATOR_AI_CEILING_CENTS = 100` with D14's why-comment (single mode doesn't pass it) |
| `src/server/estimator-notify.ts` | the listener with `company`, async links via `companyLinks`, `staffEmails` = the company inbox |
| `src/server/estimator-services.ts` | as today, but every tenant is the ARGUMENT, never a constant: `visitsForEstimate(estimateId, tenantId)`, `invoiceForEstimate(estimateId, tenantId)` (its `url` is the staff page `/app/invoices/{id}`), `convertEstimateToInvoice({ tenantId, … })` writing the invoice under `tenantId` with `dueDate` from the company's `dueDays`; `estimatorLinkSeams.bookVisitUrl` async via `companyLinks` |
| `src/server/estimator-features.ts` | `estimateBookHref(publicPath)` (two variants, 11.3) |
| `src/server/invoicing.ts` (new, both modes; variants) | `invoicingBusiness(id)`; `invoicingComms` (with --comms; `createInvoicingComms` with `invoiceUrl` via `companyLinks`); `buildInvoicingAdminHandlers(overrides?)` (`sendInvoiceEmail: invoicingComms.sendInvoice` with --comms, absent without; `delivery`; `detailsHref: "/settings/company#invoicing"`); `buildInvoicingPublicHandlers()` (`admit`, rate limit); `setupInvoicingFor(id)` |
| `src/server/comms-senders.ts` | `buildCommsSenders(transport?: EmailTransport)` and `commsSenders = buildCommsSenders()`; the email sender passes `fromName`, `replyTo` and `tenantId` to `mailer.send`; `identity: async (id) => { const p = await tenancy.companyProfile(id); return p && { name: p.name, replyTo: p.replyTo }; }`. With no `--email`, `commsSenders = { identity }` (the log still records who it would have been) |
| `src/server/comms-hooks.ts` | gains the invoicing producer (`invoicingComms.redactSent`) when --invoicing; `ensureProducerTemplates(tenantId)` unchanged in shape |
| `src/server/comms.ts` (new, both modes; variants) | `buildCommsAdminHandlers(overrides?)`: `senders: commsSenders`, `ensureTemplates: (id) => ensureCompanySetup(id)` (companies) / the producers' templates (single), `beforeSend: commsBeforeSend`, `afterRun: afterCommsRun`, `delivery` |

`buildCommsSenders(transport)` exists so the emitted identity test (12.3) can
send through the project's own senders with a capturing transport
(`createEmailSender({ send: transport })`).

**Import order.** `company-routes` → `company-setup` → the feature glue →
`company-routes` is a cycle by design. It is safe only while every
cross-module use happens INSIDE a function (the builders run when a route file
calls them, after every module has loaded), never at a module's top level
except `tenancy` and the seam objects built from it. Say so in a comment at
the top of `company-setup.ts`; the emitted unit tests import each glue module
first and alone, which fails loudly if that rule is broken.

### 11.6 Single-business mode

- Scheduling and the estimator: today's files, moved into `-single` overlays
  (11.2), unchanged in behaviour. They compile against the new package
  versions without passing any new option.
- Invoicing and comms move onto the package handlers and widgets (11.9).
- No companies-only module is emitted (`company-routes`, `company-links`,
  `company-setup`, `PublicCompanyGate`, the `-companies` overlays).

### 11.7 Catalogs, roles and the seed

- **`src/permissions/roles.ts`** (new, both modes):
  `export const TENANT_ROLES = defineTenantRoles([...])` — `[SCHEDULING_CREW_ROLE]`
  in a companies project with scheduling, `[]` otherwise (a generated array).
  `src/server/tenancy.ts` passes it as `roles` (companies) and
  `src/permissions/seed.ts` seeds `TENANT_ROLES.templates` (both).
- **`PACKAGE_PERMISSION_FRAGMENTS`** gains four TENANT rows, each
  `installedBy: companies && feature`:
  `schedulingPermissions` (scheduling), `estimatorPermissions` (estimator),
  `invoicingPermissions` (invoicing), `commsPermissions` (comms). Their `why`
  says: each company runs its own schedule, price book, ledger and messages,
  so the keys belong to the company's roles; the defaults name owner, admin,
  member, viewer and (scheduling) crew.
- **Staff keys stay single-mode only.** `staff.schedule.*` and
  `staff.estimates.*` are emitted only for single; new single-mode keys:

  | Key | Label | defaultFor |
  | --- | --- | --- |
  | `staff.invoices.view` | "See invoices" | admin, cs_lead |
  | `staff.invoices.manage` | "Raise and send invoices, record and reverse payments" | admin |
  | `staff.comms.view` | "See messages" | admin, cs_lead |
  | `staff.comms.manage` | "Edit messages and send what's due" | admin |

  with `INVOICING_STAFF_KEYS` (`invoices.view` → `staff.invoices.view`; the
  other three → `staff.invoices.manage`) and `COMMS_STAFF_KEYS` in the single
  glue, applied by a generated `authorizeStaffFor(map)` like
  `authorizeSchedulingStaff`. The deploy seed grants them (T1 12.6).
- A generator test asserts every key in every installed package's route table
  (`*_ADMIN_ROUTES[].permission`) is declared in the catalog its mode uses
  (companies: the tenant catalog; single: through the staff map).

### 11.8 Who opens a crew's route (companies)

The scheduling settings' people picker lists `listMemberPeople(tenantId)`:
the company's members, never the site's users. Picking someone changes no
role: an owner invites a crew member from the Team page with the Crew role,
then picks them for a crew. `inviteHref="/settings/team"` makes the picker say
so. (Single mode keeps its crew STAFF role and `onCrewMemberChange`.)

### 11.9 Invoicing and comms in both modes (D3)

| Mode | File | Content |
| --- | --- | --- |
| single | `app/admin/invoices/page.tsx` (`invoicing-admin`) | `<InvoicesLedger baseUrl="/api/admin/invoices" invoiceHref="/admin/invoices/{id}">` |
| single | `app/admin/invoices/[id]/page.tsx` (`invoicing-admin`, new) | `<InvoiceEditor baseUrl="/api/admin/invoices" invoiceId backHref="/admin/invoices">` |
| single | `app/(site)/invoice/[token]/page.tsx` (`invoicing-single`) | `<InvoiceView baseUrl="/api/invoices" token preview>`; noindex, no-referrer |
| single | `app/api/admin/invoices/[...path]/route.ts`, `app/api/invoices/[...path]/route.ts` (`invoicing-single`) | over `buildInvoicingAdminHandlers()` / `buildInvoicingPublicHandlers()` (fixed business; staff authorize) |
| single | `app/admin/comms/page.tsx` (`comms-admin`) | `<MessagesConsole baseUrl="/api/admin/comms" canManage>` |
| single | `app/api/admin/comms/[...path]/route.ts` (`comms-single`) | over `buildCommsAdminHandlers()` |
| both | `src/server/routers/invoicing.ts`, `src/server/routers/comms.ts`, their `_app` entries and `ROUTER_SCOPES` rows | deleted |

Single-mode business for invoices (`src/server/invoicing.ts`, single variant):
`{ name: SITE_NAME, timeZone: env.SCHEDULING_TIME_ZONE ?? env.ESTIMATOR_TIME_ZONE ?? "America/Denver"` (whichever variables the project has; generated), `contactEmail: env.EMAIL_REPLY_TO ?? null, contactPhone: null, logoUrl: null, brandColor: null, paymentInstructions: null, dueDays: 14, footer: null }`,
with a why-comment: a single-business site has no company settings page;
`SITE_NAME` is what its header already says. Listed as not included: editable
invoice details in single mode.

### 11.10 The settings registry and the checklist (companies)

- **`src/server/tenant-settings.ts`:**
  `defineTenantSettings([companySettings, ...(invoicing ? [defineSettingsFragment(invoicingSettingsFragment)] : [])])`
  — a generated array. The company settings page then shows an "Invoices"
  section with `id="invoicing"`.
- **`src/server/setup-checklist.ts`:**

  ```ts
  defineSetupChecklist([
    ...tenancyChecklistItems({ companySettings: "/settings/company", team: "/settings/team" }),
    ...schedulingChecklistItems({ booking: "/app/schedule/settings#booking", crews: "/app/schedule/settings#crews" }),   // with scheduling
    ...estimatorChecklistItems({ priceBook: "/app/price-book", settings: "/app/estimates/settings", embed: "/app/estimates/settings#embed" }),   // with the estimator
    ...invoicingChecklistItems({ details: "/settings/company#invoicing" }),   // with invoicing
  ])
  ```
  (generated; each line present only with its feature). Order by the items'
  own `order`: details 10, team 20, branding 30, booking 40, crews 50, prices
  60, estimate settings 70, invoice details 80, website embed 90.

### 11.11 The header and the company links

- **`src/nav.ts`:** `SiteLink` gains `permission?: string` (a TENANT key, for
  the active company). Companies `APP_LINKS`, each line present only with its
  feature:

  | Label | href | permission |
  | --- | --- | --- |
  | Dashboard | `/dashboard` | — |
  | Schedule | `/app/schedule` | `schedule.view` |
  | Today's route | `/app/schedule/today` | `schedule.route` |
  | Estimates | `/app/estimates` | `estimator.view` |
  | Invoices | `/app/invoices` | `invoices.view` |
  | Messages | `/app/messages` | `comms.view` |
  | Team | `/settings/team` | `members.view` |
  | Settings | `/settings/company` | `tenant.view` |
  | Admin | `/admin` | audience `staff` |

  Price book and estimate settings are reached from the Estimates pages (a
  "Price book · Settings" link row in the page headers), schedule settings from
  the Schedule page.
- **`template/src/components/AuthHeader.tsx`:** `signedInViewer` resolves the
  session ONCE (`resolveSession`) and, for a `ready` session, the active
  company's permission keys (`loadTenantPermissions`). It hands the session to
  `<CompanySwitcherSlot session>` (new optional prop; the slot resolves it
  itself when absent) and filters `APP_LINKS` by `audience` AND
  `permission ∈ can`. The comment says: a runtime permission filter over a
  generated list; a crew member's header shows Dashboard and Today's route.
  All of it inside the existing try/catch.
- **The dashboard's cards** use the same filtered list.

### 11.12 Crons (companies variants; single mode keeps today's routes)

Each keeps today's secret check (`CRON_SECRET`, Bearer or `x-cron-secret`,
401 while unset) and `maxDuration = 60`, and answers JSON with the run report.

- **`/api/cron/scheduling`:** `runForEachCompany(tenancy, async (id) => {
  await syncSchedulingCompany(id); return (await expirePendingRequests(db, id,
  { onEvent: onSchedulingEvent })).expired; }, { timeBudgetMs: 45_000,
  onError: log })`.
- **`/api/cron/estimator`:** `runForEachCompany(…, (id) => expireQuotes(db, id,
  { onEvent: onEstimatorEvent, timeBudgetMs: 5_000 }), { timeBudgetMs: 35_000 })`,
  then ONE `purgeOrphanPhotos(db, estimatorPhotoStore, { timeBudgetMs: 15_000 })`
  (it is global already).
- **`/api/cron/comms`** (emitted in BOTH modes now, so its tenant list can
  differ): companies → `runDueMessages(db, commsSenders, { tenantIds: await
  tenancy.activeCompanyIds(), timeBudgetMs: 45_000, beforeSend:
  commsBeforeSend })`, `afterCommsRun()` in a `finally`; single → today's call.

The comments say: suspended companies aren't in the list (D10); one company's
failure is in `failed` and the rest ran; `deferred` companies go first next
hour.

### 11.13 Everything else the generator writes

- **The platform's own public face, companies mode:** `renderSiteNav`'s
  SITE_LINKS "Book a visit" and "Get an estimate", `renderSitemap`'s
  `/book-visit` and `/estimate`, `renderLlmsTxt`'s two lines, and
  `renderRobots`' `/quote/` and `/visit/` disallows are SINGLE-MODE ONLY: a
  companies project has no such pages at its root (the platform takes no
  bookings; each company does, under `/t/`). `renderRobots` adds `/app/`;
  `/t/` stays disallowed (D17); no `/t/` page is in the sitemap. Single mode
  adds `/invoice/` to its disallows (it was missing).
- **`renderAdminNav`:** in companies mode the admin shell has no Schedule,
  Estimates, Price book, Invoices or Messages entries (the platform has no
  schedule of its own); single mode unchanged (with Invoices and Messages on
  the new staff keys).
- **`vercel.json`:** the three cron entries, unchanged.
- **Env:** nothing new. `CRON_SECRET`'s feature row says crons serve every
  company.
- **`capabilities.ts`** (each with a real `provenBy`):
  - `companies.feature-area` (companies + any feature): `app/(site)/app/schedule/page.tsx`
    contains `<ScheduleCalendar` (with scheduling), `…/estimates/page.tsx`
    contains `<EstimatesQueue`, `…/invoices/page.tsx` contains
    `<InvoicesLedger`, `…/messages/page.tsx` contains `<MessagesConsole`;
  - `companies.public-pages`: `t/[slug]/book-visit/page.tsx` contains
    `<VisitPicker`, `t/[slug]/estimate/page.tsx` contains `<EstimateTool`,
    `t/[slug]/invoice/[token]/page.tsx` contains `<InvoiceView`;
  - `companies.feature-isolation-proof`: the emitted tests of section 12;
  - `companies.crons`: each cron route contains `runForEachCompany` or
    `tenantIds`;
  - `invoicing.ledger` / `comms.console` (both modes): the widget pages.
- **README (emitted) "Companies" section:** what each company gets (its area,
  its public pages, its emails, its roles incl. Crew), the checklist, the
  crons; "Not included" from 15.2 verbatim. **DEPLOYMENT.md:** the comms cron
  serves every company; email goes out as each company's name on
  `EMAIL_FROM`'s address (so verify that domain at Resend once).
- **`add.ts`:** `add scheduling|estimator|invoicing|comms` in a companies
  project applies the `-companies` overlays and re-emits the companies glue,
  catalog, roles, registry and checklist.
- **SCAFFOLD.md:** unchanged in shape.

### 11.14 Generator tests (`packages/create-app/src/__tests__/tenancy-2a.test.ts`)

For `--tenant-noun Company` with every feature, and for `none` with every
feature, and for Company with each feature alone:

- **No fixed tenant in a companies project (D12):** no emitted file contains
  `"primary"`, `SCHEDULING_TENANT`, `ESTIMATOR_TENANT`, `INVOICING_TENANT`,
  `COMMS_TENANT` or `BOOTSTRAP_ADMIN_EMAIL` inside any feature glue
  (`scheduling*`, `estimator*`, `invoicing*`, `comms*`).
- **Rule 1:** the existing no-feature-conditional check covers every new file;
  plus no emitted file contains `tenantNoun`, `mode ===`, `includeScheduling`.
- **Overlays:** `-companies` only in companies, `-single`/`-admin` only in
  single; the collision check passes for every configuration in
  `configurations.ts`.
- **Routes ↔ pages:** every `/app/…` page's `baseUrl` names a route directory
  that exists (`app/api/app/[tenantId]/<feature>`); every public page's
  `baseUrl` names `app/api/t/[slug]/<feature>`.
- **Catalog:** every route-table permission of every installed feature is in
  the right catalog (11.7); `crew` is in `TENANT_ROLES` exactly when scheduling
  is installed in companies mode.
- **Retired:** no `routers/invoicing.ts`, `routers/comms.ts`, no
  `api.invoicing` / `api.comms` usage, no `ROUTER_SCOPES` row for them.
- **Checklist and registry:** the rendered lists match 11.10 per feature set.
- **Nav:** the companies `APP_LINKS` match 11.11 per feature set; every
  `permission` is a declared tenant key.
- **Versions and peers:** `versions.test.ts` and `peer-dependencies.test.ts`
  pass with the new pins (widget peers on `^0.5.0`/`^0.3.0` satisfied).

---

## 12. The emitted proofs (companies mode; the unit project; PGlite)

All three run on every `pnpm test` with nothing configured (T1 D20), mock
`@/db` with `createAppPglite()` exactly as `tenant-isolation.test.ts` does, and
build A and B through `tenancy` the same way (owners Ada and Ben; companies
"Alpha Lawn Care" and "Bravo Roofing"; A2 a member of A). Each is generated per
installed feature: a feature not installed contributes no suite, no rows and
no imports.

### 12.1 `src/server/__tests__/feature-isolation.test.ts`

**Setup (`beforeAll`):**
1. Seed, people, companies, A2, B's stray owner role in A (as
   `tenant-isolation.test.ts`, so every refusal is the gate's).
2. `ensureCompanySetup` for both companies.
3. Plant A's rows of every entity the installed features' route tables name,
   through the PACKAGE functions (never raw SQL except where a package has no
   writer: an estimator photo row), and record them:
   `fx.aRows: Record<Entity, string>` (ids; for tokens, the plaintext token;
   for `template-key`, a key only A has: A gets a custom template
   `alpha_only_note` inserted with comms' `upsertTemplate`). Every string that
   identifies A's rows (ids, tokens, customer names and emails used) is pushed
   onto `fx.aStrings`, beside T1's.
   The planting lives in the emitted helper `src/test/company-rows.ts`
   (`plantCompanyRows(db, tenantId, label): Promise<{ rows; strings }>`),
   generated per feature, so B gets the same kinds of rows too (B's lists are
   then non-empty, and "nothing of A" is a real check, not an empty array).
4. Snapshot A's feature rows: every installed feature table, `where tenant_id
   = A` (and child tables by A's parent ids: estimate items, invoice items and
   payments, availability), ordered, as JSON.

**The suites**, one `describe` per installed feature, each over that
package's route tables:

```ts
const SUITES = [   // GENERATED
  { feature: "scheduling", admin: buildSchedulingAdminHandlers, adminRoutes: SCHEDULING_ADMIN_ROUTES, adminBase: (id: string) => `/api/app/${id}/schedule/`,
    public: buildSchedulingPublicHandlers, publicRoutes: SCHEDULING_PUBLIC_ROUTES, publicBase: (slug: string) => `/api/t/${slug}/schedule/` },
  // estimator (admin, public), invoicing (admin, public), comms (admin only)
];
```

For every row of every admin table, as B
(`build…AdminHandlers({ principal: async () => ({ userId: B.id }) })`):
1. **A's company in the path:** the request at `adminBase(A.id) + path` with
   every placeholder filled from `fx.aRows` → `403`, `error.code` `forbidden`,
   and the body mentions nothing of A (`mentionsA` over `fx.aStrings`).
2. **B's company, A's rows:** at `adminBase(B.id) + path`, placeholders from
   `fx.aRows`:
   - a placeholder in the PATH → `404 not_found`;
   - otherwise → status below 500 and nothing of A in the body.

For every row of every public table, anonymous, at `publicBase(B.slug) +
path` with A's rows and tokens: the same two expectations as step 2.

With the estimator (added at integration): every row of
`ESTIMATOR_PUBLIC_ROUTES` again through `buildEstimatorEmbedHandlers()` at
`/api/estimator/`, with B's plaintext website key in `ESTIMATOR_KEY_HEADER`
(`company-rows.ts` keeps each company's as `rows["embed-key"]`): the same two
expectations. The embed is the one public entry that names its company by a
key rather than a path, so "every public route" includes it. Its kinds count
in the coverage check (`embed:estimator:{kind}`).

Then:
3. **A unchanged:** the snapshot after equals the snapshot before.
4. **Coverage, by name:** every placeholder in every installed table has an
   entry in `fx.aRows` ("Plant a {entity} row for company A in
   src/test/company-rows.ts: the {kind} route reads one"), and every route
   kind was exercised.
5. **The checks bite (negative control, in the same file):** the suite's
   per-route check is one function (`expectIsolated(res, route)`). One extra
   case runs it on a stub handler that answers every request `200` with A's
   planted row (the leak 2a exists to prevent), and asserts the check REJECTS
   it, for a path-placeholder route and for a reference-only route. A proof
   that can't fail proves nothing (T1 13.8's rule). The package-level controls
   (13.x two-tenant sweeps) and the browser's `unscoped-invoice-token` control
   (14) prove the packages' own scoping bites.

Requests carry `sec-fetch-site: same-origin` and `content-type:
application/json` (POSTs), and no `x-forwarded-for` (so the rate limiters
don't count, as in scheduling's own wrapper).

### 12.2 `src/server/__tests__/company-crons.test.ts`

- Three companies: A active with an overdue pending visit request (with
  scheduling) and an expired sent quote (with the estimator) and a due comms
  row; B active, the same; C SUSPENDED, the same.
- The scheduling and estimator crons' work functions, run through
  `runForEachCompany` exactly as the route does (the route's handler is
  imported and called with the secret; `CRON_SECRET` set through `vi.stubEnv`
  before import): A's and B's requests expire, C's don't; the report lists A
  and B in `ran`.
- **One failure doesn't stop the others:** the cron's work is run again with
  `syncSchedulingCompany` (or `expireQuotes`) mocked to throw for A only
  (`vi.spyOn` on the glue module): B still ran, A is in `failed` with a
  message, the response is 200.
- The comms cron: A's and B's due rows sent (skipped, with no email key: the
  log row exists), C's still `pending`.

### 12.3 `src/server/__tests__/company-email.test.ts` (with comms and email)

- `buildCommsSenders(capture)` with a transport that records each outbound
  message.
- `sendNow` a template for A and for B. A's From is `"Alpha Lawn Care"
  <EMAIL_FROM's address>` and its Reply-To is A's contact email (set first
  through `tenancy.updateSettings`); B's are B's. Neither carries the other's
  name or address; neither carries `EMAIL_REPLY_TO`.
- With no contact email, A's Reply-To is A's owner's address.
- The delivery log rows carry `from_name` and `reply_to` as sent.
- With scheduling: a `visit.requested` event for A sends the office notice to
  A's inbox, never to `BOOTSTRAP_ADMIN_EMAIL` (set through `vi.stubEnv`).

### 12.4 Changes to the T1 proofs

- `procedure-scopes.test.ts`: `ROUTER_SCOPES` loses `invoicing`,
  `invoicing.byToken`, `invoicing.markViewed` and `comms`.
- `tenant-isolation.test.ts`: unchanged (no new tenant procedure).
- `scripts/verify-generated.mjs`: unchanged in shape; it already runs
  `vitest run --project=unit`, which now includes the three files above.

---

## 13. Tests

PGlite for every handler and service test (D20 of T1; scheduling's
`src/__tests__/pglite.ts` is the helper to copy into comms and invoicing). The
race rule of T1 13 applies: serial interleavings in both orders, and lock
statements asserted from the query log.

### 13.1 tenancy and tenancy-widget

`packages/tenancy/src/__tests__/tenancy-2a.test.ts`:
- **Roles:** `defineTenantRoles` refuses each bad spec (key, core key,
  duplicate, rank 0/30/10/20/tie, name, description); `canManage` and
  `assignable` over a set with crew; a service with crew: an owner invites as
  Crew, the invitee accepts and holds crew; an admin changes a member to crew
  and back; a crew member can't invite or change anyone (`forbidden`); an
  unknown key → `400 invalid`; `owner` → `owner_must_transfer`;
  `createCompany` on an empty catalog seeds crew too (D10). Without `roles`,
  Tenancy 1's suite is unchanged.
- **Public lookup:** active, suspended (returned with status), retired address
  (both statuses), personal → null, deleted → null; `resolveCompanyBySlug`
  still hides suspended.
- **Profile:** every field; `replyTo` and `inbox` with a contact, without one
  (the owner's address), with a deleted owner (null / []); invoicing settings
  appear under `settings`; one query (query log).
- **`listMemberPeople`:** only active members of that company.
- **`activeCompanyIds` / `runForEachCompany`:** suspended and deleted excluded;
  a throw for one company is in `failed` and the next ran; concurrency is
  respected (a counter); the rotation by hour; the time budget defers the rest.
- **Seams:** `createCompanyRouteSeams`: signed out 401, stranger 403 "not part
  of", suspended 403 "suspended", member without the key `false`, with the key
  `{ userId }`, two calls in one request = one resolution (query log), a
  malformed path id → `resolveTenant` null with no query.
  `createPublicCompanySeams`: unknown → null; suspended → id, then `admit`
  closed with the name and contact; retired address → id; one query for both
  calls; an embed-key tenant id → its own lookup.
- **Events:** the three new events fire after commit with the right `changed`.

tenancy-widget: 5.4, plus the rewritten release test (5.6).

### 13.2 scheduling and scheduling-widget

`packages/scheduling/src/__tests__/companies.test.ts` (two tenants, A and B,
on one PGlite):
- **Overlay:** with a `company` seam the config route's name, contact and zone
  are the company's; `settings-get` reports `managedByCompany`; `settings-update`
  drops the managed keys (a body of only them changes nothing).
- **Convergence (D5):** A has confirmed and pending visits and a queued
  reminder; the company's zone changes from Denver to Chicago; the next
  request (public or admin) converges: every visit keeps its wall clock, its
  instants move by the offset, `sequence + 1`, `visit.rescheduled` with
  `notify: false` reaches the comms listener, the old reminder is withdrawn and
  a new one queued at the new instant; a second request writes nothing
  (query log); no stored row → zone overlaid, no insert (and online booking
  stays as it was); the listener's re-entrance is a no-op.
- **Admission:** closed → `409 booking_closed` with the message on every
  public route (token routes with `no-referrer`), before any scheduling query.
- **Async links and inbox:** `manageUrl`/`bookUrl`/`adminUrl` as async
  functions land in the emails; a throwing link function folds its line and
  is reported; `staffEmails` as a function is used when no
  `staffNotifyEmails` are saved, per tenant.
- **Route tables:** every row routes to its kind (a handler with a spying
  `authorize`); `SCHEDULING_ADMIN_ROUTE_PERMISSIONS` agrees with the table;
  every example reaches the lookup: as an authorised member of an EMPTY tenant,
  with placeholders filled by random UUIDs/tokens, each path-placeholder row
  answers 404 and every other row answers below 500.
- **Two tenants, every route:** with A's visits, crews, time off and tokens, B
  (authorised for B only) gets 404 or nothing of A through every admin and
  public route (the package-level version of 12.1).
- **Crew:** `SCHEDULING_CREW_ROLE` passes `defineTenantRoles`'s rules (a test
  in tenancy imports the shape; here, a structural check of the constants);
  `schedule.route` defaults include crew.
- **Checklist items:** not done → done after the matching writes; tenant-scoped.

scheduling-widget: `accentColor` tokens pass AA (the derived ink against the
page, the on-accent text against the accent); `booking_closed` renders the
server's message in `<VisitPicker>` and `<ManageVisit>`; `<SchedulingSettings>`
with `managedByCompany` renders the four fields read-only with the link and
never sends them; `inviteHref` changes the hint; the deep links focus
`#booking`, `#crews`, `#hours`; the wire parity test passes.

### 13.3 estimator and estimator-widget

`packages/estimator/src/__tests__/companies.test.ts`:
- Overlay (name, contact, zone, colour, logo) on config, quotes and settings;
  `estimatorReady` with a company: closed until settings are saved once, then
  open.
- Admission on BOTH paths: closed through a web address and through an embed
  key (with CORS), `estimates_closed` + message, before the route, the rate
  limit and any estimator query.
- The AI ceiling: a stored budget above it is spent only up to the ceiling
  (`runPhotoTakeoff` refuses past it); a save above it → `400 invalid` on
  `aiDailyBudgetCents` with the sentence.
- `settings-update` drops the managed keys.
- Async `quoteUrl`, `bookVisitUrl`, comms links and the per-tenant inbox.
- Route tables (as 13.2) and two tenants through every route (products,
  supplies, attachments, options, values, estimates, lines, photos, keys,
  quote tokens; an embed key of A used against B's web address serves A's own
  config, and that is not a leak: the key is A's).
- Checklist items.

estimator-widget: pattern hrefs (`{id}` filled and encoded) in
`<EstimatesQueue>` and `<EstimateEditor>`; managed fields read-only; the
ceiling hint and `max`; the closed message; the logo; `#embed`; wire parity.

### 13.4 email, comms and comms-widget

- **email:** section 8's tests.
- **comms** (`src/__tests__/identity.test.ts`, `handlers.test.ts` on PGlite):
  identity per tenant reaches the sender and the log columns; a throwing
  identity fails the message (and the queue retries it); an invalid reply-to
  is passed as null; SMS sender name from the identity; `tenantIds` claims
  only those tenants (an empty list claims nothing; the reclaim still runs);
  the identity is asked once per tenant per drain. Handlers: every route with
  each permission and without; A's `alpha_only_note` key → 404 for B;
  `template-save` can't create a key; `run-due` sends only that tenant's rows;
  `status` reports the identity and the late count; the route table rows route
  and reach their lookups; cross-site POSTs refused.
- **comms-widget:** the transport (every route, never throws, 401 → signed
  out, HTML → `bad_response`); the console's grouping and labels; the edit
  form's issues; the confirm on switching off; the run-due sentence lists every
  non-zero count; `canManage={false}` hides the controls; SSR; AA tokens; wire
  parity with `comms/src/wire.ts`.

### 13.5 invoicing and invoicing-widget

- **invoicing** (`src/__tests__/handlers.test.ts`, `companies.test.ts`,
  `comms.test.ts`; PGlite):
  - every staff route, each permission and without; `create` with a calendar
    due date stores the end of that day in the business's zone; without one,
    `dueDays` later; lines in cents; the package's refusals map to 409 with
    their sentences;
  - `get`'s `can` from the extra asks; `item-update`/`item-remove` of a line on
    another tenant's invoice → 404;
  - `send`: draft → sent then emailed; no email → `no-email`; no sender →
    `skipped`; a throwing sender → `failed` with the status kept; paid/void →
    409;
  - `link` is the only route carrying the token;
  - public: A's token under B → 404; a draft → 404; `admit` closed → 409
    `unavailable`; `viewed` marks sent → viewed once and never from the GET;
  - `getInvoiceByToken`/`markInvoiceViewed` with and without `tenantId`
    (without: 0.2's behaviour, kept);
  - `invoicingSettingsFragment` passes tenancy's `defineSettingsFragment` (a
    devDependency-free structural test: `schema.parse({})` gives the defaults,
    every field key is in the shape); `readInvoicingDetails` on junk → defaults;
  - the email: variables, the folding of empty lines, the token scrubbed from
    the log right after sending, the sweep, the idempotency key per resend;
  - route tables and two tenants through every route.
- **invoicing-widget:** the transports; the ledger (create with dollars and a
  percent → cents and basis points, a non-number refused before sending,
  filters in words, load more); the editor (lines, status moves in words, the
  void confirm, send outcomes, copy link, payments, reversal with a required
  reason, overpaid); the public view (fires `viewed` once, never with
  `preview`, the not-found and unavailable sentences, the business block); SSR;
  AA; wire parity with `invoicing/src/wire.ts`.

### 13.6 create-app

- 11.14's generator tests.
- `node scripts/verify-generated.mjs` for:
  - `--tenant-noun Company --admin full --estimator --scheduling --invoicing --comms --email --storage --ai`;
  - `--tenant-noun none --admin minimal --estimator --scheduling --invoicing --comms --email`.

  Report each generated project's unit-test count, including the three files of
  section 12 (companies) and T1's two. If the full run can't finish (registry
  or network), generate both and run `tsc --noEmit` plus
  `vitest run --project=unit` in each against the workspace tarballs, and say
  which.

---

## 14. The browser scenario (create-app builder)

**Fixture: `e2e/fixtures/tenancy-2a-scenario-server.ts`**, on the
`tenancy-scenario-server.ts` pattern:

- **A real backend** from the BUILT packages (`dist`): PGlite from
  `@adminigloo/testing/pglite` with the auth, tenancy, permissions,
  observability, scheduling, estimator, invoicing, comms and email tables; a
  companies-mode tenancy service with `TENANT_ROLES` (crew), the settings
  registry (company + invoicing) and the full checklist; the four features'
  handlers built the way 11.5 builds them (company seams, company links on the
  fixture's origin, per-company setup on `company.created`).
- **Email:** comms senders over a capturing transport; `GET /__test/outbox`
  returns `{ to, fromName, fromAddress, replyTo, subject, text }[]`.
- **Sign-in:** the T1 fake (`/__test/sign-in?email&name&via`); staff
  bootstrap `ava@igloo.test`.
- **Crons:** `POST /__test/cron/{scheduling|estimator|comms}` run the same
  functions the generated cron routes run; `POST /__test/clock?at=ISO` moves the
  fixture's clock (every factory takes `now`).
- **Pages** (HTML shells mounting the bundled widgets with server-computed
  props, as the emitted pages do): `/onboarding`, `/dashboard`,
  `/settings/company`, `/settings/team`, `/invite/:token`, every `/app/…` page
  of 11.3, every `/t/:slug/…` page of 11.3 (with the `PublicCompanyGate`
  logic), `/admin/companies[/:id]`. The header (switcher + permission-filtered
  links) on every company page.
- `e2e/bundle.mjs` gains scheduling-widget, estimator-widget,
  invoicing-widget and comms-widget entries (some are already there).

**Spec: `e2e/tests/tenancy-2a-scenario.spec.ts`** (one `test.describe.serial`; an
axe check on every screen it lands on):

1. **Two companies set up.** Gail signs up and names "Green Acres"
   (web address `green-acres`); Sam signs up and names "Summit Lawn". Each, in
   `/settings/company`: time zone (Denver / Chicago), contact email and phone,
   brand colour, payment instructions in the Invoices section. Gail loads the
   sample price book and saves estimate settings (tax 7.25%); Sam adds one
   product by hand and saves his. Each adds a crew with hours and opens online
   booking. Each dashboard's checklist reaches "all set" (the embed item marked
   "Not needed"). The estimate and schedule settings show the business name,
   zone and contact read-only with the link.
2. **Public pages.** `/t/green-acres/estimate` shows Green Acres' name and
   colour; `/t/summit-lawn/book-visit` offers times labelled in Central time,
   `/t/green-acres/book-visit` in Mountain time.
3. **A customer of Green Acres, end to end** (a fresh, signed-out context):
   gets an estimate and sends it; books a visit tied to it; Gail accepts the
   visit, sends the quote; the customer accepts it on
   `/t/green-acres/quote/…`; Gail turns it into an invoice and sends it; the
   customer opens `/t/green-acres/invoice/…` and sees Green Acres' payment
   instructions. THE OUTBOX: every message to the customer has `fromName`
   "Green Acres", `replyTo` Gail's contact email, and links only under
   `/t/green-acres/`; every office notice went to Green Acres' address. Sam's
   estimates, schedule, invoices and Messages show none of it, and Sam's
   browser fetching `/api/app/{Green Acres id}/estimator/v1/admin/estimates`
   gets 403.
4. **Roles.** Gail invites Cam as Crew and Mia as Member. Cam (after
   accepting) sees only Dashboard and Today's route in the header, his route
   lists the visit assigned to his crew, and `/app/estimates` shows "You don't
   have access to this page". Mia can send a quote but the price book's edit
   controls aren't offered and `/app/estimates/settings` is read-only.
5. **Crons and suspension.** Ava suspends Summit Lawn in `/admin/companies`.
   `/t/summit-lawn/book-visit` says "Summit Lawn isn't taking requests online
   right now". With both companies holding overdue requests, the clock moved
   and the scheduling cron run: Green Acres' request is expired (and its
   customer emailed), Summit's is untouched. With the fixture's
   `failCompany=<Green Acres id>` flag the next run reports Green Acres in
   `failed` and still processes a third company.
6. **Phone width** (390 px): `/app/schedule/today`, `/t/green-acres/book-visit`,
   `/t/green-acres/invoice/…` and `/app/invoices`: nothing scrolls sideways,
   targets ≥ 44 px.

**Negative controls** (in the FIXTURE, never in the packages; run with
`test.fail()`):
- `?break=shared-identity`: the comms senders get no `identity`. Step 3's
  outbox assertion must FAIL.
- `?break=unscoped-invoice-token`: the public invoicing handler reads tokens
  without the tenant. A spec step that opens a Summit invoice token under
  `/t/green-acres/invoice/…` and expects "isn't available" must FAIL.

Document both in `e2e/README.md`, with what the scenario does NOT prove
(single connection, no real Resend, no real Clerk).

---

## 15. Docs, changesets, and what's not included

### 15.1 READMEs

Each touched package's README gains a "Companies (Tenancy 2a)" section:
the new options with a code sample wiring them from `@adminigloo/tenancy`, and
the same sample for a foreign host (your own tenant lookup, your own
`authorize`). New READMEs for `invoicing-widget` and `comms-widget` on the
scheduling-widget README's structure ("What each install gets you", install,
quick start, props, theme, the transport sketch, "Not included"). Upgrade SQL
where there is any (comms 9.2). The tenancy README documents the role set, the
seams, the profile and `runForEachCompany`; its "Foreign hosts" section stays.

### 15.2 Not included (Tenancy 2a), listed in each README that touches it and in the emitted README

- **Per-company boards and widgets for feedback, notifications, files, the
  assistant, analytics, SEO/AEO and book-a-call (booking)** — Tenancy 2b.
- **Payments to companies** (Stripe Connect: a customer paying a company's
  invoice by card). Invoices are paid however the payment instructions say;
  staff record the payment.
- **Plans, limits and billing enforcement** per company.
- **Custom domains and subdomains.** Public pages live at `/t/{web-address}`.
- **Impersonation** ("view as this company") from the operator console, and
  platform-wide feature reports (all companies' visits, estimates, invoices)
  in `/admin`.
- **Search indexing of company pages**, and per-company SEO.
- **Logo and colour inside emails.** Emails carry the company's name and
  reply-to; their bodies are plain text.
- **Emailing customers about a time-zone correction** made in company settings.
  Visits keep their clock times and reminders are re-queued silently.
- **A scheduling embed** (a script for the company's own website). The
  booking page's address is shown to copy; the estimator has its keyed embed.
- **Editable invoice details and per-feature identity in single-business
  mode.** A single business's invoices are signed with the site's name.
- **Per-company custom roles and per-person permission changes.** Crew is a
  fixed role scheduling adds.
- **Moving a pre-2a companies project's feature rows** (written under the
  fixed `"primary"` business) into a company. The emitted README gives the SQL
  for one company; nothing does it automatically.

### 15.3 Changeset files (write them; don't version)

| File | Package: bump | Says |
| --- | --- | --- |
| `.changeset/tenancy-2a-tenancy.md` | `@adminigloo/tenancy: minor` | Role sets (Crew), public lookup with status, the company profile, member people, every-company runs, the route seams, three events, the widened `RoleKey` |
| `.changeset/tenancy-2a-tenancy-widget.md` | `@adminigloo/tenancy-widget: minor` | Any role the server offers; `CompanyBrandBar`, `CompanyUnavailable` |
| `.changeset/tenancy-2a-scheduling.md` | `@adminigloo/scheduling: minor` | `company`, `admit`, `resolveSchedulingSettings` (zone convergence), async links and inbox, Crew, route tables, checklist items, comms peer `^0.3.0` |
| `.changeset/tenancy-2a-scheduling-widget.md` | `@adminigloo/scheduling-widget: minor` | `accentColor`, the closed message, company-owned fields read-only, `inviteHref`, deep links |
| `.changeset/tenancy-2a-estimator.md` | `@adminigloo/estimator: minor` | `company`, `admit` on both paths, the AI ceiling, async links and inbox, route tables, checklist items, comms peer |
| `.changeset/tenancy-2a-estimator-widget.md` | `@adminigloo/estimator-widget: minor` | Pattern hrefs, read-only company fields, the ceiling, the closed message, the logo, `#embed` |
| `.changeset/tenancy-2a-email.md` | `@adminigloo/email: minor` | Per-message `fromName` and `replyTo`, `sanitizeDisplayName` |
| `.changeset/tenancy-2a-comms.md` | `@adminigloo/comms: minor` | `identity`, outbound tenant/name/reply-to, the two log columns (upgrade SQL), `tenantIds`, the staff handlers, permissions, route table |
| `.changeset/tenancy-2a-comms-widget.md` | `@adminigloo/comms-widget: minor` | First release: `MessagesConsole` |
| `.changeset/tenancy-2a-invoicing.md` | `@adminigloo/invoicing: minor` | Handlers, wire, permissions, the settings fragment, token reads scoped to a company, `./comms` (the invoice email), route tables, checklist item |
| `.changeset/tenancy-2a-invoicing-widget.md` | `@adminigloo/invoicing-widget: minor` | First release: `InvoicesLedger`, `InvoiceEditor`, `InvoiceView` |
| `.changeset/tenancy-2a-create-app.md` | `@adminigloo/create-app: minor` | Section 11 in plain words. Removed: the invoicing and comms tRPC routers and their copied pages. Moved: feature screens of a companies project from `/admin` to `/app`, public pages to `/t/{web-address}` |

Plain words, as the estimator and scheduling changesets are.
`versions.test.ts` reads the frontmatter: get the package names exactly right.

---

## 16. Hand-off

### 16.1 Order

1. **In parallel from the start:** the tenancy, scheduling, estimator,
   messages and invoicing builders. None needs another's code: the seams are
   structural (D4), and each package's tests supply their own fake seams.
   - The messages builder builds `email` then `comms` FIRST and reports
     "comms dist built", because invoicing's `./comms` tests and scheduling's
     and estimator's comms tests run against comms' `dist`. Until then, those
     builders work on everything else.
   - Each builder builds its packages into `dist/` and reports.
2. **The create-app builder** starts when all five have reported `dist/`
   built. It builds against `dist/`.

### 16.2 Every builder reports

- test counts per package against section 0's baselines, and each new test
  file;
- typecheck and build status for every touched package;
- every `// CONTRACT:` call they made, and any example body (3.1) they had to
  change;
- anything they couldn't do, and why. Don't install anything; stop and say so.

### 16.3 Checklists

**Tenancy builder**
- [ ] `pnpm --filter @adminigloo/tenancy --filter @adminigloo/tenancy-widget build typecheck test` green; T1's suites unchanged except where 4.1 changes a list.
- [ ] Wire regions byte-identical (`RoleKey`, `PublicCompanyWire`).
- [ ] The release test rewritten (5.6). README and two changesets.

**Scheduling builder**
- [ ] build, typecheck, test green for both packages; 0.4's suites untouched.
- [ ] `companies.test.ts` (13.2), including convergence re-entrance and the
      two-tenant sweep over every route.
- [ ] Route tables with examples that reach their lookups.
- [ ] Wire parity. README and two changesets.

**Estimator builder**
- [ ] build, typecheck, test green; 0.3's suites untouched.
- [ ] Admission on both paths; the ceiling where the money is spent.
- [ ] Route tables; two-tenant sweep. Wire parity. README and two changesets.

**Messages builder**
- [ ] email, comms, comms-widget: build, typecheck, test green.
- [ ] comms dist reported early (16.1).
- [ ] Upgrade SQL in the comms README. Wire parity. Three changesets.

**Invoicing builder**
- [ ] invoicing, invoicing-widget: build, typecheck, test green; 0.2's
      suites untouched (token reads without a tenant keep 0.2's behaviour).
- [ ] The ledger and the customer page do everything the retired copied pages
      did (list, filters, create, lines, status, payments, reversal, link,
      preview), plus Send.
- [ ] Wire parity. READMEs and two changesets.

**create-app builder**
- [ ] create-app tests green (count them; list each new test).
- [ ] `verify-generated` for both configurations of 13.6, with the emitted
      proofs' counts.
- [ ] The e2e fixture and spec written and run (Chromium is cached), with both
      negative controls failing as they must.
- [ ] No fixed tenant in a companies project (the grep test).
- [ ] README (create-app's "Quick start" mentions the company features),
      emitted README, DEPLOYMENT.md, changeset.

---

## 17. Every file to create or change

**Prepared by the architect (done):** `packages/invoicing-widget/**` and
`packages/comms-widget/**` skeletons; `packages/invoicing/{package.json,
tsup.config.ts, vitest.config.ts, src/comms.ts}`;
`packages/comms/{package.json, vitest.config.ts}`; `pnpm-lock.yaml`; this
document.

**`packages/tenancy`** — create `src/roles.ts`,
`src/server/company-seams.ts` (route and public seams),
`src/server/company-runs.ts` (`activeCompanyIds`, `runForEachCompany`),
`src/server/profile-read.ts` (`companyProfile`, `listMemberPeople`,
`resolvePublicCompany`), `src/__tests__/tenancy-2a.test.ts`; change
`src/index.ts`, `src/server.ts`, `src/wire.ts`, `src/settings.ts`
(the zone help), `src/server/{service.ts, types.ts, db.ts, context.ts, team.ts,
handlers.ts, invitations-lifecycle.ts, provisioning.ts, companies.ts,
profile.ts, settings-service.ts, to-wire.ts}`, `src/__tests__/barrel.test.ts`,
`README.md`.

**`packages/tenancy-widget`** — create `src/CompanyBrandBar.tsx`,
`src/CompanyUnavailable.tsx`, tests; change `src/types.ts`, `src/client.ts`,
`src/index.ts`, `src/TeamManager.tsx`, `src/words.ts`, `src/styles.ts`,
`src/__tests__/release.test.ts`, `src/__tests__/exports.test.ts`,
`package.json` (peer `^0.5.0`), `README.md`.

**`packages/scheduling`** — create `src/company.ts`
(`resolveSchedulingSettings`, the seam types, `SCHEDULING_CREW_ROLE`),
`src/routes.ts` (the two tables), `src/checklist.ts`,
`src/__tests__/companies.test.ts`, `src/__tests__/routes.test.ts`; change
`src/handlers.ts`, `src/admin-handlers.ts`, `src/comms.ts`, `src/settings.ts`
(`toSettingsWire`, the flag), `src/permissions.ts`, `src/wire.ts`,
`src/index.ts`, `package.json` (comms peer), `README.md`.

**`packages/scheduling-widget`** — change `src/types.ts`,
`src/VisitPicker.tsx`, `src/ManageVisit.tsx`, `src/styles.ts`/`src/theme.ts`
(accent tokens), `src/admin/SchedulingSettings.tsx`, `src/index.ts`, tests,
`README.md`.

**`packages/estimator`** — create `src/company.ts`
(`resolveEstimatorSettings`, the seam types), `src/routes.ts`,
`src/checklist.ts`, `src/__tests__/companies.test.ts`,
`src/__tests__/routes.test.ts`; change `src/handlers.ts`,
`src/admin-handlers.ts`, `src/comms.ts`, `src/settings.ts`,
`src/takeoff-run.ts` (the ceiling), `src/quotes.ts` (`logoUrl` on the quote),
`src/wire.ts`, `src/index.ts`, `package.json`, `README.md`.

**`packages/estimator-widget`** — change `src/types.ts`,
`src/EstimateTool.tsx`, `src/QuoteView.tsx`, `src/widget.tsx`,
`src/admin/EstimatesQueue.tsx`, `src/admin/EstimateEditor.tsx`,
`src/admin/EstimatorSettings.tsx`, `src/admin/EmbedKeys.tsx`, tests,
`README.md`.

**`packages/email`** — change `src/send.ts`, `src/sender.ts`
(`sanitizeDisplayName`), `src/index.ts`, tests; create `README.md` (there is
none today) on the scheduling README's structure.

**`packages/comms`** — create `src/handlers.ts`, `src/routes.ts`,
`src/permissions.ts`, `src/wire.ts`, `src/http.ts`,
`src/__tests__/{pglite.ts, identity.test.ts, handlers.test.ts}`; change
`src/index.ts` (identity, outbound fields, `tenantIds`, log columns),
`src/schema.ts`, `src/__tests__/fake-db.ts` (the new columns), `README.md`.

**`packages/comms-widget`** — fill `src/index.ts`, `src/admin/index.ts`;
create `src/types.ts`, `src/client.ts`, `src/http.ts`, `src/theme.ts`,
`src/styles.ts`, `src/admin/MessagesConsole.tsx`, `src/__tests__/*`,
`README.md`. (`CHANGELOG.md` is written by changesets: don't create it.)

**`packages/invoicing`** — create `src/handlers.ts`,
`src/admin-handlers.ts`, `src/routes.ts`, `src/permissions.ts`,
`src/settings.ts` (fragment, details), `src/business.ts`, `src/wire.ts`,
`src/http.ts`, `src/checklist.ts`, fill `src/comms.ts`,
`src/__tests__/{pglite.ts, handlers.test.ts, companies.test.ts, comms.test.ts, routes.test.ts}`,
`README.md` (none today); change `src/index.ts` (scoped token reads, exports).

**`packages/invoicing-widget`** — fill `src/index.ts`, `src/admin/index.ts`;
create `src/types.ts`, `src/client.ts`, `src/http.ts`, `src/theme.ts`,
`src/styles.ts`, `src/money.ts`, `src/InvoiceView.tsx`,
`src/admin/InvoicesLedger.tsx`, `src/admin/InvoiceEditor.tsx`,
`src/__tests__/*`, `README.md`.

**`packages/create-app`** —
- `src/`: `versions.ts`, `answers.ts`, `emit.ts` (catalog fragments and staff
  keys, nav, admin nav, robots, sitemap, comms senders/hooks, scheduling and
  estimator glue variants, invoicing and comms glue, crons, app router,
  `planEmit` wiring), `tenancy-emit.ts` (tenancy variants with roles and
  `onEvent`, tenant settings, checklist, `src/tenancy.ts` constants with
  `PUBLIC_COMPANY_PAGES`, the gate, `PublicCompanyGate`, company routes,
  links, setup), `tenancy-proofs-emit.ts` (ROUTER_SCOPES, the three new
  proofs, `company-rows.ts`), `capabilities.ts`, `readme-emit.ts`, `add.ts`,
  `cli.ts` (help text), a new `src/features-emit.ts` if `emit.ts` would
  otherwise grow past reason (the tenancy-emit precedent);
- `overlays/`: the moves of 11.2; new `scheduling-companies`,
  `estimator-companies`, `invoicing-companies`, `comms-companies`,
  `invoicing-single`, `comms-single`; changed `companies` (dashboard, `/t/[slug]`,
  `/app`, the switch route), `invoicing-admin`, `comms-admin`;
- `template/`: `src/components/AuthHeader.tsx`, `src/permissions/seed.ts`
  (`TENANT_ROLES`). (`src/nav.ts` and `src/components/CompanySwitcherSlot.tsx`
  are emitted: their changes are in `emit.ts` / `tenancy-emit.ts`.)
- `src/__tests__/tenancy-2a.test.ts` (new), and every existing test the moves
  touch (`scheduling-overlay.test.ts`, `estimator-overlay.test.ts`,
  `capabilities.test.ts`, `every-configuration.test.ts`,
  `permission-scopes.test.ts`, `emitted-tests.test.ts`, `versions.test.ts`);
- `README.md`.

**Repo root** — `scripts/verify-generated.mjs` needs no change (it takes the
generator flags after `--`; run it with 13.6's two flag sets and an out-dir
outside the repo), `e2e/fixtures/tenancy-2a-scenario-server.ts`,
`e2e/tests/tenancy-2a-scenario.spec.ts`, `e2e/bundle.mjs`, `e2e/README.md`,
the twelve changeset files of 15.3.

---

## 18. After review (what changed from the sections above)

The 2a review (security, business owner, template buyer) found gaps; these
amend the sections above. Where they disagree, this section wins.

- **D10, the rotation.** `runForEachCompany` starts at `rotationStart(now, n)`,
  a hash of the run's minute, not `floor(now / 1h) mod n`: on the daily cron
  every project starts with, the hourly start never moved when the company
  count divided 24. Deferred companies are logged and reported to
  `/admin/errors`; they are not promised to go first next time.
- **D10, the comms drain.** With `tenantIds`, companies take turns (each
  company's oldest due row, then each one's second, …), the housekeeping is
  scoped to the list too, and the companies cron passes `limit: 1000` and
  reports a run that stops early. DEPLOYMENT.md says a daily run sends a few
  hundred messages at most for the whole platform, and how to run it every 15
  minutes. Each company is held to a sending allowance (`allowance`, 100/h and
  500/day, 20 and 100 in its first week).
- **D7 / 13.3, keys under a web address.** A keyed request under
  `/api/t/{slug}/estimator` counts only that company's key; another company's
  is 404 (13.3's "an embed key of A used against B's web address serves A's
  own config" is reversed).
- **D9, crew.** `crew-day` is today-only for a login without `schedule.view`.
  A member who joins as Crew is put on the company's crew when it has exactly
  one with nobody on it; otherwise the schedule names them.
- **D14.** Beside the per-company ceiling, `ESTIMATOR_AI_SITE_CEILING_CENTS`
  ($5.00) caps every company's photo reading together.
- **Converting a quote** asks the invoice permission too (`invoiceAccess`).
- **11.3, public pages.** They live in `app/(company)/t/[slug]/…`, outside the
  site's chrome, with titles and link previews in the company's name
  (`publicCompanyMetadata`).
- **11.10, the embed item** is "Add an estimate button to your website":
  `<EmbedKeys publicPageUrl>` leads with a button and a page frame any website
  takes; the keyed React snippet is under "For developers". A pasted button
  leaves no key, so the item says to dismiss it once the button is up; a live
  website key still ticks it by itself.
- **D11.** Companies mode no longer seeds comms' starter templates: nothing
  sends them.
- **12.1, the proof.** It plants rows every list route can leak (the calendar's
  window, a pending request, the delivery log, a due queued message, a photo
  reading), fails if any checked table has no row of A, mixes B's rows with
  one of A's (`mixesOf`), and checks a member, a viewer and a crew member are
  refused every route their role doesn't hold by default.
