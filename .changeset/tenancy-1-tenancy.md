---
"@adminigloo/tenancy": minor
---

Companies (Tenancy 1): a business owner signs up, names their company, invites
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
