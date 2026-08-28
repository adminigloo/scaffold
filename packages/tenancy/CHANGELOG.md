# @adminigloo/tenancy

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
