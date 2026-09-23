---
"@adminigloo/feedback": minor
"@adminigloo/assistant": minor
---

Add an optional AdminIgloo license gate to the feedback intake and the assistant
chat handler. Both take a new optional `license` option ({ key, publicKey, mode })
and, only when it is passed with `mode: "enforce"`, answer 402 for a deployment
that does not hold a valid license for the feature — before the feedback intake
runs or the assistant stream opens. Omitted, or `mode: "off"` (the default a
consuming app reads from `ADMINIGLOO_LICENSE_MODE`), behaviour is unchanged, so
every existing install keeps working. Depends on the new `@adminigloo/license`.
