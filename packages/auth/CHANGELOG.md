# @adminigloo/auth

## 0.1.0

### Minor Changes

- Identity mirror. Clerk owns credentials and sessions; this owns the local user row.
  
  - `users.id` is OURS (UUID v7), with the provider id in `external_id` behind a
    unique index. riddler-go uses the Clerk id as the primary key, which is why it
    cannot change identity provider without rewriting every foreign key.
  - `Principal` — the single contract downstream packages consume. Carries
    `impersonatedBy` so staff-acting-as-user is auditable by construction.
  - `verifyIdentityWebhook()` — real svix verification, normalised payload,
    primary-email selection, lowercased for deterministic matching.
  - `shouldApplyEvent()` — rejects out-of-order webhook deliveries that would
    overwrite newer data with older data.
  - `authServer()` / `authClient()` env fragments, with both Clerk keys registered
    as mode-bound so a live key cannot run outside production.
