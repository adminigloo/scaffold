# Tenancy 1 (companies): the contract

Three builders work from this document, mostly in parallel. None of them can see
another's code until the end:

- **Server builder**: `packages/permissions` 0.2.0, `packages/tenancy` 0.4.0,
  `packages/trpc` 0.3.0, `packages/auth` 0.2.0 and `packages/testing` 0.2.0
  (sections 2–7, 9–11 and 13.1–13.4).
- **Widget builder**: the new `packages/tenancy-widget` 0.1.0 (sections 2, 7, 8
  and 13.5).
- **create-app builder**: `packages/create-app` 0.22.0, the template, overlays,
  `scripts/verify-generated.mjs` and the e2e fixture (sections 12 and 13.6–13.8).
  This builder starts once the server builder has published a build of the
  packages into `dist/` (see the hand-off order in section 15).

Section 7 (routes and wire types) belongs to the server and widget builders. If
you change a name or a shape there, the other half breaks and neither builder
will notice, so don't. Section 2 (decisions) binds everyone. Where something here
is ambiguous, pick the reading that best serves the acceptance bar in section 0,
leave a `// CONTRACT:` comment where you made the call, and list it in your
hand-off.

---

## 0. The acceptance bar

The founder's bar, in his words: *"Business owners aren't devs. If a business
owner is told by their dev that it works, they deploy it and sell it to a
customer; they need to trust that it's actually doing what is needed."*

The goal behind this chunk: the founder generates **"Igloo Back Office"**, a
multi-tenant SaaS for small service businesses, from create-app
(`--tenant-noun Company`). He installs every package the way a client would.
Tenancy 1 is done when this scenario runs end to end with no developer filling
gaps. Section 13.4 is this scenario as a package test, and section 13.8 is the
same scenario as a browser test.

1. **Sign-up lands in onboarding.** A business owner signs up and lands straight
   on "What's your company called?". A web address (slug) is suggested from the
   name and can be edited. Reserved words are refused in plain words. The
   company is created with them as its owner, in one transaction. This works
   whichever arrives first, the Clerk webhook or the first page request, and
   survives a refresh or a double submit (one company, never two). Someone who
   signs up through an **invitation** skips onboarding and lands in the
   inviting company.
2. **A setup checklist.** The owner sees a checklist that other packages can add
   items to. Tenancy 1 ships the mechanism plus the company items (business
   details, branding) and the team item (invite your team).
3. **The team page.**
   - Invite by email with a role: Admin, Member or Viewer, mapped onto the
     permission system. Owner is a role too, but you only get it by creating the
     company or by a transfer (decision D5).
   - Pending invitations, each with resend and revoke.
   - The members list.
   - Change a role, under the rank guard. The owner can't be demoted.
   - Remove a member. They lose access on their very next request.
   - A member can leave, unless they're the owner.
   - Transfer ownership, after typing the company name to confirm.
   - An optional seat-limit hook, checked at invite AND at accept (the billing
     chunk wires it later).
4. **Two companies, one switcher.** Someone in two companies uses a switcher in
   the header. The active company is remembered per user. A stale or removed
   membership falls back safely. Every company screen shows only the active
   company's data.
5. **Company settings.**
   - Name, and slug. The public URL `/t/[slug]` is reserved now and used in
     Tenancy 2.
   - Logo (through a storage seam).
   - Brand colour, contrast-checked against white and dark text.
   - Time zone, and contact email, phone and address.
   - A **typed settings registry** that other packages contribute fragments to,
     with get and update gated by a permission.
6. **The operator console** for the platform owner (staff):
   - A companies list with search and pagination. Personal workspaces are hidden
     by default.
   - Company detail: members, created, status, recent activity.
   - Suspend and reactivate. A suspended company's members see a plain "this
     company is suspended, contact support" screen, and slug lookups exclude
     suspended companies.
   - A staff role picker on People.
7. **First run heals itself.**
   - `BOOTSTRAP_ADMIN_EMAIL` becomes platform admin whenever no staff admin
     exists, not only on that person's first sign-in.
   - An `admin:grant <email>` recovery script exists.
   - The permission catalog is seeded on every deploy, after migrations, by the
     deploy workflow running an idempotent seed.
8. **Proven by tests.**
   - A two-company isolation test emitted into every generated project: company B
     gets not-found or empty for every company-A id, on every tenant procedure
     and every tenancy route.
   - A procedure-scope audit test, also emitted.
   - PGlite package tests for every lifecycle function, races included: two
     simultaneous onboardings for one user, accept-invite while removed, and
     transfer while demoted.

### The founder's rules (non-negotiable)

- Forms for customers and owners ask for what people know, in plain words. No
  ids, no "slug", no "tenant". Say "web address" and "company" (whichever noun
  the project uses), and never show an internal id to a business owner.
- No AI anywhere in this chunk. (Rule kept for completeness: any AI never does
  math and spends as little as possible.)
- Never raise legal, privacy or consent topics, in code, comments, copy or docs.

### Hard rules (all builders)

- No commits, pushes or publishes, and no `changeset version` or release.
  Write changeset FILES (section 14). Don't edit any `version` field, except
  that the new `packages/tenancy-widget` is already at `0.0.0` and stays there.
- No dev server on port 3000. No real databases: PGlite only.
- No legal, privacy or consent wording anywhere.
- Match the repo's style: thorough why-comments, decision-record comments where
  a choice was made, zod at every boundary, `tenantId` on every query, instants
  as `timestamptz`, errors with an own `readonly name`.
- create-app generator rules (packages/create-app/README.md):
  - **No runtime conditionals in emitted code.** Rule 1 forbids an `if` asking
    whether a feature was installed. Two variants of one file, chosen by the
    generator, are fine.
  - Overlays are strictly additive.
  - `--tenant-noun none` keeps a single-business mode that still works.
- UI a buyer needs ships as package components with a transport, so fixes flow
  by npm. Emitted pages are thin wrappers.
- Work only in `C:\Users\dalli\scaffold-tenancy` (branch `feat/tenancy-0.4`).
  Don't touch `C:\Users\dalli\scaffold`, `scaffold-sched04`, `scaffold-est03` or
  any `adminIgloo` folder.

### The workspace is ready (done by the architect)

- `pnpm install` has run, with the lockfile updated. **Don't install anything.**
  If something is truly missing, stop and say so in your hand-off.
- `@adminigloo/tenancy`:
  - new entry `./server` (skeleton `src/server.ts`, builds);
  - dependency `@adminigloo/auth` (workspace);
  - peer `zod` (`catalog:peers`) and devDependency `zod`;
  - devDependency `@electric-sql/pglite ^0.5.8`;
  - `vitest.config.ts` with PGlite timeouts;
  - `files` now includes `README.md`. The builder writes the README.
- `@adminigloo/permissions`:
  - new entry `./server` (skeleton);
  - devDependency `@electric-sql/pglite ^0.5.8`;
  - `vitest.config.ts`.
- `@adminigloo/testing`:
  - new entry `./pglite` (skeleton);
  - optional peer `@electric-sql/pglite ^0.5.8`, and peer `drizzle-orm`;
  - both as devDependencies too.
- `packages/tenancy-widget` exists at `0.0.0`. It has:
  - `package.json` with React as its only peer;
  - devDependencies `happy-dom`, `react`, `react-dom`, the React types, and
    `@adminigloo/tenancy` (workspace, used **only** by the parity test in
    13.5);
  - `tsconfig.json`;
  - `tsup.config.ts` with entries `index` and `admin` and the "use client"
    banner;
  - `src/index.ts`, `src/admin/index.ts`, `src/version.ts`
    (`TENANCY_WIRE_VERSION = "v1"`) and a smoke test.
- `permissions`, `tenancy`, `testing` and `tenancy-widget` all build. All
  touched packages typecheck.
- Baselines, all green:

  | Package | Tests |
  | --- | --- |
  | tenancy | 116/116 |
  | permissions | 30/30 |
  | trpc | 83/83 |
  | auth | 19/19 |
  | testing | 148/148 |
  | tenancy-widget | 1/1 |
  | create-app | 1605/1605 |

- If you change a package that another one imports from `dist`, rebuild it:
  `pnpm --filter @adminigloo/<name> build`. Build order:
  `auth → permissions → tenancy → trpc → testing → tenancy-widget → create-app`.

### Prior art (the founder's own code; lift the best)

