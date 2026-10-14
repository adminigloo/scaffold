# @adminigloo/estimator-widget

## 0.3.0

### Minor Changes

- 2df95e8: Company features (Tenancy 2a).
  
  - **Pattern hrefs**: `estimateHref` (on the queue, the editor and the admin
    shell) accepts a string with `{id}` ("/app/estimates/{id}") as well as a
    function, so a server page can pass it.
  - **Company-owned fields read-only** in estimator settings (name, contact
    details, time zone, brand colour), under "These come from your company
    settings." with the link. The first-run form asks only for what is still
    the estimator's.
  - **The site's ceiling** on photo-reading spend: the daily budget's hint says
    "Up to $x.xx a day on this site." and a budget above it is refused before
    saving.
  - **The closed message**: when the business isn't taking estimates online, the
    estimate tool and the quote page show the server's sentence, with how to
    reach them.
  - The company's **logo** beside its name on the estimate tool and the quote
    page, and a `#embed` deep link that focuses the website embed keys.
  - **Read-only for people who can look but not change** (`canManage={false}`
    on `PriceBook`, `EstimatorSettings` and `EmbedKeys`): a company member who
    quotes from the price book sees it with no add, edit, retire or sample
    button, and estimate settings read-only, instead of controls the server
    would refuse. `EstimatesQueue` and `EstimateEditor` take it too, for a
    company's viewer: the estimates listed with no "New estimate", and each
    estimate shown in full with no action, edit or photo change ("You can see
    this estimate. Your role can't change it."). Without the prop nothing
    changes.
  - **Fixed**: the website embed's two snippet boxes scroll sideways but
    couldn't take keyboard focus, so someone without a mouse couldn't read the
    end of the line to copy. Each now takes focus and is named by the line
    above it.
  - **Fixed**: the accepted quote's "Pick a time for the work" button was
    painted in the banner's green on the business's colour, which nobody could
    read. A button in a banner now keeps its own colours.
  
  After review:
  
  - **Your website, no code**: with `publicPageUrl` (and `buttonColor`),
    `EmbedKeys` leads with a button and a page frame any website takes — Wix,
    Squarespace, WordPress — and folds the keyed React snippet under "For
    developers", saying what it needs.
  - `notices={false}` on any staff screen, for the second screen on a page that
    already shows them.
  - The sample price book asks which trade (lawn care, cleaning or ramps); a new
    product starts as "A count"; examples are no longer about ramps; the time
    zone is shown by name; an empty Lead alerts list says where alerts go.

## 0.2.0

### Minor Changes

- 7226d06: Fixes from the estimator 0.3 review (2026-10-12), for the screens.
  
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
- 7226d06: The estimator's screens, for `@adminigloo/estimator` 0.3: a customer gets a
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

## 0.1.1

### Patch Changes

- 91c7d58: Unit-mode products send their count in `quantity` only. Sending it as
  `measurement.units` as well billed a per-unit component quantity² times once
  the engine (estimator 0.2.0) scales per-unit parts by `units`. The widget also
  asks for a name and an email or phone before saving, matching the platform,
  which now refuses a lead nobody can call back — instead of failing with a
  generic error after the round trip.
