---
"@adminigloo/create-app": minor
---

The `--estimator` wiring, after the estimator 0.3 review (2026-10-12):

- The staff screens say WHY photo reading is off, in words that name the fix:
  generated without `--ai` ("isn't part of this site", with
  `pnpm dlx @adminigloo/create-app add ai`), no `ANTHROPIC_API_KEY`, or a
  model with no price (`estimatorPhotoReadingOff`, passed as
  `photoReadingOff`).
- `/api/cron/estimator` runs each job to a 20-second budget instead of 100
  rows: a backlog of unsent photos is cleared in one run, and every quote
  expiry is announced (a run cut off part-way leaves the rest for the next).
- The photo reading gives up after 12 seconds with no retry, inside the
  route's 30.
- The next steps put Settings first: `/estimate` is closed, and no quote can
  be sent, until the business's name and tax rate are saved. A new product and
  the sample stay off `/estimate` until the owner turns each one on.
- The nightly generator matrix builds two estimator projects: the full
  field-service one (`--estimator --scheduling --invoicing --comms --email
  --storage --ai --admin full`) and the smallest (`--estimator --admin minimal
  --no-comms --no-storage`).