- **Riddler Go** (`C:\Users\dalli\riddler-go`):
  - `lib/auth/workspace.ts`: pointer, then deterministic memberships, then
    rewriting a stale pointer, then invitations by verified email.
  - `lib/auth/switch-organization.ts`: the membership check is the whole
    security story, and one uniform refusal.
  - `lib/organizations/actions.ts`: owner-only rename with a same-statement row
    lock.
  - `lib/hosts/actions.ts`: `removeHost` (clears the pointer, audits inside the
    transaction) and `changeHostRole` (the owner can't be demoted).
  - `lib/entitlements/check-host-seats.ts`: seats are checked under a lock, at
    invite AND at accept.
  - `domain/branding/schema.ts`: `contrastRatio`, `readableInkFor`, and
    "warn, never block".
  - `domain/organizations/reserved-slugs.ts`.
- **Ask Lou** (`C:\Users\dalli\askLou\SquireSolutions`):
  - `src/app/onboarding/components/OnboardCheck.tsx`: no writes in queries,
    latched one-shot effects, invitation fallback.
  - `src/server/api/routers/adminCompanies.ts`: list (search, filters,
    pagination), getById, and suspend/reactivate with a reason.
  - CompanyForm is accounting-specific. Take only its name field's tone.
- **This repo**:
  - `packages/tenancy`: hashed, race-safe invitations. Keep them, and route new
    paths through them.
  - `packages/permissions`: the two-layer resolver and sealed keys.
  - `packages/trpc`: the rung ladder and `scopeOfProcedure`.
  - `packages/scheduling` `src/admin-handlers.ts` and `src/http.ts`: the
    handler factory, route table, same-site check and error mapping.
  - `packages/scheduling-widget` and `packages/estimator-widget` `./admin`:
    transport, host-following theme, plain wording, focus-trapped dialog,
    "never throw".
  - `packages/analytics/src/__tests__/pglite.ts`: generating DDL from Drizzle,
    including composite PKs, FKs, and partial and expression indexes.

### The audit findings this chunk answers

From `C:\Users\dalli\adminigloo-audit-2026-10\audit-verified.json`:

| Finding | Where it's answered |
| --- | --- |
| PC-01, CA-V1 (webhook-first sign-ups get nothing) | D8, 6.2 `provisionUser`, 12.3 (auth.ts, webhook) |
| PC-V1, CA-V2 (sign-in before seed locks /admin) | D9, 4.4 `ensureBootstrapAdmin`, 12.3 admin layout, 12.6 `admin:grant`, 12.7 nextSteps |
| PC-09 (seeding never reaches prod) | 4.3 `seedPermissionCatalog`, 12.6 `db:seed:deploy` + deploy.yml, `add` prints `pnpm db:seed` |
| PC-02, CA-02, SR-02, SR-14 (no create/switch/onboarding) | 6.3–6.4, 8.3–8.4, 12.4 |
| PC-03, SR-02 (no remove/role/leave/transfer) | 6.8 |
| PC-04, TB-09 (no staff role assignment) | 4.5 `assignRoleTemplate`, 6.11 `setStaffRole`, 8.12 `<StaffPeople>` |
| PC-06, SR-11 (read-only 50-row tenant list) | 6.11, 8.10–8.11. Not included: impersonation, notes, plan override, deletion |
| PC-07 (security glue lives in the template) | 4.2 loaders and 4.3 seed move to `permissions/server`; provisioning to `tenancy/server`. Not included: table prefixes |
| PC-14 (seats) | D16, 6.9 |
| PC-19 (scope audit not wired) | 9.2 `inventoryOf`, 12.8 emitted `procedure-scopes.test.ts` |
| PC-20 (webhook ledger dead, deletion dangles) | 6.2 `deprovisionUser`, 12.3 webhook ledger. Not included: non-Clerk identity providers |
| PC-V2 (comments that lie) | 12.10 lists each comment to correct |
| SR-12 (no per-tenant settings store) | D13, 5.3, 6.6 |
| SR-13 (no /t/[slug]) | D14, 6.12 `resolveCompanyBySlug`, 12.4 `/t/[slug]` placeholder. Pages are Tenancy 2 |
| SR-15 (personal-workspace invites, ambiguous resolution) | D6, 6.3 (deterministic resolution, pointer), 6.9 (`personal_workspace` refusal) |
| SR-22 (no isolation suite) | 12.8 emitted `tenant-isolation.test.ts`, 13.2 `handlers.test.ts` package matrix. Feature packages' two-tenant tests are Tenancy 2 |
| CA-10 (stranger can't get from README to running app) | 12.7: nextSteps registry line and `pnpm db:seed`; an emitted project `README.md`; a buyer quick start at the top of create-app's README. Not included: the full flag table |
| CA-11 (closing instructions skip features) | 12.7: `CRON_SECRET` in `.env.example` for comms, a comms nextSteps line, SCAFFOLD.md answer rows iterate `Answers` |
| CA-17 (header unusable on a phone; Admin link for everyone) | 12.3 (AuthHeader): header disclosure menu under `sm`, `/admin` link only for staff |
| CA-18 (/setup public in production) | 12.3: `notFound()` in production unless staff; footer omits it in production |
| CA-20, TB-08, SR-16 (one staff key gates every feature) | **Tenancy 2**: feature routes move to tenant keys there. Listed as not included |
| TB-08, TB-09 (testbed) | Answered through create-app. The testbed is regenerated, not edited |

---

## 1. What changes, in one page

| Package | Before | After |
| --- | --- | --- |
| `@adminigloo/permissions` 0.2.0 | A resolver, but loaders, seed and bootstrap live in the template | Root gains `STAFF_ROLE_TEMPLATES`, `RoleTemplateSpec`, `BootstrapPolicy`, and `FIRM_WIDE` from a pg-core-free module. New `./server`: `createDrizzlePermissionLoaders`, `seedPermissionCatalog`, `ensureBootstrapAdmin`, `assignRoleTemplate`, `listRoleTemplates`, `roleOf` |
| `@adminigloo/tenancy` 0.4.0 | Invitations, owner-role grant, workspace ids | Root gains slug and name rules, brand-colour contrast, the settings registry (`defineSettingsFragment`, `defineTenantSettings`, `companySettings`), checklist types, `members.role.change`, `tenancyAuditedActions`, `TENANCY_STAFF_PERMISSION_KEYS`. Schema: suspension, `created_by`/`creation_key`, `setup_state`, `tenant_retired_slugs`. New `./server`: `createTenancyService` (provisioning, session, companies, profile, branding, logo, settings, checklist, team, transfer, invitations, operator, slug resolution), `tenancyMembershipGate`, `createTenancyHandlers`, `createTenancyOperatorHandlers`, `TENANCY_ROUTES`, `TENANCY_OPERATOR_ROUTES`, `TenancyError` |
| `@adminigloo/tenancy-widget` 0.1.0 (new) | none | `.`: `Onboarding`, `CompanySwitcher`, `SetupChecklist`, `TeamManager`, `CompanySettings`, `CompanySuspended`, `AcceptInvitation`. `./admin`: `CompaniesConsole`, `CompanyDetail`, `StaffPeople`. Transports, theme, styles |
| `@adminigloo/trpc` 0.3.0 | Scope audit exists, never wired | `inventoryOf(router)`; `auditBuiltProcedures` accepts dotted-path overrides; optional `explainTenantDenial` gives a suspended company its own FORBIDDEN message |
| `@adminigloo/auth` 0.2.0 | `users` | `users.provisioned_at` |
| `@adminigloo/testing` 0.2.0 | Factories without the new columns | `./pglite` builds a real Postgres from a schema object; factories learn the new columns |
| `@adminigloo/create-app` 0.22.0 | Every user gets "Personal"; nothing creates, switches, removes or transfers; staff roles need SQL; no deploy seed | The wiring plan in section 12 |

---

## 2. Decisions (binding on every builder)

Each decision is written as a decision record. Copy the reasoning into the code
comment at the place it's enforced.

**D1. The UI ships in a new `@adminigloo/tenancy-widget`, not in a
`@adminigloo/tenancy/ui` entry.**
- Five widget packages already set the shape: React as the only peer, a
  "use client" banner on every bundle, a transport, a host-following theme. The
  founder's buyers already know it.
- The tenancy root is imported by server code and by client components that only
  want `TENANT_ROLE_TEMPLATES`. Giving it a React peer and a client banner would
  make every server import pay for React. Splitting the banner per entry inside
  one tsup config is the fragile kind of cleverness.
- UI fixes ship on their own version line, without bumping the data layer's
  migrations.
- A foreign host (section 14.3) that never renders these screens installs
  nothing React-shaped.
- The `./admin` entry keeps the operator console out of every customer bundle.

**D2. HTTP handlers in the package, not tRPC routers in the template.**
`createTenancyHandlers` and `createTenancyOperatorHandlers` hold every
lifecycle route, the scheduling 0.4 precedent. The emitted project mounts them
behind its own sign-in. A security fix to who may remove whom then reaches every
project by `npm update`, whereas a router copied into the template would be
frozen at generation. The template's tRPC `invitations` router is **retired**:
its rules (the rank guard, the remapped accept outcome, audit actions with the
same keys) move into the handlers, so there is exactly one invite path.

**D3. A company route names its tenant in the PATH. The active pointer only
decides what a page renders.**
- Every company route is `v1/companies/{tenantId}/...`. The handler authorises
  membership and permission against THAT id, the way `tenantProcedure` takes
  `tenantId` from input.
- `users.active_tenant_id` decides which company the server page renders, and
  that page hands the id to the widget.
- Resolving the tenant from the pointer inside the handler would be wrong.
  Example: a user switches company in tab 2, then presses "Remove" in tab 1,
  which still shows company A. The pointer now says B, and if the person exists
  in B the removal lands in the company they weren't looking at. With the id in
  the path, tab 1 acts on A, which is what the screen showed.

**D4. One owner per company.** `tenants.owner_user_id` is the owner, and the
owner is the only member holding the `owner` template. Every lifecycle function
keeps these two in step, and section 13.2 asserts it after every mutating test.
Co-owners are not a T1 concept.

**D5. Ranks stay STRICTLY greater (`canManageTemplateKey`), so owner is reached
only by creating a company or by transfer.**
- Nobody outranks an owner, so an invitation can never carry `owner`.
- Nobody can change or remove an owner, and an owner can't demote themselves.
- "The last owner can't be demoted" is therefore enforced twice: by the rank
  guard, and by the explicit `owner_protected` refusal.
- An owner invites admins, members and viewers. An admin invites members and
  viewers. Equal ranks never manage each other.

**D6. `--tenant-noun` other than `none` = `mode: "companies"`. `none` =
`mode: "personal"`.**
- **companies**:
  - No personal workspace is created for anyone.
  - A user with no live company membership is `needs-onboarding`.
  - Rows of kind `personal` (from a project that existed before 0.22) are
    ignored by session resolution and the switcher. Only the operator console
    still sees them.
  - Inviting into a `personal` tenant is refused with `personal_workspace`.
- **personal**: today's single-business mode, unchanged in behaviour.
  - Every user gets their personal workspace at provisioning, race-free now.
  - There is no onboarding, no company settings, no checklist and no `/dashboard`.
  - The team page works for the personal workspace. Invitations into personal
    workspaces are allowed in this mode (that is how a household or a two-person
    shop shares one account today).
  - The switcher appears only for someone who belongs to two or more workspaces
    (they accepted an invitation). It never offers "Create another". This is
    what keeps an invited person from being stranded in someone else's
    workspace (SR-15).
- The generator picks the mode as a literal in emitted code (rule 1 holds).

**D7. Every member-lifecycle mutation serialises on the company row, and every
lock is taken in one order.**
- Each mutation runs `select … from tenants where id = $1 for update` first.
- The global lock order, never violated:
  1. per-user advisory lock (`createCompany` only);
  2. the tenants row;
  3. the tenant_invitations row;
  4. the role advisory lock (inside `assignRoleTemplate`);
  5. the users row (pointer writes).
- Under the lock, the function re-reads everything it decides on:
  - the actor's membership, role and **permission set** (re-resolved on the
    transaction);
  - the target's membership and role;
  - the company's suspension.
- This is what makes the race tests in 13.2 pass by construction. A
  permission resolved before the lock is a hint for rendering, never the
  authority.
- `acceptInvitation` finds the invitation's tenant by hash WITHOUT a lock, takes
  the company lock, then takes the invitation row lock. The opposite order
  deadlocks against `sendInvitation`'s upsert on the same row.

**D8. Provisioning is a state machine with one stamp, `users.provisioned_at`.**
- Section 6.2 has the table. Every write in it is idempotent (`on conflict do
  nothing`, or a conditional update). The stamp is written LAST, so a crash
  halfway leaves it null and the next request finishes the job.
- `currentPrincipal` reads the stamp from the row it already loads, so a
  provisioned user pays no extra query. The webhook provisions too.
- Users created before 0.22 have a null stamp, so they are provisioned on their
  next request. This **repairs PC-01's victims automatically**. No backfill
  stamps them.

**D9. The bootstrap admin is retried whenever it can matter, not once per
user.**
- `ensureBootstrapAdmin` runs:
  - in `provisionUser`;
  - in the `/admin` layout when the caller is not staff;
  - in both seeds, as `ensureBootstrapAdminFor(BOOTSTRAP_ADMIN_EMAIL)`;
  - and `admin:grant` exists as the manual recovery.
- "An admin exists" means a staff `admin` template holder whose user is not
  deleted.
- In email mode the eligibility check runs before any query, so a non-matching
  user visiting `/admin` costs nothing.

**D10. A company can be created before `pnpm db:seed` ever ran.** If the
`owner` tenant template is missing, `createCompany` seeds the tenant scope from
the catalog it was given (`seedPermissionCatalog`, inside its transaction,
under the seed's advisory lock). Without this, the owner of the first company on
a fresh database would hold nothing in it. Scheduling's `ensureCrewAccess` set
this precedent. `createCompany` never commits a company whose owner holds no
role: a zero-row grant throws `internal`.

**D11. Removing a member is a delete, recorded in the audit log.**
- One transaction deletes:
  - the `tenant_members` row;
  - the tenant `principal_role` row;
  - their per-person `principal_override` rows for that tenant;
  - and nulls their `users.active_tenant_id` if it pointed there.
- Re-inviting them later starts clean, and the audit row is the history.
- Leaving does the same. Deleting a user (webhook) does not remove them. It sets
  their memberships to `status = 'suspended'`, so rosters keep the name, and
  deletes their staff roles (section 6.2).

**D12. Changing a member's role clears their per-person overrides in that
tenant.** The overrides were set relative to the old role. An admin demoted to
member who keeps an `allow tenant.edit` override is a demotion that did nothing.
The cleared keys go into the audit metadata. Staff role changes keep their
overrides; only removing a staff role clears them (section 4.5).

**D13. Settings live in `tenants.settings` jsonb, one key per fragment, read
through a typed registry.**
- Fragments are declared in code (zod schema plus field specs), composed per
  project like the permission catalog, and refused at definition time on a
  duplicate key.
- Stored values are parsed field by field. Invalid stored data falls back to
  that fragment's defaults and is reported, never thrown, so one bad save can't
  take the settings page down.
- Name and slug are real columns. Logo and brand colour live in
  `tenants.branding`. The setup checklist's state lives in its own
  `tenants.setup_state` column, so the registry owns `settings` completely.

**D14. A slug, once used, is never freed.**
- Changing a slug moves the old one into `tenant_retired_slugs`.
- Availability checks consult both tables.
- `resolveCompanyBySlug` follows a retired slug to its company, so Tenancy 2 can
  answer with a redirect.
- Without this, a renamed company's old links, emails and receipts would land
  on whoever claimed the old address next. The schema comment on
  `tenants_slug_idx` already promises exactly this for deleted tenants.

**D15. Suspension is a company property (`tenants.suspended_at`) enforced in
ONE place, the membership gate.** For a suspended company:
- `tenancyMembershipGate` answers `company-suspended`, so:
  - `loadTenantPermissions` returns null, and every tRPC tenant procedure and
    every company route refuses;
  - with `explainTenantDenial`, the refusal message says suspended.
- `resolveSession` shows the suspended screen.
- `resolveCompanyBySlug` returns null.
- `acceptInvitation` answers `company-unavailable`.
- Operator functions still see it. Staff are not members, so the gate is not in
  their path.

**D16. The seat hook is a limit source; tenancy does the counting.**
- `seats?: { limitFor(tx, tenantId): Promise<number | null> }`, where null means
  unlimited.
- Tenancy counts under the company lock:
  - at invite: active members + open pending invitations (excluding the one
    being re-sent) + 1 must be ≤ limit;
  - at accept: active members + 1 must be ≤ limit.
- Billing only has to answer "how many". The counting and the race-safety live
  where the rows are. Counting is done under the same company lock every
  joining path takes (D7), so two accepts can't both take the last seat. No
  advisory lock is needed: Riddler needed one only because it had no row to
  lock.

**D17. Audit goes through a sink called INSIDE the transaction.**
- `audit?: (tx, event) => Promise<void>`. The row commits with the change, or
  neither does (Riddler's `recordAdminAudit(tx, …)`).
- Events are a closed vocabulary, `tenancyAuditedActions`, spread into the
  project's audit registry. Its three `invitation.*` keys keep their exact
  existing names, because a key is permanent.
- `onEvent` (after commit, failures swallowed and reported to `onEventError`)
  is the seam for notifications. Nothing in T1 needs it.

**D18. Invitations keep the 0.3 service.**
- The hash-only token, the upsert on the partial index, `FOR UPDATE` on accept,
  the union result and `requireMatchingEmail = true` are all unchanged.
- The lifecycle layer wraps it: company lock first, rank guard,
  `already_member`, personal-workspace refusal, seats, pointer write, audit.
- `createInvitationService` grows two things:
  - an optional `beforeConsume` hook, so seats and suspension are decided under
    the locks it already holds;
  - `acceptForVerifiedEmail`, for D19.
- Nothing else in its behaviour changes.

**D19. An invitation can be accepted by a VERIFIED email address alone, from
onboarding.**
- With `requireMatchingEmail` on, the token was never the real gate: the
  invited address was.
- Clerk's verified addresses prove control of that mailbox as well as the mailed
  link does.
- So the onboarding page lists open invitations addressed to the user's verified
  addresses, and lets them join with one click.
- This makes "signed up through an invitation" land in the company even when
  the redirect back to `/invite/[token]` was lost: email verified on another
  device, tab closed.
- Unverified addresses never qualify. The host supplies the verified list from
  Clerk on the server, never from the browser.
- Joining still needs a deliberate click. It never happens at provisioning: an
  account must not join a company as a side effect of signing in. (Ask Lou's
  OnboardCheck auto-accepts, and had to be latched against firing twice; a
  click avoids both problems.)

**D20. The emitted isolation test runs on PGlite in the UNIT project.**
- It runs on every `pnpm test` with nothing configured, and in the generator
  matrix's `vitest run --project=unit` step.
- A test that only runs with `DATABASE_URL` is a test that reports "skipped",
  and SR-22 exists because skips are free.
- `@adminigloo/testing/pglite` builds the database from the project's own
  `schema` object (the same object drizzle-kit generates the migrations from),
  so the test database can't drift from the real one.

---

## 3. Schema (server builder)

### 3.1 `@adminigloo/tenancy/schema`: `tenants` gains columns

```ts
/** Who created it. Immutable; the owner pointer moves, this never does. Bare text, no FK (same reason as owner_user_id). */
createdBy: text("created_by"),
/**
 * The creating form's one-time key (a UUID minted when the form mounted).
 * (created_by, creation_key) is unique, so a refresh or a double submit
 * replays instead of creating a second company. NULL for rows not made by
 * createCompany (personal workspaces, seeds).
 */
creationKey: text("creation_key"),
/** Set by an operator. Non-null = suspended (decision D15). */
suspendedAt: timestamp("suspended_at", { withTimezone: true }),
/** Why, in the operator's words. Shown to staff only, never to the company. */
suspendedReason: text("suspended_reason"),
/** The staff user who suspended it. */
suspendedBy: text("suspended_by"),
/** Setup checklist state (decision D13): { dismissed?: string[]; hiddenAt?: string } */
setupState: jsonb("setup_state").$type<TenantSetupState>().notNull().default({}),
```

New indexes on `tenants`:

```ts
uniqueIndex("tenants_creation_key_idx").on(t.createdBy, t.creationKey).where(sql`${t.creationKey} is not null`),
index("tenants_kind_created_idx").on(t.kind, t.createdAt),
```

Exported types (root, type-only):

```ts
export interface TenantSetupState { readonly dismissed?: readonly string[]; readonly hiddenAt?: string }
export interface TenantBranding {
  readonly logoUrl?: string;
  /** The storage key, so a replaced logo can be deleted. */
  readonly logoKey?: string;
  /** Normalised "#rrggbb". */
  readonly brandColor?: string;
  /** The text colour that reads on brandColor (brandColorReport().textOnColor). */
  readonly onBrandColor?: "#ffffff" | "#111111";
}
```

`branding` keeps its `TenantJson` column type. The server parses it with a zod
schema for `TenantBranding` and treats anything unparseable as `{}`.

### 3.2 New table `tenant_retired_slugs`

```ts
export const tenantRetiredSlugs = pgTable(
  "tenant_retired_slugs",
  {
    /** Globally unique: a retired slug belongs to the company that retired it, forever (D14). */
    slug: text("slug").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    retiredAt: createdAt(),
  },
  (t) => [index("tenant_retired_slugs_tenant_idx").on(t.tenantId)],
);
```

`tenancySchema` gains `tenantRetiredSlugs`.

### 3.3 `@adminigloo/auth/schema`: `users` gains one column

```ts
/**
 * When provisioning finished for this user (decision D8). NULL = not yet:
 * the next request (currentPrincipal) or webhook delivery runs provisionUser,
 * which is idempotent and stamps this LAST.
 */
provisionedAt: timestamp("provisioned_at", { withTimezone: true }),
```

### 3.4 Upgrade SQL (README "Upgrading from 0.3", for hosts not on drizzle-kit)

```sql
alter table users add column if not exists provisioned_at timestamptz;
-- Deliberately NOT backfilled: a null stamp makes the next request provision the
-- user, which repairs anyone the 0.3 webhook race left without a workspace.

alter table tenants
  add column if not exists created_by text,
  add column if not exists creation_key text,
  add column if not exists suspended_at timestamptz,
  add column if not exists suspended_reason text,
  add column if not exists suspended_by text,
  add column if not exists setup_state jsonb not null default '{}'::jsonb;
create unique index if not exists tenants_creation_key_idx
  on tenants (created_by, creation_key) where creation_key is not null;
create index if not exists tenants_kind_created_idx on tenants (kind, created_at);

create table if not exists tenant_retired_slugs (
  slug text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  retired_at timestamptz not null default now()
);
create index if not exists tenant_retired_slugs_tenant_idx on tenant_retired_slugs (tenant_id);
```

Permissions has no schema change.

---

## 4. `@adminigloo/permissions` 0.2.0 (server builder)

### 4.1 Root (client-safe, no pg-core)

- **New `src/constants.ts`** exports `FIRM_WIDE = "*"`. `schema.ts` imports it
  from there, and `index.ts` re-exports it from there. This stops the root from
  importing `drizzle-orm/pg-core`. Keep the existing tenancy pin tests green.
- **`STAFF_ROLE_TEMPLATES`**, moved from the template's `scripts/seed-roles.ts`:

```ts
export const STAFF_ROLE_TEMPLATES = [
  { key: "admin", name: "Administrator", description: "Runs the platform: every staff screen, staff roles and settings.", rank: 30 },
  { key: "cs_lead", name: "Customer service lead", description: "Helps customers and sees their companies and people.", rank: 20 },
  { key: "cs_agent", name: "Customer service agent", description: "Helps customers day to day.", rank: 10 },
] as const satisfies readonly RoleTemplateSpec[];
export type StaffRoleTemplateKey = (typeof STAFF_ROLE_TEMPLATES)[number]["key"];

export interface RoleTemplateSpec { readonly key: string; readonly name: string; readonly description?: string; readonly rank: number }

export type BootstrapPolicy =
  | { readonly mode: "first-user" }                 // local: whoever is first while no admin exists
  | { readonly mode: "email"; readonly email: string } // deployed: only this address
  | { readonly mode: "off" };                        // deployed with no BOOTSTRAP_ADMIN_EMAIL
```

### 4.2 `./server`: loaders

```ts
export type PermissionsDb = PgDatabase<any, any, any>;

export type MembershipVerdict = "member" | "not-a-member" | "company-suspended";
/** Supplied by @adminigloo/tenancy/server (tenancyMembershipGate). Permissions knows no membership table. */
export type MembershipGate = (
  db: PermissionsDb,
  input: { readonly userId: string; readonly tenantId: string },
) => Promise<MembershipVerdict>;

export interface DrizzlePermissionLoaders {
  loadTenantPermissions(input: { readonly principal: { readonly userId: string }; readonly tenantId: string }): Promise<PermissionSet | null>;
  loadStaffPermissions(input: { readonly principal: { readonly userId: string } }): Promise<PermissionSet | null>;
  explainTenantDenial(input: { readonly principal: { readonly userId: string }; readonly tenantId: string }): Promise<"not-a-member" | "company-suspended">;
}

export function createDrizzlePermissionLoaders(
  db: PermissionsDb,
  options: { readonly membership: MembershipGate },   // REQUIRED: a loader with no membership gate admits anyone
): DrizzlePermissionLoaders;
```

- This is the template's `src/server/permissions.ts` semantics exactly, moved.
  Port its comments (the load-bearing NULL, the FIRM_WIDE predicate on the staff
  gate, two queries merged in memory).
- **Tenant:** the gate must answer `"member"`, otherwise `null`. Then:
  1. read the `principal_role` row (scope tenant, that tenant);
  2. read that template's `role_template_grant` rows;
  3. read the principal's `principal_override` rows for (tenant, tenantId);
  4. call `resolvePermissionSet`.
- **Staff:** without a `principal_role` row (scope staff, tenant `FIRM_WIDE`),
  return `null`. Otherwise resolve at `FIRM_WIDE` the same way.
- `explainTenantDenial` calls the gate. `"member"` can't reach it in practice;
  return `"not-a-member"` for it.
- Every query goes through the handle given, so passing a transaction gives the
  read-your-writes the lifecycle functions need (D7).
- Use the query builder with the tables from `./schema`. Never use `db.query.*`:
  the relational API needs the schema registered on the handle, and a package
  can't assume that.

### 4.3 `./server`: `seedPermissionCatalog`

```ts
export interface SeedScopeInput { readonly catalog: Catalog; readonly templates: readonly RoleTemplateSpec[] }
export interface SeedPermissionCatalogInput { readonly staff?: SeedScopeInput; readonly tenant?: SeedScopeInput }
export interface SeedReport {
  readonly created: readonly string[];            // "staff/admin", "tenant/owner"
  readonly skippedCustomised: readonly string[];  // non-system templates found under a shipped key
  readonly grantsAdded: number;
  readonly sealsAdded: number;
  readonly sealsLifted: number;                   // deny rows on SYSTEM templates turned to allow, see below
  readonly ungrantedKeys: readonly { readonly scope: Scope; readonly key: string }[]; // keys no template grants (the /admin/access health card, PC-09)
}
export function seedPermissionCatalog(db: PermissionsDb, input: SeedPermissionCatalogInput): Promise<SeedReport>;
```

The logic is today's `scripts/seed-roles.ts`, moved and hardened:

- **One transaction**, under `pg_advisory_xact_lock(hashtextextended('adminigloo:permissions:seed', 0))`.
- **Templates:** `insert … on conflict (scope, tenant_id, key) do nothing` at
  `FIRM_WIDE`, with `is_system = true`, then re-select.
  - A row that exists with `is_system = false` is skipped and reported. A
    customised template is never touched.
- **For each system template:**
  - for every key in `catalog.defaultsFor(template.key)`, insert an `allow`
    grant `on conflict do nothing`;
  - for every sealed key NOT in its defaults, insert a `deny` row `on conflict do
    nothing`.
- **The one update the seed performs:** a key now in `defaultsFor` whose system
  template holds a `deny` row from an earlier seal is set to `allow`, and counted
  in `sealsLifted`. Otherwise a catalog change that grants a previously sealed key
  could never take effect. Comment it as the only exception to insert-only.
- `ungrantedKeys` lists catalog keys that no template in that scope grants after
  the run.
- Idempotent: a second run reports `created: []`, `grantsAdded: 0`, `sealsAdded: 0`.

### 4.4 `./server`: `ensureBootstrapAdmin`

```ts
export const BOOTSTRAP_ADMIN_LOCK_KEY = 8_140_231; // the template's key, kept so mixed-version instances still exclude each other

export type BootstrapOutcome =
  | { readonly granted: true }
  | { readonly granted: false; readonly reason: "off" | "not-eligible" | "admin-exists" | "templates-missing" };

export function ensureBootstrapAdmin(
  db: PermissionsDb,
  input: {
    readonly principalId: string;
    readonly email: string | null;
    readonly policy: BootstrapPolicy;
    readonly adminTemplateKey?: string;   // default "admin"
    /** Does this principal still exist? Tenancy passes a users-table check (deleted users don't count as admins). */
    readonly isActivePrincipal?: (tx: PermissionsDb, principalId: string) => Promise<boolean>;
  },
): Promise<BootstrapOutcome>;
```

Order, which matters for cost:

1. **Policy check, before ANY query.**
   - `off` → `{ granted: false, reason: "off" }`.
   - `email` → compare the trimmed, lowercased `input.email` with the policy's.
     A mismatch or a null → `not-eligible`.
   - `first-user` → eligible.
2. **Transaction:**
   1. `pg_advisory_xact_lock(BOOTSTRAP_ADMIN_LOCK_KEY)`.
   2. Find the admin template at `FIRM_WIDE`. Missing → `templates-missing`.
   3. Read every holder of that template (staff, `FIRM_WIDE`). If at least one
      holder exists and either no `isActivePrincipal` was given or it accepts
      that holder → `admin-exists`. Holders it rejects (deleted users) don't
      count.
   4. Insert `principal_role` (`principalId`, staff, `FIRM_WIDE`, template)
      with `on conflict (principal_id, scope, tenant_id) do update set
      template_id = excluded.template_id`. A crew-only or cs_agent staff row is
      promoted: when no admin exists, the bootstrap person must become one.
   5. → `{ granted: true }`.

Port the template's bootstrap.ts comments: who qualifies where, the advisory
lock story, and self-hosted deployments.

### 4.5 `./server`: role assignment and lookups

```ts
export class RoleAssignmentError extends Error {
  readonly name = "RoleAssignmentError";
  constructor(readonly code: "self" | "rank" | "unknown-template" | "last-holder", message: string) { super(message) }
}

export interface AssignRoleTemplateInput {
  readonly scope: Scope;
  readonly tenantId?: string;             // FIRM_WIDE for staff (the default)
  readonly principalId: string;
  readonly templateKey: string | null;    // null removes the role
  /** A person (rank-guarded) or a named system actor (admin:grant, bootstrap): no rank guard. */
  readonly actor: { readonly principalId: string } | { readonly system: string };
  /** Refuse leaving zero holders of this key in this scope+tenant ("admin" for staff). */
  readonly protectLastKey?: string;
  /** Delete the principal's overrides in this scope+tenant when the role changes (tenant: true; staff: only on removal). */
  readonly clearOverrides?: "never" | "on-change" | "on-removal";
}
export interface RoleAssignment {
  readonly previous: { readonly key: string; readonly rank: number } | null;
  readonly next: { readonly key: string; readonly rank: number } | null;
  readonly changed: boolean;
  readonly clearedOverrides: readonly string[];
}
export function assignRoleTemplate(db: PermissionsDb, input: AssignRoleTemplateInput): Promise<RoleAssignment>;
```

- **Lock:** `pg_advisory_xact_lock(hashtextextended('adminigloo:roles:' || scope || ':' || tenantId, 0))`
  in the caller's transaction. Open one if the handle isn't already one: call
  `db.transaction`, which is a savepoint when nested.
- **Rank guard** (person actors only):
  - Read the actor's template rank in this scope and tenant from
    `role_template.rank`. Using DB ranks means the crew role and custom staff
    templates rank correctly too.
  - The actor must hold one: no template → `rank`.
  - It must strictly exceed the target's current rank (a target with no role
    counts as rank 0) and the new template's rank. Otherwise → `rank`.
  - Self → `self`.
- **Unknown key**, or a deleted template → `unknown-template`.
- **`protectLastKey`:** if the target holds that key, the change drops them off
  it, and nobody else holds it → `last-holder`.
- **Writing:**
  - Upsert on `(principal_id, scope, tenant_id)`: `do update set template_id,
    updated_at`.
  - Removing deletes the row.
  - Clear overrides per `clearOverrides`.
  - A no-op (same template) → `changed: false`, nothing written.

```ts
export function listRoleTemplates(db: PermissionsDb, input: { readonly scope: Scope; readonly tenantId?: string }):
  Promise<readonly { id: string; key: string; name: string; description: string | null; rank: number; isSystem: boolean }[]>; // rank desc, deleted excluded
export function roleOf(db: PermissionsDb, input: { readonly principalId: string; readonly scope: Scope; readonly tenantId?: string }):
  Promise<{ templateId: string; key: string; name: string; rank: number } | null>;
```

---

## 5. `@adminigloo/tenancy` 0.4.0 root (client-safe; server builder)

The root must stay free of table objects and `drizzle-orm/pg-core` (service.ts
explains why). New modules: `slug.ts`, `color.ts`, `settings.ts`,
`checklist.ts` and `audit.ts`. `permissions.ts` changes.

### 5.1 Names and web addresses (`slug.ts`)

```ts
export const SLUG_MIN = 3;
export const SLUG_MAX = 40;
export const COMPANY_NAME_MAX = 80;
/** Reserved because a route, a subdomain we might want, or plain confusion would collide. Lowercase. */
export const RESERVED_SLUGS: ReadonlySet<string>;
export type SlugProblem = "too-short" | "too-long" | "invalid" | "reserved";
export type CompanyNameProblem = "too-short" | "too-long" | "invalid";

export function suggestSlug(name: string): string;
export function validateSlug(slug: string, options?: { readonly reserved?: Iterable<string> }): SlugProblem | null;
export function slugProblemMessage(problem: SlugProblem | "taken", noun?: string): string;
export function normaliseCompanyName(name: string): string;
export function companyNameProblem(name: string): CompanyNameProblem | null;
export function companyNameProblemMessage(problem: CompanyNameProblem, noun?: string): string;
```

- **`RESERVED_SLUGS`, at minimum:**

  ```
  about access account accounts admin adminigloo api app apps assets auth billing
  blog book book-visit careers cart checkout companies company contact dashboard
  docs email estimate estimates files help home igloo images invite invites
  invoice invoices jobs legal login logout mail me new null oauth onboarding
  organization organizations people press pricing products public quote quotes
  register root schedule security settings setup shop sign-in sign-up signin
  signup staff static status store support system t team teams terms undefined
  visit webhooks workspace workspaces www you _next
  ```

  The host can add more through the service's `reservedSlugs`.
- **`validateSlug`:**
  - length between `SLUG_MIN` and `SLUG_MAX`;
  - `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, so no leading, trailing or doubled dash and
    nothing outside `[a-z0-9-]`;
  - must not start with `ws-` (the personal-workspace prefix), which counts as
    `invalid`;
  - not reserved.
  - Order of checks: too-short, too-long, invalid, reserved.
- **`suggestSlug(name)`:**
  1. Normalise with NFKD and drop combining marks.
  2. Lowercase.
  3. Turn `&` into `and` and `'` into nothing.
  4. Turn every run of other characters into `-`, then trim dashes.
  5. Cut to `SLUG_MAX` at the last dash at or before the limit, when there is
     one.
  6. If the result is shorter than `SLUG_MIN`, append `-co` (repeat once if
     it's still short). If it starts with `ws-`, PREFIX `co-` instead
     ("WS Lawn Services" → `co-ws-lawn-services`): appending `-co` leaves the
     `ws-` start that `validateSlug` refuses (AMENDED, review T1-02).
  7. If reserved, append `-co`.

  It never returns an invalid slug: a property test runs 1 000 random names.
  Collision suffixes (`-2`, `-3`, …) are the server's job.
- **`normaliseCompanyName`** trims and collapses whitespace runs to one space.
- **`companyNameProblem`** works on the normalised name:
  - shorter than 2 → `too-short`;
  - longer than `COMPANY_NAME_MAX` → `too-long`;
  - control characters, or no letter and no digit at all → `invalid`.
- **Messages** are plain sentences:

  | Problem | Message |
  | --- | --- |
  | reserved | "That web address is kept for the site itself. Try another, like acme-plumbing." |
  | taken | "That web address is already used by another {noun}." |
  | too-short | "Use at least 3 letters or numbers." |
  | too-long | "Keep it to 40 characters or fewer." |
  | invalid | "Use lowercase letters, numbers and single dashes, like summit-window-co." |

  The noun defaults to `"company"`. Name messages (`companyNameProblemMessage`):

  | Problem | Message |
  | --- | --- |
  | too-short | "Give your {noun} a name of at least 2 characters." |
  | too-long | "Keep the name to 80 characters or fewer." |
  | invalid | "Use letters or numbers in the name." |

### 5.2 Brand colour (`color.ts`)

```ts
export function normaliseHexColor(input: string): string | null; // "#ABC" | "abc" | "#aabbcc" → "#aabbcc"; anything else → null
export function contrastRatio(a: string, b: string): number;    // WCAG 2.x, hex in
export interface BrandColorReport {
  readonly color: string;                               // normalised
  readonly textOnColor: "#ffffff" | "#111111";          // whichever reads better ON the colour
  readonly ratioWithWhiteText: number;                  // contrastRatio(color, "#ffffff"), 2 decimals
  readonly ratioWithDarkText: number;                   // contrastRatio(color, "#111111"), 2 decimals
  readonly ratioOnWhitePage: number;                    // = ratioWithWhiteText: the colour as text/links on a white page
  readonly readable: boolean;                           // max(ratioWith*) >= 4.5, decided on the 2-decimal ratios (AMENDED, T1-02)
  readonly warning: string | null;
}
export function brandColorReport(hex: string): BrandColorReport | null; // null for an unparseable colour
export const AA_TEXT_RATIO = 4.5;
```

- The maths is Riddler's `domain/branding/schema.ts`, re-implemented: channel
  linearisation `c <= 0.04045 ? c/12.92 : ((c+0.055)/1.055)^2.4`, luminance
  weights `0.2126/0.7152/0.0722`, and `(L1+0.05)/(L2+0.05)`.
- **Warn, never block.** A colour is never refused for contrast.
- `warning` is set when either is true:
  - `!readable`: "Text on this colour is hard to read. A darker or lighter shade
    will work better.";
  - `ratioOnWhitePage < 3`: "This colour is light, so links and headings in it
    will be hard to read on a white page. It works best as a background behind
    dark text."
  - When both are true, the first wins.

### 5.3 The settings registry (`settings.ts`; imports `zod`)

```ts
export type SettingsFieldKind = "text" | "textarea" | "email" | "tel" | "url" | "timezone" | "select" | "toggle" | "number";

export interface SettingsField {
  /** Key inside the fragment's object (flat: no dots). */
  readonly key: string;
  readonly label: string;                 // plain words: "Email customers can reach you at"
  readonly help?: string;
  readonly kind: SettingsFieldKind;
  readonly options?: readonly { readonly value: string; readonly label: string }[]; // select
  readonly placeholder?: string;
  readonly autoComplete?: string;         // e.g. "email", "tel", "address-line1"
  readonly width?: "full" | "half";       // default "full"
  readonly required?: boolean;            // UI hint only; the schema decides
  readonly min?: number; readonly max?: number; readonly step?: number;
}

export interface TenantSettingsFragment<K extends string = string, S extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> {
  /** /^[a-z][a-z0-9-]{1,31}$/ and not starting with "__". The jsonb key under tenants.settings. */
  readonly key: K;
  readonly label: string;                 // section heading: "Business details"
  readonly description?: string;
  /** Every field must have a default (.default()), so `schema.parse({})` yields the defaults. */
  readonly schema: S;
  readonly fields: readonly SettingsField[];   // every field.key must exist in schema.shape (checked at definition)
  readonly viewPermission?: string;            // default "tenant.view"
  readonly editPermission?: string;            // default "tenant.edit"
  readonly order?: number;                     // default 100; ascending
}

export function defineSettingsFragment<const K extends string, S extends z.ZodObject<z.ZodRawShape>>(
  fragment: TenantSettingsFragment<K, S>,
): TenantSettingsFragment<K, S>;            // throws InvalidSettingsFragmentError (bad key, field not in shape, schema.parse({}) fails)

export interface TenantSettingsRegistry<F extends readonly TenantSettingsFragment[] = readonly TenantSettingsFragment[]> {
  readonly fragments: F;                       // sorted by order, then key
  get(key: string): TenantSettingsFragment | undefined;
  defaults(): SettingsValues<F>;
  /** Parse one stored settings blob: per fragment, safeParse; on failure use that fragment's defaults and report. */
  parse(stored: unknown): { readonly values: SettingsValues<F>; readonly problems: readonly { fragment: string; message: string }[] };
}
export type SettingsValues<F extends readonly TenantSettingsFragment[]> = {
  readonly [P in F[number] as P["key"]]: z.output<P["schema"]>;
};
export function defineTenantSettings<const F extends readonly TenantSettingsFragment[]>(fragments: F): TenantSettingsRegistry<F>;
// throws DuplicateSettingsFragmentError (readonly name) on a repeated key

export class DuplicateSettingsFragmentError extends Error { readonly name = "DuplicateSettingsFragmentError" }
export class InvalidSettingsFragmentError extends Error { readonly name = "InvalidSettingsFragmentError" }

/** IANA zone check used by the company fragment (Intl.DateTimeFormat with timeZone; try/catch). */
export function isTimeZone(value: string): boolean;
```

**The company fragment shipped by tenancy** (`companySettings`, key `company`,
label `"Business details"`, order 10). Each field preprocesses an empty string to
`null`:

| Field | Kind | Label | Schema |
| --- | --- | --- | --- |
| `timeZone` | timezone | "Time zone" — help "Dates and times your customers see use this." | `z.string().nullable().default(null)` refined with `isTimeZone` |
| `contactEmail` | email | "Email customers can reach you at" | trimmed, lowercased `.email().max(254)`, nullable, default null |
| `contactPhone` | tel | "Phone customers can call" | `.trim().max(40)`, nullable, default null |
| `addressLine1` | text | "Street address" | `max(120)` nullable default null |
| `addressLine2` | text | "Apartment, suite, unit (optional)" | `max(120)` nullable default null |
| `city` | text | "City" (half) | `max(80)` nullable default null |
| `region` | text | "State" (half) | `max(80)` nullable default null |
| `postalCode` | text | "ZIP code" (half) | `max(20)` nullable default null |
| `country` | text | "Country" (half) | `max(80)` nullable default null |

Autocomplete hints: `email`, `tel`, `address-line1`, `address-line2`,
`address-level2`, `address-level1`, `postal-code`, `country-name`.

Tenancy 2 consumers read typed values on the server (section 6.6
`readSettings`). For example `settings.company.timeZone` will be scheduling's
default zone, and `tenants.name` the estimator's business name.

### 5.4 Checklist types (`checklist.ts`)

```ts
export interface ChecklistContext {
  readonly db: unknown;                        // the server's TenancyDb, typed in ./server
  readonly tenantId: string;
  readonly company: { readonly name: string; readonly slug: string; readonly logoUrl: string | null; readonly brandColor: string | null };
  readonly settings: Readonly<Record<string, unknown>>;   // parsed registry values
  readonly counts: { readonly activeMembers: number; readonly invitationsEverSent: number };
}
export interface SetupChecklistItem {
  readonly key: string;                        // "company.details"; /^[a-z][a-z0-9.-]{1,63}$/
  readonly title: string;
  readonly description: string;
  readonly actionLabel: string;                // the link's words: "Add details"
  readonly href: string;                       // where to do it, a host path
  readonly order: number;
  readonly permission?: string;                // only people holding it see the item; default "tenant.edit"
  isDone(ctx: ChecklistContext): boolean | Promise<boolean>;
}
export interface SetupChecklist { readonly items: readonly SetupChecklistItem[] }   // sorted by order, then key
export function defineSetupChecklist(items: readonly SetupChecklistItem[]): SetupChecklist; // DuplicateChecklistItemError on a repeated key
export class DuplicateChecklistItemError extends Error { readonly name = "DuplicateChecklistItemError" }
```

The three T1 items live in `./server` (section 6.7), because their predicates
read counts.

### 5.5 Permissions (`permissions.ts`)

- Add, after `members.remove`:

```ts
"members.role.change": {
  label: "Change roles",
  description: "Change what a member can do here. Never above your own role.",
  category: "Team",
  defaultFor: ["owner", "admin"],
},
```

- Copy changes (keys unchanged): use the word "company" in labels and
  descriptions where they say "organisation". `"tenant.view"` becomes "See the
  company's name, web address, branding and details." Don't change the keys.
- Add the following export. create-app declares these keys in its staff catalog
  with noun-aware labels, and its generator test asserts every one of them is
  declared:

```ts
/** Staff keys the operator handlers check. create-app declares them (noun-aware labels) and a generator test asserts each is in its staff catalog. */
export const TENANCY_STAFF_PERMISSION_KEYS = [
  "staff.tenants.view", "staff.tenants.suspend", "staff.people.view", "staff.roles.view", "staff.roles.manage",
] as const;
```

### 5.6 Audit vocabulary (`audit.ts`)

This is structurally an observability `AuditedActionMap`. Tenancy doesn't
depend on observability.

```ts
export const tenancyAuditedActions = {
  "company.created":              { label: "Created a company" },
  "company.profile.updated":      { label: "Changed the company's name or web address" },
  "company.branding.updated":     { label: "Changed the company's logo or colour" },
  "company.settings.updated":     { label: "Changed company settings" },
  "company.ownership.transferred":{ label: "Handed ownership of the company to someone else", sensitive: true },
  "company.suspended":            { label: "Suspended a company" },
  "company.reactivated":          { label: "Reactivated a company" },
  "member.role.changed":          { label: "Changed a member's role", sensitive: true },
  "member.removed":               { label: "Removed a member" },
  "member.left":                  { label: "Left the company" },
  "invitation.sent":              { label: "Invited somebody to join" },
  "invitation.accepted":          { label: "Accepted an invitation and joined", sensitive: true },
  "invitation.revoked":           { label: "Revoked an invitation before it was accepted" },
  "staff.role.assigned":          { label: "Gave someone a staff role", sensitive: true },
  "staff.role.removed":           { label: "Took away someone's staff role" },
  "staff.bootstrap.granted":      { label: "Made the first administrator", sensitive: true },
} as const;
export type TenancyAuditAction = keyof typeof tenancyAuditedActions;
```

### 5.7 Root exports added

`SLUG_MIN`, `SLUG_MAX`, `COMPANY_NAME_MAX`, `RESERVED_SLUGS`, `suggestSlug`,
`validateSlug`, `slugProblemMessage`, `normaliseCompanyName`,
`companyNameProblem`, `companyNameProblemMessage`, `normaliseHexColor`,
`contrastRatio`, `brandColorReport`, `AA_TEXT_RATIO`, `isTimeZone`,
`defineSettingsFragment`, `defineTenantSettings`, `companySettings`,
`DuplicateSettingsFragmentError`, `InvalidSettingsFragmentError`,
`defineSetupChecklist`, `DuplicateChecklistItemError`, `tenancyAuditedActions`
and `TENANCY_STAFF_PERMISSION_KEYS`.

Type exports: `SlugProblem`, `CompanyNameProblem`, `BrandColorReport`,
`SettingsFieldKind`, `SettingsField`, `TenantSettingsFragment`,
`TenantSettingsRegistry`, `SettingsValues`, `SetupChecklistItem`,
`SetupChecklist`, `ChecklistContext`, `TenancyAuditAction`, `TenantBranding`
and `TenantSetupState`.

`barrel.test.ts` is updated to match.

---

## 6. `@adminigloo/tenancy/server` (server builder)

This entry is server-only. It imports tables from `../schema`, `users` from
`@adminigloo/auth/schema`, and functions from `@adminigloo/permissions/server`.

Rules for every builder of this entry:

- **Use the query builder (`db.select().from(table)`), never `db.query.*`.**
  This is a decision record. The relational API needs a schema registered on the
  handle, and the tsup CJS build holds its own copy of the table objects.
- **Keep the query-name comment on raw SQL.** Every statement written as raw
  `sql` carries the `/* adminigloo:tenancy/<name> */` comment the 0.3 code
  uses, so tests can assert on the query log.

### 6.1 Construction, types and errors

```ts
export type TenancyDb = PgDatabase<any, any, any>;
export type TenancyMode = "companies" | "personal";
export type RoleKey = "owner" | "admin" | "member" | "viewer";

/** Lowercase: { singular: "company", plural: "companies" }. Used in messages. */
export interface TenancyNoun { readonly singular: string; readonly plural: string }

export interface LogoStore {
  put(input: { readonly pathname: string; readonly bytes: Uint8Array; readonly contentType: string }): Promise<{ readonly url: string; readonly key: string }>;
  delete(key: string): Promise<void>;
}
export interface SeatLimitSource {
  /** null = unlimited. Called inside the company-locked transaction. */
  limitFor(tx: TenancyDb, tenantId: string): Promise<number | null>;
  /** Where "upgrade" goes, shown beside the seats-full message. Optional. */
  readonly upgradeHref?: string;
}
export interface RequestFacts { readonly ipAddress: string | null; readonly userAgent: string | null }
export interface TenancyAuditEvent {
  readonly action: TenancyAuditAction;
  readonly actorUserId: string | null;          // null = a system actor (webhook, seed, admin:grant)
  readonly scope: "tenant" | "staff";
  readonly tenantId: string | null;
  readonly resourceType: "tenant" | "tenant_member" | "tenant_invitation" | "staff_role";
  readonly resourceId: string;
  readonly metadata: Readonly<Record<string, unknown>>;  // never a token, never a URL carrying one
  readonly request: RequestFacts | null;
}
export type TenancyAuditSink = (tx: TenancyDb, event: TenancyAuditEvent) => Promise<void>;
export type TenancyEvent =
  | { readonly type: "company.created"; readonly tenantId: string; readonly userId: string }
  | { readonly type: "member.joined"; readonly tenantId: string; readonly userId: string; readonly via: "invitation" | "verified-email" }
  | { readonly type: "member.removed" | "member.left"; readonly tenantId: string; readonly userId: string; readonly by: string }
  | { readonly type: "member.role.changed"; readonly tenantId: string; readonly userId: string; readonly from: RoleKey | null; readonly to: RoleKey; readonly by: string }
  | { readonly type: "ownership.transferred"; readonly tenantId: string; readonly from: string; readonly to: string }
  | { readonly type: "company.suspended" | "company.reactivated"; readonly tenantId: string; readonly by: string }
  | { readonly type: "invitation.sent"; readonly tenantId: string; readonly invitationId: string; readonly by: string };
export type TenancyEventListener = (event: TenancyEvent) => void | Promise<void>;

export interface CreateTenancyServiceOptions {
  readonly db: TenancyDb;
  readonly mode: TenancyMode;
  /** The project's tenant catalog. createCompany seeds the tenant templates from it when they're missing (D10). */
  readonly tenantCatalog: Catalog;
  readonly bootstrap: BootstrapPolicy;
  readonly noun?: TenancyNoun;                        // default company/companies
  readonly settings?: TenantSettingsRegistry;          // default defineTenantSettings([companySettings])
  readonly checklist?: SetupChecklist;                 // default defineSetupChecklist(tenancyChecklistItems({}))
  readonly seats?: SeatLimitSource;
  readonly logos?: LogoStore;                          // absent → logo routes answer logo_storage_off
  readonly reservedSlugs?: Iterable<string>;           // added to RESERVED_SLUGS
  readonly invitations?: { readonly expiresInHours?: number; readonly requireMatchingEmail?: boolean };
  readonly audit?: TenancyAuditSink;
  readonly onEvent?: TenancyEventListener;
  readonly onEventError?: (error: unknown, event: TenancyEvent) => void;
  readonly now?: () => Date;
}
export function createTenancyService(options: CreateTenancyServiceOptions): TenancyService;
```

Construction fails fast. It throws on a bad option:

- `db` is missing;
- `mode` is unknown;
- the settings registry has no `company` fragment. The service relies on
  `company.timeZone` and the contact fields for the checklist and the operator
  detail.

The service holds `createDrizzlePermissionLoaders(db, { membership:
tenancyMembershipGate })`. Inside a transaction it builds the same loaders on
`tx` (D7).

```ts
export type TenancyErrorCode =
  | "invalid" | "signed_out" | "forbidden" | "not_a_member" | "company_suspended" | "not_staff" | "cross_site"
  | "not_found" | "unavailable" | "name_invalid" | "slug_invalid" | "slug_reserved" | "slug_taken"
  | "rank" | "owner_protected" | "owner_must_transfer" | "self" | "last_owner" | "last_admin"
  | "already_member" | "personal_workspace" | "seats_full" | "confirmation_mismatch"
  | "logo_storage_off" | "logo_invalid" | "rate_limited" | "internal";

export class TenancyError extends Error {
  readonly name = "TenancyError";
  constructor(
    readonly code: TenancyErrorCode,
    message: string,
    readonly details?: { readonly issues?: readonly { path: (string | number)[]; message: string }[]; readonly suggestion?: string; readonly upgradeHref?: string },
  ) { super(message) }
  get status(): number { return TENANCY_ERROR_STATUS[this.code] }
}
export const TENANCY_ERROR_STATUS: Readonly<Record<TenancyErrorCode, number>>;
```

In the messages below, `{noun}` is the singular noun.

| code | status | default message |
| --- | --- | --- |
| `invalid` | 400 | "Check the highlighted fields." (+ `issues`) |
| `signed_out` | 401 | "You've been signed out. Sign in again to keep working." |
| `forbidden` | 403 | "You don't have access to do that here. Ask the owner of this {noun} to change your role." |
| `not_a_member` | 403 | "You're not part of this {noun}." |
| `company_suspended` | 403 | "This {noun} is suspended. Contact support to restore it." |
| `not_staff` | 403 | "That needs a staff role." |
| `cross_site` | 403 | "That request came from another site and was refused." |
| `not_found` | 404 | "That isn't here any more." (the same for every foreign or missing id) |
| `unavailable` | 404 | "That isn't available on this site." (onboarding routes in personal mode) |
| `name_invalid` | 422 | `companyNameProblemMessage(problem)` |
| `slug_invalid` / `slug_reserved` | 422 | `slugProblemMessage(problem)` (+ `suggestion`) |
| `slug_taken` | 409 | `slugProblemMessage("taken")` (+ `suggestion`) |
| `rank` | 403 | "You can only change people whose role is below yours, and only to a role below yours." |
| `owner_protected` | 409 | "That's the owner. Ownership has to be handed to someone else first." |
| `owner_must_transfer` | 409 | "Owner isn't a role you can give. Use Transfer ownership instead." |
| `self` | 409 | Role change: "You can't change your own role. Ask someone above you." Removal: "To remove yourself, use Leave." |
| `last_owner` | 409 | "You own this {noun}. Hand ownership to someone else before you leave." |
| `last_admin` | 409 | "That's the only administrator. Make someone else an administrator first." |
| `already_member` | 409 | "That person is already on your team." |
| `personal_workspace` | 409 | "A personal workspace can't have a team. Create a {noun} to invite people." |
| `seats_full` | 409 | "Your plan includes {limit} people and {used} are on the team or invited. Remove someone or upgrade to add more." |
| `confirmation_mismatch` | 422 | "Type the {noun}'s name exactly as it's shown to confirm." |
| `logo_storage_off` | 409 | "Logo uploads aren't switched on for this site yet." |
| `logo_invalid` | 422 | "Use a PNG, JPG or WebP image under 1 MB." |
| `rate_limited` | 429 | "That's a lot of requests. Wait a minute and try again." |
| `internal` | 500 | "Something went wrong on our side. Try again in a moment." |

Every message is a complete sentence a business owner can act on. None names a
permission key, an internal id, or an email the caller didn't supply.

### 6.2 Provisioning: the state machine (D8, D9)

The states a user can be in:

| State | Meaning |
| --- | --- |
| S0 | No `users` row for this identity |
| S1 | A row exists, and `provisioned_at` is null |
| S2 | Provisioned |
| SX | The row is soft-deleted (`deleted_at` set) |

How each event moves between them:

| Event | From | Writes | To |
| --- | --- | --- | --- |
| Webhook `user.created`/`user.updated` (W) | S0 | Insert the row. The unique `(identity_provider, external_id)` index guards it, and on conflict it re-selects. Then `provisionUser`. | S2 |
| W | S1, S2 | Update the row (stale events skipped, as today), then `provisionUser`. It is idempotent and may grant the bootstrap admin. | S2 |
| Page or API request via `currentPrincipal` (P) | S0 | Mirror insert (on conflict do nothing, re-select), then `provisionUser` | S2 |
| P | S1 | `provisionUser` | S2 |
| P | S2 | Nothing: the stamp is on the row already read | S2 |
| Webhook `user.deleted` (D) | any | Soft delete, then `deprovisionUser` | SX (`currentPrincipal` returns null; the row is never resurrected) |

W and P may race freely, because every write is safe to repeat:

- The insert is guarded by the unique index.
- Each write in `provisionUser` is `on conflict do nothing` or conditional.
- The bootstrap runs under its own advisory lock.
- The stamp is `update users set provisioned_at = $now where id = $1 and
  provisioned_at is null`, written last.
- A failure before the stamp leaves the user in S1, and the next request
  finishes the job.

```ts
provisionUser(input: { readonly userId: string; readonly email: string | null }): Promise<{
  readonly personalWorkspaceId: string | null;   // personal mode only
  readonly bootstrap: BootstrapOutcome;
  readonly stamped: boolean;                      // false when already provisioned (it still ran, idempotently)
}>;
```

The steps run in this order. They deliberately don't share one transaction:
each step is idempotent, and the bootstrap has its own transaction and lock.

1. **Personal mode only:**
   1. Ensure the tenant templates exist (D10).
   2. Insert the `tenants` row `on conflict do nothing`, with:
      - `id = personalWorkspaceId(userId)`;
      - kind `personal`;
      - `slug = personalWorkspaceSlug(userId)`;
      - name `"Personal"`;
      - owner and `created_by` both set to `userId`.
   3. Insert the active membership `on conflict do nothing`.
   4. Call `grantTenantOwnerRole`.
   5. Run `update users set active_tenant_id = $ws where id = $1 and
      active_tenant_id is null`.
2. **Companies mode:** nothing tenant-shaped. Onboarding creates the company.
   **Invitations are never auto-accepted** (D19).
3. Call `ensureBootstrapAdmin(db, { principalId: userId, email, policy:
   options.bootstrap, isActivePrincipal: users-row-exists-and-not-deleted })`.
   When it grants, audit `staff.bootstrap.granted` (actor null, scope staff,
   resource `staff_role`).
4. Stamp `provisioned_at`.

```ts
deprovisionUser(input: { readonly userId: string }): Promise<{ readonly staffRolesRemoved: number; readonly membershipsSuspended: number; readonly ownedCompanies: readonly string[] }>;
```

In one transaction, it:

- deletes the user's staff `principal_role` rows and staff overrides;
- sets `tenant_members.status = 'suspended'` on all their memberships;
- nulls `active_tenant_id`;
- returns the org tenants where they are still `owner_user_id`. The operator
  detail then shows "The owner's account was deleted".

Ownership is never transferred automatically. It audits `staff.role.removed`
for each staff role removed.

```ts
ensureBootstrapAdmin(input: { readonly userId: string; readonly email: string | null }): Promise<BootstrapOutcome>;   // the /admin layout's self-heal
ensureBootstrapAdminFor(input: { readonly email: string }): Promise<BootstrapOutcome & { readonly userId: string | null }>;
```

`ensureBootstrapAdminFor` is the seed's backfill:

- It looks up a non-deleted user by lowercased email.
- If there's none, it returns `{ granted: false, reason: "not-eligible",
  userId: null }`.
- Otherwise it calls `ensureBootstrapAdmin` with policy `{ mode: "email", email }`.

The same logic is also exported standalone, because a seed script has no
service and must not import the app's env:

```ts
export function ensureBootstrapAdminForEmail(db: TenancyDb, input: { readonly email: string; readonly audit?: TenancyAuditSink }): Promise<BootstrapOutcome & { readonly userId: string | null }>;
```

The service method delegates to it.

### 6.3 Session: which company are you in? (D3, D6, D15)

```ts
export type SessionState =
  | { readonly state: "needs-onboarding"; readonly user: UserFacts; readonly invitations: readonly PendingForMe[] }
  | { readonly state: "ready"; readonly user: UserFacts; readonly company: CompanyView; readonly companies: readonly CompanyChoice[] }
  | { readonly state: "suspended"; readonly user: UserFacts; readonly company: CompanyView; readonly companies: readonly CompanyChoice[] };

resolveSession(input: { readonly userId: string; readonly verifiedEmails?: readonly string[] }): Promise<SessionState>;
setActiveCompany(input: { readonly userId: string; readonly tenantId: string }): Promise<CompanyView>;
```

`CompanyView`, `CompanyChoice`, `PendingForMe` and `UserFacts` are the server
shapes of `CompanyWire`, `CompanyChoiceWire`, `PendingForMeWire` and the
session's `user` (section 7.3).

How `resolveSession` decides:

1. **Find the live memberships.** That means active `tenant_members` rows
   joined to tenants that aren't deleted:
   - in companies mode, filtered to `kind = 'org'`;
   - in personal mode, filtered to `kind = 'personal'`.
2. **Order them deterministically.** Never rely on emission order (Riddler's
   ordering bug):
   1. companies that aren't suspended, before suspended ones;
   2. in personal mode only, the user's OWN workspace
      (`personalWorkspaceId(userId)`) before any workspace they were invited
      into;
   3. then membership `created_at` ascending;
   4. then `tenant_id` ascending.
3. **Use the pointer if it's still good.** If `users.active_tenant_id` names a
   live membership, that is the company.
4. **Otherwise, take the first in order and rewrite the pointer**:
   `update … where id = $1 and active_tenant_id is distinct from $chosen`.
5. **If there's no membership at all:**
   - In companies mode, return `needs-onboarding`. Its `invitations` come from
     `invitationsForMe({ verifiedEmails })`, which is empty without that input.
   - In personal mode, run `provisionUser` once to heal, and retry once. If
     there's still nothing, throw `internal`.
6. **Return the state:**
   - If the chosen company is suspended, return `suspended`. Its `companies`
     lists every live membership, each choice flagged with `status`.
   - Otherwise return `ready`.

`setActiveCompany` checks that the caller is an active member, the company
isn't deleted, and its `kind` matches the mode. Anything else is `not_found`,
the same answer for a foreign id and a missing one. A suspended company may be
chosen; the page then shows the suspended screen. It writes the pointer and
returns the view.

### 6.4 Creating a company (D6, D10)

```ts
checkSlug(input: { readonly actorUserId: string; readonly slug?: string; readonly name?: string; readonly tenantId?: string }): Promise<SlugCheck>;
// SlugCheck = SlugCheckWire (7.3). Given only `name`, suggest from it and check the suggestion.
// Given `tenantId`, the actor must hold tenant.view there (else not_found), and the
// company's own current slug and its own retired slugs count as available.

createCompany(input: {
  readonly userId: string;
  readonly name: string;
  readonly slug?: string;                 // absent → suggested from the name; collisions get -2, -3 … automatically
  readonly requestKey: string;            // a UUID from the form's mount; 8..64 chars of [A-Za-z0-9-]
  readonly purpose: "onboarding" | "additional";
  readonly request?: RequestFacts;
}): Promise<{ readonly status: "created" | "replayed" | "already-onboarded"; readonly company: CompanyView }>;
```

In personal mode `createCompany` answers `unavailable`.

**Before the transaction**, it validates:

- the name: `normaliseCompanyName`, then `companyNameProblem`. A problem
  answers `name_invalid`.
- an explicit slug: lowercased and trimmed, then `validateSlug` against the
  reserved set. A problem answers `slug_invalid` or `slug_reserved`, each with a
  `suggestion`.

**The transaction** takes the per-user advisory lock first, then works through
these steps:

1. **Lock.** Take
   `pg_advisory_xact_lock(hashtextextended('adminigloo:tenancy:create:' || userId, 0))`.
   Every create for one user waits its turn here.
2. **Replay.** If a tenant has `created_by = userId and creation_key =
   requestKey`, make sure its membership, owner role and pointer exist, and
   return `{ status: "replayed" }`. A double submit or a refresh lands here.
3. **Guard onboarding.** If `purpose = "onboarding"` and the user already has a
   live org membership, return `{ status: "already-onboarded", company: <the
   session's company> }`. Two tabs racing onboarding with two different keys
   therefore create only one company.
4. **Seed the owner template if missing.** If the `owner` tenant template
   doesn't exist, run `seedPermissionCatalog(tx, { tenant: { catalog:
   tenantCatalog, templates: TENANT_ROLE_TEMPLATES } })` (D10).
5. **Insert the tenant**, with:
   - `id = uuidv7()`;
   - kind `org`;
   - the slug and name;
   - owner and `created_by` both set to `userId`;
   - `creation_key = requestKey`.
6. **Make sure the slug is free.** A slug is taken if it's in `tenants.slug` or
   in `tenant_retired_slugs`. Check both before inserting. If the insert still
   hits a unique violation (a race), catch it through a savepoint:
   - a suggested slug tries the next candidate: `base-2`, `base-3`, … up to
     `-20`, then `base-` plus 4 random characters from `[a-z0-9]`;
   - an explicit slug throws `slug_taken`, with the first free candidate as the
     `suggestion`.
7. **Insert the active membership.**
8. **Grant the owner role** with `assignRoleTemplate(tx, { scope: "tenant",
   tenantId, principalId: userId, templateKey: "owner", actor: { system:
   "createCompany" } })`. After step 4 it can't write zero rows. If it ever
   does, throw `internal`: an owner who holds nothing is never committed.
9. **Point the user at it:** `update users set active_tenant_id = $new`.
10. **Audit** `company.created`, with metadata `{ name, slug, purpose }`.

After the commit, it calls `onEvent({ type: "company.created" })` and returns
`created`.

### 6.5 Profile, branding and logo

Every function here takes `actorUserId` and `tenantId`. Every mutation:

1. locks the company row first (D7);
2. re-resolves the actor's permissions on `tx`;
3. refuses with `forbidden` if the actor doesn't hold the key.

```ts
getCompany(input: { readonly actorUserId: string; readonly tenantId: string }): Promise<{ readonly company: CompanyView; readonly can: readonly string[] }>;
// Needs tenant.view. `can` is the caller's resolved tenant permission keys, so the widget
// can hide what they can't do. The server still refuses.

