# @adminigloo/tenancy

## 0.5.0

### Minor Changes

- 2df95e8: Company features (Tenancy 2a): what the feature packages need to serve many
  companies from one site.
  
  - **Roles a project composes.** `defineTenantRoles([...])` adds roles below
    admin to the core four (scheduling adds Crew: someone who opens their own
    route on a phone and sees nothing else). Pass it as `roles` to
    `createTenancyService`; invitations, role changes, the team page's options
    and the first-company seed all use it. A bad role (a core key, a rank that
    ties a core role, a missing name) fails at boot with
    `InvalidTenantRoleError`. An unknown role key over HTTP is refused with
    "Pick one of the roles listed." `RoleKey` on the wire now takes any
    lowercase key. Without `roles`, nothing changes.
  - **A public lookup that knows about suspension.** `resolvePublicCompany(slug)`
    returns a suspended company with `status: "suspended"` (through its current
    or an old address), so its public pages can say it isn't taking requests
    instead of a 404. `resolveCompanyBySlug` still hides it, as before.
    `PublicCompany` gains `timeZone`; `publicCompanyToWire` (no id) feeds the
    widget's brand bar.
  - **The company profile.** `companyProfile(id)`: name, web address, status,
    time zone, contact details, address, logo and colour, where customer replies
    go (the contact email, else the owner's), where its own notices go, and every
    settings section's values. One query, no permission check (for server code
    that has already decided whom it serves). `listMemberPeople(id)`: a
    company's active people, for "who opens this crew's route".
  - **Every company, for crons.** `activeCompanyIds()` and
    `runForEachCompany(tenancy, work, { concurrency, timeBudgetMs, onError })`:
    one company's failure is reported and the next one runs; the start rotates by
    the hour so a cut-short run doesn't skip the same companies every time.
  - **Route seams.** `createCompanyRouteSeams({ tenancy, principal })` gives the
    feature packages' staff routes `resolveTenant` and `authorize` (signed out
    401, not a member 403, suspended 403, missing permission `false`; one
    permission lookup per request). `createPublicCompanySeams({ tenancy })`
    gives their public routes `resolveTenant` (by web address) and `admit`
    (closed for a suspended company, with how to reach it).
  - **Three events** after commit: `company.settings.updated` (with the changed
    fields), `company.profile.updated` (name and/or web address) and
    `company.branding.updated`.
  - The time zone field's help now says visits already booked keep their clock
    times.
  
  After review: `runForEachCompany` starts at a different company every run
  (`rotationStart`), so a daily cron that runs out of time never leaves out the
  same companies day after day; `CompanyProfile.createdAt`; and the activity
  log describes a settings change in words ("Business details: time zone,
  phone"), not field keys.

## 0.4.0

### Minor Changes

- cc16902: Companies (Tenancy 1): a business owner signs up, names their company, invites
  the team and runs it, and the platform owner can see and steer every company.
  
  **For a business owner and their team** (`@adminigloo/tenancy/server`):
  
  - **Race-free sign-up.** `provisionUser` is a state machine with one stamp
    (`users.provisioned_at`): the Clerk webhook and the first page request can
    arrive in either order, a crash halfway is finished by the next request, and
    0.3 users the webhook race left with nothing are repaired on their next visit.
    A single-business project's workspace is named after its owner ("Sam Lee's
    workspace"); once handed to someone else it stays theirs.
  - **Create a company** (`createCompany`): one transaction, the creator as owner,
    the web address suggested from the name (`-2`, `-3` on a collision), reserved
    words refused in a sentence. The same form's key replays instead of making a
    second company, and a replay is read-only: someone no longer in the company
    gets `not_found`, never their old owner role back.
  - **Which company am I in?** (`resolveSession`, `setActiveCompany`): the pointer
    is a preference, never an authority; a stale one falls back deterministically.
    Someone removed from their only company is told which one.
  - **The team** (`getTeam`, `changeMemberRole`, `removeMember`, `leaveCompany`,
    `transferOwnership`): every row says what THIS caller may do to it, computed on
    the server; ranks are strictly greater; the owner can't be demoted or removed;
    removal takes effect on the very next request; a role change clears that
    person's own overrides; a hand-over needs the company's name typed. Removing,
    leaving or demoting someone withdraws the open invitations they could no
    longer send.
  - **Invitations** keep the 0.3 service and gain the company lock, the rank guard
    (including against overwriting someone else's open invitation), seats checked
    at invite and at accept (`seats.limitFor`), joining by a verified address from
    onboarding, a preview of what a link is for (and, before Accept, whether it
    is for one of the caller's verified addresses), accepting by any VERIFIED
    address, and re-sends that keep every earlier email's link working
    (`earlier_token_hashes`). Accepting starts clean (a leftover role or
    override is replaced), and an invitation stops working when its sender can no
    longer invite. One company emails one address at most once every 10 minutes about an open invitation (withdrawing and inviting again starts fresh, still within the daily five)
    and five times a day (`INVITATION_EMAIL_COOLDOWN_MINUTES`,
    `INVITATION_EMAILS_PER_ADDRESS_PER_DAY`); inside those limits a re-send or a
    new role is still saved, the email waits, and the inviter gets the link and a
    sentence (`delivery: "held"`, `note`). Only an email the mailer answered
    "sent" counts: the email is reserved under the company lock
    (`email_sending_at`) and released when the delivery is skipped, fails or
    throws, so the inviter is never told "We emailed" about one that didn't go
    (`IssuedInvitation.emailReservation`, `settleInvitationEmail`). A wrong-account Accept is noted on the
    invitation, masked, for the team page (`InvitationWire.wrongAccount`).
  - **Settings** (`defineSettingsFragment`, `defineTenantSettings`,
    `companySettings`): a typed registry other packages add sections to; values
    are parsed field by field and never take the page down.
  - **Profile and branding**: name, web address (old addresses keep pointing here,
    bounded: three changes a day per company and five per person, counted in
    `tenant_slug_changes`, the last three kept; losing a race for an address is
    `slug_taken`, never a 500), brand colour with a
    contrast report that warns and never refuses, and a logo through a storage
    seam (the caller is checked before anything is stored).
  - **The setup checklist** (`defineSetupChecklist`, `tenancyChecklistItems`):
    items other packages add; a dismissal can be undone; a hidden list comes back
    when a new item is added.
  - **The membership gate** (`tenancyMembershipGate`): suspension enforced in one
    place, for the permission loaders, the routes and the pages.
  - **HTTP handlers** (`createTenancyHandlers`, `createTenancyOperatorHandlers`,
    `TENANCY_ROUTES`): every company route names its company in the path; POSTs
    must be same-origin and JSON (an empty body too); a company's invite and logo
    budgets are charged only for members who hold the route's permission, and an
    invitation is also charged to its sender (`invite-sender`,
    `invite-sender-day`). One account owns at most `companiesPerAccount`
    companies (default 10).
  
  **For the platform owner**: list, search and page every company; one company's
  detail; suspend and reactivate; give a company whose owner closed their account
  a new owner; release a company's old web addresses; People with staff roles,
  where an administrator can make another administrator and the last one can't
  be removed. `ensureBootstrapAdminForEmail` refuses an address two accounts
  share. Console search finds a company by a MEMBER's email too, a company's
  detail lists who is invited, and releasing a suspended company's addresses
  frees its current one.
  
  **Activity in plain words**: `describeTenancyAuditEntry(action, metadata)` (root)
  turns a company-lifecycle audit row into "Jake: Member → Admin", "jo@x.com as
  Viewer", "Reason: payment needed" for the operator console.
  
  **Schema** (`@adminigloo/tenancy/schema`): `tenants` gains `created_by`,
  `creation_key`, `suspended_at`, `suspended_reason`, `suspended_by` and
  `setup_state`; `tenant_invitations` gains `earlier_token_hashes`, `emailed_at`,
  `email_sending_at`, `wrong_account_at` and `wrong_account_email`; two new
  tables, `tenant_retired_slugs` and `tenant_slug_changes`. The README's
  "Upgrading from 0.3" has the SQL.
  
  **One breaking-shaped addition:** `AcceptResult` gains
  `{ status: "refused" }` (from the new `beforeConsume` hook), and
  `InvitationService` gains `acceptForVerifiedEmail`. Code that switches over
  `AcceptResult` exhaustively needs the new case.
  
  Not included (Tenancy 2 and later): feature routes on the active company,
  public company pages, plans and billing, impersonation, custom roles, custom
  domains, company deletion.

### Patch Changes

- Updated dependencies [cc16902]
- Updated dependencies [cc16902]
  - @adminigloo/auth@0.2.0
  - @adminigloo/permissions@0.2.0

## 0.3.0

### Minor Changes

- A tenant's owner holds the owner role in it, as a row.
  
  **Owning a tenant conferred nothing.** `tenants.owner_user_id` says who a tenant
  belongs to and `tenant_members` says they are in it; neither is a permission.
  `@adminigloo/permissions` is deny-by-default all the way down and grants nothing
  implicitly, so a customer who signed up, was given a personal workspace and
  bought something held zero permissions in the only tenant they belonged to.
  `/account/billing` told them the renewal amount is shown to whoever holds
  `subscriptions.view` — "normally its owner" — while they were the owner,
  `account.billingPortal` answered FORBIDDEN, and inviting anybody was refused
  because they had no rank to compare an invitation against. Nothing errored; the
  product simply behaved as though the customer were a stranger in their own
  account.
  
  **A row, not a rule in the resolver.** Teaching `resolvePermissionSet` that an
  owner implicitly holds the owner template is fewer lines and needs no backfill,
  and it costs the property the permission model is built on: everything a
  principal can do is a row you can read, join, diff and audit. An implicit grant
  appears in no table — the admin checklist could not render it,
  `explainPermission` could not attribute it, revoking it would mean special-casing
  the ownership pointer, and "why can this person refund" would be answered by a
  resolver's source rather than by the database. This package already refuses that
  trade once, by giving `tenant_members` no role column so that a role is written
  in exactly one place.
  
  **Two new exports.**
  
  - `grantTenantOwnerRole(db, { tenantId, userId })` — one owner, at workspace
    creation. Returns whether a row was written.
  - `backfillTenantOwnerRoles(db)` — every tenant whose owner is an active member
    and holds no role. Returns how many rows were written. This is the repair for
    workspaces that already exist, and it is not optional: the creation path runs
    on a user's *first* sign-in only, so fixing creation fixes nobody who has
    already signed up.
  
  Both are a single `insert … select` against `role_template`, so an unseeded
  database inserts zero rows and reports zero rather than throwing — a first
  sign-in must not become a 500 because `pnpm db:seed` has not been run yet. Both
  carry `on conflict do nothing` against `principal_role`'s primary key, so an
  owner who has deliberately been assigned a *lower* template is never silently
  promoted back. The backfill skips soft-deleted tenants and suspended owners,
  because reinstating authority somebody removed on purpose is not a repair.
  
  `TENANT_OWNER_TEMPLATE_KEY` is exported alongside them so the one word that has
  to agree with `TENANT_ROLE_TEMPLATES`, with every `defaultFor: ["owner"]` in
  every catalog fragment and with the seeded row has a single spelling.
  
  **What this does to `assertMayGrant`.** Its rank comparison is
  `canManageTemplateKey`, which is strictly greater, so an owner still cannot
  invite another owner — deliberately, and unchanged. What changes is everything
  below that: an owner previously matched the "you hold no role in this
  organisation" branch and was refused *every* role, including viewer. They can
  now invite admin, member and viewer, which is the behaviour that branch was
  written to allow.
  
  No table objects and no `drizzle-orm/pg-core`, so the package root stays safe
  for client components.

### Patch Changes

- @adminigloo/db@0.2.2

## 0.2.0

### Minor Changes

- `createInvitationService` — the hop that turns a link into a membership.
  
  The package already minted invitation tokens, hashed them and classified rows.
  None of that puts anybody in a tenant, and nothing here did: the app half of
  this feature shipped calling `createInvitationService` from
  `@adminigloo/tenancy`, the identifier existed in no build of the package, and
  every generated configuration failed `tsc --noEmit` on one import.
  
  - **`send`, `accept`, `revoke`, `listForTenant`.** Built by
    `createInvitationService({ db })`, against an `execute`/`transaction`-shaped
    handle rather than the Drizzle query builder — the package root is imported by
    client components for `TENANT_ROLE_TEMPLATES`, so a table object here would
    drag `drizzle-orm/pg-core` into those bundles, and `newId` from
    `@adminigloo/db` would drag the Neon WebSocket driver and `ws` with it, which
    does not merely bloat a client bundle, it fails to build. `uuidv7` is a direct
    dependency for the same reason.
  - **Accepting is ONE transaction, and it is the whole point.** Marking an
    invitation consumed and writing `tenant_members` plus `principal_role` are
    three statements describing one fact. Split across round trips, a crash
    between them leaves a spent token and no member — unrecoverable from the
    application, because the plaintext token is gone, the row says the job is
    done, and the partial unique index does not cover an accepted row, so a fresh
    invitation to the same address would sit beside a membership that never
    happened.
  - **Single use is enforced by the database.** The row is taken with `SELECT …
    FOR UPDATE` before anything is decided, so two simultaneous redemptions
    serialise instead of both reading "pending". The loser is not an exception: it
    wakes after the winner commits, re-reads the row it now holds, and answers
    `already-a-member`. A double-click on the accept button is the ordinary case.
  - **The accept path's security regime is written down at the decision.**
    `generateInvitationToken` is 32 bytes of CSPRNG output as base64url, stored
    only as SHA-256 — opaque and unguessable, which on Better Auth's analysis is
    the regime where possession of the link is itself proof the holder received
    the mail, and a second identity check is not required. It is required anyway
    by default. Unguessability defends against somebody who never saw the link and
    does nothing about the people who did — relays, scanners, shared mailboxes,
    forwards — and what sits at the end of this link is a ROLE inside somebody
    else's organisation. `requireMatchingEmail: false` takes the other regime
    deliberately. The address compared is the one the identity provider verified
    and mirrored, never one the caller supplied; an account with no mirrored
    address fails the comparison, because "we do not know who you are" must not
    read as "you match".
  - **`AcceptResult` is a union of six, and a refusal is not an exception.**
    `accepted`, `already-a-member`, `expired`, `revoked`, `wrong-email` and
    `unknown-token`. A spent token and a token that never existed both report
    `unknown-token`, identically, so the endpoint is not an oracle for anybody
    holding a list of guesses.
  - **`tenant_invitations.revoked_by`**, mirroring `invited_by`. The audit log
    records the same act better, with a verified actor and a request context, but
    it is archived and this is not: "nobody cancelled it, the link just stopped
    working" is one of the few arguments this feature produces after the fact, and
    the answer should not depend on the audit log still holding that week.
  - **Tests for every refusal and for the race.** Expired, revoked,
    already-a-member, wrong-email, unknown-token, a corrupted stored hash, a
    deleted role template, and two genuinely interleaved redemptions of one link
    producing exactly one membership. They run the real statements through
    Drizzle's own dialect against a small fake Postgres, so the parameters are the
    parameters a driver would receive, and `for update` is a real queue.

### Patch Changes

- Shared dependency versions moved to pnpm's `catalog:` protocol.
  
  `drizzle-orm` was written out in eleven manifests and `zod` in nine, so bumping
  either was a bulk edit nobody could review — and the failure mode of a missed
  line is silent: two packages built against two different minors of drizzle emit
  .d.ts files whose column types are structurally incompatible, and the error
  surfaces in a generated project as an unreadable mismatch between two packages
  that each look correct on their own. `pnpm-workspace.yaml` now names each
  version once.
  
  **Nothing changes in the published tarballs.** pnpm rewrites `catalog:` to the
  literal range when a package is packed, and the packed manifests were compared
  against the previous ones to confirm it: every dependency, devDependency and
  peerDependency range is byte-for-byte what it was. This is recorded because the
  manifests changed and because the replacement is a publish-time behaviour worth
  being able to find in a changelog, not because a consumer will see anything.
  
  There are TWO catalogs on purpose. The default names the single version this
  workspace builds and tests against; the `peers` catalog names the wider range
  published packages promise their consumers — `drizzle-orm` is built against
  `^0.45.2` and accepts `^0.45.0`, `zod` is built against v4 and still accepts
  v3.25+. Collapsing them into one entry would silently narrow every published
  peer range, which is a breaking change for every consumer one patch behind.
  
  A new test in `@adminigloo/create-app` fails if any workspace manifest goes back
  to spelling a catalogued range out, and if the ranges the generator writes into
  a new project drift from the catalog.
- Updated dependencies
  - @adminigloo/db@0.2.1
  - @adminigloo/permissions@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies
  - @adminigloo/db@0.2.0
  - @adminigloo/permissions@0.1.1

## 0.1.0

### Minor Changes

- Tenants, members and invitations.
  
  - `tenant_members` carries NO role column. Roles live in `principal_role` in
    `@adminigloo/permissions`, one place — askLou splits role across
    `accountCompanies.roleId` and `companyRoleId` with 1-4 magic numbers that
    contradict its own seeded `role` table, and documents the conflict rather
    than resolving it.
  - Personal workspaces (`ws_<userId>`) make tenancy universal, so a consumer app
    and a B2B app run identical query paths. Minting refuses an empty user id
    rather than creating a workspace the predicate would then disown.
  - Invitation tokens are stored as SHA-256 only, verified with a timing-safe
    compare over the hex, and the open-invite uniqueness is a partial index whose
    predicate cannot exclude expired rows — which is why issuing must UPSERT.
  - Owns no `billing.*` key: that namespace belongs to `@adminigloo/stripe`, so a
    near-duplicate cannot silently decide access based on which key a route reads.
  - Tables are reachable only from the `/schema` subpath, keeping drizzle out of
    client bundles and avoiding duplicate CJS table objects.
