# @adminigloo/tenancy

Companies for an AdminIgloo app: a business owner signs up, names their company
and owns it; invitations bring the team in at a role (owner, admin, member,
viewer); people change roles, get removed, leave and hand ownership over; one
person can belong to several companies and switch between them; each company has
a web address, a logo, a brand colour and settings other packages add to; and the
platform's own staff can list, open, suspend, reactivate and re-own any company.
Every rule — who may change whom, the one owner, seats, suspension — is enforced
here, on the server, inside one transaction per change, so the screens
(`@adminigloo/tenancy-widget`) and your own code can't disagree about it.

```
@adminigloo/tenancy          client-safe: names and web addresses, brand colour contrast,
                             the settings and checklist registries, permission keys,
                             the audit vocabulary, role templates
@adminigloo/tenancy/schema   the drizzle tables (tenants, members, invitations, retired web addresses)
@adminigloo/tenancy/server   createTenancyService, the HTTP handlers, the membership gate,
                             the *ToWire helpers, ensureBootstrapAdminForEmail
```

Peers: `drizzle-orm` (^0.45) and `zod` (^3.25 or ^4). It depends on
`@adminigloo/auth` (the `users` table), `@adminigloo/permissions` (role
templates, the rank rules, the first administrator) and `@adminigloo/db`.

## What each install gets you

