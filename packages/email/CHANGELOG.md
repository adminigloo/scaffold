# @adminigloo/email

## 0.1.0

### Minor Changes

- Transactional email with a delivery log that degrades to a no-op instead of
  throwing when it is not configured.
  
  - `parseSenderAddress` accepts both `hello@x.com` and `Name <hello@x.com>`.
    riddler-go validated this with `z.string().email()`, which rejected the
    display-name form — including the exact string its own code used as a
    fallback — so setting the correct value took the server down at boot with an
    error that said only "Invalid email".
  - With no API key a send is recorded as `skipped` and the intent logged, so a
    developer can see what would have gone out. Throwing instead makes every
    feature that sends mail unusable until someone finds a key.
  - An unset webhook secret REFUSES to process delivery events rather than
    trusting the payload — without it the route cannot tell a real bounce from
    anyone on the internet POSTing JSON.
