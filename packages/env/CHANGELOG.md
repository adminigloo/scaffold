# @adminigloo/env

## 0.1.0

### Minor Changes

- Boot-time environment validation.
  
  - `resolveAppEnv()` derives local/staging/production from `VERCEL_ENV` — never
    from a variable of its own, so the deployment cannot be spoofed from a dashboard.
  - `assertKeyMode()` binds provider key mode to the deployment. Runs outside Zod,
    so `SKIP_ENV_VALIDATION` cannot switch it off: a live key can never run outside
    production.
  - `appUrl()` refuses a localhost origin on a real deployment, and says in the
    error that `NEXT_PUBLIC_*` requires a rebuild.
  - Pooled vs unpooled Postgres URL discrimination, prefixed-secret and
    generated-secret helpers.
  - `defineEnv()` composes per-package env fragments.
