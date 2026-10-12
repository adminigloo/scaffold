---
"@adminigloo/estimator-widget": minor
---

Fixes from the estimator 0.3 review (2026-10-12), for the screens.

- "More ways to measure" really hides its questions (`.aiew-root [hidden]`).
- The photo reading has **Change the count**, which takes the customer to the
  count; a count lowered below the photo's asks about the step onto the porch
  (the server's `fewerCheck`, under the field). No sentence says "below".
- The photo preview is a `data:` image, so it shows under a strict
  Content-Security-Policy (`img-src 'self' data:`); the fallback decode uses a
  `data:` URL too, and the OffscreenCanvas path paints white first (a
  transparent PNG was black).
- `<QuoteView>` sends the `version` it shows with an accept or a decline, and
  on `quote_changed` shows the new version in the server's words.
  `AcceptQuoteBody` and `DeclineQuoteBody` now require `version`.
- `<EstimatorSettings>`: a business that never saved settings gets one **Get
  started** form (name, phone, email, sales tax, labor rate), saved together;
  the rest open after. A settings save by someone who can't see the labor rate
  never sends one.
- `<PriceBook>`: a new product starts off the website, and the sample's
  confirmation says its products do too. The list shows each product's price
  at an everyday answer ("3 steps: $6,921.46, margin 28.57%"). The editor stays
  open after "Create the product" ("Created"), with the test answers; hours at
  a $0 labor rate are called out in Labor and under the breakdown; each supply
  has **Bought whole**; the ramp settings have "Use the step height from the
  photo"; and waste, markup, margin and the labor rate are hidden, not shown as
  0, from someone without access to costs. On a phone, supplies are cards and
  the editor keeps the price and margin in a bar at the bottom. A supply fed
  from the business's own price list shows "Price from your list", its cost
  read-only.
- `<EstimateEditor>`: the send dialog shows the server's `sendWarnings` before
  sending; "Customer was shown" only on a customer's own estimate; the reading's
  star is text-sized.
- The wire types follow the server: `fewerCheck`, `PublicQuote.version`,
  `usePhotoStepHeight`, `roundUp`, `externalRef` / `managedExternally`,
  `ProductExample`, `sendWarnings`, nullable cost fields, three new error codes
  and three new notices.
- README: one install block (token from the environment) with Docker, the
  Content-Security-Policy directives, how to render the stylesheet on the
  server with its nonce (no unstyled flash), and no reference to a contract
  file the package doesn't ship.
