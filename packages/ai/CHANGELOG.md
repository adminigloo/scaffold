# @adminigloo/ai

## 0.1.1

### Patch Changes

- Updated dependencies
  - @adminigloo/env@0.2.0
  - @adminigloo/db@0.2.0
  - @adminigloo/auth@0.1.1
  - @adminigloo/permissions@0.1.1

## 0.1.0

### Minor Changes

- Conventions for streaming routes: authorize before the stream opens, and record
  what it cost.
  
  - The ordering is the point. Once headers are flushed there is no clean way to
    send a 403 — the client has already begun rendering a response that will
    simply stop. Permission resolution completes before the handler is called.
  - Usage is recorded on completion, error AND cancellation. A row that only
    writes on clean completion under-reports every abandoned request, and a user
    closing the tab still consumed tokens.
  - Cost is integer micros supplied by the app. Per-million-token rates lose
    precision as floats at exactly the volumes that matter, and a price baked into
    a package is wrong the week after it ships.