| You install / import | You get | You wire yourself |
| --- | --- | --- |
| `@adminigloo/tenancy` + `./schema` + `./server` | **Sign-up that can't race:** `provisionUser`, called from both the identity webhook and the first page request, sets a person up exactly once (`users.provisioned_at`), and repairs anyone an earlier version left with nothing. **Companies:** `createCompany` (one transaction, the creator as owner, the web address suggested from the name, reserved words refused, a replayed form never makes a second one and never gives a removed person their role back). **The session:** which company someone is in, a preference that is re-checked every time, with a deterministic fallback. **The team:** roles with strictly-greater ranks, the owner who can't be demoted or removed, removal that takes effect on the next request, a hand-over that needs the name typed, leaving. **Invitations:** hashed tokens, the company lock, the rank guard (including against overwriting someone else's invitation), seats checked at invite and accept, joining by a verified address, a preview of what a link is for, a re-send whose earlier link keeps working, and invitations withdrawn when their sender loses the power to send them. **Settings and checklist registries** other packages add to. **Branding:** name, web address (old ones keep pointing here, bounded), brand colour with a contrast report, a logo through your storage. **Suspension**, enforced in one membership gate. **The operator functions** for platform staff. **HTTP handlers** for all of it, rate-limited, same-origin JSON only. | One `createTenancyService({ … })` with your database, mode, permission catalog, bootstrap policy and audit sink; two route files mounting the handlers; `provisionUser` in your webhook and your `currentPrincipal`; the membership gate passed to `@adminigloo/permissions/server`'s loaders. |
| `@adminigloo/tenancy-widget` (+ `/admin`) | The screens for all of the above. | Thin pages; see its README. |
| `create-adminigloo-app` | All of it, wired: onboarding, the dashboard and its checklist, company settings, the team page, the header switcher, the invitation page, the operator console and People, the deploy-time seed, `pnpm admin:grant`, and a two-company isolation test in the project's own `pnpm test`. | Nothing. |

## Install

The package is private, published to GitHub Packages. Add the scope to your
project's `.npmrc` (commit this line, it holds no secret):

```
@adminigloo:registry=https://npm.pkg.github.com
```

and your token to your **user-level** `~/.npmrc`, never the repo:

```
//npm.pkg.github.com/:_authToken=<a GitHub token with read:packages>
```

Then:

```sh
npm install @adminigloo/tenancy @adminigloo/permissions @adminigloo/auth
```

## Quick start

**One construction site.** Build the service once and import it everywhere:

```ts
// src/server/tenancy.ts
import { auditEntry } from "@adminigloo/observability";
import { auditLog } from "@adminigloo/observability/schema";
import { companySettings, defineSetupChecklist, defineTenantSettings } from "@adminigloo/tenancy";
import { createTenancyService, tenancyChecklistItems } from "@adminigloo/tenancy/server";

export const tenancy = createTenancyService({
  db,
  mode: "companies",                         // or "personal": one workspace per person
  tenantCatalog,                             // your tenant permission catalog (spread tenancyPermissions into it)
  noun: { singular: "company", plural: "companies" },
  settings: defineTenantSettings([companySettings]),
  checklist: defineSetupChecklist([...tenancyChecklistItems()]),
  // Who becomes the first platform administrator, retried whenever none exists.
  // Pass "email" mode on a deployment; the address must be VERIFIED by your
  // identity provider (users.email only ever holds a verified one).
  bootstrap: { mode: "email", email: process.env.BOOTSTRAP_ADMIN_EMAIL! },
  logos: myLogoStore,                        // { put, delete }; omit and the settings page says uploads are off
  reservedSlugs: ["my-product"],             // your own brand is not a customer's web address
  invitations: { expiresInHours: 24 * 7 },
  audit: async (tx, event) => {              // on the same transaction as the change
    await tx.insert(auditLog).values(auditEntry(auditRegistry, { ...event, actor: event.actorUserId ? { userId: event.actorUserId } : null }));
  },
});
```

**Set people up from both paths.** In your identity webhook, after writing the
user row, and in your `currentPrincipal`, when the row's `provisionedAt` is
null:

```ts
await tenancy.provisionUser({ userId: row.id, email: row.email });
// and on the provider's "user deleted" event, after the soft delete:
await tenancy.deprovisionUser({ userId: row.id });
```

**The membership gate** decides who belongs where, suspension included. Hand it
to the permission loaders so your tRPC rungs and pages agree with the handlers:

```ts
import { createDrizzlePermissionLoaders } from "@adminigloo/permissions/server";
import { tenancyMembershipGate } from "@adminigloo/tenancy/server";

export const { loadTenantPermissions, loadStaffPermissions, explainTenantDenial } =
  createDrizzlePermissionLoaders(db, { membership: tenancyMembershipGate });
```

**Mount the handlers** (the widget talks to these):

```ts
// app/api/tenancy/[...path]/route.ts
const { handle } = createTenancyHandlers({
  tenancy,
  principal: async () => principalOrNull,          // { userId, email } of the signed-in person
  verifiedEmails: async () => addressesTheyVerified,
  invitationUrl: (token) => `${APP_URL}/invite/${encodeURIComponent(token)}`,
  // Only when this project can send mail: "sent" | "skipped" | "failed".
  deliverInvitation: async (mail) => ({ status: await sendEmail(mail) }),
  limit: async ({ bucket, key }) => myLimiter(bucket, key),   // TENANCY_RATE_LIMITS has the budgets
});
export const GET = handle;
export const POST = handle;

// app/api/admin/tenancy/[...path]/route.ts
const { handle } = createTenancyOperatorHandlers({ tenancy, principal, recentAudit });
```

`recentAudit` returns the company's audit rows newest first; build each line's
`detail` with `describeTenancyAuditEntry(action, metadata)` from the root, which
turns the metadata this package writes into "Jake: Member → Admin".

**Pages** render `@adminigloo/tenancy-widget` components with
`sessionToWire(await tenancy.resolveSession({ userId }))` and the other `*ToWire`
helpers, so the server turns its views into the wire shape in one place.

**Seed the roles on every deploy**, after migrations, with
`@adminigloo/permissions/server`'s `seedPermissionCatalog` and this package's
`TENANT_ROLE_TEMPLATES`, then `backfillTenantOwnerRoles(db)`, then — for a
named first administrator — `ensureBootstrapAdminForEmail(db, { email })`, which
refuses an address two accounts share.

## The rules, in plain words

- One owner per company, always. The owner can't be demoted or removed; they hand
  the company over (typing its name) and become an Admin.
- Ranks are strictly greater: you change only people below you, and only to roles
  below yours. Owner is reached only by creating a company or a hand-over.
- Removal deletes the membership, the role, any per-person access and the
  open invitations that person sent; it takes effect on their very next request.
- A suspended company: everyone in it sees "suspended — contact support", its web
  address answers "not found", and the platform's staff reactivate it.
- A company whose owner closed their account can be given a new owner by staff
  holding `staff.tenants.transfer`; staff holding `staff.tenants.suspend` can also
  release its old web addresses.
- Web addresses: three changes a day per company and five a day per person
  (counted from `tenant_slug_changes`, so switching back and forth counts),
  the last three kept as redirects. For a SUSPENDED company, staff's release
  also frees its current address (it moves to a neutral `co-…` one), so a
  squatted business name can be handed back without SQL.
- One account owns at most `companiesPerAccount` live companies (default 10;
  `null` for no limit), and an invitation is charged to its sender as well as
  to the company (`invite-sender`: 50 an hour, `invite-sender-day`: 200 a
  day), so making companies doesn't multiply what one account can send.
- One company emails one address about an OPEN invitation at most once every
  10 minutes (withdrawing and inviting again starts fresh), and about all its
  invitations to that address five times a day (`INVITATION_EMAIL_COOLDOWN_MINUTES`,
  `INVITATION_EMAILS_PER_ADDRESS_PER_DAY`), counted from the invitation rows
  themselves. A re-send or a re-invite at a new role inside those limits is
  still saved; only the email waits, and the inviter gets the link and a
  sentence saying when it can be emailed again (`delivery: "held"`, `note`).
  The first invitation to an address is never held. The limits apply when the
  handlers have a `deliverInvitation`, and they count only the emails it
  answered `"sent"` for: the email is reserved before it is handed over (so two
  Resends at once can't both go) and released if the answer is `"skipped"`,
  `"failed"`, anything else, or a throw — so the next Resend emails, and the
  inviter is never told "We emailed" about an email that didn't go. One whose
  answer never comes back holds the address for at most 10 minutes, saying
  only that we haven't heard back. With no `deliverInvitation`, nothing is
  sent and nothing is ever held: the inviter gets the link every time — so
  pass one only when the project can actually send mail. Calling
  `sendInvitation({ …, sendsEmail: true })` yourself? Email the link, then
  `settleInvitationEmail({ …issued.emailReservation, tenantId, sent })`.
- When someone presses Accept signed in with a different address, the
  invitation remembers it (masked, `j•••@gmail.com`, at most once per 10
  minutes), and the team page shows it beside the invitation: "Someone tried
  to accept this while signed in as j•••@gmail.com". No email is sent.
- Accepting an invitation starts clean: a role or per-person overrides left
  behind without a membership (an out-of-band delete) are replaced by the
  invitation's role, and the audit says what was replaced. An invitation is
  its sender's authority: if the sender can no longer invite (removed,
  demoted, a staff `deny members.invite`), it is withdrawn when used.
- In single-business mode a workspace handed to someone else stays theirs: the
  previous owner is never put back by provisioning, and if they're removed from
  it they get a new workspace of their own.

## Company features (Tenancy 2a)

0.5 adds what the feature packages (scheduling, the estimator, invoicing,
comms) need to serve many companies from one site. Nothing here is required:
without it, 0.5 behaves as 0.4.

### Roles a project composes

The core four (owner, admin, member, viewer) plus whatever the project's
packages add. Scheduling adds Crew: someone who opens their own route on a
phone and sees nothing else.

```ts
import { defineTenantRoles } from "@adminigloo/tenancy";
import { SCHEDULING_CREW_ROLE } from "@adminigloo/scheduling";

export const roles = defineTenantRoles([SCHEDULING_CREW_ROLE]);   // owner, admin, member, viewer, crew

export const tenancy = createTenancyService({ /* … */, roles });
// and the seed: seedPermissionCatalog(db, { tenant: { catalog, templates: roles.templates } })
```

Extra roles rank below admin (1–29, never 10 or 20), so the owner and the
admins manage them; a tie would mean two roles that can't manage each other,
which nobody would guess from the team page. A bad role fails at boot with
`InvalidTenantRoleError`. Invitations, role changes and the team page's
options all read the set; an unknown role key is refused with "Pick one of
the roles listed." The first company created on a database seeds the set's
templates, and a database seeded before Crew existed gets Crew on the next
company created. `DEFAULT_TENANT_ROLES` is Tenancy 1's four.

### The company, for server code

No permission check on these, like `readSettings`: they're for code that has
already decided whom it serves (a handler after `authorize`, a public page
after `resolveTenant`, a cron).

- **`companyProfile(id)`**: name, web address and `publicPath`, kind, status,
  time zone, contact email and phone, address, logo, colour and the text colour
  on it, `replyTo` (the contact email, else the owner's sign-in address),
  `inbox` (where the company's own notices go), and every settings section's
  values. One query. It's structurally a `SchedulingCompany`, an
  `EstimatorCompany` and an `InvoicingBusiness`'s base, so you pass
  `(id) => tenancy.companyProfile(id)` straight in.
- **`resolvePublicCompany(slug)`**: the company at a web address (current or
  old), WITH its status: a suspended company comes back `"suspended"`, so its
  public pages can say it isn't taking requests instead of a 404.
  `resolveCompanyBySlug` still hides it. `publicCompanyToWire(found)` is the
  public face for `<CompanyBrandBar>` (no id on it).
- **`listMemberPeople(id)`**: the company's active people, for "who opens this
  crew's route". Never the site's whole user table.
- **`activeCompanyIds()`**: every company a cron should serve (not suspended,
  not deleted), ordered by id.

### Every company, for crons

```ts
import { runForEachCompany } from "@adminigloo/tenancy/server";

const report = await runForEachCompany(tenancy, (tenantId) => sweepOverdue(db, tenantId), {
  concurrency: 4,          // default
  timeBudgetMs: 20_000,    // stop STARTING companies after this; the rest are `deferred`
  onError: (error, tenantId) => log.error({ tenantId, error }),
});
// { companies, ran: [{ tenantId, result }], failed: [{ tenantId, error }], deferred: [ids] }
```

One company's throw is in `failed` (the message only, cut to 300 characters)
and the next company runs. Every run starts at a different company
(`rotationStart(now, n)`, a hash of the run's minute), so a run cut short never
skips the same companies run after run — whatever the schedule: a start that
moved by the hour started at the same company every day on a daily cron
whenever the company count divided 24. Deferred companies aren't promised to go
first next time, so log a non-empty `deferred` where you'll see it. If the
company list itself can't be read, the whole run rejects.

`companyProfile(id).createdAt` says when a company was made, for a host that
gives new companies lower limits (create-app's sending allowance does).

### Route seams for the feature packages

```ts
import { createCompanyRouteSeams, createPublicCompanySeams } from "@adminigloo/tenancy/server";

// Staff routes: /api/app/{company id}/…
const seams = createCompanyRouteSeams({ tenancy, principal: (req) => getSignedInUser(req) });
createSchedulingAdminHandlers({ db, resolveTenant: seams.resolveTenant, authorize: seams.authorize, /* … */ });

// Public routes: /api/t/{web address}/…
const pub = createPublicCompanySeams({ tenancy });
createSchedulingHandlers({ db, resolveTenant: pub.resolveTenant, admit: pub.admit, /* … */ });
```

`authorize(req, permission, tenantId)` answers, in order: signed out → a 401
"You've been signed out. Sign in again to keep working."; not a member of this
company (or a made-up id) → 403 "You're not part of this company."; suspended
→ 403 "This company is suspended. Contact support to restore it."; without the
permission → `false` (the handler's own 403); otherwise `{ userId }`. One
permission lookup per request, however many times a route asks.

`admit(tenantId, req)` is open for an active company and closed for a
suspended or unknown one, with "{Name} isn't taking requests online right now.
Call {phone} or email {email}." A slug-addressed request costs one tenancy
query for both calls.

### Events

Three more, after commit through `onEvent`: `company.settings.updated`
(`section` and the `changed` fields, as in the audit row),
`company.profile.updated` (`changed`: `"name"` and/or `"slug"`) and
`company.branding.updated`. Scheduling's time zone follows the company's by
listening for `company.settings.updated` with `"timeZone"` changed.

## Upgrading from 0.4

Nothing to migrate. `RoleKey` is now `"owner" | "admin" | "member" | "viewer"
| (string & {})`: code that switches over it exhaustively needs a default.
`PublicCompany` gains `timeZone`, and `TenancyService` gains `roles`,
`resolvePublicCompany`, `companyProfile`, `listMemberPeople` and
`activeCompanyIds` (a hand-written fake of the service needs them).

## Upgrading from 0.3

For hosts not on drizzle-kit (with drizzle-kit, `db:generate` writes this for you):

```sql
alter table users add column if not exists provisioned_at timestamptz;
-- Deliberately NOT backfilled: a null stamp makes the next request set the person
-- up, which repairs anyone the 0.3 webhook race left without a workspace.

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

-- Every earlier link of a re-sent invitation keeps working (the first email's
-- always; up to 20 in all).
alter table tenant_invitations
  add column if not exists earlier_token_hashes text[] not null default '{}'::text[];
create index if not exists tenant_invitations_earlier_token_hashes_idx
  on tenant_invitations using gin (earlier_token_hashes);
-- When each invitation's link was emailed (the last day's), for the per-address
-- email limits, and an email still on its way; and the last wrong-account
-- Accept, masked, for the team page.
alter table tenant_invitations
  add column if not exists emailed_at timestamptz[] not null default '{}'::timestamptz[],
  add column if not exists email_sending_at timestamptz,
  add column if not exists wrong_account_at timestamptz,
  add column if not exists wrong_account_email text;

create table if not exists tenant_retired_slugs (
  slug text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  retired_at timestamptz not null default now()
);
create index if not exists tenant_retired_slugs_tenant_idx on tenant_retired_slugs (tenant_id);

-- Every web-address change (the daily limits count these, per company and per person).
create table if not exists tenant_slug_changes (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  from_slug text not null,
  to_slug text not null,
  changed_by text,
  changed_at timestamptz not null default now()
);
create index if not exists tenant_slug_changes_tenant_idx on tenant_slug_changes (tenant_id, changed_at);
create index if not exists tenant_slug_changes_by_idx on tenant_slug_changes (changed_by, changed_at);
```

`AcceptResult` (the 0.3 invitation service) gains `{ status: "refused" }`; code
that switches over it exhaustively needs the new case.

## Foreign hosts: don't use this package

If your app already has its own sign-in and its own idea of a customer account
(Ridgeline is the example: its own auth, its brands as tenants), don't install
`@adminigloo/tenancy`. It assumes `@adminigloo/auth`'s `users` table and owns
company membership, roles and onboarding end to end. Every other AdminIgloo
package takes the tenant from you instead: pass your own tenant id to their
`resolveTenant(req)` / `tenantId` options and your own permission check to their
`authorize` option. Your app stays the authority on who belongs where.

## Not included

- **Per-company boards and widgets for feedback, notifications, files, the
  assistant, analytics, SEO/AEO and book-a-call (booking)** — **Tenancy 2b**.
  (Scheduling, the estimator, invoicing and comms are per company since 2a.)
- **Payments to companies** (Stripe Connect: a customer paying a company's
  invoice by card). Invoices are paid however the payment instructions say;
  staff record the payment.
- **Search indexing of company pages**, and per-company SEO.
- **Logo and colour inside emails.** Emails carry the company's name and
  reply-to; their bodies are plain text.
- **Emailing customers about a time-zone correction** made in company
  settings. Visits keep their clock times and reminders are re-queued silently.
- **Moving a pre-2a companies project's feature rows** (written under the
  fixed `"primary"` business) into a company. Nothing does it automatically.
- **Plans, billing and entitlements.** The seat hook exists. The billing chunk
  wires it to plans.
- Viewing as a customer (impersonation). `staff.tenants.impersonate` is declared
  and sealed, and nothing implements it.
- A custom role editor for companies, and per-person permission changes for
  company members. The roles are the project's set (`defineTenantRoles`):
  Crew is a fixed role scheduling adds.
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
