# @adminigloo/db

## 0.1.0

### Minor Changes

- Neon Postgres primitives.
  
  - `createDb()` — pooled WebSocket client. WebSocket rather than HTTP mode so
    interactive transactions stay atomic; guards against pool leaks under Next's
    hot reload.
  - Column conventions: UUID v7 entity keys, bigserial log keys, bigint minor-unit
    money, timestamptz, soft-delete markers.
  - `withRollback()` — the integration-test sandbox. Real SQL, nothing committed,
    and it fails loudly rather than silently committing if the driver swallows the
    rollback signal.
  - `assertMigrationAllowed()` — blocks hand-run production migrations and blocks
    any migration handed a pooled connection string.
  - `dbServer()` env fragment enforcing the pooled/unpooled split.
