# @adminigloo/tenancy

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