updateCompanyProfile(input: { readonly actorUserId: string; readonly tenantId: string; readonly name?: string; readonly slug?: string; readonly request?: RequestFacts }): Promise<CompanyView>;
```

`updateCompanyProfile` needs `tenant.edit`.

- **A new name** is validated as in 6.4.
- **A new slug:**
  1. Validate it.
  2. Refuse it if it's taken, in `tenants` or in the retired slugs, by anyone
     other than this company.
  3. Insert the OLD slug into `tenant_retired_slugs` `on conflict do nothing`.
  4. If the NEW slug is one this company retired earlier, delete that retired
     row. Getting your old address back is fine.
- **A personal workspace** can't change its slug (`invalid`).
- **Audit** `company.profile.updated`, with `{ from: {name, slug}, to: {name, slug} }`.

```ts
updateBranding(input: { readonly actorUserId: string; readonly tenantId: string; readonly brandColor: string | null; readonly request?: RequestFacts }): Promise<{ readonly company: CompanyView; readonly brand: BrandColorReport | null }>;
```

`updateBranding` needs `tenant.edit`.

- The colour goes through `normaliseHexColor`. A null input clears it; an
  unparseable value answers `invalid` on `brandColor`.
- It stores `brandColor` and `onBrandColor` (`= textOnColor`) in `branding`,
  merged with the logo keys.
- **It never refuses for contrast.**
- It audits `company.branding.updated`.

```ts
setLogo(input: { readonly actorUserId: string; readonly tenantId: string; readonly file: { readonly bytes: Uint8Array; readonly contentType: string; readonly filename?: string }; readonly request?: RequestFacts }): Promise<CompanyView>;
removeLogo(input: { readonly actorUserId: string; readonly tenantId: string; readonly request?: RequestFacts }): Promise<CompanyView>;
```

Both need `tenant.edit`.

What `setLogo` accepts:

- With no `logos` store configured, it answers `logo_storage_off`.
- It accepts `image/png`, `image/jpeg` and `image/webp`, 1 MB at most. SVG is
  refused because it can carry script.
- It checks the magic bytes too, not just the declared type. Anything else
  answers `logo_invalid`.

The order of `setLogo` matters, so a failed write never leaves the company
without its old logo:

1. `put` FIRST, outside the transaction, at pathname
   `tenancy/logos/{tenantId}/{uuidv7()}.{png|jpg|webp}`.
2. Lock, update `branding.logoUrl` and `branding.logoKey`, and audit.
3. After the commit, make a best-effort `delete` of the previous key, and log a
   failure.
4. If the transaction fails, make a best-effort delete of the new key.

`removeLogo` clears both fields, then makes a best-effort delete of the stored
key.

### 6.6 Settings

```ts
getSettings(input: { readonly actorUserId: string; readonly tenantId: string }): Promise<SettingsView>;          // SettingsView = SettingsWire
updateSettings(input: { readonly actorUserId: string; readonly tenantId: string; readonly section: string; readonly values: unknown; readonly request?: RequestFacts }): Promise<SettingsSectionView>;
readSettings(tenantId: string): Promise<SettingsValues<...>>;   // server-internal, NO permission check: for other packages' server code (Tenancy 2)
```

`getSettings`:

- resolves the caller's permission set;
- includes only the sections whose `viewPermission` the caller holds, and
  answers `forbidden` if that leaves none;
- sets each section's `canEdit` to whether the caller holds its
  `editPermission`;
- reads values through `registry.parse(tenants.settings)`. Parse problems are
  reported the way `onEventError` reports, never thrown.

`updateSettings`, in order:

1. An unknown section answers `not_found`.
2. Lock the company and re-resolve the actor. Without the section's
   `editPermission`, answer `forbidden`.
3. Validate with `fragment.schema.safeParse(values)`. On failure, answer
   `invalid`, with the zod issues mapped to `{ path, message }` in plain words.
4. Write with `update tenants set settings = jsonb_set(coalesce(settings,
   '{}'::jsonb), array[$key], $json::jsonb, true), updated_at = now() where id
   = $1`. This replaces the whole section; unknown keys are already stripped.
5. Audit `company.settings.updated`, with `{ section, changed: [the field keys
   whose value changed] }`. Never record the values.
6. Return the updated section.

### 6.7 The setup checklist

```ts
export function tenancyChecklistItems(hrefs: { readonly companySettings?: string; readonly team?: string }): readonly SetupChecklistItem[];
// defaults: companySettings "/settings/company", team "/settings/team"

getChecklist(input: { readonly actorUserId: string; readonly tenantId: string }): Promise<ChecklistView>;   // tenant.view
dismissChecklistItem(input: { readonly actorUserId: string; readonly tenantId: string; readonly key: string }): Promise<ChecklistView>;  // tenant.edit
hideChecklist(input: { readonly actorUserId: string; readonly tenantId: string }): Promise<ChecklistView>;  // tenant.edit
```

Tenancy 1 ships three items:

| key | order | permission | title | description | actionLabel | href | done when |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `company.details` | 10 | `tenant.edit` | "Add your business details" | "Your time zone, and the email or phone customers can reach you at." | "Add details" | `{companySettings}#details` | `company.timeZone !== null && (company.contactEmail !== null \|\| company.contactPhone !== null)` |
| `team.invite` | 20 | `members.invite` | "Invite your team" | "Add the people who work with you. Each gets an email with a link to join." | "Invite people" | `{team}` | `activeMembers >= 2 \|\| invitationsEverSent >= 1` |
| `company.branding` | 30 | `tenant.edit` | "Add your logo and colour" | "They appear on the pages and emails your customers see." | "Add branding" | `{companySettings}#branding` | `logoUrl !== null \|\| brandColor !== null` |

How the view is built:

- It includes only the items whose `permission` the caller holds.
- `done` comes from each item's `isDone`. `dismissed` comes from
  `setup_state.dismissed`.
- `complete` means every visible item is done or dismissed.
- `hidden` means `setup_state.hiddenAt` is set.
- If an item's `isDone` throws, that item counts as not done, the error goes to
  `onEventError`, and the other items still render.

Writes:

- Dismissing an unknown key answers `not_found`.
- Dismiss and hide lock the company and update `setup_state` with `jsonb`
  functions.
- They aren't audited: they're housekeeping.

### 6.8 The team: list, roles, removal, leaving, transfer (D4, D5, D7, D11, D12)

```ts
getTeam(input: { readonly actorUserId: string; readonly tenantId: string }): Promise<TeamView>;   // members.view; TeamView = TeamWire
```

What `getTeam` returns:

- **Members.** Both active rows and member-suspended rows, with names and
  emails from `users`. The owner comes first, then members by role rank
  (highest first), then by name or email.
- **Roles.** They come from `principal_role` joined to `role_template`. A member
  with no role row is a real case (a template deleted since): it shows
  `roleKey: null` and `roleName: "No role"`.
- **What the caller may do to each row (`actions`).** This is computed on the
  server from the CALLER's role and permissions, so the widget never works out
  a rank itself:
  - `roles` lists every `RoleKey` other than `owner` and the target's current
    one, but only when all of these hold:
    - the caller holds `members.role.change`;
    - the caller isn't the target;
    - the target isn't the owner;
    - `canManageTemplateKey(caller, current)` and `canManageTemplateKey(caller, k)`.
  - `remove` is true when the caller holds `members.remove`, isn't the target,
    the target isn't the owner, and the caller outranks the target (no role
    counts as rank 0).
  - `transferTo` is true when the caller is the owner and holds
    `tenant.transfer`, and the target is active and isn't the caller.
- **`you.canLeave`** is false for the owner, with `leaveBlocked` set to the
  `last_owner` message.
- **`invitableRoles`** lists the roles the caller may invite people as: the
  caller must hold `members.invite`, and `canManageTemplateKey(caller, k)` must
  hold for k ∈ {admin, member, viewer}.
- **`seats`** is `{ limit, used: activeMembers, pending: openInvitations }` when
  a seat source is configured and `limitFor` returns a number. Otherwise it's
  null.

```ts
changeMemberRole(input: { readonly actorUserId: string; readonly tenantId: string; readonly targetUserId: string; readonly roleKey: RoleKey; readonly request?: RequestFacts }): Promise<MemberView>;
```

How `changeMemberRole` works:

1. **Lock.** Lock the company. If it's suspended, answer `company_suspended`.
2. **Check the actor.** Re-resolve the actor's permission set on `tx`. If they
   aren't a member, answer `not_a_member`. Without `members.role.change`,
   answer `forbidden`.
3. **Check the role.** `roleKey === "owner"` answers `owner_must_transfer`.
4. **Check the target.**
   - not an active member: `not_found`;
   - the actor themselves: `self`;
   - the owner (`owner_user_id`): `owner_protected`.
5. **Change it** with `assignRoleTemplate(tx, { scope: "tenant", tenantId,
   principalId: target, templateKey: roleKey, actor: { principalId: actor },
   clearOverrides: "on-change" })`. Its `rank` maps to `rank`, and `self` to
   `self`.
6. **Audit** `member.role.changed`, with `{ from, to, clearedOverrides }`.
7. **Notify** `onEvent` after the commit.

```ts
removeMember(input: { readonly actorUserId: string; readonly tenantId: string; readonly targetUserId: string; readonly request?: RequestFacts }): Promise<{ readonly removed: string }>;
```

How `removeMember` works:

1. **Lock and check the actor.** Lock the company and re-resolve the actor,
   who needs `members.remove`.
2. **Check the target.**
   - the actor themselves: `self`, with the "use Leave" message;
   - not a member: `not_found`;
   - the owner: `owner_protected`.
3. **Check rank.** The actor's rank must be strictly greater than the target's
   (no role counts as 0). Otherwise answer `rank`.
4. **Remove.** In one transaction (D11), delete the membership, the tenant
   `principal_role` row and the tenant overrides, and null their pointer if it
   named this tenant.
5. **Audit** `member.removed`, with `{ role }`.

There's no session to invalidate. The loaders, handlers, page gate and header
slot all read the database on every request, so the removed person is refused
on their very next request. 13.2 proves it.

```ts
leaveCompany(input: { readonly userId: string; readonly tenantId: string; readonly request?: RequestFacts }): Promise<{ readonly left: string }>;
```

How `leaveCompany` works:

1. **Lock.** Lock the company. If the user isn't a member, answer `not_found`.
2. **The owner can't leave**: answer `last_owner`.
3. **Remove** them with the same deletes as removal.
4. **Audit** `member.left`.

Leaving needs no permission: being a member is enough, and that includes
members of a suspended company. Leaving a suspended company is allowed.

```ts
transferOwnership(input: { readonly actorUserId: string; readonly tenantId: string; readonly toUserId: string; readonly confirmName: string; readonly request?: RequestFacts }): Promise<TeamView>;
```

How `transferOwnership` works:

1. **Lock.** Lock the company. If it's suspended, answer `company_suspended`.
2. **Check the actor.** Re-resolve. The actor must be `owner_user_id` AND hold
   `tenant.transfer` (a sealed key). Otherwise answer `forbidden`.
3. **Check the typed confirmation.** If
   `normaliseCompanyName(confirmName).toLowerCase() !==
   normaliseCompanyName(name).toLowerCase()`, answer `confirmation_mismatch`.
4. **Check the target.**
   - the actor themselves: `self`;
   - not an active member: `not_found`.
5. **Hand it over.**
   - Set `owner_user_id` to the target.
   - Give the target the `owner` role and the previous owner `admin`. Both go
     through `assignRoleTemplate` with `actor: { system: "transferOwnership" }`
     and `clearOverrides: "on-change"`.
   - `protectLastKey` isn't used; D4 is asserted in tests instead.
6. **Audit** `company.ownership.transferred` (sensitive), with `{ from, to }`.
7. **Return** the new team view, as the previous owner (now an admin) sees it.

**The races (D7).** 13.2 tests each one in both orders:

- **Transfer to B while B is being removed.**
  - If the removal commits first, the transfer finds B isn't a member and
    answers `not_found`.
  - If the transfer commits first, the removal finds B is the owner and answers
    `owner_protected`.
- **Transfer while the actor is being demoted.** The actor's ownership and
  permission are read under the lock. An actor who has lost `tenant.transfer`
  (say, an override deny was added) or is no longer the owner gets `forbidden`.
- **A role change by an admin who was demoted a moment ago.** The actor's set is
  re-resolved under the lock, so the answer is `forbidden` or `rank`.

### 6.9 Invitations (D16, D18, D19)

```ts
listInvitations(input: { readonly actorUserId: string; readonly tenantId: string }): Promise<readonly InvitationView[]>;
// members.invite. Pending and expired only (as the 0.3 router), newest first.
// Each row carries canResend and canRevoke, from the caller's rank against the invitation's role.

sendInvitation(input: { readonly actorUserId: string; readonly tenantId: string; readonly email: string; readonly roleKey: RoleKey; readonly request?: RequestFacts }): Promise<IssuedInvitation>;
resendInvitation(input: { readonly actorUserId: string; readonly tenantId: string; readonly invitationId: string; readonly request?: RequestFacts }): Promise<IssuedInvitation>;
// IssuedInvitation = { invitation: InvitationView; token: string; expiresAt: Date }.
// The token exists only in this return value.

revokeInvitation(input: { readonly actorUserId: string; readonly tenantId: string; readonly invitationId: string; readonly request?: RequestFacts }): Promise<{ readonly id: string }>;
```

