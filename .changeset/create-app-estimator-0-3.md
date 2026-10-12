---
"@adminigloo/create-app": minor
---

A generated `--estimator` project is now an estimating business a ramp company
(or any measured trade) can run, built from `@adminigloo/estimator` 0.3 and
`@adminigloo/estimator-widget` 0.2 with no code of its own beyond wiring.

**What a business gets**

- `/estimate`: the instant estimate (`<EstimateTool>`), in the public nav, the
  sitemap and llms.txt. Customers answer what they know — how many steps go up
  to the door, the height of one step if they measured it — and see a live
  price from the business's own price book with the working in plain words.
  Never "length of run": the code works that out. An optional photo is shown
  back, kept with the estimate, and (with `--ai`) read for the step count only.
- `/quote/[token]`: the quote a customer accepts or declines online
  (`<QuoteView>`). Never indexed, no Referer, kept out of robots.txt.
- `/admin/estimates`: leads and quotes (`<EstimatesQueue>`), with search,
  filters and archive; `/admin/estimates/[id]`: one estimate (`<EstimateEditor>`)
  — the photo, what the AI saw beside what the customer settled on, the lines to
  edit (re-priced from the price book), "Send quote".
- `/admin/estimator`: the price book (`<PriceBook>`): products priced from the
  business's own supplies, labor, waste and markup or margin, with a live test
  quote and exactly what a customer is asked. "Load a sample catalog" only on
  purpose — nothing seeds itself from a public page.
- `/admin/estimator/settings`: business details, tax, quote validity and
  follow-up, lead alerts, photo reading and its daily budget
  (`<EstimatorSettings>`), and website embed keys (`<EmbedKeys>`).
- `/api/estimator` (the page and the keyed embed; `/api/estimator/embed` keeps
  0.2 embeds working) and `/api/admin/estimator`, behind this project's sign-in
  and five new staff keys: `staff.estimates.view`, `.manage`, `.costs`,
  `.pricebook`, `.settings` — seeing costs and margins is its own key.
- `/api/cron/estimator`, scheduled in `vercel.json`: marks quotes past their
  date expired (and tells the customer and the office) and deletes photos
  nobody sent.

**Glue, by what else is installed** (generated `src/server/estimator-notify.ts`
and `src/server/estimator-services.ts`):

- `--comms` (+ `--email`): the new-lead email to the office, the customer's
  copy, the quote with its link, the follow-up when nobody answers (withdrawn
  the moment they do, re-checked by the comms cron at send time), the
  thank-you, the expiry note and the office's notices.
- `--storage`: the customer's photo kept with the estimate.
- `--ai`: the photo read by Claude Haiku 4.5 (`ESTIMATOR_TAKEOFF_MODEL` to
  change it) — observations only, one small call, every call's tokens and cost
  in `ai_usage`. `MODEL_RATES` gains the Haiku 4.5 row. Without `--ai` the
  customer counts the steps and the admin says reading is off.
- `--scheduling`: an accepted quote's "Book the visit" opens `/book-visit`
  tied to the estimate, and the visits booked from it are listed on it;
  `/admin/schedule?date=YYYY-MM-DD` opens that day.
- `--invoicing`: "Create invoice" turns an accepted quote into an invoice in
  one transaction, once.

**Breaking (0.x minor)**

- The tRPC `estimator` router, `src/components/estimate/EstimateTool.tsx`,
  `src/server/estimator-seed.ts` (the demo catalog seeded on first read),
  `src/server/estimator-takeoff.ts` and `/api/estimator/takeoff` are gone. The
  widgets speak HTTP to the package's handlers.
- `--estimator --admin none` is refused, in plain words: nobody could build the
  price book or answer a lead. `--estimator` brings `--comms`, `--storage` and
  `--email` unless declined.
- Pins `@adminigloo/estimator` `^0.3.0` and adds `@adminigloo/estimator-widget`
  `^0.2.0`.
- `CRON_SECRET` is declared for the estimator; `ESTIMATOR_TIME_ZONE` and (with
  `--ai`) `ESTIMATOR_TAKEOFF_MODEL` are new optional variables.
- `recordAiUsage` takes `userId: null` for a call nobody signed in made.

New capabilities: `estimator.quotes`, `estimator.photos`,
`estimator.photo-reading`, `estimator.followups`, `estimator.book-visit` and
`estimator.invoicing`.
