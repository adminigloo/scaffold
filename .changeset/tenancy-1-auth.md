---
"@adminigloo/auth": minor
---

- `users.provisioned_at` (nullable): when provisioning finished. Null means the
  next request provisions the user. Deliberately not backfilled.
- The webhook mirrors only VERIFIED addresses into `users.email` (the primary one
  when it is verified, otherwise the first verified one, otherwise none), and
  `IdentityEvent` gains `verifiedEmails`. An address someone merely typed into
  their profile can no longer become the account's email, which is what decides
  invitations and the first administrator.
- A `user.deleted` event always applies (Clerk sends it without `updated_at`),
  and `isResurrection` tells a caller not to let a late `user.created` or
  `user.updated` bring a deleted account back.
