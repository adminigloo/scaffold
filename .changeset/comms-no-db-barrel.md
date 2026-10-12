---
"@adminigloo/comms": patch
---

Installs without a database driver it doesn't use: the id and timestamp column
helpers are the package's own (`uuidv7`), so importing `@adminigloo/comms` no
longer loads `@adminigloo/db` and, through it, the Neon driver, `ws` and the
env package. The `zod` peer is `^4.0.0`, the version the published types were
always built against.
