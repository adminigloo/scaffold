---
"@adminigloo/create-app": minor
---

Add the `create-adminigloo-app add <feature>` subcommand: turn a feature on in a
project that was already generated. It reads the project's `adminigloo.json`,
plans the feature exactly as generating with it would have — mounting its router,
registering its schema, adding its env and admin nav — and never overwrites a
file you have edited (those land as `<file>.new` to merge). The invariant, which
the tests assert for every feature: `add` on an untouched project produces
byte-for-byte what generating fresh with that feature would have.

Also bumps the `@adminigloo/feedback` (0.8.0) and `@adminigloo/assistant` (0.8.0)
pins to the license-aware releases. Both are no-ops for a generated project until
license enforcement is turned on.
