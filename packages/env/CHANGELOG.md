# @adminigloo/env

## 0.1.1

### Patch Changes

- `defineEnv` now returns usable value types instead of `unknown`.
  
  TypeScript cannot compute `createEnv`'s mapped return type while the schema
  records are still generic parameters, so every variable arrived as `unknown` and
  `env.DATABASE_URL` failed to typecheck at the first use. Found by generating a
  project and running `tsc` on it, not by a unit test — the package's own tests
  never read a value back out. `InferEnvSchemas` spells the result out, and a
  compile-time assertion now guards it.

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
