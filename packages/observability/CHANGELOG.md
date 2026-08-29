# @adminigloo/observability

## 0.1.0

### Minor Changes

- Structured logging with credentials redacted, an audit vocabulary, error
  capture and rate limiting.
  
  - `REDACT_PATHS` names every credential-bearing variable this scaffold declares,
    and `redactValue` masks by VALUE shape for the ones whose path you cannot know
    in advance — including the hyphen-delimited Anthropic and OpenAI key formats
    that every underscore-based rule misses.
  - Connection strings mask userinfo only: the host is the diagnosis, and it is
    not the secret.
  - `defineAuditedActions` makes the registry the only way to name an action.
    askLou logs some actions as inline string literals, so an audit sweep that
    greps the registry silently misses them.
  - `errorFingerprint` is stable across deploys and machines, which is what lets
    `error_log` increment an occurrence count instead of inserting a millionth row.
  - Fixed-window rate limiting over an injected store, so nothing hard-depends on
    Upstash and the limiter is testable in memory.
