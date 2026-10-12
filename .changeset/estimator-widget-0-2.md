---
"@adminigloo/estimator-widget": minor
---

The estimator's screens, for `@adminigloo/estimator` 0.3: a customer gets a
real price from what they can count or measure, the business turns the lead
into a quote the customer accepts from a link, and the owner builds every
price from their own supplies.

**For customers**

- `<EstimateTool>`: an inline estimate (no modal needed). The product's
  questions come from the server in plain words ("How many steps go up to the
  door?", "Height of one step (optional)"), start empty, and never ask for a
  number the customer would have to work out. The price updates 300 ms after
  the last change, with how it was worked out, what was assumed ("Based on an
  estimated step height of 7–8 in. Measure one step and enter it for a tighter
  estimate.") and why it's a range. The widget does no arithmetic: every
  number and sentence is the server's.
- The photo: shrunk in the browser before upload (768 px, JPEG), shown back at
  once, the AI's reading beside it ("We counted 3 steps."), the count
  pre-filled in the same stepper marked "From your photo" and changeable. A
  measured job is never read. Up to three photos, kept with the estimate.
- Saved: the reference, the range, what happens next, and "Book a visit to
  measure" (`bookHref`).
- `<QuoteView>`: the quote page — the business, the lines, tax, total, how long
  it's good for, Accept / Decline confirmed on the page, the states after
  (accepted, declined, expired, being updated) in one sentence each, and a
  clean print.
- `<EstimatorButton>` + `<EstimatorModal>` (0.1's API, kept) is now a real
  dialog: labelled, Escape and a click outside close it, focus is trapped and
  handed back, the page doesn't scroll behind it.
- Errors are never an endless "Loading…": a key that isn't set up for the
  website, a lost connection (with Retry), and instant estimates switched off
  each say so plainly.

**For the office (`@adminigloo/estimator-widget/admin`, new)**

- `<EstimatorAdmin>`: four tabs — Estimates, Price book, Settings, Website
  embed — with the setup notices shown once.
- `<EstimatesQueue>`: search, Leads / Drafts / Sent / Accepted / Declined /
  Expired / Invoiced / All / Archived with counts, the photo and "AI read" at
  a glance, "Load more", New estimate.
- `<EstimateEditor>`: the photos opened large, each line's questions and
  options, "Set the price myself", what the AI read beside "The customer
  changed: steps 3 → 4", totals from the server, and the actions the server
  offers: send the quote (saying exactly what the customer gets), send again,
  revise, record a yes or no, copy the link, archive, duplicate, make an
  invoice, book the visit.
- `<PriceBook>`: products priced from a supplies library (how many, per what),
  labor, waste, markup or target margin, minimum and range, with options; a
  live "Test a quote" showing exactly what the customer is asked and sees, and
  — for those allowed to see costs — the cost breakdown and margin. "Load a
  sample catalog" only on a click. Changing a supply's cost names the prices it
  moves.
- `<EstimatorSettings>`: business, time zone, brand colour (previewed in light
  and dark), quotes, tax and currency, labor rate and contingency, lead alerts,
  instant estimates on/off, photos and the AI's daily limit with what it has
  cost.
- `<EmbedKeys>`: a key per website, shown once, with a snippet built from this
  deployment's address, "Test this key", and the websites it works on.

**Look**

- Follows the host page's theme (data-theme, a dark class, color-scheme, the
  background it sits on) live; `--aiew-*` tokens at zero specificity; every
  pair AA in light and dark. The business's brand colour applies in both
  themes and stays readable whatever it is. `nonce` for a strict CSP.
- No "Powered by" unless you pass `poweredBy`.
- 0.1's `aie-*` stylesheet is gone, with its invalid `font:` shorthand.

**Kept from 0.1**

`EstimatorProvider`, `EstimatorButton`, `EstimatorModal`, `useEstimator()`, the
`EstimatorTransport` class (deprecated, now a thin wrapper over
`createEstimatorClient`) and 0.1's types. `EstimatorConfig.clientKey` is now
optional (the business's own pages need no key), and the config gains
`theme`, `accentColor`, `bookHref`, `poweredBy`, `locale` and `nonce`.
`EstimatorTransport.takeoff()` always answers `result: null`: the AI no longer
measures anything; it reports what it sees.
