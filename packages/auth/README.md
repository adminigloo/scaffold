# @adminigloo/auth

The identity half of an AdminIgloo app: the `users` table that mirrors your
identity provider (Clerk), the `Principal` every server function receives, and
the webhook verification that keeps the mirror honest. Roles are never read from
the provider — they live in `@adminigloo/permissions`.

```
@adminigloo/auth          Principal, verifyIdentityWebhook, shouldApplyEvent, isResurrection, env fragments
@adminigloo/auth/schema   users, identity_webhook_events
```

## What each install gets you

| You install | You get | You wire yourself |
| --- | --- | --- |
| `@adminigloo/auth` + `./schema` | A `users` row per person (`provisioned_at` says whether they have been set up), a webhook-event ledger so a retried delivery never runs twice, signature verification, VERIFIED-address-only mirroring (`email` is the primary address when verified, else the first verified one, else null; `verifiedEmails` lists them all), an out-of-order guard, and `isResurrection` so a late event never brings a deleted account back. | The webhook route and your `currentPrincipal`; both call `@adminigloo/tenancy`'s `provisionUser` (and the route calls `deprovisionUser` on deletion). |

## Install

Add the scope to your project's `.npmrc` (`@adminigloo:registry=https://npm.pkg.github.com`)
and a token with `read:packages` to your user-level `~/.npmrc`, then
`npm install @adminigloo/auth`.

## Why only verified addresses

`users.email` decides two things: who becomes the platform's first
administrator, and whom an invitation is for. An address somebody merely typed
into their profile can be anyone's — the founder's included — so it never lands
there. Keep "verify email at sign-up" on in your identity provider.

## Upgrading from 0.1

```sql
alter table users add column if not exists provisioned_at timestamptz;
-- Deliberately NOT backfilled: a null stamp makes the next request set the person
-- up, which repairs anyone an earlier webhook race left without a workspace.
```

A `user.deleted` event now always applies (the provider sends it without a
timestamp), and a later `user.created` / `user.updated` for a deleted account is
skipped (`isResurrection`).
