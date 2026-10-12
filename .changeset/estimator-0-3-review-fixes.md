---
"@adminigloo/estimator": minor
---

Fixes from the 0.3 review (2026-10-12): what an owner told "it works" would
otherwise have found out from a customer.

- **Closed until set up.** No estimate page, no customer email, no quote
  before the business has saved its name and tax rate (`estimatorReady`,
  `publicEstimatesOpen`, `settings_incomplete`). A product that prices at $0 is
  answered as "priced by a person", never as $0, and the admin names it
  (`products_unpriced`), as it names labor hours at a $0 rate
  (`labor_rate_zero`) and a price book with nothing on the website
  (`nothing_public`).
- **The sample arrives off the website**, so its made-up prices reach no
  customer until the owner turns each product on.
- **Unmeasured jobs are priced in the middle of their range**: the default
  typical step is 7.5 in (the band is still 7–8). The quote's line says what it
  is priced at ("3 steps, 7.5 in each (estimated), 23 ft of ramp"), and the
  estimate's `sendWarnings` say it BEFORE the send, with the range in dollars.
  The customer's email asks them to reply with one step's height.
- **The step count and the porch.** The reading says what it counted ("We
  counted 3 steps up, including the last one onto the porch or landing"), the
  help says "2 steps and the porch is 3", and a customer who lowers the photo's
  count is asked about it (`TakeoffReading.fewerCheck`). Staff get the reading
  without customer instructions. No sentence says "below".
- **A total height that can't be the steps given** (under 4.5 or over 9 in a
  step: "3" meant as 3 ft) is questioned on its field, never priced.
- **The photo's step height is the owner's call**: kept inside their own
  From–To, said plainly when the photo looked outside it, and switchable off
  per product (`usePhotoStepHeight`).
- **Bought whole**: a supply can round up to whole units per item
  (`roundUp`, on by default for one sold each): 5.25 posts are priced as 6.
- **Quotes have versions.** An accept or decline names the version the
  customer saw; a re-sent quote's old links stop working, so a quote emailed to
  the wrong address can be cut off by sending it again.
- **Every expiry is announced**, at least once: announced, then stamped, and a
  cron cut off part-way leaves the rest for the next run (`timeBudgetMs`).
- **Photo storage has limits**: at most 12 unsent photos per visitor and 500
  per business a day (`photoLimits`), counted in the database; the clean-up
  runs to a time budget instead of 100 a day.
- **The AI budget counts readings in progress** at their most, under one
  advisory lock with the per-visitor count, so a burst can't overrun it; a
  reading gives up after 12 s with no retry.
- **Nothing a visitor typed is a link** in any email, the office's included,
  and the public submit ignores a line description.
- **Costs stay with those who may see them**: waste, markup, margin and the
  default labor rate are stripped for staff without `estimator.costs.view`,
  who can't preview unsaved cost changes either.
- **An existing price list can feed the supplies**: `upsertComponentByRef` and
  `getComponentByRef` (one row per `externalRef`, the cost "managed outside"
  and refused in the price book), and `onPriceBookChange` on the staff handler
  for a host that mirrors changes back.
- **Behind proxies**: `createClientIpKey({ trustProxy, cloudflare })`, and the
  README's table of setups.
- **Installs anywhere**: no `@adminigloo/db` dependency (nothing loads a
  database driver), the zod peer says `^4.0.0` like the types, and the README
  has the full CREATE script for a database whose migrations belong to Prisma,
  Rails or Knex (kept in its own Postgres schema), one install block with
  Docker, the cron route with its secret and a GitHub Actions schedule, and
  what happens without `rateLimit`.
- The accuracy eval refuses to run without `sharp` (now a dev dependency) and
  says when it found no real photo to score.
