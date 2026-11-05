---
"@adminigloo/tenancy": minor
"@adminigloo/tenancy-widget": minor
"@adminigloo/create-app": minor
---

People: invite someone to a staff role by email, and edit a person's name.

- tenancy 0.9: `inviteStaff` (an address with one account gets the role at once; any other waits in the new `staff_invitations` table for 14 days, emailed at most once per 10 minutes), taken up on the verified address at `provisionUser` and at the /admin gate's new `ensureStaffAccess`, with the inviter's authority; `listStaffInvitations`, `revokeStaffInvitation`; `setPersonName`, written to the app's identity provider first. New operator routes and handler options (`deliverStaffInvitation`, `staffSignUpUrl`); `AdminPerson.canRename`. One new table: generate a migration.
- tenancy-widget: `<StaffPeople>` gets the Invite form, the invitations waiting with Withdraw, and Edit name.
- create-app: every project wires it: `src/server/staff-invitation-mail.ts`, Clerk as the name's identity provider, the operator handlers' mailer and sign-up link, and `ensureStaffAccess` in the /admin layout.