**Sending and resending** happen in one transaction. The lock order is the
company row, then the invitation row (through the service's upsert).

1. **Lock.** Lock the company. If it's suspended, answer `company_suspended`.
2. **Mode.** In companies mode, a `kind = 'personal'` tenant answers
   `personal_workspace`.
3. **Check the actor.** Re-resolve; the actor needs `members.invite`.
4. **Check the role.**
   - `roleKey === "owner"`: `owner_must_transfer`.
   - the actor has no role: `forbidden`.
   - `!canManageTemplateKey(actorKey, roleKey)`: `rank`.
5. **Check the email.** Normalise it. If an active member already has that
   email, answer `already_member`.
6. **Check seats (D16).**
   - Call `seats.limitFor(tx)`.
   - Count active members plus open pending invitations. Pending means not
     accepted, not revoked and not expired. On a resend, leave out this email's
     existing open row.
   - That count plus 1 must be at most the limit. Otherwise answer `seats_full`,
     with the limit and the count in the message and the `upgradeHref`.
7. **Send.** Call `createInvitationService({ db: tx, … }).send({ … })`. The
   UPSERT is unchanged.
8. **Audit** `invitation.sent`, with `{ email, roleKey, resend: boolean }`.

**Resending** first looks the invitation up within this tenant. It answers
`not_found` if the invitation is foreign, accepted or revoked. It re-checks the
rank against the invitation's role, then calls `send` with the same email and
role. That rotates the token on the same row.

**Revoking:**

- The id must belong to this tenant; otherwise answer `not_found`. This is the
  IDOR guard from the 0.3 router.
- The actor must outrank the invitation's role.
- Then call `service.revoke`, and audit `invitation.revoked` with
  `{ email, roleKey, previousState }`.

The service returns the token. Delivering the email is the handler's job, after
the commit (section 7.1).

```ts
acceptInvitation(input: { readonly token: string; readonly userId: string; readonly request?: RequestFacts }): Promise<AcceptOutcome>;
joinInvitation(input: { readonly invitationId: string; readonly userId: string; readonly verifiedEmails: readonly string[]; readonly request?: RequestFacts }): Promise<AcceptOutcome>;
invitationsForMe(input: { readonly verifiedEmails: readonly string[] }): Promise<readonly PendingForMe[]>;

export type AcceptOutcome =
  | { readonly status: "accepted" | "already-a-member"; readonly company: { readonly id: string; readonly name: string } }
  | { readonly status: "expired" | "revoked" | "wrong-email" | "unknown" }
  | { readonly status: "company-unavailable" }
  | { readonly status: "seats-full"; readonly message: string };
```

How `acceptInvitation` works:

1. **Find the company, without a lock**:
   `select tenant_id from tenant_invitations where token_hash = $hash`. If
   there's no row, answer `unknown`.
2. **Lock the company** in a transaction. If it's deleted or suspended, answer
   `company-unavailable`.
3. **Accept** with `createInvitationService({ db: tx, requireMatchingEmail,
   beforeConsume }).accept(token, userId)`. The service's `FOR UPDATE` on the
   invitation row comes second, after the company lock (D7).
4. **Check seats in `beforeConsume(tx, { tenantId, userId })`.** The hook runs
   after the identity gate and the state checks, right before consuming. If
   active members plus 1 would exceed the limit, it returns `{ refuse:
   "seats-full", message }`. The service then returns `{ status: "refused",
   reason }` and consumes nothing.
5. **On `accepted`:**
   - write the pointer (`active_tenant_id = tenantId`), so the invitee lands in
     the inviting company;
   - audit `invitation.accepted`, with the INVITEE as the actor.
6. **Map the service's result:**

   | Service result | Outcome |
   | --- | --- |
   | `wrong-email` | `wrong-email`, with `invitedEmail` dropped |
   | `unknown-token` | `unknown` |
   | `refused` | `seats-full` |
   | `already-a-member` | `already-a-member`, and the pointer is written too |

**Accepting after being removed.** X accepted, was removed, then presses accept
again from a second tab or a double click. The invitation row is `accepted` and
X isn't a member, so the service answers `unknown-token`, which maps to
`unknown`. The removal sticks. 13.2 tests it.

`joinInvitation` follows the same flow, with two differences:

- It finds the company by invitation id (no lock), then calls
  `service.acceptForVerifiedEmail(id, userId, verifiedEmails)` in place of the
  token lookup.
- Its identity check is that the invitation's email is in the normalised
  `verifiedEmails`. Otherwise it answers `wrong-email`.

Everything after that is the same as the token path.

`invitationsForMe`:

- lists open invitations (pending and not expired) addressed to any of the
  normalised verified emails, in companies that aren't suspended or deleted;
- returns `{ id, companyName, roleKey, roleName, invitedBy, expiresAt }` for
  each, where `invitedBy` is the inviter's display name or email;
- returns `[]` for an empty input.

**Changes to `createInvitationService`** (`src/service.ts`). They are additive
only:

```ts
// CreateInvitationServiceDeps gains:
readonly beforeConsume?: (tx: InvitationDb, input: { readonly tenantId: string; readonly userId: string }) =>
  Promise<{ readonly refuse: string; readonly message: string } | null>;

// AcceptResult gains:
| { readonly status: "refused"; readonly reason: string; readonly message: string; readonly tenantId: string }

// InvitationService gains:
acceptForVerifiedEmail(invitationId: string, userId: string, verifiedEmails: readonly string[]): Promise<AcceptResult>;
```

`acceptForVerifiedEmail`:

- locks the invitation row by id (`FOR UPDATE`);
- checks identity by "the invited email is in the normalised verifiedEmails",
  instead of the token check plus `resolveAccepterEmail`;
- from the state checks onward, reuses the exact consume path. Factor it out.

The existing tests stay green, unchanged.

### 6.10 The membership gate (D15)

```ts
export const tenancyMembershipGate: MembershipGate;
```

It runs one query:

```sql
select m.status as member_status, t.suspended_at, t.deleted_at
from tenant_members m join tenants t on t.id = m.tenant_id
where m.tenant_id = $tenantId and m.user_id = $userId
limit 1
```

| Result | Verdict |
| --- | --- |
| No row, or `deleted_at` is set, or `member_status <> 'active'` | `not-a-member` |
| `suspended_at` is set | `company-suspended` |
| Anything else | `member` |

The gate doesn't filter on `kind`. For authorisation, a personal workspace is a
tenant like any other; D6 only shapes how the session is resolved.

### 6.11 Operator (staff) functions

Every operator function takes `actorUserId` and checks the caller first:

- it resolves `loaders.loadStaffPermissions`, and answers `not_staff` if that's
  null;
- it answers `forbidden` if the caller lacks the key the route needs.

```ts
listCompanies(input: { readonly actorUserId: string; readonly q?: string; readonly kind?: "org" | "personal" | "all"; readonly status?: "active" | "suspended" | "all"; readonly page?: number; readonly pageSize?: number }): Promise<AdminCompanyList>;
```

`listCompanies` needs `staff.tenants.view`.

- **Defaults.** Kind `"org"` (so personal workspaces are hidden), status
  `"all"`, page 1, pageSize 25 (100 at most).
- **Search.** `q` is trimmed and capped at 100 characters. It matches
  `name ILIKE`, `slug ILIKE`, the owner's email `ILIKE`, or `id = q` exactly.
  Escape `%`, `_` and `\` in `q`.
- **Order.** `created_at desc, id desc`. `total` comes from a `count(*)` with
  the same filter.
- **Rows.** Each carries `members` (the active count) and `owner`
  (`{ userId, email, name }`). Deleted tenants are excluded.

```ts
getCompanyDetail(input: { readonly actorUserId: string; readonly tenantId: string }): Promise<AdminCompanyDetail>;
```

`getCompanyDetail` needs `staff.tenants.view`. An unknown or deleted id answers
`not_found`. It returns:

- **the company's facts:**
  - status, and the suspension's reason and who suspended it;
  - when it was created and by whom;
  - the owner, and whether the owner's account is deleted;
  - the web address, logo and colour;
  - the time zone and contact details, from the `company` settings;
- **the members**, with roles and status;
- **the count** of pending invitations;
- **`can.suspend`**, true when the caller holds `staff.tenants.suspend`;
- **`activity: null`.** The HANDLER fills it in from its `recentAudit` option
  (7.2).

```ts
suspendCompany(input: { readonly actorUserId: string; readonly tenantId: string; readonly reason: string; readonly request?: RequestFacts }): Promise<AdminCompanyDetail>;
reactivateCompany(input: { readonly actorUserId: string; readonly tenantId: string; readonly request?: RequestFacts }): Promise<AdminCompanyDetail>;
```

Both need `staff.tenants.suspend`.

- **The reason** is trimmed and must be 3–500 characters; otherwise answer
  `invalid`.
- **Lock** the company row.
- **Suspend** sets `suspended_at`, `suspended_reason` and `suspended_by`.
  **Reactivate** nulls all three.
- **Both are idempotent.** Suspending a company that's already suspended keeps
  the first timestamp and reason, and returns the detail.
- **Audit** `company.suspended` with `{ reason }`, or `company.reactivated`, at
  scope `staff`.
- **Notify** `onEvent` after the commit.

```ts
listPeople(input: { readonly actorUserId: string; readonly q?: string; readonly staffOnly?: boolean; readonly page?: number; readonly pageSize?: number }): Promise<AdminPeople>;
listStaffRoles(input: { readonly actorUserId: string }): Promise<readonly StaffRoleView[]>;
setStaffRole(input: { readonly actorUserId: string; readonly targetUserId: string; readonly templateKey: string | null; readonly request?: RequestFacts }): Promise<AdminPerson>;
```

**`listPeople`** needs `staff.people.view`.

- It lists users who aren't deleted.
- `q` matches email or display name with `ILIKE`, escaped.
- Defaults: page 1, pageSize 25 (100 at most), ordered by `created_at desc`.
- Each row carries:
  - `companies`, the count of active memberships;
  - `staffRole`, from `roleOf`;
  - `canChange`, true when the actor holds `staff.roles.manage`, isn't the
    target, and outranks the target's current role.
- The response also carries `roles` (from `listRoleTemplates` for staff, each
  `assignable` when the actor's rank is greater than the template's) and `you`.

**`listStaffRoles`** needs `staff.roles.view`, and returns the same `roles`.

**`setStaffRole`** needs `staff.roles.manage`.

- It calls `assignRoleTemplate(db, { scope: "staff", principalId: target,
  templateKey, actor: { principalId: actor }, protectLastKey: "admin",
  clearOverrides: "on-removal" })`.
- It maps the errors:

  | `assignRoleTemplate` error | Answer |
  | --- | --- |
  | `last-holder` | `last_admin` |
  | `rank` | `rank` |
  | `self` | `self` |
  | `unknown-template` | `invalid` |

- If the target isn't a user, or is deleted, it answers `not_found`.
- It audits `staff.role.assigned` with `{ from, to }`, or `staff.role.removed`.
- It returns the updated person.

### 6.12 Public lookup by web address

```ts
resolveCompanyBySlug(slug: string): Promise<{ readonly company: PublicCompany; readonly retiredSlug: string | null } | null>;
export interface PublicCompany { readonly id: string; readonly name: string; readonly slug: string; readonly logoUrl: string | null; readonly brandColor: string | null; readonly onBrandColor: "#ffffff" | "#111111" | null; readonly contactEmail: string | null; readonly contactPhone: string | null }
```

How it resolves a slug:

1. Lowercase the slug.
2. Look for a `kind = 'org'` company that isn't suspended or deleted. If none is
   found, return null.
3. If the slug isn't current, fall back to `tenant_retired_slugs`. A match sets
   `retiredSlug` to the requested slug, and returns the company as it is now,
   with its current slug. Tenancy 2 turns that into a redirect.
4. A retired slug whose company is suspended returns null.

It needs no permission: this is the public face.

### 6.13 Reading helpers for the host

```ts
companyFor(tenantId: string): Promise<CompanyView | null>;   // no permission; for server pages that already gated (e.g. the header)
```

This reads a company without checking permission. Use it only from server pages
that have already been through the gate, such as the header.

---

## 7. Routes and wire types (server AND widget builders; declare verbatim)

The handlers live in `@adminigloo/tenancy/server`. The wire types are declared
twice: by the server in `src/wire.ts`, and by the widget in `src/types.ts`.
**The two copies are byte-identical.** Each file wraps the section 7.3 block in
`// WIRE:BEGIN` and `// WIRE:END` lines, and a widget test reads both files and
compares the regions (13.5). `TenancyErrorCode` (6.1) sits inside the region
in both copies.

### 7.1 `createTenancyHandlers`: the company routes

```ts
export interface TenancyPrincipal { readonly userId: string; readonly email: string | null }
export type TenancyRateBucket = "create-company" | "slug-check" | "switch" | "invite" | "accept" | "logo" | "write" | "operator-write";
export const TENANCY_RATE_LIMITS: Readonly<Record<TenancyRateBucket, { readonly limit: number; readonly windowMs: number }>>;
// create-company 10/hour per user · slug-check 120/minute per user · switch 60/minute per user · invite 50/hour per tenant ·
// accept 20/10 minutes per user · logo 20/hour per tenant · write 120/minute per user · operator-write 60/hour per user

export interface InvitationDelivery {
  readonly to: string;
  readonly tenantId: string;
  readonly companyName: string;
  readonly invitedBy: string | null;     // the inviter's display name or email
  readonly roleName: string;
  readonly url: string;                  // carries the token; goes in the email only
  readonly expiresAt: Date;
  readonly invitationId: string;
}

export interface CreateTenancyHandlersOptions {
  readonly tenancy: TenancyService;
  /** Who is signed in. null → 401 signed_out. create-app passes currentPrincipal (which also provisions). */
  readonly principal: (req: Request) => Promise<TenancyPrincipal | null>;
  /** The caller's VERIFIED addresses, from the identity provider, on the server (D19). Absent → no invitations by email. */
  readonly verifiedEmails?: (req: Request) => Promise<readonly string[]>;
  /** The absolute link mailed to an invitee. */
  readonly invitationUrl: (token: string) => string;
  /** Sends the invitation email after commit. Absent → delivery "skipped" and the link is returned to the inviter. */
  readonly deliverInvitation?: (input: InvitationDelivery) => Promise<{ readonly status: "sent" | "skipped" | "failed" }>;
  /** Your rate limiter. Absent → unlimited. */
  readonly limit?: (input: { readonly bucket: TenancyRateBucket; readonly key: string }) => Promise<{ readonly allowed: boolean; readonly retryAfterSeconds?: number }>;
  /** The IP and user agent recorded in the audit. Default: x-forwarded-for's first hop or x-real-ip, and user-agent. */
  readonly requestFacts?: (req: Request) => RequestFacts;
  /** Your error reporter, for the 500s only. */
  readonly onError?: (error: unknown, req: Request) => void | Promise<void>;
}
export interface TenancyHandlers { handle(req: Request): Promise<Response> }
export function createTenancyHandlers(options: CreateTenancyHandlersOptions): TenancyHandlers;

export interface TenancyRoute {
  readonly kind: TenancyRouteKind;
  readonly method: "GET" | "POST";
  readonly path: string;            // relative to the mount, e.g. "v1/companies/:tenantId/members/:userId/remove"
  readonly scope: "signed-in" | "company" | "staff";
  readonly permission: string | null;   // null = membership (company) or sign-in only; "fragment" = the settings section's own view/edit permission
  readonly bucket: TenancyRateBucket | null;
}
export const TENANCY_ROUTES: readonly TenancyRoute[];
export const TENANCY_OPERATOR_ROUTES: readonly TenancyRoute[];
```

**Routing.** A request is routed by the path suffix that follows the `/v1/`
segment, so the handler works wherever it's mounted. The scheduling 0.4
mechanics apply:

- a wrong method answers `405`, with `allow` set;
- an unknown path answers `404 not_found`;
- `OPTIONS` answers `204` with no CORS headers.

Nothing here is ever cross-origin.

**Every request runs these steps, in order:**

1. **Match the route.**
2. **POSTs only: refuse cross-site requests.** Use scheduling's
   `isCrossSiteRequest`; a failure answers `403 cross_site`.
3. **Sign-in.** Call `principal(req)`. Null answers `401 signed_out`.
4. **Rate limit.** If the route has a bucket and `limit` is set, call `limit({
   bucket, key })`. The key is `user:{userId}`, or `tenant:{tenantId}` for the
   invite and logo buckets. Not allowed answers `429 rate_limited`, with
   `retry-after`.
5. **Validate params.** Path params must be 1–128 characters of `[A-Za-z0-9_-]`;
   otherwise answer `404 not_found`.
6. **Validate the body with zod.** JSON is capped at 16 KB; a logo is
   multipart, capped at 1.2 MB. A bad body answers `400 invalid` with `issues`.
7. **Call the service.** A `TenancyError` becomes `{ error: { code, message,
   issues?, suggestion?, upgradeHref? } }` with its status. Anything else
   becomes `500 internal`, passed to `onError`. Never echo it to the caller.
8. **Respond.** Every response carries `cache-control: no-store` and
   `content-type: application/json; charset=utf-8`.

**Authorisation lives in the service.** Every service method re-resolves
membership and permission itself (D7). The handler never pre-checks a
permission. The route table's `permission` column documents which key the
service enforces, and the handler tests read it back.

| kind | method | path | scope | permission | bucket | body → 200 response |
| --- | --- | --- | --- | --- | --- | --- |
| `session` | GET | `v1/session` | signed-in | — | — | → `SessionWire` |
| `slug-check` | GET | `v1/slug?name=&slug=&tenantId=` | signed-in | null (the service also needs `tenant.view` when `tenantId` is given) | slug-check | → `SlugCheckWire` |
| `company-create` | POST | `v1/companies` | signed-in | — | create-company | `CreateCompanyBody` → `CreateCompanyWire` |
| `active-set` | POST | `v1/active` | signed-in | membership | switch | `SetActiveBody` → `{ company: CompanyWire }` |
| `invite-accept` | POST | `v1/invitations/accept` | signed-in | the token | accept | `AcceptBody` → `AcceptWire` |
| `invite-join` | POST | `v1/invitations/:invitationId/join` | signed-in | verified email | accept | `{}` → `AcceptWire` |
| `company-get` | GET | `v1/companies/:tenantId` | company | `tenant.view` | — | → `CompanyProfileWire` |
| `profile-update` | POST | `v1/companies/:tenantId/profile` | company | `tenant.edit` | write | `ProfileBody` → `{ company: CompanyWire }` |
| `branding-update` | POST | `v1/companies/:tenantId/branding` | company | `tenant.edit` | write | `BrandingBody` → `BrandingWire` |
| `logo-upload` | POST | `v1/companies/:tenantId/logo` | company | `tenant.edit` | logo | multipart field `file` → `{ company: CompanyWire }` |
| `logo-remove` | POST | `v1/companies/:tenantId/logo/remove` | company | `tenant.edit` | write | `{}` → `{ company: CompanyWire }` |
| `settings-get` | GET | `v1/companies/:tenantId/settings` | company | `"fragment"` (each section's `viewPermission`) | — | → `SettingsWire` |
| `settings-update` | POST | `v1/companies/:tenantId/settings/:section` | company | `"fragment"` (the section's `editPermission`) | write | `SettingsBody` → `{ section: SettingsSectionWire }` |
| `checklist-get` | GET | `v1/companies/:tenantId/checklist` | company | `tenant.view` | — | → `ChecklistWire` |
| `checklist-dismiss` | POST | `v1/companies/:tenantId/checklist/:itemKey/dismiss` | company | `tenant.edit` | write | `{}` → `ChecklistWire` |
| `checklist-hide` | POST | `v1/companies/:tenantId/checklist/hide` | company | `tenant.edit` | write | `{}` → `ChecklistWire` |
| `team-get` | GET | `v1/companies/:tenantId/members` | company | `members.view` | — | → `TeamWire` |
| `member-role` | POST | `v1/companies/:tenantId/members/:userId/role` | company | `members.role.change` | write | `RoleBody` → `{ member: MemberWire }` |
| `member-remove` | POST | `v1/companies/:tenantId/members/:userId/remove` | company | `members.remove` | write | `{}` → `{ removed: string }` |
| `leave` | POST | `v1/companies/:tenantId/leave` | company | membership | write | `{}` → `{ left: string }` |
| `transfer` | POST | `v1/companies/:tenantId/transfer` | company | `tenant.transfer` | write | `TransferBody` → `TeamWire` |
| `invitations-list` | GET | `v1/companies/:tenantId/invitations` | company | `members.invite` | — | → `InvitationsWire` |
| `invitation-send` | POST | `v1/companies/:tenantId/invitations` | company | `members.invite` | invite | `InviteBody` → `IssuedWire` |
| `invitation-resend` | POST | `v1/companies/:tenantId/invitations/:invitationId/resend` | company | `members.invite` | invite | `{}` → `IssuedWire` |
| `invitation-revoke` | POST | `v1/companies/:tenantId/invitations/:invitationId/revoke` | company | `members.invite` | write | `{}` → `{ id: string }` |

**Invitation delivery** (`invitation-send` and `invitation-resend`):

1. The service commits and returns the token.
2. The handler builds `url = invitationUrl(token)`.
3. It calls `deliverInvitation` (no deliverer means `"skipped"`), and catches a
   throw as `"failed"`.
4. It answers with `IssuedWire`. `link` is null when the email went out
   (`"sent"`), and the URL otherwise. That's the 0.3 router's rule, with its
   comment ported.

The token is never logged, audited or returned when the email was sent.

**Personal mode.** In personal mode, `company-create`, `invite-join` and
`active-set` answer `404 unavailable`. The session reports `mode: "personal"`.

### 7.2 `createTenancyOperatorHandlers`: staff routes

```ts
export interface CreateTenancyOperatorHandlersOptions {
  readonly tenancy: TenancyService;
  readonly principal: (req: Request) => Promise<TenancyPrincipal | null>;
  /** Recent activity for a company's detail page, newest first. Absent → activity: null ("not connected"). */
  readonly recentAudit?: (input: { readonly tenantId: string; readonly limit: number }) => Promise<readonly AuditLineWire[]>;
  readonly limit?: CreateTenancyHandlersOptions["limit"];
  readonly requestFacts?: CreateTenancyHandlersOptions["requestFacts"];
  readonly onError?: CreateTenancyHandlersOptions["onError"];
}
export function createTenancyOperatorHandlers(options: CreateTenancyOperatorHandlersOptions): TenancyHandlers;
```

| kind | method | path | permission | bucket | body → 200 response |
| --- | --- | --- | --- | --- | --- |
| `admin-companies` | GET | `v1/admin/companies?q=&kind=&status=&page=&pageSize=` | `staff.tenants.view` | — | → `AdminCompanyListWire` |
| `admin-company` | GET | `v1/admin/companies/:tenantId` | `staff.tenants.view` | — | → `AdminCompanyDetailWire` (`activity` from `recentAudit`, limit 20) |
| `admin-suspend` | POST | `v1/admin/companies/:tenantId/suspend` | `staff.tenants.suspend` | operator-write | `SuspendBody` → `AdminCompanyDetailWire` |
| `admin-reactivate` | POST | `v1/admin/companies/:tenantId/reactivate` | `staff.tenants.suspend` | operator-write | `{}` → `AdminCompanyDetailWire` |
| `admin-people` | GET | `v1/admin/people?q=&staffOnly=&page=&pageSize=` | `staff.people.view` | — | → `AdminPeopleWire` |
| `admin-staff-roles` | GET | `v1/admin/staff-roles` | `staff.roles.view` | — | → `{ roles: StaffRoleWire[] }` |
| `admin-staff-role-set` | POST | `v1/admin/people/:userId/staff-role` | `staff.roles.manage` | operator-write | `StaffRoleBody` → `{ person: AdminPersonWire }` |

The steps are the same as 7.1. Someone signed in without a staff role answers
`403 not_staff`.

### 7.3 Wire types

```ts
export type Instant = string;           // ISO 8601, UTC ("2026-10-12T15:04:05.000Z")
export type RoleKey = "owner" | "admin" | "member" | "viewer";
export type CompanyStatus = "active" | "suspended";
export type CompanyKind = "org" | "personal";

export interface WireIssue { path: (string | number)[]; message: string }
export interface WireErrorBody {
  error: { code: TenancyErrorCode; message: string; issues?: WireIssue[]; suggestion?: string; upgradeHref?: string };
}

export interface CompanyWire {
  id: string;
  name: string;
  slug: string;
  kind: CompanyKind;
  status: CompanyStatus;
  logoUrl: string | null;
  brandColor: string | null;
  onBrandColor: "#ffffff" | "#111111" | null;
  publicPath: string;                 // "/t/" + slug (reserved now; Tenancy 2 serves pages under it)
  createdAt: Instant;
  role: RoleKey | null;               // the caller's
  isOwner: boolean;                   // the caller is the owner
}
export interface CompanyChoiceWire {
  id: string; name: string; slug: string; logoUrl: string | null;
  role: RoleKey | null; status: CompanyStatus; active: boolean;
}
export interface PendingForMeWire {
  id: string; companyName: string; roleKey: RoleKey | null; roleName: string;
  invitedBy: string | null; expiresAt: Instant | null;
}
export interface SessionWire {
  mode: "companies" | "personal";
  state: "needs-onboarding" | "ready" | "suspended";
  user: { userId: string; email: string | null; name: string | null };
  company: CompanyWire | null;        // null exactly when needs-onboarding
  companies: CompanyChoiceWire[];     // [] when needs-onboarding
  invitations: PendingForMeWire[];    // non-empty only when needs-onboarding
  formerCompany: string | null;       // needs-onboarding only: the name of the company they were removed from or left
}

export type SlugProblemWire = "too-short" | "too-long" | "invalid" | "reserved" | "taken";
export interface SlugCheckWire {
  slug: string;                       // what was checked (normalised); with only `name`, the suggestion
  available: boolean;
  problem: SlugProblemWire | null;
  message: string | null;             // plain sentence when not available
  suggestion: string;                 // always a free, valid slug
}
export interface CreateCompanyBody { name: string; slug?: string; requestKey: string; purpose?: "onboarding" | "additional" } // purpose default "onboarding"
export interface CreateCompanyWire { status: "created" | "replayed" | "already-onboarded"; company: CompanyWire }
export interface SetActiveBody { tenantId: string }

export interface AcceptBody { token: string }  // 1..512 chars
export interface AcceptWire {
  status: "accepted" | "already-a-member" | "expired" | "revoked" | "wrong-email" | "unknown" | "company-unavailable" | "seats-full";
  company: { id: string; name: string } | null;     // set for accepted / already-a-member only
  message: string | null;                            // set for seats-full only
}
export interface InvitationPreviewWire {
  found: boolean;                     // false for a used, withdrawn, expired or unknown link, or an unavailable company
  companyName: string | null;
  roleName: string | null;
  invitedBy: string | null;           // the inviter's name or email
  // Review R2 T1BO-07: is it for one of the signed-in person's verified
  // addresses? null when unknown (no caller, or the site doesn't match emails).
  addressMatches: boolean | null;
  sentTo: string | null;              // addressMatches === false only: the invited address, masked ("c•••@greenblade.test")
  signedInAs: string | null;          // addressMatches === false only: the caller's own address
}

export interface CompanyProfileWire { company: CompanyWire; can: string[]; logoUploads: boolean }
export interface ProfileBody { name?: string; slug?: string }
export interface BrandingBody { brandColor: string | null }
export interface BrandColorReportWire {
  color: string; textOnColor: "#ffffff" | "#111111";
  ratioWithWhiteText: number; ratioWithDarkText: number; ratioOnWhitePage: number;
  readable: boolean; warning: string | null;
}
export interface BrandingWire { company: CompanyWire; brand: BrandColorReportWire | null }

export type SettingsFieldKind = "text" | "textarea" | "email" | "tel" | "url" | "timezone" | "select" | "toggle" | "number";
export interface SettingsFieldWire {
  key: string; label: string; help: string | null; kind: SettingsFieldKind;
  options: { value: string; label: string }[] | null;
  placeholder: string | null; autoComplete: string | null;
  width: "full" | "half"; required: boolean;
  min: number | null; max: number | null; step: number | null;
}
export interface SettingsSectionWire {
  key: string; label: string; description: string | null;
  fields: SettingsFieldWire[];
  values: Record<string, string | number | boolean | null>;
  canEdit: boolean;
}
export interface SettingsWire { sections: SettingsSectionWire[] }
export interface SettingsBody { values: Record<string, string | number | boolean | null> }

export interface ChecklistItemWire { key: string; title: string; description: string; actionLabel: string; href: string; done: boolean; dismissed: boolean }
export interface ChecklistWire { items: ChecklistItemWire[]; done: number; total: number; complete: boolean; hidden: boolean }

export interface RoleOptionWire { key: RoleKey; name: string; description: string; rank: number }
export interface MemberWire {
  userId: string; name: string | null; email: string | null;
  roleKey: RoleKey | null; roleName: string;
  isOwner: boolean; isYou: boolean;
  status: "active" | "suspended";
  joinedAt: Instant;
  actions: { roles: RoleKey[]; remove: boolean; transferTo: boolean };
}
export interface TeamWire {
  company: { id: string; name: string; kind: CompanyKind };
  you: {
    userId: string; roleKey: RoleKey | null; isOwner: boolean;
    canInvite: boolean; canLeave: boolean; leaveBlocked: string | null; canTransfer: boolean;
  };
  members: MemberWire[];
  roles: RoleOptionWire[];            // owner, admin, member, viewer, highest first
  invitableRoles: RoleKey[];
  seats: { limit: number; used: number; pending: number } | null;
}
export interface RoleBody { roleKey: RoleKey }
export interface TransferBody { toUserId: string; confirmName: string }

export interface InvitationWire {
  id: string; email: string; roleKey: RoleKey | null; roleName: string;
  state: "pending" | "expired"; expiresAt: Instant | null; createdAt: Instant;
  canResend: boolean; canRevoke: boolean;
  // Review R3 T1BO-07: the last time someone pressed Accept on its link while
  // signed in with a different address (noted at most once per 10 minutes).
  wrongAccount: { signedInAs: string | null; at: Instant } | null;   // signedInAs masked: "j•••@gmail.com"
}
export interface InvitationsWire { invitations: InvitationWire[] }
export interface InviteBody { email: string; roleKey: RoleKey }   // email: trimmed, 3..254, an address
export interface IssuedWire {
  // "held" (review R3 SEC-T1-B): saved, but this company emailed that address
  // too recently or too often to email it again yet; `link` and `note` say what to do.
  invitation: InvitationWire; delivery: "sent" | "skipped" | "failed" | "held"; link: string | null;
  replaced: boolean;                  // an open invitation to that address was re-sent (its earlier link keeps working)
  note: string | null;                // "held" only: why it wasn't emailed and when it can be, in a sentence
}

// operator
export interface PersonRefWire { userId: string; email: string | null; name: string | null }
export interface AdminCompanyRowWire {
  id: string; name: string; slug: string; kind: CompanyKind; status: CompanyStatus;
  createdAt: Instant; members: number; owner: PersonRefWire | null;
}
export interface AdminCompanyListWire { companies: AdminCompanyRowWire[]; total: number; page: number; pageSize: number }
export interface AdminMemberWire {
  userId: string; name: string | null; email: string | null;
  roleKey: RoleKey | null; roleName: string; isOwner: boolean;
  status: "active" | "suspended"; joinedAt: Instant;
}
export interface AuditLineWire {
  at: Instant; action: string; label: string; actor: string | null; sensitive: boolean;
  detail: string | null;              // plain words from the row's metadata: "Jake: Member → Admin"
}
export interface AdminCompanyDetailWire {
  company: AdminCompanyRowWire & {
    publicPath: string; logoUrl: string | null; brandColor: string | null;
    createdBy: PersonRefWire | null;
    ownerDeleted: boolean;
    suspendedAt: Instant | null; suspendedReason: string | null; suspendedBy: PersonRefWire | null;
    timeZone: string | null; contactEmail: string | null; contactPhone: string | null;
  };
  members: AdminMemberWire[];
  pendingInvitations: number;
  // Review R2 T1BO-09: who is invited, so support can answer "I can't get in".
  invitations: { email: string; roleName: string; invitedBy: string | null; expiresAt: Instant | null }[];
  retiredAddresses: string[];         // old web addresses still pointing here
  activity: AuditLineWire[] | null;   // null = the host connected no activity source
  can: { suspend: boolean; assignOwner: boolean; releaseAddresses: boolean };
}
export interface SuspendBody { reason: string }   // 3..500 chars
export interface AssignOwnerBody { toUserId: string }
export interface StaffRoleWire { key: string; name: string; rank: number; assignable: boolean }
export interface AdminPersonWire {
  userId: string; email: string | null; name: string | null; createdAt: Instant;
  companies: number;
  staffRole: { key: string; name: string; rank: number } | null;
  isYou: boolean; canChange: boolean;
}
export interface AdminPeopleWire {
  people: AdminPersonWire[]; total: number; page: number; pageSize: number;
  roles: StaffRoleWire[];
  you: { userId: string; roleKey: string | null };
}
export interface StaffRoleBody { templateKey: string | null }
```

Each section is listed with the code that implements it:

| Section | Implemented by |
| --- | --- |
| 6.3 | `session` |
| 6.4 | `slug-check`, `company-create` |
| 6.5 | `company-get`, `profile-update`, `branding-update`, `logo-*` |
| 6.6 | `settings-*` |
| 6.7 | `checklist-*` |
| 6.8 | `team-get`, `member-*`, `leave`, `transfer` |
| 6.9 | `invitation*`, `invite-*` |
| 6.11 | `admin-*` |
| `TENANCY_WIRE_VERSION` | `"v1"`, both packages |

---

## 8. `@adminigloo/tenancy-widget` 0.1.0 (widget builder)

The skeleton is already in place. React is the only peer. The widget needs no
Tailwind and no CSS import step from the buyer.

Copy what you need from scheduling-widget, but don't import it. Take these
modules and pieces:

- `http.ts`: `createRequester`, `toClientError`, and the narrow checks;
- `theme.ts`;
- the token and style injection pattern;
- `admin/ui.tsx`'s focus-trapped dialog, notices and status;
- `US_TIME_ZONES`.

The CSS prefix is `aitw-`. The root class is `.aitw-root`, and tokens are named
`--aitw-*`.

### 8.1 Transports (never throw)

```ts
export type Result<T> = { ok: true; data: T } | { ok: false; error: ClientError };
export interface ClientError {
  code: TenancyErrorCode | "network" | "bad_response";
  message: string;          // the server's plain sentence, or ours
  status: number;           // 0 when no answer
  issues?: WireIssue[];
  suggestion?: string;
  upgradeHref?: string;
}
export interface TransportOptions { baseUrl: string; fetch?: typeof fetch; headers?: Record<string, string> }

export interface TenancyTransport {
  session(): Promise<Result<SessionWire>>;
  checkSlug(q: { name?: string; slug?: string; tenantId?: string }): Promise<Result<SlugCheckWire>>;
  createCompany(body: CreateCompanyBody): Promise<Result<CreateCompanyWire>>;
  setActive(tenantId: string): Promise<Result<{ company: CompanyWire }>>;
  acceptInvitation(token: string): Promise<Result<AcceptWire>>;
  joinInvitation(invitationId: string): Promise<Result<AcceptWire>>;
  company(tenantId: string): Promise<Result<CompanyProfileWire>>;
  updateProfile(tenantId: string, body: ProfileBody): Promise<Result<{ company: CompanyWire }>>;
  updateBranding(tenantId: string, body: BrandingBody): Promise<Result<BrandingWire>>;
  uploadLogo(tenantId: string, file: Blob): Promise<Result<{ company: CompanyWire }>>;   // multipart, field "file"; no content-type header set by hand
  removeLogo(tenantId: string): Promise<Result<{ company: CompanyWire }>>;
  settings(tenantId: string): Promise<Result<SettingsWire>>;
  updateSettings(tenantId: string, section: string, body: SettingsBody): Promise<Result<{ section: SettingsSectionWire }>>;
  checklist(tenantId: string): Promise<Result<ChecklistWire>>;
  dismissChecklistItem(tenantId: string, itemKey: string): Promise<Result<ChecklistWire>>;
  hideChecklist(tenantId: string): Promise<Result<ChecklistWire>>;
  team(tenantId: string): Promise<Result<TeamWire>>;
  changeRole(tenantId: string, userId: string, body: RoleBody): Promise<Result<{ member: MemberWire }>>;
  removeMember(tenantId: string, userId: string): Promise<Result<{ removed: string }>>;
  leave(tenantId: string): Promise<Result<{ left: string }>>;
  transfer(tenantId: string, body: TransferBody): Promise<Result<TeamWire>>;
  invitations(tenantId: string): Promise<Result<InvitationsWire>>;
  invite(tenantId: string, body: InviteBody): Promise<Result<IssuedWire>>;
  resendInvitation(tenantId: string, invitationId: string): Promise<Result<IssuedWire>>;
  revokeInvitation(tenantId: string, invitationId: string): Promise<Result<{ id: string }>>;
}
export function createTenancyClient(options: TransportOptions): TenancyTransport;

export interface TenancyAdminTransport {
  companies(q: { q?: string; kind?: "org" | "personal" | "all"; status?: "active" | "suspended" | "all"; page?: number; pageSize?: number }): Promise<Result<AdminCompanyListWire>>;
  company(tenantId: string): Promise<Result<AdminCompanyDetailWire>>;
  suspend(tenantId: string, body: SuspendBody): Promise<Result<AdminCompanyDetailWire>>;
  reactivate(tenantId: string): Promise<Result<AdminCompanyDetailWire>>;
  people(q: { q?: string; staffOnly?: boolean; page?: number; pageSize?: number }): Promise<Result<AdminPeopleWire>>;
  staffRoles(): Promise<Result<{ roles: StaffRoleWire[] }>>;
  setStaffRole(userId: string, body: StaffRoleBody): Promise<Result<{ person: AdminPersonWire }>>;
}
export function createTenancyAdminClient(options: TransportOptions): TenancyAdminTransport;
```

The transports work exactly like scheduling-widget's:

- **URLs.** They are exactly the paths in section 7. Ids are
  `encodeURIComponent`'d. Base and path are joined with `joinUrl`.
- **Headers.**
  - A POST sends `content-type: application/json`, except the logo upload,
    whose `FormData` sets its own type.
  - A GET sends no custom header, so no preflight is needed.
  - `cache: "no-store"`.
- **Never throw.**
  - Every answer is checked narrowly: a shape it doesn't recognise becomes
    `bad_response`, and a thrown fetch becomes `network`.
  - A 401 always means signed out. So does a 200 that's a redirected HTML page.
  - `toClientError` keeps `suggestion` and `upgradeHref` from the error body.
- **Error codes.** `WIRE_ERROR_CODES` is the `TenancyErrorCode` set.
- **`transport` or `baseUrl`.** Every component takes either. With both,
  `transport` wins. With neither, the component renders one plain error ("This
  page isn't connected to its server yet.") and never crashes.

### 8.2 Theme, tokens, styles (every component)

These are scheduling-widget's rules, word for word, with the `aitw` prefix:

- **Theme.** The `theme?: "auto" | "light" | "dark"` prop. On `auto`, the
  widget follows the host page, re-resolves live, and leaves no `data-theme` on
  the server render.
- **Common props.** Every component also takes `nonce?`, `className?`,
  `style?` and `locale?` (default `"en-US"`).
- **Tokens.** The token set is booking's: `ground surface ink muted faint line
  line-strong accent accent-strong accent-soft on-accent ok ok-soft warn
  warn-soft danger danger-soft on-danger focus radius radius-sm shadow font`.
- **Specificity.** Tokens are declared under `:where(.aitw-root)`, at zero
  specificity. Component rules stay at class specificity.
- **Contrast.** Every colour is a token. Light and dark values both pass AA for
  text, and a contrast unit test proves it.
- **Style injection.**
  - `injectTenancyStyles({ nonce })` injects `<style id="aitw-styles">`.
  - `injectTenancyAdminStyles({ nonce })` injects `aitw-admin-styles`.
  - Each is injected once and never duplicated. `nonce` is set on the
    `<style>` element.
  - `tenancyWidgetCss()` and `tenancyAdminCss()` return the CSS text.
- **The company's own brand colour.**
  - The accent stays the HOST's.
  - When a component gets `company.brandColor`, it may show it only as a swatch
    or logo-adjacent mark. Never re-skin the widget with a customer's colour.
- **Nouns.** `noun?: { singular: string; plural: string }`, default
  `{ singular: "company", plural: "companies" }`. Copy uses it lowercase in
  sentences and capitalised in headings, through one `nounTitle()` helper.

### 8.3 `<Onboarding>` (entry `.`)

```ts
interface OnboardingProps {
  baseUrl?: string; transport?: TenancyTransport;
  purpose?: "onboarding" | "additional";        // default "onboarding"; "additional" = "Create another company"
  afterHref?: string;                           // where to go after it's created/joined; default "/dashboard"
  publicUrlPrefix?: string;                     // shown before the slug, e.g. "https://app.example.com/t/"; default "/t/"
  initialSession?: SessionWire;                 // server-resolved, so no loading flash
  onDone?: (result: { status: CreateCompanyWire["status"] | AcceptWire["status"]; company: { id: string; name: string } }) => void; // overrides navigation
  noun?; locale?; theme?; nonce?; className?; style?;
}
```

**Invitations first.** When the session lists `invitations`, they come first.
Each is a card: "{companyName} invited you to join as {roleName}." with a
primary button "Join {companyName}". Pressing it calls `joinInvitation(id)`:

- `accepted` or `already-a-member` → navigate to `afterHref`;
- any other status → that status's plain message (8.9), shown in the card.

Below the cards: "Or create your own {noun}".

**The one question: the name.**
- The heading is "What's your {noun} called?". For `additional`, it's "Create
  another {noun}".
- One text input, labelled with the heading.
- `autoComplete="organization"`, autofocused, maximum 80 characters.

**The web address.**
- Derived live from the name, `suggestSlug` copied, and shown as
  `{publicUrlPrefix}{slug}`.
- A text button, "Change", turns it into an editable input. Once edited, the
  name no longer drives it.
- Availability is checked with `checkSlug` after 350 ms of quiet:
  - while checking, a quiet "Checking…";
  - a problem → its `message` and a one-click "Use {suggestion}" button;
  - available → "Available" with an `ok` icon. The words carry the meaning,
    not colour alone.

**Submitting.**
- The button is "Create {noun}". It's disabled while sending.
- `requestKey` is minted once per mount with `crypto.randomUUID()`, with a
  fallback when that's unavailable. Every retry and every double submit sends
  the SAME key.
- The `purpose` prop is sent.
- On success, navigate with `window.location.assign(afterHref)`. A full load,
  so every server-rendered screen re-resolves the active company.
- `name_invalid` and `slug_*` errors land on their field, with
  `aria-describedby`. `slug_taken` offers its suggestion.
- In personal mode (`initialSession.mode === "personal"`), render a plain
  notice, "This site doesn't use {plural}.", and no form.

### 8.4 `<CompanySwitcher>` (entry `.`; it sits in the header)

```ts
interface CompanySwitcherProps {
  baseUrl?: string; transport?: TenancyTransport;
  /** Server-resolved; renders with no fetch. Without it the component fetches session() on mount. */
  session?: SessionWire;
  reloadHref?: string;          // where to go after switching; default "/dashboard"
  createHref?: string | null;   // "Create another {noun}"; default "/onboarding?another=1"; null = no link
  settingsHref?: string | null; // "{Noun} settings"; default "/settings/company"
  teamHref?: string | null;     // "Team"; default "/settings/team"
  noun?; locale?; theme?; nonce?; className?; style?;
}
```

- **The button.**
  - It shows the active company's logo (24 px) or an initials badge, and its
    name, truncated to 24 characters with `title` set to the full name.
  - It has `aria-haspopup="menu"` and `aria-expanded`, and its accessible name
    is "{Name}, switch {noun}".
- **The menu.**
  - It uses `role="menu"`, with every company as a `role="menuitemradio"` and
    the active one `aria-checked="true"`.
  - A suspended company shows the suffix "Suspended". It can still be chosen,
    and the page then explains.
  - After a separator: the `createHref` link, `settingsHref` and `teamHref`.
- **Keyboard.**
  - Enter, Space or ArrowDown opens the menu.
  - Arrow keys and Home/End move through it.
  - Escape closes it and returns focus to the button.
  - Tab closes it.
  - Clicking outside closes it.
- **Choosing a company** calls `setActive(id)`, then
  `window.location.assign(reloadHref)`. On an error, a toast-style status line
  appears inside the menu.
- **No session.**
  - `needs-onboarding` renders a link, "Set up your {noun}", to
    `createHref ?? "/onboarding"`.
  - `personal` mode with one workspace renders nothing. With two or more it
    renders the menu, with no "Create another" link and no settings link (the
    personal slot passes `createHref={null}` and `settingsHref={null}`).
- At 390 px it fits in a 44 px-high hit area, with the name ellipsised.

### 8.5 `<SetupChecklist>` (entry `.`)

```ts
interface SetupChecklistProps {
  baseUrl?: string; transport?: TenancyTransport;
  tenantId: string;
  initial?: ChecklistWire;
  title?: string;              // default "Finish setting up"
  noun?; locale?; theme?; nonce?; className?; style?;
}
```

- `hidden` renders nothing. So does an empty `items`, which happens for a member
  who can do none of them.
- **Progress.** "{done} of {total} done", as a native `<progress>` with that
  text as its label.
- **Each item.**
  - It shows a check (done) or a circle (to do), the title, the description,
    and the action link (`actionLabel` → `href`, styled as a button). The link
    is hidden when the item is done.
  - "Not needed" is a text button. It dismisses the item and refreshes from the
    answer. A dismissed item shows struck-through with "Skipped".
- **When `complete`.**
  - "You're all set." and a "Hide this list" button, which calls
    `hideChecklist`.
  - Before that, "Hide this list" sits in a secondary menu, so it isn't
    tempting before anything is done.
- **Freshness.** The list refetches on `visibilitychange` back to visible, so
  ticking an item in another tab updates it.

### 8.6 `<TeamManager>` (entry `.`)

```ts
interface TeamManagerProps {
  baseUrl?: string; transport?: TenancyTransport;
  tenantId: string;
  initial?: TeamWire;
  afterLeaveHref?: string;        // default "/dashboard" (which resolves the next company or onboarding)
  noun?; locale?; theme?; nonce?; className?; style?;
}
```

The page is built from four parts, in this order.

**1. Invite** (when `you.canInvite`):
- Fields:
  - "Email address" (`type="email"`, `autoComplete="off"`);
  - "Role", a select of `invitableRoles`. Each option is the role name, with
    its description as the option's hint below the select.
- The button is "Send invitation".
- On success:
  - `delivery: "sent"` → "Invitation sent to {email}."
  - otherwise → "We couldn't email it, so copy this link and send it yourself."
    with a read-only input holding `link` and a "Copy link" button. The copy
    uses `navigator.clipboard`, falling back to selecting the text.
- `seats_full` shows its message, plus an "Upgrade" link when `upgradeHref`
  is set.
- **Seats line.** When `seats` is set: "{used + pending} of {limit} places used
  (including invitations)."

**2. Members** (a table at ≥ 640 px, stacked cards below):
- **Name** shows the name (or the email), with the email under it. The caller's
  own row adds "(you)". The owner's adds an "Owner" badge.
- **Role.**
  - When `actions.roles` is non-empty: a `<select>` labelled "Role for {name}",
    holding the current role plus `actions.roles`. Changing it saves at once:
    the row disables, then confirms "Role changed" or reverts with the error.
  - Otherwise: plain text.
- **Status.** "Active", or "Account closed" for a member-suspended row.
- **Joined** is a date in `locale`.
- **Remove** appears only when `actions.remove`. It opens a confirm dialog:
  "Remove {name} from {company}? They lose access straight away. Anything they
  made stays." with the buttons "Remove {name}" (danger) and "Cancel".

**3. Pending invitations** (when `you.canInvite` and the list isn't empty):
- Each row shows the email, the role, and either "Expires {date}" or "Expired"
  (warn).
- "Resend" (when `canResend`) shows the same delivery outcome as an invite.
- "Revoke" (when `canRevoke`) asks to confirm: "Withdraw the invitation to
  {email}? The link they have will stop working."

**4. Danger zone:**
- **Leave {company}** (when `you.canLeave`).
  - It confirms: "Leave {company}? You'll lose access to it straight away."
  - After leaving → `window.location.assign(afterLeaveHref)`.
  - When `leaveBlocked` is set, the button is replaced by that sentence.
- **Transfer ownership** (when `you.canTransfer` and some member has
  `actions.transferTo`).
  - A select of eligible members: "New owner".
  - A text input labelled "Type {company name} to confirm".
  - The button is "Transfer ownership" (danger). It's disabled until the typed
    text matches case-insensitively, and the server checks again.
  - The explanation: "{New owner} becomes the owner and can manage billing and
    the team. You'll become an Admin."
  - On success, re-render from the returned `TeamWire`.

**Every write.**
- It disables just the control it touched.
- It announces the outcome in one `role="status"` live region.
- It never throws.
- After any success it refetches `team()`. The server's `actions` are the only
  source of what may be done.

**Errors.**
- `not_a_member` and `forbidden` → a full-panel notice with that message.
  You've been removed, or demoted while the page was open.
- `company_suspended` → that message.

### 8.7 `<CompanySettings>` (entry `.`)

```ts
interface CompanySettingsProps {
  baseUrl?: string; transport?: TenancyTransport;
  tenantId: string;
  initialCompany?: CompanyProfileWire;
  initialSettings?: SettingsWire;
  publicUrlPrefix?: string;       // default "/t/"
  noun?; locale?; theme?; nonce?; className?; style?;
}
```

There are three areas. Each is a `<section>` with its own heading, Save button
and status line, and each saves independently.

**1. Profile** (`id="profile"`):
- **Name.**
- **Web address**, shown as `{publicUrlPrefix}{slug}`.
  - It's editable and checked live with `checkSlug({ slug, tenantId })`.
  - A warning sits under it: "Changing this changes your public web address.
    The old address keeps pointing here."
  - Read-only for a personal workspace.
- Without `tenant.edit` in `can`, every input is read-only, with the line "Only
  an owner or admin can change these."

**2. Branding** (`id="branding"`):
- **Logo.**
  - A preview of the current logo, or a placeholder.
  - "Upload logo" is a file input with `accept="image/png,image/jpeg,image/webp"`.
  - The client checks the type and that it's ≤ 1 MB before sending, and the
    server checks again.
  - "Remove logo".
- **Brand colour.**
  - A native `<input type="color">` paired with a hex text input, kept in sync.
    Both are labelled "Brand colour".
  - "Clear colour".
- **Live preview.**
  - A sample button filled with the colour, with its text in `textOnColor`.
    The report is computed client-side with the copied `brandColorReport`, and
    the server's answer replaces it after saving.
  - A sample link in the colour, on white.
  - Plain sentences: "Text on this colour: {ratio} to 1 ({readable ? 'easy to
    read' : 'hard to read'})." Then `warning` if there is one.
- `logo_storage_off` shows its message, and the upload control is disabled.

**3. Registry sections** (`id={section.key}`; the company fragment's anchor is
`id="details"`):
- Every section from `settings()` is rendered generically from its field specs:

  | Field kind | Renders as |
  | --- | --- |
  | `text`, `email`, `tel`, `url` | an input of that type |
  | `textarea` | a textarea |
  | `select` | a select |
  | `toggle` | a checkbox, labelled |
  | `number` | a number input, with min, max and step |
  | `timezone` | a select of `US_TIME_ZONES`, then the rest under "Other time zones" |

  For `timezone`, the rest comes from `Intl.supportedValuesOf("timeZone")` when
  available. The current value is always present as an option. An empty choice
  is labelled "Choose a time zone".
- `width: "half"` pairs two fields on a row at ≥ 640 px.
- `canEdit: false` makes a section read-only.
- Save sends the whole section's values. Empty inputs are sent as `null`.
- `invalid` issues are mapped to fields by `path[0]`.
- **Unsaved changes.** A section that's been changed and not saved shows
  "Unsaved changes". A `beforeunload` guard is registered only while any section
  is dirty.
- **Deep links.** Opening the page with `#details` or `#branding` scrolls to and
  focuses that section's heading. Checklist links depend on this.

### 8.8 `<CompanySuspended>` and `<AcceptInvitation>` (entry `.`)

```ts
interface CompanySuspendedProps {
  companyName: string;
  companies?: CompanyChoiceWire[];      // others to switch to
  baseUrl?: string; transport?: TenancyTransport;
  supportEmail?: string | null;         // "Contact support" becomes a mailto when given
  reloadHref?: string;                  // after switching; default "/dashboard"
  noun?; locale?; theme?; nonce?; className?; style?;
}
```

- **What it says.**
  - Heading: "{companyName} is suspended".
  - Body: "You can't use it right now. Contact support to restore it." When
    `supportEmail` is set, that's a mailto link to it.
  - Nothing about why. The reason is staff-only.
- **Other companies.** When there are other active companies, it adds "Switch
  to another {noun}:" with a button for each (`setActive`, then reload).
- It has no other actions.

```ts
interface AcceptInvitationProps {
  baseUrl?: string; transport?: TenancyTransport;
  token: string;
  signedInAs: string | null;            // the signed-in email, shown so a wrong-account case explains itself
  afterHref?: string;                   // default "/dashboard"
  noun?; locale?; theme?; nonce?; className?; style?;
}
```

- **Nothing happens until the button is pressed.** This is the 0.3 page's
  security decision; keep it.
- The button is "Accept invitation". The line under it is "You're signed in as
  {signedInAs}."
- **Outcomes**, replacing the template's `AcceptInvitation`:

  | Outcome | What it shows |
  | --- | --- |
  | `accepted` | "You're in {company}." and "Go to {company}" → `afterHref`. Auto-navigates after 1.5 s; the link is there for anyone who'd rather click. |
  | `already-a-member` | "You were already in {company}." with the same link. |
  | `expired` | "This invitation has expired. Ask whoever invited you to send a new one." |
  | `revoked` | "This invitation was withdrawn." |
  | `wrong-email` | "This invitation is for a different email address. Sign out and sign in with the address it was sent to." |
  | `unknown` | "This link can't be used. It may have been used already." |
  | `company-unavailable` | "This {noun} isn't available right now." |
  | `seats-full` | `message` |

### 8.9 Plain-words table (shared)

One module, `src/words.ts`, holds every user-facing sentence. Error codes map
to the server's `message` first, and these fallbacks are used only when the
server sent none:

| Code | Fallback |
| --- | --- |
| `network` | "We couldn't reach the server. Check your connection and try again." |
| `bad_response` | "Something went wrong on our side. Try again in a moment." |
| `signed_out` | `SIGNED_OUT_MESSAGE`, as in scheduling-widget |

Never show a code, an id or a stack.

### 8.10 `<CompaniesConsole>` (entry `./admin`)

```ts
interface CompaniesConsoleProps {
  baseUrl?: string; transport?: TenancyAdminTransport;
  detailHref?: string | ((tenantId: string) => string); // default "/admin/companies/{id}": a PATTERN with {id}, so a
                                                         // server page can pass it (a function can't cross into a
                                                         // client component) (AMENDED, T1-02 / TB-DEPLOY-13)
  defaultKind?: "org" | "personal" | "all";     // default "org"; create-app passes "all" in personal mode
  pageSize?: number;                            // default 25
  noun?; locale?; theme?; nonce?; className?; style?;
}
```

**Filters.**
- A search input labelled "Search {plural} by name, web address or owner's
  email", debounced 300 ms.
- "Show": a select of {plural} / Personal workspaces / All.
- "Status": a select of All / Active / Suspended.
- The state is mirrored into the URL with `history.replaceState` (`q`, `kind`,
  `status`, `page`), and read back on mount, so a refresh or a shared link
  keeps the view.

**The table** (≥ 768 px; stacked cards below):

| Column | Shows |
| --- | --- |
| Name | a link to `detailHref` with `{id}` filled in (or `detailHref(id)` when given a function) |
| Web address | `/t/{slug}` |
| People | `members` |
| Owner | email or name |
| Created | a date |
| Status | "Active", or "Suspended" as a warn badge |

**Pagination.** "Showing {from}–{to} of {total}", with Previous and Next
buttons, disabled at the ends.

**Empty states.**
- No results for a search → "Nothing matches “{q}”."
- None at all → "No {plural} yet. They appear here when someone signs up."

### 8.11 `<CompanyDetail>` (entry `./admin`)

```ts
interface CompanyDetailProps {
  baseUrl?: string; transport?: TenancyAdminTransport;
  tenantId: string;
  backHref?: string;            // default "/admin/companies"
  noun?; locale?; theme?; nonce?; className?; style?;
}
```

**Header.**
- The name, a status badge and the web address.
- "Back to {plural}" → `backHref`.

**Facts.** A `<dl>` holding:
- Created (date, and by whom);
- Owner (email). When `ownerDeleted`: "(account closed). Ownership needs
  handing over";
- Time zone;
- Contact email and phone;
- Pending invitations.

**Members.** A table of name, email, role, status and joined.

**Recent activity.**
- A list of `when · actor · label`. Sensitive lines get a "Sensitive" badge.
- `activity: null` → "Activity isn't connected on this site."

**Suspend and reactivate** (when `can.suspend`):
- **Active company.** "Suspend {noun}" opens a dialog:
  - the reason, required: a textarea labelled "Why (only staff see this)";
  - the warning: "Everyone in {name} loses access until you reactivate it.
    They'll see a message telling them to contact support.";
  - the buttons "Suspend" (danger) and "Cancel".
- **Suspended company.** A warn notice: "Suspended {date} by {who}: {reason}".
  The button is "Reactivate". It confirms, then reactivates.
- After either, re-render from the response.

### 8.12 `<StaffPeople>` (entry `./admin`)

```ts
interface StaffPeopleProps {
  baseUrl?: string; transport?: TenancyAdminTransport;
  pageSize?: number;            // default 25
  noun?: { singular: string; plural: string };   // for the companies column (AMENDED, T1-02)
  locale?; theme?; nonce?; className?; style?;
}
```

**Filters.**
- Search, labelled "Search people by name or email".
- A checkbox, "Staff only".

**Rows.** Name, email, joined, {plural} count, and "Staff role".

**The staff role select.**
- The options are "No staff role" plus every role, highest first. An option is
  `disabled` when it isn't `assignable`.
- A select is disabled when `!canChange`, with a reason in visible text:
  - your own row: "You can't change your own role.";
  - a row above you: "Only someone above them can change this."
- Changing the select asks for confirmation when GIVING a role: "Give {email}
  the {role} staff role? They'll be able to use the staff screens that role
  allows." Removing confirms with "Remove {email}'s staff role?".
- Saving updates the row from the response. `last_admin` and `rank` show their
  message on the row.

**Pagination** works as in 8.10. The bootstrap admin's row works like any
other. A "you" marker uses `isYou`.

### 8.13 Accessibility (all components)

- **Labels.** Every input has a visible `<label>`. Errors are linked with
  `aria-describedby` and `aria-invalid`.
- **Live regions.** Each component has one polite `role="status"` region for
  outcomes, and a `role="alert"` only for a failed write.
- **Dialogs.**
  - `role="dialog"`, `aria-modal="true"`, labelled by their heading.
  - Focus trapped. The first control is focused on open, and Escape closes.
  - Focus returns to the trigger on close.
  - Scheduling-widget's `admin/ui.tsx` already does all of this; copy it.
- **Touch targets.** At least 44×44 px below 640 px.
- **Focus and motion.** A visible focus ring (`--aitw-focus`), and
  `prefers-reduced-motion` respected.
- **Tables.** Every table has `<th scope="col">`. A stacked-card layout keeps
  label and value pairs.
- **Language.** Uses `locale`. Dates go through `Intl.DateTimeFormat(locale, {
  dateStyle: "medium" })`.

### 8.14 Exports

The `.` entry exports:

- **Components and their props types:**
  - `Onboarding`, `CompanySwitcher`, `SetupChecklist`, `TeamManager`,
    `CompanySettings`, `CompanySuspended`, `AcceptInvitation`;
  - `OnboardingProps`, `CompanySwitcherProps`, `SetupChecklistProps`,
    `TeamManagerProps`, `CompanySettingsProps`, `CompanySuspendedProps`,
    `AcceptInvitationProps`.
- **Transport:** `createTenancyClient`, `TenancyTransport`, `Result`,
  `ClientError`, `TransportOptions`.
- **Styles:** `injectTenancyStyles`, `tenancyWidgetCss`.
- **Pure helpers:** `suggestSlug`, `validateSlug`, `brandColorReport`,
  `contrastRatio`, `normaliseHexColor`, `US_TIME_ZONES`, `nounTitle`.
- **Wire:** `TENANCY_WIRE_VERSION`, and every wire type in 7.3.

The `./admin` entry exports:

- **Components:** `CompaniesConsole`, `CompanyDetail`, `StaffPeople`, and
  their props types.
- **Transport:** `createTenancyAdminClient`, `TenancyAdminTransport`.
- **Styles:** `injectTenancyAdminStyles`, `tenancyAdminCss`.
- **Wire:** `TENANCY_WIRE_VERSION`, and the operator wire types.

---

## 9. `@adminigloo/trpc` 0.3.0: the rungs (server builder)

The ladder stays the same, with these four rungs:

| Rung | What it adds |
| --- | --- |
| public | nothing |
| protected | a principal |
| tenant | `tenantId` taken from the input, and a `can` set for that tenant |
| staff | `can` for the staff scope |

`requireTenant` and `requireStaff` add a key check on top. There is **no new
"active tenant" rung**, because of D3. A procedure names its tenant in its input,
and the server page that rendered the screen supplies the active company's id.

T1 adds three things.

### 9.1 A suspended company gets its own refusal

```ts
// PermissionLoaders gains one OPTIONAL method (backwards compatible):
explainTenantDenial?(input: { readonly principal: Principal; readonly tenantId: string }): Promise<"not-a-member" | "company-suspended">;
```

How the tenant rung uses it:

1. When `loadTenantPermissions` returns null, the rung calls
   `explainTenantDenial`, if it is present.
2. If the answer is `"company-suspended"`, the rung throws
   `companySuspended()`. That is a `FORBIDDEN` with the message "Access to this
   account is suspended. Contact support to restore it." The wording avoids the
   tenant noun on purpose, because the package can't know it.
3. Any other answer, or a missing method, throws `notAMember(tenantId)` as
   today.

Export `companySuspended` beside `notAMember`.

`createDrizzlePermissionLoaders` returns an object that satisfies this interface
structurally. Its input type is `{ principal: { userId } }`, which a `Principal`
satisfies.

### 9.2 `inventoryOf`, and per-procedure scope overrides

```ts
export interface RouterLike { readonly _def: { readonly procedures: Readonly<Record<string, unknown>> } }
/** Every procedure of a built router, flattened. `router` = the first path segment ("" for a root-level procedure). */
export function inventoryOf(router: RouterLike): DerivedEntry[];
```

- tRPC 11's `router._def.procedures` is already flat, keyed by dotted path. This
  was verified against @trpc/server 11.18: the keys are `["a", "b.c", "b.d.e"]`.
- For each entry, `declared` comes from `_def.meta?.scope` when that is a valid
  `ProcedureScope`.

`auditBuiltProcedures(entries, expected)` changes in one way. A key in `expected`
may now be either a router name or a full dotted path. **The full path wins over
the router name.** This lets a mixed router declare its exceptions. For example,
`invoicing: "staff"` sits alongside `"invoicing.byToken": "public"` and
`"invoicing.markViewed": "public"`. The violation messages stay the same.

### 9.3 Tests

These go in `src/__tests__/inventory.test.ts` and `procedures.test.ts`:

- `inventoryOf` flattens nested routers.
- `inventoryOf` reads `meta.scope`.
- An exact-path override beats the router entry.
- An unregistered path is still a violation.
- With `explainTenantDenial` answering `company-suspended`, a non-member call
  gets the suspended message.
- Without the method, a non-member still gets the old message.

---

## 10. `@adminigloo/testing` 0.2.0 (server builder)

### 10.1 `./pglite`

```ts
export interface PgliteDbOptions { readonly schema: Readonly<Record<string, unknown>>; readonly logQueries?: boolean }
export interface PgliteTestDb<TSchema extends Record<string, unknown>> {
  readonly db: PgliteDatabase<TSchema>;      // drizzle(client, { schema }), so db.query.* works too
  readonly client: PGlite;
  /** Every statement sent through db, in order (when logQueries). Clear with queries.length = 0. */
  readonly queries: { sql: string; params: unknown[] }[];
  close(): Promise<void>;
}
export function createPgliteDb<TSchema extends Record<string, unknown>>(options: PgliteDbOptions & { schema: TSchema }): Promise<PgliteTestDb<TSchema>>;
/** The DDL alone, for a caller managing its own PGlite. */
export function schemaDdl(schema: Readonly<Record<string, unknown>>): string[];
```

`schemaDdl` builds DDL from every value in `schema`.

**What it picks up.** It collects each value that is a `PgTable` (use
`is(value, PgTable)`) or a `PgEnum` (use `isPgEnum`). It de-duplicates by name.
Other values are ignored, so the generated project's `schema` object can be
passed whole.

**What it emits, in order:**

1. `CREATE TYPE … AS ENUM` for each enum.
2. `CREATE TABLE`, with:
   - each column's type;
   - `PRIMARY KEY` on single-column keys;
   - `NOT NULL`;
   - SQL and literal defaults (jsonb literals included);
   - composite `CONSTRAINT … PRIMARY KEY`;
   - `config.uniqueConstraints`;
   - `config.checks`.
3. `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY`, with `ON DELETE` and
   `ON UPDATE`.
4. `CREATE [UNIQUE] INDEX`, with the partial `WHERE` and any expression columns.

**Where it comes from.** It is a promotion of
`packages/analytics/src/__tests__/pglite.ts`, plus enums and unique
constraints. Don't change analytics.

**Its errors** carry a readable name:

- A default that can't be written as a literal throws a `PgliteDdlError`. It has
  `readonly name` and names the column.
- A parameterised expression in DDL throws the same error.

**Peer dependencies.** `@electric-sql/pglite` is imported lazily inside
`createPgliteDb`, so importing the module without PGlite installed fails only
when you call it. The message names the package to install.

### 10.2 `./factories`

- `buildTenant` gains `createdBy`, `creationKey`, `suspendedAt`,
  `suspendedReason`, `suspendedBy` and `setupState`.
- `buildUser` gains `provisionedAt`.
- Both keep their deterministic defaults. Nulls stay null, and `setupState`
  defaults to `{}`.

### 10.3 Tests

These go in `src/__tests__/pglite.test.ts`.

**What the DDL builder must handle:**

- A schema object containing the permissions enums, `tenant_members`'s composite
  PK, `tenant_invitations`'s partial unique index, and an FK with
  `on delete cascade` builds without errors.
- `ON CONFLICT` on the partial index works.
- The cascade fires.
- A value in `schema` that is neither a table nor an enum is skipped.

**The public API:**

- `createPgliteDb` returns a `db` whose `db.query.<table>` works.
- `queries` logs statements.

---

## 11. `@adminigloo/auth` 0.2.0 (server builder)

- **New column:** `users.provisioned_at` (section 3.3).
- **Nothing else changes.**
- **Tests:** the existing suites stay green. Add one schema test that asserts the
  column exists and is nullable.

The webhook ledger table (`identity_webhook_events`) stays as it is. create-app
starts writing to it (section 12.3), which answers PC-20's "dead code" point
without a package change.

---

## 12. create-app 0.22.0: the wiring plan (create-app builder)

This section is a file-by-file plan. Every new or changed emitted file obeys
these rules:

- No `if` asks whether a feature or a mode is installed. The generator picks a
  variant instead.
- Overlays only add files.
- The pages are thin wrappers around package components.

Where a file comes in two variants, the companies variant is used when
`tenantNoun !== "none"` and the personal variant when it is `"none"`.

### 12.1 Packages, versions, answers

**`versions.ts`**

| Package | Version |
| --- | --- |
| `tenancy` | `0.4.0` |
| `tenancy-widget` | `0.1.0` (new entry) |
| `permissions` | `0.2.0` |
| `auth` | `0.2.0` |
| `trpc` | `0.3.0` |
| `testing` | `0.2.0` |

Each entry gets the usual why-comment.

**`answers.ts`**

- `packagesFor` puts `tenancy-widget` in the BASE set. The team page is in every
  project.
- `overlayNamesFor` pushes `"companies"` when `tenantNoun !== "none"`. That is
  the new overlay in 12.4.
- `optionalEnvFor`:
  - adds `CRON_SECRET` for comms (CA-11);
  - adds an optional `SUPPORT_EMAIL`, listed in the env module as
    `SUPPORT_EMAIL: z.string().email().optional()`. Its .env.example comment
    reads: "Where a suspended company is told to write. Without it they're told
    to contact support with no link."
- `capabilities` (`capabilities.ts`) changes:
  - **`tenancy.organizations`** gets a real `provenBy`. It mentions:
    - `app/(site)/onboarding/page.tsx` containing `<Onboarding`;
    - `src/components/CompanySwitcherSlot.tsx` containing `<CompanySwitcher`;
    - `app/(site)/settings/company/page.tsx` containing `<CompanySettings`;
    - `app/(site)/settings/team/page.tsx` containing `<TeamManager`;
    - `app/api/tenancy/[...path]/route.ts` containing `createTenancyHandlers(`.
  - **`tenancy.personal-workspace`** checks for the personal
    `src/server/tenancy.ts` containing `mode: "personal"`.
  - **New `tenancy.first-run`** checks for:
    - `scripts/seed-deploy.ts` containing `seedPermissionCatalog`;
    - `deploy.yml` containing `db:seed:deploy`;
    - `scripts/admin-grant.ts`.
  - **New `tenancy.isolation-proof`** checks for both emitted tests in 12.8.
  - **New `admin.operator-console`** (only when `adminShell !== "none"`) checks
    for `app/admin/companies/page.tsx` containing `<CompaniesConsole` and
    `app/admin/people/page.tsx` containing `<StaffPeople`.
  - The comment at `capabilities.ts:498-501`, which admits that a switcher and
    a create form are not emitted, is replaced.

**`renderPackageJson`**

- Adds the dependency `@adminigloo/tenancy-widget`.
- Adds the scripts:
  - `"db:seed:deploy": "tsx scripts/seed-deploy.ts"`;
  - `"admin:grant": "tsx scripts/admin-grant.ts"`.
- Adds the devDependency `"@electric-sql/pglite": "^0.5.8"`. Put the range in
  the same constant table that holds the other third-party ranges, and add a
  test pinning it to the workspace packages' devDependency.

### 12.2 Emitted modules (new renderers in `emit.ts`)

**`src/tenancy.ts`**, client-safe constants for both modes:

```ts
export const NOUN = { singular: "company", plural: "companies" } as const;   // from answers, lowercase
export const NOUN_TITLE = { singular: "Company", plural: "Companies" } as const;
export const AFTER_AUTH_PATH = "/dashboard";        // personal variant: "/"
export const TENANCY_API = "/api/tenancy";
export const TENANCY_ADMIN_API = "/api/admin/tenancy";
export const PUBLIC_COMPANY_PREFIX = "/t/";
export const ADMIN_COMPANIES_DEFAULT_KIND = "org";   // personal variant: "all"
```

**`src/server/tenant-settings.ts`** emits the registry:

```ts
export const tenantSettings = defineTenantSettings([companySettings]);
```

Tenancy 2 adds fragments here. The generator owns the list, as it does for the
permission catalog.

**`src/server/setup-checklist.ts`** emits:

```ts
export const setupChecklist = defineSetupChecklist([...tenancyChecklistItems({ companySettings: "/settings/company", team: "/settings/team" })]);
```

Tenancy 2 adds items here.

**`src/server/tenancy.ts`** comes in two variants, and exports all of the
following. It is the ONE construction site.

- `tenancy = createTenancyService({ … })`, configured with:
  - `db`;
  - `mode`, the literal `"companies"` or `"personal"`;
  - `tenantCatalog`;
  - `noun: NOUN`, `settings: tenantSettings` and `checklist: setupChecklist`;
  - `bootstrap: bootstrapPolicy()`. That is `resolveAppEnv() === "local" ? {
    mode: "first-user" }`, otherwise `env.BOOTSTRAP_ADMIN_EMAIL ? { mode:
    "email", email } : { mode: "off" }`. This is a runtime environment check,
    the same one bootstrap.ts has today. It is not a feature conditional.
  - `logos: tenancyLogoStore`, from 12.2's last module;
  - `invitations: { expiresInHours: INVITATION_EXPIRY_HOURS }`;
  - `audit: auditSink`, which inserts `auditEntry(auditRegistry, {...event})`
    into `auditLog` on `tx`;
  - `onEventError`, which logs.
- `tenancyMembershipGate`, re-exported for `src/server/permissions.ts`.
- `requestPrincipal(): Promise<TenancyPrincipal | null>`, which wraps
  `currentPrincipal`.
- `verifiedEmails(): Promise<string[]>`. This is Clerk `currentUser()`'s
  `emailAddresses` filtered to `verification?.status === "verified"` and
  lowercased. It returns `[]` when Clerk isn't configured.
- `invitationUrl(token)`, moved here from the retired `src/server/invitations.ts`.
- `buildTenancyHandlers(overrides?: { principal?; verifiedEmails? })` returns
  `createTenancyHandlers({ … })`, wired to:
  - `tenancy`, `principal: requestPrincipal`, `verifiedEmails` and
    `invitationUrl`;
  - `deliverInvitation`, which adapts `sendInvitationEmail` from the existing
    emitted `src/server/invitation-mail.ts`;
  - `limit`, which maps `TENANCY_RATE_LIMITS[bucket]` onto `limiter.limit({ key:
    "tenancy:" + bucket + ":" + key, policy })`;
  - `requestFacts`, built from `requestContext`;
  - `onError: reportError`.

  The test (12.8) passes a fake principal through `overrides`.
- `buildTenancyOperatorHandlers(overrides?)` is wired the same way, plus
  `recentAudit`. That is a query on `auditLog` filtered to the tenant, newest
  first, `limit` rows, with labels from `auditRegistry`.

**`src/server/tenancy-logo.ts`** also has two variants, chosen by
`includeStorage`:

- `export const tenancyLogoStore: LogoStore | undefined`, which adapts
  `getBlobStore()`. The adapter returns `undefined` when there is no blob token,
  so the page explains instead of failing.
- Without storage, it is `undefined`.

**`src/components/CompanySwitcherSlot.tsx`** is a server component with two
variants.

- The companies variant:
  1. `const principal = await currentPrincipal()`. Calling this on every
     signed-in page view is deliberate: the first page after sign-up provisions
     the user (PC-01).
  2. `const session = sessionToWire(await tenancy.resolveSession({ userId }))`.
  3. `return <CompanySwitcher session={session} baseUrl={TENANCY_API} noun={NOUN} reloadHref="/dashboard" />`.
  4. The whole thing is wrapped in try/catch. On a database failure it renders
     nothing, because the header must never fail a page.
- The personal variant is the same component with `createHref={null}` and
  `settingsHref={null}`. `<CompanySwitcher>` itself renders nothing when a
  personal-mode user has one workspace (8.4), so the slot needs no `if`.

The server must turn `SessionState` into `SessionWire` in one place.
`@adminigloo/tenancy/server` exports these helpers for that:

- `sessionToWire`;
- `companyToWire`;
- `teamToWire`, and the rest of the same family.

The handlers use the same helpers.

**`src/components/CompanyGate.tsx`** is a server component with two variants.

```tsx
export async function CompanyGate(props: {
  path: string;                                   // for the sign-in round trip
  permission?: string;                            // the page's key, e.g. "tenant.view"
  children: (ctx: { principal: Principal; company: CompanyWire; can: readonly string[] }) => ReactNode;
}): Promise<ReactNode>
```

It works through these checks in order:

1. No principal → `redirect('/sign-in?redirect_url=' + encodeURIComponent(path))`.
2. `needs-onboarding` → `redirect("/onboarding")`. The personal variant never
   reaches this, because resolution provisions.
3. `suspended` → render `<CompanySuspended companyName companies baseUrl supportEmail={env.SUPPORT_EMAIL ?? null} noun />`.
4. `ready` → `can = (await loadTenantPermissions(...))?.toArray() ?? []`. If the
   page's permission is missing, render a `<Notice>`: "You don't have access to
   this page. Ask the owner of {company} to change your role."
5. Otherwise, render `children(ctx)`.

**Every company page calls `CompanyGate` itself.** Don't put it in a layout.
Layouts don't re-render on client navigation, and "the parent checked" isn't
enforced by anything. That is the existing comment in members/page.tsx; carry
it.

### 12.3 Template changes (all projects)

**`src/server/auth.ts`**

- `mirrorUser` stops calling `ensurePersonalWorkspace` and
  `grantBootstrapAdminIfFirst`. Both functions are deleted.
- `currentPrincipal` changes to:
  `const row = existing ?? await mirrorUser(externalId); if (!row) return null; if (row.provisionedAt === null) await tenancy.provisionUser({ userId: row.id, email: row.email });`
- Rewrite the header comment to describe the state machine (6.2). Remove the
  claim that the webhook "only keeps the row fresh". Both paths now provision.

**`app/api/webhooks/clerk/route.ts`** has five changes:

1. **Claim the event first, in the ledger (PC-20).**
   1. Insert the event (`eventId` = svix id, `type`, `payload` = the body) with
      `on conflict do nothing`, then select it.
   2. If `processed_at` is set → answer `200 { received: true, skipped: "duplicate" }`.
   3. Otherwise process the event.
   4. On success, stamp `processed_at`.
   5. On failure, increment `attempts` (text → int → text), set `last_error`
      (message only, ≤ 500 characters), and answer 500. Clerk retries.
2. **After the insert or update for `user.created` and `user.updated`:**
   `await tenancy.provisionUser({ userId: row.id, email: row.email })`.
3. **For `user.deleted`, after the soft delete:**
   `await tenancy.deprovisionUser({ userId: existing.id })`.
4. **Keep the existing order of the safety checks:** signature, then rate
   limit, then the error report.
5. **No email is stored in the error context.**

**`src/server/permissions.ts`** becomes a few lines. The why-comments move to
the package.

```ts
export const { loadTenantPermissions, loadStaffPermissions, explainTenantDenial } =
  createDrizzlePermissionLoaders(db, { membership: tenancyMembershipGate });
```

**`src/server/trpc.ts`** passes `{ loadTenantPermissions, loadStaffPermissions, explainTenantDenial }`.

**`src/server/bootstrap.ts`** is DELETED. Its logic is now
`permissions/server`'s `ensureBootstrapAdmin`. Keep a one-line pointer in the
DEPLOYMENT.md first-run section.

**`src/server/tenant.ts`**

- `currentTenantFor(userId)` is reimplemented over `tenancy.resolveSession`:
  `ready` → `{ id, name, slug, isPersonal }`; anything else → null.
- Keep the export. The account and billing overlay pages call it.
- Rewrite the comment. Remove "not a state auth.ts produces" (PC-V2).

**Retired, deleted along with their tests:**

- `src/server/routers/invitations.ts`;
- `src/server/invitations.ts`, whose `invitationUrl` moves to `src/server/tenancy.ts`;
- `src/components/invitations/PendingInvitations.tsx`;
- `src/components/invitations/AcceptInvitation.tsx`.

**`renderAppRouter`** drops the `invitations` router and its import. It keeps
`members.list`.

**`renderAuditRegistry`** drops `invitationAuditedActions` and spreads
`tenancyAuditedActions` from `@adminigloo/tenancy`. The three `invitation.*`
keys are unchanged, so historic rows keep their labels.

**`app/(site)/invite/[token]/page.tsx`**

- Keep the signed-out path: create an account or sign in, `redirect_url` back
  to the invite.
- Signed in, render
  `<AcceptInvitation baseUrl={TENANCY_API} token={token} signedInAs={principal.email} afterHref={AFTER_AUTH_PATH} noun={NOUN} />`.

**`app/(site)/members/page.tsx`** becomes `redirect("/settings/team")`. Old
links and old invitation emails keep working.

**`app/(site)/settings/team/page.tsx`** is in the base template, for both
modes:

```tsx
<CompanyGate path="/settings/team" permission="members.view">{({ company }) =>
  <><PageHeader title="Team" description={`Who's in ${company.name}, and who's been invited.`} />
  <TeamManager baseUrl={TENANCY_API} tenantId={company.id} noun={NOUN} afterLeaveHref={AFTER_AUTH_PATH} /></>}</CompanyGate>
```

**`app/api/tenancy/[...path]/route.ts`** is in the base template:

```ts
const { handle } = buildTenancyHandlers(); export const GET = handle; export const POST = handle;
```

It sets `runtime = "nodejs"` and `dynamic = "force-dynamic"`.

**`app/api/admin/tenancy/[...path]/route.ts`** is in the base template, built
the same way from `buildTenancyOperatorHandlers()`. It is mounted even without
an admin shell, on the admin router's reasoning.

**`src/components/AuthHeader.tsx`** gets five changes (CA-17):

1. **The switcher.** Signed in, it renders `<CompanySwitcherSlot />` before
   `AppLinks`.
2. **Staff-only links.** `APP_LINKS` entries gain `audience: "everyone" | "staff"`.
   `/admin` is `"staff"`. `AppLinks` receives
   `isStaff = (await loadStaffPermissions({ principal })) !== null`.
3. **Cost of that check.** It is one query, made only for signed-in viewers,
   inside the same try/catch as the switcher.
4. **A phone menu.** Below `sm`, the links fold into a
   `<details class="sm:hidden">` disclosure: summary "Menu", with links stacked
   and 44 px targets. From `sm` up, the row is as today.
5. **No staff branching in markup.** The header has no `if` for staff. It
   filters `APP_LINKS` by audience. That is a runtime permission filter on a
   generated list, and the comment says so. It replaces the old "NOT
   permission-filtered, on purpose" note. That note was right to avoid an
   extra query per page; the switcher now pays for the principal anyway.

**Sign-in and sign-up pages.**

- `fallbackRedirectUrl={AFTER_AUTH_PATH}` applies when there's no
  `redirect_url`.
- `forceRedirectUrl={back}` applies only when `back` is set.
- Sign-up for an invitation keeps `redirect_url=/invite/...`.

**`app/(site)/setup/page.tsx`** (CA-18): in production
(`resolveAppEnv() === "production"`), call `notFound()` unless the viewer is
staff.

**`renderSiteNav`**

- `FOOTER_LINKS` entries for `/setup*` gain `audience: "developer"`.
- `SiteFooter` drops them when `resolveAppEnv() === "production"`.

**Admin overlay (`admin-minimal`)**

- **`app/admin/layout.tsx`**, when `can === null` and the principal exists:
  1. `const healed = await tenancy.ensureBootstrapAdmin({ userId, email })`.
  2. If `healed.granted`, re-load the staff permissions and continue.
  3. Otherwise render `<AdminUnavailable reason={healed.reason === "templates-missing" ? "not-seeded" : "not-staff"} />`.
- **`AdminUnavailable`**:
  - gains `"not-seeded"`, with the copy "This site's roles haven't been
    installed yet. Run `pnpm db:seed`, then reload.";
  - adds to `not-staff`: "If you run this site and are locked out, run
    `pnpm admin:grant you@example.com` from the project folder.";
  - fixes PC-V2's claim that someone "can grant you access". It now says who
    and how: "an administrator, from People".
- **`app/admin/companies/page.tsx`** (new) has a page header with the plural
  noun, and renders:

  ```tsx
  <CompaniesConsole baseUrl={TENANCY_ADMIN_API} detailHref={ADMIN_COMPANY_DETAIL_HREF} defaultKind={ADMIN_COMPANIES_DEFAULT_KIND} noun={NOUN} />
  ```

  `ADMIN_COMPANY_DETAIL_HREF` is the pattern `"/admin/companies/{id}"` from
  `src/tenancy.ts` — a string, because this is a server page (AMENDED, T1-02 /
  TB-DEPLOY-13).

  ```tsx
  ```

  `ADMIN_COMPANIES_DEFAULT_KIND` comes from the emitted `src/tenancy.ts`: `"org"`
  in companies mode, `"all"` in personal mode. The overlay file is the same in both
  modes, so there is no new template token and no `if`.
- **`app/admin/companies/[id]/page.tsx`** (new):

  ```tsx
  <CompanyDetail baseUrl={TENANCY_ADMIN_API} tenantId={id} noun={NOUN} />
  ```

  It awaits `params` (it's a Promise).
- **`app/admin/tenants/page.tsx`** becomes `redirect("/admin/companies")`.
- **`app/admin/people/page.tsx`** MOVES here from admin-full, so every shell can
  hire staff (PC-04/TB-09). It renders `<StaffPeople baseUrl={TENANCY_ADMIN_API} />`.
- Each page re-checks its staff key server-side before rendering, as today's
  pages do: `staff.tenants.view` or `staff.people.view`. The handlers re-check
  anyway.
- **`admin-full`** loses `app/admin/people/page.tsx`. The overlay-collision test
  stays green.
- **`RoleEditor`** (admin-full) keeps its override checklist. When the selected
  person holds no staff template, it renders a notice instead of the checklist:
  "{email} has no staff role. Give them one on People first; per-person changes
  only apply on top of a role." This is the PC-04 silent no-op.

**`renderAdminNav`**: the Accounts group becomes:

- `/admin/companies` (the plural label, `staff.tenants.view`);
- `/admin/people` ("People", `staff.people.view`), now in both shells;
- `/admin/support` (full only), unchanged.

**`renderPermissionsCatalog`**

- `appStaffPermissions` gains:

  ```ts
  "staff.tenants.suspend": { label: `Suspend and reactivate ${plural}`, description: "Everyone in a suspended one loses access until it's reactivated.", category: plural, defaultFor: ["admin"] }
  ```

- The labels of `staff.tenants.view` and `staff.people.view` stay noun-aware.
- A generator test asserts that every `TENANCY_STAFF_PERMISSION_KEYS` entry is
  declared in the rendered staff catalog. It also asserts that every
  `TENANCY_ROUTES` permission other than null or `"fragment"` is in the tenant
  catalog.

### 12.4 The `companies` overlay (new; `tenantNoun !== "none"` only)

| File | What it renders |
| --- | --- |
| `app/(site)/onboarding/page.tsx` | Signed out → redirect to sign-up with `redirect_url=/onboarding`. Otherwise `session = await tenancy.resolveSession({ userId, verifiedEmails: await verifiedEmails() })`. When `ready` and `?another` is absent → `redirect("/dashboard")`. Renders `<Onboarding initialSession={sessionToWire(session)} purpose={another ? "additional" : "onboarding"} baseUrl={TENANCY_API} publicUrlPrefix={appUrl + "/t/"} afterHref="/dashboard" noun={NOUN} />`. |
| `app/(site)/dashboard/page.tsx` | `<CompanyGate path="/dashboard" permission="tenant.view">` → page header with the company name, then `<SetupChecklist baseUrl tenantId />`, then the existing `APP_LINKS` for the company as cards. |
| `app/(site)/settings/company/page.tsx` | `<CompanyGate path="/settings/company" permission="tenant.view">` → `<CompanySettings baseUrl tenantId publicUrlPrefix noun />`. Title: "{Noun} settings". |
| `app/(site)/t/[slug]/page.tsx` | The reserved public face. `resolveCompanyBySlug(slug)` → null gives `notFound()`; `retiredSlug` set gives `permanentRedirect('/t/' + company.slug)`. Otherwise a small card: logo, name, and contact email and phone when set. `metadata: { robots: { index: false } }` until Tenancy 2 gives it real pages. |

`renderSiteNav` sets `APP_LINKS` per mode:

- **companies:** Dashboard (`/dashboard`), Team (`/settings/team`), Settings
  (`/settings/company`), Admin (`/admin`, staff only, when there's a shell);
- **personal:** Team (`/settings/team`), Admin (staff only).

`renderRobots` disallows `/onboarding`, `/dashboard`, `/settings` and `/t/`. In
T1, `/t/` is noindex anyway.

### 12.5 The single-business mode (`--tenant-noun none`)

This mode works as it did in 0.21. What it gets:

- **Provisioning.** It is race-free now. Every user's personal workspace is
  created by `provisionUser`, from both the webhook and the page.
- **Team page.** `/settings/team` (and `/members` redirecting to it) works for
  the personal workspace.
- **Operator console.** It lists all workspaces (`defaultKind="all"`).
- **Shared fixes.** The bootstrap self-heal, `admin:grant`, the deploy seed and
  both emitted tests are identical to the companies mode.

What it leaves out:

- onboarding, `/dashboard`, company settings, `/t/[slug]` and `SetupChecklist`;
- the switcher, except for someone in two or more workspaces (8.4).

`AFTER_AUTH_PATH = "/"`.

### 12.6 First run: seed, deploy, recovery

**`src/permissions/seed.ts`** (template; it imports no env):

```ts
export async function seedPermissions(db: PgDatabase<any, any, any>, options: { readonly bootstrapEmail?: string | null; readonly log?: (line: string) => void } = {}): Promise<void>
```

It does three things, in order:

1. `seedPermissionCatalog(db, { staff: { catalog: staffCatalog, templates: STAFF_ROLE_TEMPLATES }, tenant: { catalog: tenantCatalog, templates: TENANT_ROLE_TEMPLATES } })`.
2. `backfillTenantOwnerRoles(db)`.
3. When a bootstrap email is given, `ensureBootstrapAdminForEmail(db, { email, audit })`
   from `@adminigloo/tenancy/server`. It needs no service and no mode.

The `audit` sink here (and in `admin-grant.ts`) uses a LOCAL registry,
`defineAuditedActions(tenancyAuditedActions)`, and inserts into `auditLog`
directly. The project's `src/server/audit.ts` imports routers that import
`@/db` and so `@/env`, which a deploy job doesn't have. The keys are the same
ones the app's registry spreads, so the rows read back with their labels.

It prints a plain report (created templates, grants added, keys nobody holds,
bootstrap outcome) through `log`. The default for `log` is `console.log`.

The scripts that use it:

- **`scripts/seed-roles.ts`** (`pnpm db:seed`) becomes
  `seedPermissions(db, { bootstrapEmail: process.env.BOOTSTRAP_ADMIN_EMAIL })`.
  It keeps `--env-file=.env.local`.
- **`scripts/seed-deploy.ts`** (`pnpm db:seed:deploy`, new):
  - it is built like `scripts/migrate.ts`: `process.loadEnvFile(".env.local")`
    in a try;
  - it requires `DATABASE_URL_UNPOOLED`, refuses a pooled URL, and prints the
    target host;
  - it uses a Neon `Pool` and `drizzle(pool)`, then `seedPermissions(db, {
    bootstrapEmail: process.env.BOOTSTRAP_ADMIN_EMAIL })`, then `pool.end()`
    in `finally`;
  - it never imports `@/env`. The comment says why, as migrate.ts's does.
- **`scripts/admin-grant.ts`** (`pnpm admin:grant <email>`, new). The recovery
  tool, PC-V1 and CA-V2's "no way in short of SQL". It:
  - loads `.env.local` (in a try) and uses `DATABASE_URL_UNPOOLED ?? DATABASE_URL`;
  - prints the host;
  - finds the non-deleted user by lowercased email;
  - when there's no such user, prints "Nobody has signed in with {email} yet.
    Sign in once, then run this again." and exits 1;
  - otherwise calls `assignRoleTemplate(db, { scope: "staff", principalId,
    templateKey: "admin", actor: { system: "admin:grant" } })`;
  - audits `staff.role.assigned` with actor null and `{ via: "admin:grant" }`,
    through the local registry described above;
  - prints "{email} is now an administrator.";
  - is idempotent, printing "already an administrator" on a rerun.

**`deploy.yml`** (template): in both `migrate-staging` and `migrate-production`,
right after `pnpm db:migrate:deploy`, add a step running `pnpm db:seed:deploy`.
Give it:

- `DATABASE_URL_UNPOOLED: ${{ secrets.DATABASE_URL_UNPOOLED }}`;
- `BOOTSTRAP_ADMIN_EMAIL: ${{ vars.BOOTSTRAP_ADMIN_EMAIL }}`;
- a comment: "the permission catalog is seeded on every deploy, after
  migrations; new feature keys reach production roles here".

**`DEPLOYMENT.md`** gets a "First run" section covering:

- what the deploy seeds;
- `BOOTSTRAP_ADMIN_EMAIL`, set as a repository or environment variable AND in
  Vercel;
- the self-heal;
- `pnpm admin:grant`.

### 12.7 CLI, `add`, docs (CA-10, CA-11)

**`nextSteps`, base block**, in this order:

1. "Before `pnpm install`: export `GITHUB_TOKEN` (a token with read:packages); `.npmrc` reads it."
2. `pnpm install`
3. `pnpm db:generate && pnpm db:migrate`
4. `pnpm db:seed`
5. `pnpm dev`

Then the line: "Sign in. With no administrator yet, you become one when you open
/admin."

**`nextSteps`, comms block:** "Scheduled messages need CRON_SECRET in Vercel;
until then /api/cron/comms answers 401."

**`add.ts`** prints `pnpm db:generate && pnpm db:migrate && pnpm db:seed`.

**`renderScaffoldRecord`** builds the answer rows by iterating `Answers` keys,
except `scope` and `projectName`. A missing label falls back to the key. Add a
test asserting every key appears.

**New emitted `README.md`**, rendered from the manifest, with these sections:

1. what this project is;
2. quick start (the same steps as `nextSteps`);
3. first run and recovery;
4. "Companies" (companies mode) or "Single business" (personal mode). This says
   what you get and lists "Not included" from 14.2 verbatim;
5. the installed packages.

**`packages/create-app/README.md`** gets a new top section, "Quick start (for
buyers)":

- the registry setup: the `.npmrc` scope line and `GITHUB_TOKEN`;
- one command;
- the first-run steps;
- a link to `--help`.

The rules stay below it. Not included: the full flag → packages table.

### 12.8 The emitted proofs (every project; the unit project; PGlite)

**`src/server/__tests__/procedure-scopes.test.ts`** (PC-19)

- It imports `appRouter` and runs
  `auditBuiltProcedures(inventoryOf(appRouter), EXPECTED_SCOPES)`.
- It expects `ok`, and prints the violations otherwise.
- The generator renders `EXPECTED_SCOPES` from the installed routers, with one
  row per router plus path overrides. From today's overlays:

| Router or path | Scope |
| --- | --- |
| `health` | public |
| `members` | tenant |
| `admin` | staff |
| `ai` | tenant |
| `feedback`, `seo`, `notifications`, `files`, `assistant`, `comms`, `aeo`, `catalog` | staff |
| `invoicing` | staff |
| `invoicing.byToken`, `invoicing.markViewed` | public |
| `checkout` | public |
| `checkout.createIntent` | authenticated |
| `account` | tenant |
| `billing` | staff |
| `billing.subscribeToPlan`, `billing.simulateSubscription` | tenant |

- Put the table in `emit.ts` as `ROUTER_SCOPES`, keyed by the answer that
  installs each router.
- A generator test fails if a router overlay exists with no `ROUTER_SCOPES`
  row. A second test greps each overlay router for `requireTenant(`,
  `requireStaff(`, `publicProcedure` and `protectedProcedure`, and checks the
  rows against them.

**`src/server/__tests__/tenant-isolation.test.ts`** (SR-22, scenario step 8).
These are its sections, in order.

- **Setup.**
  - `vi.mock("@/db", async () => ({ db: (await createPgliteDb({ schema })).db }))`,
    using `@adminigloo/testing/pglite` and `@/db/schema`. Keep the
    `globalThis` handle trick if needed so the same instance is reused.
  - Before all: `seedPermissions(db)`.
  - Through `tenancy`, create user A (owner of company A) and user B (owner of
    company B), each with a role. Company A also gets a second member, A2, and
    a pending invitation.
  - In personal mode, use the personal workspaces of A and B instead, and invite
    A2 into A's.
- **tRPC.** For every entry `e` of `inventoryOf(appRouter)` where
  `scopeOfProcedure(e.procedure) === "tenant"`:
  1. As B, through
     `createCallerFactory(appRouter)(createScaffoldContext({ principal: B }))`,
     call it with `{ tenantId: A.id }`. Expect `TRPCError` `FORBIDDEN`. The rung
     runs before the procedure's own input parser (verified against
     @trpc/server 11.18), so no other input is needed.
  2. It must appear in the generated `ISOLATION_CASES`. A missing entry fails
     with "Add an isolation case for {path}: a tenant procedure nobody proved
     can't read another company's rows". A case is one of:
     - `{ kind: "tenant-only" }`: the procedure takes no resource id. If it's a
       query, call it as B with `{ tenantId: B.id }` and assert that
       `JSON.stringify(result)` contains none of A's identifying strings: A's
       ids, emails, names and slug.
     - `{ kind: "by-id", input: (fx) => ({ tenantId: fx.B.id, …A's ids }), expect: "not-found" | "empty" }`.
       In T1 every tenant procedure is `tenant-only`. The by-id shape is for
       Tenancy 2.
- **Handlers.** For every `route` in `TENANCY_ROUTES` with
  `scope === "company"`, call `buildTenancyHandlers({ principal: async () => B })`:
  1. Substitute `:tenantId` with A's id, and the other params with A's ids
     (`:userId` = A2, `:invitationId` = A's invitation, `:section` = `company`,
     `:itemKey` = `team.invite`). Send the minimal valid body from
     `ISOLATION_BODIES[kind]`. Expect status `403` and code `not_a_member`.
  2. Then substitute `:tenantId` with B's id and keep A's other ids. Expect
     either:
     - `404 not_found`, for routes with `:userId` or `:invitationId`; or
     - a 2xx or a 4xx whose body contains none of A's identifying strings.
- **Nothing of A changed.** Snapshot A's members, roles, invitations, settings,
  branding, name and slug before the run, and compare after.
- **Coverage.** Every route kind in `TENANCY_ROUTES` must have an
  `ISOLATION_BODIES` entry, or the test fails with a named message.

**`scripts/verify-generated.mjs`** runs `pnpm exec vitest run --project=unit`
after the typecheck. It's PGlite, so no database is needed.

### 12.9 Template tests

- **`auth-mirror.integration.test.ts`**:
  - add "webhook inserts the row (and provisions), then the first page
    request": the row is stamped and the workspace exists (personal), or no
    workspace exists (companies);
  - add "row exists unprovisioned (a 0.21 user), then a request provisions it";
  - adapt the existing tests to the provisioning call.
- **`bootstrap.integration.test.ts`** is deleted. It moved to the permissions
  and tenancy package tests, which cover more.
- **`invitations.test.ts`** is deleted, along with the router.
- **`router.test.ts`** is kept. Add the suspended-message case.

### 12.10 Comments that must change (PC-V2)

| Where | Old claim | Replace with |
| --- | --- | --- |
| `seed-roles.ts:107-108` | "already in the deploy path" | the truth: `db:seed:deploy` runs after `db:migrate:deploy` |
| `bootstrap.ts:114-115` | "assigned from /admin" | the file is deleted; People assigns staff roles now |
| `tenant.ts:31-32` | member-of-nothing "is not a state auth.ts produces" | rewritten |
| `members/page.tsx:73-75` | the "suspended membership" copy | the page is replaced |
| `tenancy/schema.ts:56` | "the transfer path rewrites" | now true; cite `transferOwnership` |
| `AuthHeader.tsx:145` | not permission-filtered | rewritten per 12.3 |

For each line the builder changes, grep the new code for the claim it replaced.

---

## 13. Tests

Every lifecycle function is proved on PGlite. PGlite is real Postgres, but it is
a single connection, so two transactions never truly run at once. That shapes
how races are tested:

- **What the race tests prove.** Each race is run as a sequential interleaving
  at the lock boundary, in BOTH orders. That proves the re-check-under-lock
  LOGIC: the second caller sees the first one's committed result. A test that
  fires two calls with `Promise.all` proves no more than that: PGlite runs them
  one after the other, and such a test passes with every lock deleted (review R2
  F2). They are named as serial-order checks, never as race tests.
- **How we prove the lock is taken.** The query log shows the lock statement,
  WITH ITS LOCK CLAUSE (`for update`, `pg_advisory_xact_lock(`), for every lock
  the lifecycle relies on: the company row first in each mutation, the per-user
  create lock, the invitation row by token and by id, the role lock and the
  bootstrap lock (team.test.ts, "every lock the lifecycle relies on…"). Deleting
  any one of them fails that test (negative-controlled). A real-Postgres
  concurrency job (two connections) is still owed.
- **Where this comes from.** The scheduling 0.4 approach. Keep its explanatory
  comment.

### 13.1 permissions (`packages/permissions/src/__tests__/`; PGlite helper copied from analytics, plus enums)

**`loaders.test.ts`**

- The membership gate's three verdicts:
  - `not-a-member` → null.
  - `company-suspended` → null, and `explainTenantDenial` says suspended.
  - `member` → the role's grants.
- Overrides:
  - an `allow` override adds a key;
  - a `deny` override removes a key;
  - a sealed key stays denied despite an `allow` override.
- Staff:
  - a staff row at a real tenant id is not staff (the FIRM_WIDE predicate);
  - a staff row at `*` is staff.
- Every query uses the handle given. A transaction sees its own uncommitted
  role row.

**`seed.test.ts`**

- First run:
  - creates the system templates;
  - grants each catalog key's `defaultFor`;
  - adds a seal (deny) row for each sealed key that isn't a default.
- A second run is a no-op: `created: []`, zero grants added.
- A customised (non-system) template under a shipped key is skipped and
  reported.
- A key newly added to the catalog reaches the system templates on the next run.
- `sealsLifted`: a key that was sealed and is now a default turns into `allow`.
- `ungrantedKeys` lists keys no template holds.
- Two runs back to back stay idempotent. The advisory lock shows in the query
  log.

**`bootstrap.test.ts`**

- Refusals:
  - policy `off` → `off`, with zero queries;
  - an email that doesn't match → `not-eligible`, with zero queries;
  - no admin template → `templates-missing`.
- Grants:
  - the matching email gets admin;
  - `first-user` grants the first caller only, and the second gets
    `admin-exists`.
- Admins whose user is deleted don't count:
  - an admin rejected by `isActivePrincipal` doesn't count as existing, so
    another eligible user is granted;
  - a cs_agent holder is promoted to admin when no admin exists.
- The lock key is `8140231`, and it is the first statement.
- PC-V1, end to end:
  1. sign-in happens before the seed → `templates-missing`;
  2. seed;
  3. call again → granted.

**`assign.test.ts`**

- The rank guard:
  - the actor must strictly outrank both the target's current role and the new
    role;
  - an equal rank is refused;
  - an actor with no role is refused.
- The other refusals:
  - changing yourself → `self`;
  - an unknown key → `unknown-template`;
  - `protectLastKey` refuses to demote or remove the only admin
    (`last-holder`), and allows it when a second admin exists.
- `clearOverrides`:
  - `"on-change"` clears the overrides in that scope and tenant only;
  - `"on-removal"` leaves them on a change and clears them on a removal.
- A system actor bypasses the rank guard.
- Re-assigning the same template is a no-op.

### 13.2 tenancy (`packages/tenancy/src/__tests__/`; PGlite)

Use a local `pglite.ts` that builds auth `users`, the tenancy tables and the
permissions tables. Seed the tenant catalog with
`definePermissions("tenant", { ...tenancyPermissions })` and the staff catalog
with the five `TENANCY_STAFF_PERMISSION_KEYS`.

After every mutating test, a shared `assertOwnerInvariant(db, tenantId)` checks
D4: `owner_user_id` must equal the single holder of the `owner` template.

**`slug.test.ts`, `color.test.ts`, `settings.test.ts`, `checklist-defs.test.ts`** (root, pure)

- Slugs:
  - `suggestSlug` property test, 1 000 random names: every result is valid.
  - Unicode names fold correctly: "Café & Co." → `cafe-and-co`.
  - Reserved and short names get `-co`.
  - `validateSlug` table: every problem, and the order the checks run in.
- Contrast:
  - known pairs: white on black = 21; #777777 on white ≈ 4.48; #22c55e ≈ 2.28
    with white text and ≈ 8.29 with #111111 (so its `textOnColor` is dark);
  - `textOnColor` is chosen correctly;
  - the warnings fire;
  - `normaliseHexColor` accepts `#abc` and rejects `red`.
- Settings registry:
  - refuses a duplicate key, a `__` key, and a field not in the schema;
  - a fragment whose `parse({})` fails is refused;
  - an invalid stored value falls back to defaults and reports a problem;
  - `SettingsValues` is type-tested with `expectTypeOf`.
- `defineSetupChecklist` refuses a duplicate key.

**`provisioning.test.ts`** (scenario step 1, D8, D9)

- Webhook-first: insert the row, provision, then the page request.
  - Companies mode: stamped, with no tenant.
  - Personal mode: workspace, membership, owner role and pointer.
- Page-first, then the webhook: the same end state, with nothing duplicated.
- Both at once: `Promise.all` of the webhook path and the page path → one
  workspace, one role row, one stamp.
- A crash before the stamp: inject a failing audit sink on the bootstrap. The
  stamp is still null, and the next call completes and stamps.
- A 0.21 user (row present, stamp null, no workspace) is repaired on the next
  request.
- `deprovisionUser`:
  - staff role rows are removed;
  - memberships are suspended;
  - the pointer is nulled;
  - `ownedCompanies` is listed;
  - the gate now says `not-a-member` for them.
- Bootstrap, end to end: the `BOOTSTRAP_ADMIN_EMAIL` user signs in before the
  seed (not granted). After the seed, `ensureBootstrapAdmin` (the /admin
  self-heal) grants. `ensureBootstrapAdminFor` from the seed grants too.

**`companies.test.ts`** (scenario step 1)

- Create:
  - writes the tenant, an active membership, the owner role, the pointer and a
    `company.created` audit;
  - its status is `created`.
- Repeats:
  - the same `requestKey` again → `replayed`, with the same id and no second
    row;
  - two onboardings with different keys, `Promise.all` → one `created` and one
    `already-onboarded`, with the same company and only one tenant row;
  - `purpose: "additional"` → a second company.
- The per-user advisory lock is the first statement.
- Slugs:
  - a suggested slug that collides gets `-2` on the second company;
  - an explicit slug that's taken → `slug_taken`, with a free suggestion;
  - a retired slug counts as taken;
  - reserved → `slug_reserved`;
  - invalid → `slug_invalid`.
- Names: a blank, an emoji-only or an 81-character name → `name_invalid`.
- An unseeded database: the tenant templates are seeded inside the creation, and
  the owner holds a role (D10).
- Personal mode → `unavailable`.

**`session.test.ts`** (scenario step 4)

- The pointer, when it's valid, is honoured.
- A stale pointer:
  - the user was removed → falls back to the next company, and the pointer is
    rewritten;
  - the company was deleted → falls back.
- The fallback order is deterministic:
  - two companies joined in the same millisecond → ordered by id;
  - companies that aren't suspended come first.
- A suspended active company → `suspended`, listing the others.
- Every membership suspended → `suspended` on the first.
- Companies mode with only a legacy personal workspace → `needs-onboarding`.
- `needs-onboarding` lists invitations for VERIFIED emails only. An unverified
  address, a suspended company or an expired invitation is excluded.
- `setActiveCompany`:
  - a foreign company → `not_found`;
  - a company the user was removed from → `not_found`;
  - a suspended company is allowed.

**`team.test.ts`** (scenario step 3)

- The role matrix. Assert every cell:
  - actors: owner, admin, member, viewer;
  - targets: owner, admin, member, viewer, and someone with no role;
  - roles: admin, member, viewer, owner.
- Role changes:
  - changing a role clears the target's overrides in that tenant only, and the
    audit lists them;
  - an admin with an override `allow tenant.edit` who is demoted to member loses
    `tenant.edit`.
- `getTeam` `actions` agree with what the mutations then accept. Property test:
  for every row and role in `actions.roles`, the change succeeds; for every role
  not listed, it is refused.
- Removal:
  - deletes the membership, the role and the overrides;
  - nulls the pointer;
  - the removed user's NEXT `loadTenantPermissions` is null, `resolveSession`
    falls back, and a handler call answers 403 (scenario step 3, "very next
    request");
  - removing yourself → `self`;
  - removing the owner → `owner_protected`;
  - an admin removing an admin → `rank`;
  - a member with no role can be removed by an admin.
- Leaving:
  - works for a member;
  - the owner leaving → `last_owner`;
  - a member of a suspended company can leave.
- Transfer:
  - a wrong confirmation → `confirmation_mismatch`;
  - the confirmation is case- and whitespace-insensitive;
  - a non-owner admin → `forbidden`;
  - the owner with `tenant.transfer` denied by an override is still `forbidden`
    (the key is sealed);
  - a successful transfer swaps the roles, moves the pointer, writes a
    sensitive audit row and keeps D4.
- Races (D7), each in both orders:
  - transfer to B against removing B;
  - transfer against the actor losing ownership (a second transfer runs first);
  - a role change by an actor demoted just before → `forbidden` or `rank`.
- The company-row `FOR UPDATE` is the first statement of every mutation's
  transaction (query log).

**`invitations-lifecycle.test.ts`** (scenario steps 1 and 3)

- Sending:
  - the rank guard: an owner can invite an admin, an admin can't, and inviting
    an owner → `owner_must_transfer`;
  - an email that's already a member → `already_member`;
  - a personal tenant in companies mode → `personal_workspace`;
  - a suspended company → `company_suspended`.
- Seats, through an injected `limitFor`:
  - invitations sent until full → `seats_full`, with limit and used in the
    message;
  - a resend of an open invitation doesn't count twice;
  - two accepts racing for the last seat (sequential, both orders) → one
    accepted, one `seats-full`, and nothing consumed for the loser.
- Accepting:
  - sets the pointer;
  - writes the sensitive audit with the invitee as actor;
  - signing up through an invitation and accepting lands in the inviting
    company: `resolveSession` is `ready` there and never `needs-onboarding`.
- Accept while removed: accept, remove, accept again → `unknown`, and the
  membership is not re-created.
- Revoke against accept, both orders: revoke first → `revoked`; accept first →
  the revoke still records itself, and the member remains.
- `joinInvitation`:
  - needs the invited email in `verifiedEmails` (otherwise `wrong-email`);
  - otherwise behaves like accept.
- Lock order: `acceptInvitation`'s log shows the unlocked lookup, then the
  tenants `FOR UPDATE`, then the invitation `FOR UPDATE`.
- IDOR: resend or revoke an invitation id from another company → `not_found`.
- The 0.3 `service.test.ts` and `invitations.test.ts` stay green, unchanged,
  except for added cases covering `beforeConsume` and `acceptForVerifiedEmail`.

**`settings-service.test.ts` and `checklist.test.ts`** (scenario steps 2 and 5)

- Settings:
  - get: the sections the caller may view, with `canEdit` per section;
  - update: validates (an invalid email or time zone → `invalid` with paths),
    replaces only that section, and audits the changed keys without their
    values;
  - a viewer → `forbidden`.
- Checklist:
  - the three items progress as the details, an invite and the branding are
    added;
  - items are filtered by permission: a member sees none;
  - dismiss and hide work, and are kept in `setup_state`;
  - an `isDone` that throws → that item is not done, and the rest still render.

**`branding.test.ts`** (scenario step 5)

- `updateBranding` stores the colour and `onBrandColor`, and never refuses for
  contrast.
- Logos:
  - no store → `logo_storage_off`;
  - SVG, a mislabelled type (wrong magic bytes) or more than 1 MB →
    `logo_invalid`;
  - a replacement `put`s first, then deletes the old key after the commit;
  - a failed transaction deletes the new key.
- Profile:
  - a slug change retires the old slug;
  - `resolveCompanyBySlug(old)` returns the company with `retiredSlug` set;
  - another company can't claim the old slug;
  - getting your own old slug back works.

**`operator.test.ts`** (scenario step 6)

- Listing:
  - search by name, slug, owner email and exact id;
  - `%` and `_` are escaped;
  - pagination returns totals;
  - personal workspaces are hidden by default, and `kind: "all"` shows them;
  - a status filter.
- Detail:
  - members, the owner, and `ownerDeleted` after `deprovisionUser`.
- Suspension:
  - suspend writes the audit;
  - the gate then answers `company-suspended`;
  - `resolveCompanyBySlug` → null;
  - `acceptInvitation` → `company-unavailable`;
  - `resolveSession` → `suspended`;
  - suspend is idempotent (the first reason is kept), and reactivate restores
    everything.
- Access:
  - non-staff → `not_staff`;
  - staff without the key → `forbidden`.
- People:
  - list with staff roles;
  - `setStaffRole` rank: a cs_lead can't grant admin;
  - self → `self`;
  - removing the last admin → `last_admin`;
  - each change writes the audit.

**`handlers.test.ts`**

- Each route in `TENANCY_ROUTES` and `TENANCY_OPERATOR_ROUTES` returns its
  documented 200 shape. Read the table back.
- The basics:
  - signed out → 401;
  - a wrong method → 405;
  - an unknown path → 404;
  - a cross-site POST → 403 `cross_site`;
  - a 17 KB body → 400;
  - a rate limit returning `allowed: false` → 429 with `retry-after`.
- Invitations: delivery `"sent"` → `link: null`; delivery `"failed"` → `link`
  set, with the token never in any audit row or log line (check the query log
  and the audit sink).
- `TenancyError` responses carry `code`, `message` and, where they apply,
  `suggestion` and `upgradeHref`. A thrown non-`TenancyError` → 500 `internal`,
  reported through `onError`, with no stack in the body.
- **The two-company matrix.** This is the package's own proof of scenario step
  8. Every company route, as B:
  - with A's tenant id → 403 `not_a_member`;
  - with B's tenant id and A's other ids → 404, or a body without A's
    identifying strings;
  - afterwards, A's state is unchanged.
- Personal mode: `company-create`, `invite-join` and `active-set` → 404
  `unavailable`.

### 13.3 trpc and testing

See 9.3 and 10.3.

### 13.4 Package business scenario (THE acceptance test; server builder)

`packages/tenancy/src/__tests__/business-scenario.test.ts` drives the HANDLERS
with `Request` objects and a cookie-less fake principal function. It runs on
PGlite in companies mode, with the noun "company". It starts with an EMPTY
catalog on purpose: the tenant templates arrive through D10's self-seed in
step 1, and the staff templates through the seed in step 6. The steps, in
order:

1. **The owner signs up, webhook first.**
   1. Insert Olivia (`olivia@summitwindows.test`), the way the webhook does, and
      call `provisionUser`.
   2. `GET session` → `needs-onboarding`.
   3. `GET slug?name=Summit Window Co.` → `summit-window-co`, available.
   4. `POST companies { slug: "admin" }` → 422 `slug_reserved` with a
      suggestion.
   5. `POST companies { name, requestKey: K }` twice → `created`, then
      `replayed`, with the same id.
   6. `GET session` → `ready` in Summit, and Olivia is the owner.
2. **The checklist.** `GET checklist` → 3 items, 0 done.
3. **Settings.** `POST settings/company { timeZone: "America/Denver",
   contactEmail, contactPhone }`, then `POST branding { brandColor: "#0f766e" }`.
   The report shows white text, readable. The checklist now has 2 of 3 done.
4. **The team.**
   1. Invite `sam@summitwindows.test` as a Member. With no deliverer, delivery
      is `"skipped"` and the link is returned.
   2. Sam signs up page-first (no webhook) and accepts the token → `accepted`.
      Sam's session → `ready` in Summit, never onboarding. The checklist is 3/3.
   3. Olivia promotes Sam to Admin.
   4. Sam (an admin) tries to invite as Admin → 403 `rank`. As a Viewer → OK.
   5. Olivia removes Sam. Sam's next `GET members` → 403 `not_a_member`. Sam's
      session → `needs-onboarding`.
   6. Re-invite Sam as a Member; Sam accepts.
   7. Sam leaves → OK (he is not the owner). Re-invite again, and Sam accepts.
   8. Transfer ownership to Sam with a wrong name → 422. With the right name →
      Sam is the owner, Olivia is an admin.
   9. Olivia leaves → OK. Sam leaving → 409 `last_owner`.
   10. Seats: inject `limitFor` → 1. With Sam alone on the team, inviting
       anyone → 409 `seats_full`, with "1" in the message. Remove the limit
       again (the injected function reads a variable the test sets).
5. **Two companies.**
   1. Sam creates "Sam's Side Gig" (`purpose: "additional"`). The session lists
      both.
   2. `POST active` Summit, then `GET members` for each tenant id. Each shows
      only its own people.
   3. A third user, Rae, is invited into both companies and accepts both; her
      pointer is on the Side Gig. Sam removes Rae from the Side Gig. Rae's next
      session falls back to Summit, and her pointer is rewritten.
6. **The operator.**
   1. Ava (`BOOTSTRAP_ADMIN_EMAIL`) signs in before the seed: not staff. Seed.
      Ava's `/admin` self-heal → admin.
   2. `GET admin/companies` → Summit and the Side Gig, with no personal
      workspaces.
   3. Detail of Summit: members, created, status.
   4. Ava suspends the Side Gig with a reason.
   5. Its members' `GET company` → 403 `company_suspended`, and their session
      → `suspended`.
   6. `resolveCompanyBySlug` → null.
   7. Reactivate → `ready`.
   8. Ava gives Olivia `cs_agent` on People. Olivia, as a cs_agent, tries to
      change Ava → 403.
7. **The first run** (scenario step 7):
   - `seedPermissionCatalog` twice is idempotent;
   - a key added to the catalog reaches the owner template on the next seed;
   - the D4 invariant holds throughout.

### 13.5 Widget (`packages/tenancy-widget`; vitest; happy-dom)

**Transports** (`client.test.ts`):

- every route's URL and method;
- the multipart logo upload sets no content-type header by hand;
- a 401 means signed out;
- an HTML error page → `bad_response`;
- a thrown fetch → `network`;
- `suggestion` and `upgradeHref` are carried through.

**Wire parity** (`wire-parity.test.ts`):

- reads `../../tenancy/src/wire.ts` and `src/types.ts` from disk, and asserts
  that the region between `// WIRE:BEGIN` and `// WIRE:END` is byte-identical;
- imports `@adminigloo/tenancy`'s `suggestSlug`, `validateSlug` and
  `brandColorReport`, and checks the widget's copies agree on 500 generated
  inputs. This is the ONLY use of the devDependency.

**`Onboarding`**:

- the slug follows the name until it's edited;
- the 350 ms debounce;
- a reserved slug → message and "Use {suggestion}";
- a double click → one request, and its retry reuses the same `requestKey`;
- invitation cards join;
- personal mode shows the notice.

**`CompanySwitcher`**:

- the menu keyboard: arrows, Home/End, Escape returns focus;
- `menuitemradio` checked;
- a suspended company is labelled;
- choosing one calls `setActive`, then navigates (stub `location.assign`);
- `needs-onboarding` → the setup link.

**`SetupChecklist`**:

- progress text;
- dismiss;
- hide when complete;
- renders nothing when hidden or empty;
- refetches on visibility.

**`TeamManager`**:

- renders only the server's `actions`, so a row with `roles: []` has no select;
- a role change reverts on an error;
- the remove confirm dialog: focus trap, Escape, focus returned;
- the invite outcome shows the link when not sent;
- `seats_full` shows the upgrade link;
- leaving navigates;
- `leaveBlocked` text;
- the transfer button is disabled until the name matches, then succeeds;
- `not_a_member` on refresh → the full-panel notice.

**`CompanySettings`**:

- the slug warning;
- the client-side logo type and size check;
- colour sync between the picker and the hex input;
- the contrast sentence;
- `logo_storage_off` disables the upload;
- generic fields (timezone, email, tel, half width);
- `invalid` issues land on their fields;
- the unsaved-changes guard is added and removed;
- `#details` focuses its section.

**`CompanySuspended`** and **`AcceptInvitation`**: every outcome's text, and
nothing fires before the click.

**Admin components**:

- `CompaniesConsole`:
  - search debounce;
  - URL sync (`replaceState`);
  - filters;
  - pagination text;
  - empty states;
- `CompanyDetail`:
  - the suspend dialog needs a reason;
  - reactivate;
  - activity `null` copy;
- `StaffPeople`:
  - disabled options when not `assignable`;
  - the own-row reason;
  - the giving-a-role confirm;
  - `last_admin` message.

**Theme and styles**: host theme detection, the injection being idempotent with
its nonce, and every token passing AA in light and dark.

**SSR** (`render.test.tsx`, through `renderToStaticMarkup`): every component
renders without a DOM, with no `data-theme` in auto mode, and a loading state
rather than a crash.

### 13.6 create-app (`packages/create-app/src/__tests__/`)

**Generation, both modes:**

- the `companies` overlay is applied only for a noun that isn't `none`;
- `src/server/tenancy.ts`'s variant carries the right `mode` literal;
- the personal `CompanySwitcherSlot` passes `createHref={null}` and
  `settingsHref={null}`;
- `/members` redirects;
- the invitations router and its files are gone.

**Rule 1:**

- An extended no-feature-conditional check: no emitted file contains `mode ===`,
  `tenantNoun` or `includeStorage`.
- The existing rule-1 test covers the new files.

**Catalog:**

- `staff.tenants.suspend` is declared;
- every `TENANCY_STAFF_PERMISSION_KEYS` key and every tenant route permission is
  in its catalog.

**`ROUTER_SCOPES`**: there's a row for every router overlay, and the rows match
a grep of the rungs (12.8).

**`deploy.yml`**: `db:seed:deploy` follows `db:migrate:deploy` in both migrate
jobs, with `DATABASE_URL_UNPOOLED` and `BOOTSTRAP_ADMIN_EMAIL`.

**`nextSteps`:**

- `GITHUB_TOKEN` comes before `pnpm install`;
- `pnpm db:seed` comes before `pnpm dev`;
- the comms block names `CRON_SECRET`.

**`add` and docs:**

- `add` prints `pnpm db:seed`;
- `.env.example` has `CRON_SECRET` with comms, and `SUPPORT_EMAIL`;
- SCAFFOLD.md has a row for every `Answers` key;
- a README is emitted.

**Capabilities**: the four new or changed `provenBy` checks pass on the
generated plans for both modes.

**Versions**: `versions.test.ts` passes with the new pins and the changeset
frontmatter.

### 13.7 The generated project proves itself

When `scripts/verify-generated.mjs` runs, the generated project's unit tests
must be green in both modes, and the run reports their count. Those tests
include:

- `procedure-scopes.test.ts`;
- `tenant-isolation.test.ts`;
- the updated `auth-mirror` (integration; skipped without a database, as
  before).

Run it at least for `--tenant-noun Company --admin full` and `--tenant-noun none
--admin minimal`, and list the results in the hand-off.

### 13.8 The browser scenario (create-app builder; written now, run when Chromium is cached)

**The fixture: `e2e/fixtures/tenancy-scenario-server.ts`.** It follows the
scheduling scenario fixture:

- **The backend is real.** The packages are imported from their built `dist`,
  with a PGlite database from `@adminigloo/testing/pglite` holding the auth,
  tenancy, permissions and observability tables.
- **Wiring:**
  - `createTenancyService` in companies mode, with the catalogs as 13.2;
  - a bootstrap email of `ava@igloo.test`;
  - an in-memory `LogoStore`, served at `/__test/logos/:key`;
  - an audit sink into `audit_log`;
  - `recentAudit` reading it back.
- **Sign-in is a fake identity, no Clerk.**
  - `GET /__test/sign-in?email=&name=&via=webhook|page` sets the cookie
    `e2e-user=<email>`.
  - `via=webhook` inserts the user row and calls `provisionUser`, the way the
    webhook does.
  - `via=page` leaves the row to the first request.
  - The `principal(req)` function reads the cookie. It mirrors a missing row
    (the way `currentPrincipal` does) and provisions it when the stamp is
    null.
  - The fake also answers `verifiedEmails`, with the cookie's address counted
    as verified.
- **Outbox.** `deliverInvitation` records `{ to, url }`, and
  `GET /__test/outbox` returns the list.
- **Pages** are HTML shells mounting the bundled widget components with
  server-computed props, the way the emitted Next pages do:
  - `/onboarding`, `/dashboard`, `/settings/company`, `/settings/team`,
    `/invite/:token`;
  - `/admin/companies`, `/admin/companies/:id`, `/admin/people`.

  The `CompanyGate` logic (redirects and the suspended screen) is implemented
  in the fixture. A header with `<CompanySwitcher session>` appears on every
  company page.
- **APIs:** `/api/tenancy/*` and `/api/admin/tenancy/*` → the two handlers.
- `e2e/bundle.mjs` gains the tenancy-widget entries.

**The spec: `e2e/tests/tenancy-scenario.spec.ts`** (one long `test.describe.serial`).
Each step runs an axe check (`@axe-core/playwright`, no serious violations)
on the screen it lands on.

1. **Onboarding.**
   1. Olivia signs in (`via=webhook`) → `/dashboard` redirects to `/onboarding`.
   2. She types "Summit Window Co.". The address shows `/t/summit-window-co`.
   3. She edits it to "admin" → the reserved message, then clicks "Use …".
   4. She double-clicks "Create company" → lands on `/dashboard`.
   5. The database holds exactly one company.
2. **The checklist** shows "0 of 3 done", and "Add details" goes to
   `/settings/company#details`. There she fills in the time zone and contact,
   saves, and goes back: "1 of 3 done".
3. **Branding.** She picks the colour `#0f766e`. The preview text says "easy to
   read". She uploads a PNG logo, and it appears in the header switcher after a
   reload.
4. **An invitation.**
   1. On `/settings/team` she invites `sam@…` as a Member. Delivery is recorded
      in the outbox.
   2. In a new context, Sam (`via=page`) opens the outbox URL and gets sent to
      sign in. The fixture's sign-in returns him to `/invite/:token`.
   3. "Accept invitation" → lands on `/dashboard` for Summit. He never sees
      onboarding.
5. **Managing the team.**
   1. Olivia sees Sam and changes him to Admin. Sam's role select vanishes from
      his own view.
   2. Olivia removes Sam (through the confirm dialog). In Sam's tab, the next
      action on `/settings/team` shows the "not part of this company" notice.
      Reloading `/dashboard` sends him to onboarding.
6. **Two companies.**
   1. Sam is re-invited and accepts, then creates "Side Gig" through the
      switcher's "Create another company".
   2. The switcher lists both. Switching to Summit and back is a full reload,
      and the Team page shows only that company's people.
7. **Transfer and leave.**
   1. Olivia's transfer button stays disabled until the company name is typed.
      Sam becomes the owner.
   2. Olivia leaves.
   3. Sam's "Leave" is replaced by the owner sentence.
8. **The operator.**
   1. Ava signs in → `/admin/companies` self-heals her to admin.
   2. The list hides personal workspaces. Searching "summit" finds the company.
   3. In the detail, she suspends Side Gig with a reason.
   4. Sam switches to Side Gig and sees "Side Gig is suspended" with a switch
      button. Ava reactivates it, and Sam's reload works.
   5. On `/admin/people`, Ava gives Olivia "Customer service agent". The select
      on her own row is disabled, with the reason shown.
9. **Phone width** (390 px): onboarding, the switcher menu, the team page as
   cards, and the settings page. Nothing scrolls horizontally, and every target
   is ≥ 44 px.

**Negative controls.** A test that passes either way guards nothing, so two steps are re-run against a deliberately broken setup and must FAIL. Both breakages live in the FIXTURE; the packages carry no bug switches.

- `?break=fresh-key`: the fixture mounts `<Onboarding>` with a transport wrapper that mints a new `requestKey` on every `createCompany` call. Step 1's "exactly one company" assertion must fail.
- `?break=cached-gate`: the fixture renders company pages from a session cached at sign-in, instead of resolving per request. Step 5's "removed member loses access" assertion must fail.

The spec runs both controls with `test.fail()`. Document them in `e2e/README.md`.

---

## 14. Docs, changesets, and what's not included

### 14.1 READMEs

Every README follows the scheduling-widget README's structure, in this order:

1. one paragraph on what it is;
2. **"What each install gets you"**: a table of what you install, what you get,
   and what you wire yourself;
3. **Install**: the registry setup, the `.npmrc` scope line and the token;
4. a quick start with exact code;
5. **Upgrading from 0.3**: the SQL in 3.4, for tenancy and auth;
6. **Not included** (14.2), verbatim.

- **`packages/tenancy/README.md`** (new) also has a section headed exactly
  **"Foreign hosts: don't use this package"** (14.3).
- **`packages/tenancy-widget/README.md`** (new) also covers:
  - the transport sketch, for a host backing the widget with tRPC;
  - the theme contract;
  - the props of each component.
- **`packages/permissions/README.md`** documents `./server`. So does
  **`packages/trpc`**'s README.

### 14.2 Not included (Tenancy 1), listed in each README that touches it

- **Feature routes are still pinned.** Moving scheduling, estimator,
  invoicing, comms, aeo, assistant, feedback, files, notifications and SEO off
  the fixed `"primary"` tenant onto the active company, with a tenant
  permission set per feature (CA-20, TB-08, SR-16) — **Tenancy 2**.
- **Public company pages.** The pages under `/t/[slug]` (book, estimate,
  feedback) — **Tenancy 2**. Tenancy 1 reserves the address, resolves it, and
  shows a contact card.
- **Plans, billing and entitlements.** The seat hook exists. The billing chunk
  wires it to plans.
- Viewing as a customer (impersonation). `staff.tenants.impersonate` is declared
  and sealed, and nothing implements it.
- A custom role editor for companies, and per-person permission changes for
  company members. The owner/admin/member/viewer roles are fixed.
- Custom domains and subdomains.
- Company deletion, data export, operator notes, and comping a plan.
- Suspending a single member. You remove them instead. The `suspended` member
  status exists only for closed accounts.
- Moving billing ownership in Stripe when ownership is transferred.
- Emails to removed members or to a new owner. `onEvent` is the seam.
- Converting a legacy personal workspace into a company. In companies mode,
  personal workspaces are ignored.
- Identity providers other than Clerk.
- Table prefixes, or a dedicated Postgres schema.

### 14.3 "Foreign hosts: don't use this package" (exact README section, tenancy)

> If your app already has its own sign-in and its own idea of a customer
> account (Ridgeline is the example: its own auth, its brands as tenants),
> don't install `@adminigloo/tenancy`. It assumes `@adminigloo/auth`'s `users`
> table and owns company membership, roles and onboarding end to end. Every
> other AdminIgloo package takes the tenant from you instead: pass your own
> tenant id to their `resolveTenant(req)` / `tenantId` options and your own
> permission check to their `authorize` option. Your app stays the authority on
> who belongs where.

### 14.4 Changeset files (write them; don't version)

- **`.changeset/tenancy-1-tenancy.md`** — `@adminigloo/tenancy: minor`.
  Companies: onboarding, the switcher, the team lifecycle, settings, the
  checklist, the operator console, and race-free provisioning. It lists the
  schema upgrade and the one breaking-shaped addition: `AcceptResult` gains
  `refused`.
- **`.changeset/tenancy-1-tenancy-widget.md`** — `@adminigloo/tenancy-widget:
  minor`. First release, components listed.
- **`.changeset/tenancy-1-permissions.md`** — `@adminigloo/permissions: minor`.
  `./server`: loaders, seed, bootstrap and role assignment. Root:
  `STAFF_ROLE_TEMPLATES`, and `FIRM_WIDE` from a module without pg-core.
- **`.changeset/tenancy-1-trpc.md`** — `@adminigloo/trpc: minor`. `inventoryOf`,
  path overrides, and the suspended refusal.
- **`.changeset/tenancy-1-auth.md`** — `@adminigloo/auth: minor`.
  `users.provisioned_at`.
- **`.changeset/tenancy-1-testing.md`** — `@adminigloo/testing: minor`.
  `./pglite`, and the factories' new columns.
- **`.changeset/tenancy-1-create-app.md`** — `@adminigloo/create-app: minor`. A
  summary of section 12. It names what is removed: the invitations tRPC router,
  the template invitation components, and `bootstrap.ts`. It names what is
  moved: People into admin-minimal, and `/admin/tenants` → `/admin/companies`.

Write the text plainly, as the estimator and scheduling changesets do.
`versions.test.ts` reads the frontmatter, so get the package names exactly
right.

---

## 15. Hand-off checklist

### Order

1. **Server builder:** auth → permissions → tenancy (root, then `./server`) →
   trpc → testing. Build each package after you finish it.
2. **Widget builder,** in parallel from the start. Use section 7 only, and stub
   transports in your tests.
3. **create-app builder,** once the server builder reports `dist/` built for
   the five packages, and the widget builder has at least built the
   component exports. It builds against `dist/`.

### Every builder reports

- the test counts per package, against the baselines in section 0;
- typecheck and build status for every touched package;
- every `// CONTRACT:` call they made;
- anything they couldn't do and why. Don't install anything; stop and say so.

### Server builder

- [ ] `pnpm --filter @adminigloo/{auth,permissions,tenancy,trpc,testing} build typecheck test`
      all green. The existing tests are untouched, except where a decision here
      changes them, and each such change is listed.
- [ ] `business-scenario.test.ts` (13.4) passes. Each of its 7 steps is
      reachable from a `describe` name.
- [ ] D4 holds after every mutating test. Every mutation's first transaction
      statement is the company lock (query-log assertions).
- [ ] The wire region in `src/wire.ts` is marked `// WIRE:BEGIN` and
      `// WIRE:END`.
- [ ] READMEs and changesets are written.

### Widget builder

- [ ] Build, typecheck and test are green.
- [ ] Wire parity (13.5) passes against the server builder's `wire.ts`. If it
      isn't there yet, the parity test is `it.todo`, and the hand-off says so.
- [ ] Every component renders under SSR.
- [ ] The contrast token test passes in light and dark.
- [ ] README and changeset are written.

### create-app builder

- [ ] create-app tests are green. Count them, and list each new test.
- [ ] `node scripts/verify-generated.mjs` ran for both 13.7 configurations.
      Report the generated project's unit-test counts, including
      `tenant-isolation` and `procedure-scopes`. If the full run can't finish
      (registry or network), generate both projects and run
      `tsc --noEmit` plus `vitest run --project=unit` in each with the
      workspace tarballs, and say which.
- [ ] The e2e fixture and spec are written. If Chromium is cached, the spec ran,
      including both negative controls:
      - a transport that mints a new `requestKey` on every call: step 1's "one
        company" assertion must FAIL;
      - a fixture flag that renders company pages from a cached session: step
        5's "removed member loses access" assertion must FAIL.
      If Chromium isn't cached, say so.
- [ ] Every PC-V2 comment in 12.10 is corrected.


---

## 16. Amendments made while building (review round, 2026-10-12)

Every `CONTRACT:` / `DECISION:` note in the code, listed here so the next builder
works from the text and not from memory.

**Server (`@adminigloo/tenancy`, `@adminigloo/permissions`, `@adminigloo/auth`, `@adminigloo/trpc`)**

- **Replay is read-only (sec T1-01).** `createCompany`'s replay returns the
  company only while the caller is still an active member; otherwise
  `not_found`. It never writes a membership or role row.
- **Verified addresses only (sec T1-02, TB-DEPLOY-09).** `users.email` is the
  primary address when verified, else the first verified one, else null;
  `IdentityEvent.verifiedEmails` lists them. `ensureBootstrapAdminForEmail` and
  `admin:grant` refuse an address two live accounts share.
- **Invitations follow their sender (sec T1-03).** Removing, leaving or
  demoting someone withdraws the open invitations they could no longer send
  (`invitation.revoked`, `via` = the cause).
- **Send can't overwrite (UX T1-04, sec T1-04).** `sendInvitation` under the
  company lock refuses (`rank`) when an open invitation to that address carries
  a role the actor doesn't outrank; a permitted re-send keeps the earlier link
  working (`previous_token_hash`).
- **Rate limits after membership (sec T1-06).** The `invite` and `logo` buckets
  are keyed by company and charged only once the caller is shown to be a member;
  `setLogo` checks the caller before anything is stored.
- **Web addresses (sec T1-07).** Three changes a day per company; the last three
  retired addresses kept; `releaseRetiredAddresses` for staff (`staff.tenants.suspend`);
  create-app passes the project's own name as reserved.
- **Deletion is final (sec T1-08).** `user.deleted` always applies, is stamped
  when received, and a later create/update can't resurrect the row
  (`isResurrection`).
- **Top-rank peers (sec T1-09).** `assignRoleTemplate({ topRankPeers: true })`:
  an administrator can make another administrator; `protectLastKey` keeps the
  last one.
- **Staff scope everywhere (sec T1-10).** Every template lookup is by scope, so
  the first administrator is never handed the company "admin".
- **Identity before company state (sec T1-11).** Accept checks the address
  before reporting `company-unavailable`.
- **Same-origin JSON (sec T1-12).** Company POSTs must be `Sec-Fetch-Site:
  same-origin` (or a matching Origin) and `application/json` (multipart for the
  logo).
- **New owner by staff (UX T1-03).** `assignOwner` (`POST
  v1/admin/companies/:tenantId/owner`, `staff.tenants.transfer`), limited to
  active members, audited as `company.ownership.transferred` `via: operator`.
- **Removal keeps the pointer (UX T1-09).** The session tells "never had a
  company" from "was removed or left" (`formerCompany`); staff with no company
  go to the admin console.
- **Checklist (UX T1-13).** `restore` and `show` routes; a hidden list returns
  when a new item is added.
- **Activity in words (UX T1-17).** `AuditLineWire.detail`, built by
  `describeTenancyAuditEntry` (root).
- **Personal workspace names (TB-DEPLOY-10).** "{name}'s workspace".
- **leave by a non-member** answers 403 `not_a_member` (the isolation matrix),
  not 404; `active-set` is allowed in personal mode (the switcher needs it);
  route params allow dots (checklist keys like `team.invite`).

**create-app**

- **Two files, not one.** `src/server/tenancy.ts` builds the service;
  `src/server/tenancy-handlers.ts` builds the handlers (`buildTenancyHandlers`,
  `buildTenancyOperatorHandlers`, `requestPrincipal`, `invitationUrl`), because
  the handlers need `currentPrincipal` from auth.ts and auth.ts needs the
  service — one file would be an import cycle. `verifiedEmails()` lives in
  auth.ts beside the Clerk read.
- **Mode differences are constants, not variants, where only a value differs.**
  `CompanyGate.tsx` is one file reading `ONBOARDING_HREF` and `STAFF_HOME` from
  the generated `src/tenancy.ts`.
- **`/sign-out`** (template) gives `<AcceptInvitation signOutHref>` a real link.
- **`admin.setOverride` follows the rank rules (sec T1-05)**: not on yourself,
  only below you, only keys you hold, a company member's extra access only from
  the top staff rank; `staff.roles.manage` sealed; proved by the emitted
  `admin-overrides.test.ts`.
- **Deploy (TB-DEPLOY-01..08, 11, 14).** `packageManager` in package.json;
  ci.yml installs with `PACKAGES_READ_TOKEN`; the seed after every migration;
  an "Admin grant" `workflow_dispatch` job; `NEXT_PUBLIC_APP_URL` falls back to
  the production domain on production; ClerkProvider and both pages carry this
  site's sign-in and sign-up addresses; DEPLOYMENT.md covers the Clerk
  production instance, its webhook, Deployment Protection, email and first run;
  next steps no longer `cp .env.example`.
- **The isolation test plants a stray role row** for B in A, so each refusal is
  the membership gate's, not a missing grant's (its negative control fails
  without the gate).
- **The browser scenario** drops the first create answer (once for onboarding,
  once for "Create another") so the retry is a real second request; the
  fresh-key control runs on "Create another", because onboarding is also guarded
  by "one company per person".

## 17. Review round 2 (2026-10-12): what changed

**Server (`@adminigloo/tenancy`)**

- **A handed-over personal workspace stays handed over (SEC-T1-A, F1).**
  `provisionUser` writes the owner's membership, owner role, default name and
  pointer only while `owner_user_id` is that person, under the company lock.
  Someone who handed theirs over and was removed (or left) gets a NEW workspace
  (`ws_<user>.2`, …) from the session heal, never the old one back; personal
  sessions sort "your own" by owner, not by id.
- **Rate budgets (SEC-T1-B, SEC-T1-D).** A company bucket is charged only for a
  member who holds the route's permission (`TenancyService.hasPermission`); an
  invitation is also charged to its sender (`invite-sender` 50/hour,
  `invite-sender-day` 200/day). One account owns at most `companiesPerAccount`
  live companies (option, default 10; `forbidden` past it). No per-recipient
  cap: it would let any inviter block a real employer's invitation to that
  address for a day.
- **Web addresses (SEC-T1-C, F5, F6).** Changes are logged in
  `tenant_slug_changes` and counted per company (3/day) and per person (5/day),
  so switching back and forth counts. Losing a race for an address is
  `slug_taken` with a suggestion (a savepoint), never a 500. Releasing a
  SUSPENDED company's addresses frees its current one too (moved to a neutral
  `co-…` address, audited as `current`). Suspension alone still keeps the
  address: a company suspended over a bill comes back to its own.
- **Joining starts clean (SEC-T1-E, F3).** `consumeLocked` replaces a leftover
  role with the invitation's and deletes leftover overrides (the person was not
  a member a moment ago); `invitation.accepted` records what it replaced.
- **An invitation is its sender's authority (SEC-T1-F, F4).** A demotion to a
  role without `members.invite` withdraws ALL their open invitations; and
  `beforeConsume` withdraws one whose sender can no longer invite (any cause:
  a staff deny override, an edited template) — the invitee hears "withdrawn".
  A hand-over still keeps the previous owner's (they stay an Admin who may
  invite).
- **Every emailed link works (T1BO-02, F7).** `previous_token_hash` became
  `earlier_token_hashes text[]` (GIN-indexed): every earlier link of a re-sent
  invitation is honoured, the first email's always (`EARLIER_LINKS_KEPT` = 20).
- **Verified addresses (TB2-10, T1BO-07).** Accepting by link counts every
  verified address the host passes (`acceptInvitation({ verifiedEmails })`);
  the preview, given the caller, says whether the invitation is theirs and, if
  not, where it went (masked) and who they are signed in as.
- **No twins (T1BO-01).** "Create another" with the same name (case and spacing
  ignored) within 10 minutes opens the company already made. `checkSlug` says
  "That's the web address of X, which you already have" for the caller's own.
- **Support (T1BO-09).** Console search matches members' emails; company detail
  lists pending invitations (`AdminCompanyDetail.invitations`).
- **JSON on every JSON route (SEC-T1-H).** `readJson` checks the content type
  before treating an empty body as `{}`.

**Widget (`@adminigloo/tenancy-widget`)**: the address shown before Create is
the server's (T1BO-03); a lost Create answer is checked against the session
(T1BO-01); visible confirmations on the team page (T1BO-04); the wrong-address
explanation before Accept (T1BO-07); a sticky unsaved bar and an in-app link
guard in settings (T1BO-08); People counts link to the companies console, detail
lists invitations (T1BO-09); "Withdraw" everywhere, articles, readable zones, the
swatch and colour hints, "Access change", the owner confirm waits for a choice
(T1BO-10); freeing a suspended company's address (SEC-T1-C).

**create-app**: the isolation proof's "by-id" kind and input check (TB2-01);
the webhook's deletion tombstone and `admin:grant --id` (SEC-T1-G);
`setOverride` under the company lock for members only (F3); DEPLOYMENT.md's
generated "Vercel needs these" table, private-package access, the Deployment
Protection exception (TB2-02, 03, 05); README order, mode-specific "Not
included", the field-service note (TB2-04, 06, 07); `add` env split (TB2-08);
readable script failures (TB2-09); the plain invite page and landing screens
(T1BO-06, T1BO-11).

**e2e**: the README says what the scenario does NOT prove (T1BO-05); the
fixture's staff catalog and invite page match the generated ones; confirmations
are asserted on screen (`seenOnScreen`).

## 18. Review round 3 (2026-10-12): what changed

**create-app**

- **An optional id can't pass as tenant-only (TB2-01).** The isolation proof
  parsed B's company id alone, so `userId: z.string().optional()` was never
  sent and a procedure reading ANY company's member by it passed. Now
  `inputFieldsOf` (`@adminigloo/trpc`) reads every leaf the procedure's parsers
  declare — optional, nested, in arrays, through unions and pipes — and a
  "tenant-only" case fails if any other one `looksLikeAnId` (`userId`,
  `filter.memberIds[]`, `visit_id`); a query is also asked with each of A's ids
  in every text input it may be given (whatever it's called), and must answer
  with nothing of A's. A procedure that may be handed a row's id is "by-id".
- **Accepting by the link, through the project's own route (TB2-10).** New
  emitted `src/server/__tests__/invite-accept-route.test.ts` POSTs to
  `app/api/tenancy/[...path]/route.ts` with only Clerk stood in for: a second
  VERIFIED address is accepted; an unverified one and someone else's are
  refused. Removing `verifiedEmails` from `src/server/tenancy-handlers.ts` (or
  from the package handler) fails it.
- **admin:grant names the database it can't reach (TB2-09).**
  `describeScriptFailure` reads the cause chain (drizzle's "Failed query" wraps
  the driver's event), and admin:grant passes `<host>/<database>`; a template
  test runs the script against 127.0.0.1:9.

**Server (`@adminigloo/tenancy`)**

- **Per-company, per-address email limits (SEC-T1-B).** One company emails one
  address about an OPEN invitation at most once every
  `INVITATION_EMAIL_COOLDOWN_MINUTES` (10), and at most
  `INVITATION_EMAILS_PER_ADDRESS_PER_DAY` (5) invitation emails in any 24 hours
  across every invitation to it (withdraw-and-invite-again counts). Counted from
  `tenant_invitations.emailed_at` under the company lock, so it holds with no
  audit sink and two Resends can't both pass. Inside the limits the invitation
  is still SAVED — a first invitation, a fresh link, a new role — and only the
  email waits: `IssuedInvitation.emailHold`, `delivery: "held"`, the link, and
  `note`, the inviter's sentence ("We emailed … 3 minutes ago … You can email it
  again in 7 minutes, or copy the link below…"). Applies when the handlers have
  a `deliverInvitation` (`sendsEmail`). Still no cap anyone can spend for
  another company: the limits are per company.
- **The owner sees a wrong-account attempt (T1BO-07).** An Accept that answers
  `wrong-email` notes `wrong_account_at` and the caller's address masked
  (`wrong_account_email`, "j•••@gmail.com") on the open invitation, at most once
  per `WRONG_ACCOUNT_NOTE_MINUTES` (10). `InvitationWire.wrongAccount`; no email.

**Widget**: a held invitation shows the server's sentence and the link, never
"We couldn't email"; a re-send that wasn't emailed no longer says "A new email
went to …"; "Someone tried to accept this while signed in as j•••@gmail.com
(date). Ask them to sign in with the address it was sent to, or withdraw it and
invite the address they use." beside the invitation.

**Schema**: `tenant_invitations` gains `emailed_at timestamptz[]`,
`wrong_account_at`, `wrong_account_email` (the README's upgrade SQL has them).

## 19. Review round 4 (2026-10-12): what changed

**Server (`@adminigloo/tenancy`)**

- **"We emailed" only about an email that went (SEC-T1-B, blocking).** The
  per-address limits recorded an email inside the invitation's transaction,
  before the handler delivered it, so a delivery that was skipped (no mailer,
  no `RESEND_API_KEY`), failed or threw still counted, and the next Resend was
  held with "We emailed … a minute ago". Now the email is RESERVED under the
  company lock (`tenant_invitations.email_sending_at`, so two Resends at once
  still can't both go) and the handler settles it after the deliverer answers
  (`TenancyService.settleInvitationEmail`, `IssuedInvitation.emailReservation`):
  only `"sent"` is stamped into `emailed_at`, the history the limits and the
  inviter's sentence are read from; `"skipped"`, `"failed"`, any other answer
  (reported as `"failed"`) or a throw releases it at once. A Resend while one
  is on its way is held with a sentence that says only that ("We started
  emailing … and haven't heard back yet"); one that never comes back stops
  holding after `INVITATION_EMAIL_COOLDOWN_MINUTES` and is never counted. The
  daily-limit sentence says "the link in the email we already sent" only when
  an email of that invitation went. Recording the outcome failing is reported
  and never changes the answer.
- **The wrong-account note's guards (T1BO-07)** are pinned by tests: only an
  OPEN invitation is noted, and only for the wrong-account answer — never for
  the right person's expired link, a full or suspended company, or someone
  already in.

**create-app**

- **A project with no mailer is never told it emails (SEC-T1-B).**
  `src/server/invitation-mail.ts` exports `invitationEmailsConfigured`
  (`sender.configured`: the email package AND a `RESEND_API_KEY`; `false` with
  no email package), and `src/server/tenancy-handlers.ts` passes
  `deliverInvitation` only when it is true. New emitted
  `src/server/__tests__/invite-email-route.test.ts` proves it through the
  project's own handlers: as set up (no key / no package) never held and the
  mailer never asked; a mailer answering skipped or failed, or throwing, then
  Resend → emailed, not held; once an email went, the limit holds and says so.
- **Tenant-only means nothing else unless it says why (TB2-01).** The isolation
  proof now refuses ANY input a "tenant-only" procedure declares beyond
  `tenantId` and its globals — an optional `email` or `who` like an optional
  `userId`, mutations included — unless the case's `allow` names it with a
  reason (at least a phrase; a field the procedure really takes; never an
  id-like name). Queries are probed with everything that identifies company A
  (`fx.aStrings`: ids, its people's addresses and names, its name and web
  address), allowed fields included. The template's own extras are allowed
  with reasons: `ai.spend.days`, `account.invoices.limit`,
  `billing.simulateSubscription.status` / `.cancelAtPeriodEnd`.
- **"Could not reach the database" only by code (TB2-09).**
  `describeScriptFailure` walks `cause`, an ErrorEvent's `error`, Neon's
  `sourceError` and an AggregateError's `errors`, and says "could not reach"
  only for a network code (ECONNREFUSED, ENOTFOUND, ETIMEDOUT, EAI_AGAIN,
  ECONNRESET, EHOSTUNREACH, ENETUNREACH, ECONNABORTED, EPIPE, undici's
  UND_ERR_CONNECT_TIMEOUT / UND_ERR_SOCKET, Postgres 08xxx and 57P01–03). A
  reachable database refusing a statement is "A query on the database at … failed:
  <its reason> (<code>)", without the statement or its parameters.

**Widget**: a re-send that wasn't emailed says "The earlier links to this
invitation still work too." — links, not emails, since with no mailer there
never were any.

**Schema**: `tenant_invitations` gains `email_sending_at timestamptz` (the
README's upgrade SQL has it).
