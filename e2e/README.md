# adminigloo-e2e

Real-browser (Playwright) tests for browser-behaviour code that a node/jsdom
test cannot exercise — the feedback screenshot capture is the first.

**Deliberately outside the pnpm workspace.** A normal `pnpm install` at the repo
root must never pull a browser driver into every library's typecheck (see the
note in `packages/testing/src/playwright.ts`). Playwright lives here and here
only; you opt in.

## Run

```sh
cd e2e
pnpm install
pnpm browsers   # one-time: download the Chromium build (skips if already cached)
pnpm test
```

`pnpm test` bundles each package's browser module (via `bundle.mjs`, esbuild →
`fixtures/*.bundle.js`) and runs the specs. Stitched screenshots for eyeballing
are written to `test-results/`.

## What `feedback-capture.spec.ts` proves

- A `position: fixed` **modal** is captured and stitched at its viewport
  position, and the page behind it is dimmed. (The bug that started this: a
  full-page capture drops fixed elements, so the modal was missing entirely.)
- A `position: fixed` **chat/side panel** is captured, but the page is **not**
  dimmed (only a real modal has a backdrop).
- An **in-flow** dialog is **not** re-captured and the page is **not** dimmed —
  the failure mode where a well-meant fix double-draws an element the page shot
  already contained and greys out the whole screen.

## What the other feedback specs prove

- **`feedback-centered-modal.spec.ts`** — a modal centred the way real dialogs
  are (`left/top: 50%` plus a `-50%` shift, as Tailwind v4's `translate`
  property and as v3's `transform`), at 1× and 1.5× pixel ratio and on a
  scrolled page: all four corner markers land at their true positions. (Before
  the fix, only the bottom-right corner survived — the sibling project's
  "corner of the modal" bug.)
- **`feedback-layers.spec.ts`** — every fixed layer, not just modals: a scrolled
  page keeps its fixed header and banner; an AI chat shows its latest message
  (its scroll position is kept); a see-through layer is drawn exactly once;
  fields inside a modal are redacted during its capture; toasts in a
  zero-height region, transform-positioned popovers, and a native `<dialog>`
  with its `::backdrop` all land where they were; a chat panel under a modal's
  backdrop is dimmed while the modal is not; `[data-sensitive]` content is
  blacked out; finding layers stays cheap on a 10k-node page.
- **`feedback-capture-regressions.spec.ts`** — the capture defects a 2026-09-23
  adversarial review reproduced: scrolled pages (both axes) showing the wrong
  region, a fixed inset-0 app shell losing its screenshot, a phone-width shadcn
  dialog captured narrow, stacked toasts upside down, a fixed background drawn
  over the page, fixed menus / sticky bars inside a modal, sticky headers,
  ancestor opacity (hidden and half-transparent), shadow roots and fixed SVGs,
  transformed-ancestor clipping, slow images holding the click, and capture
  writing into live fields.
- **`feedback-over-radix.spec.ts`** — the whole widget in a buyer-shaped app
  (`fixtures/host-app.tsx`: React 19 + a shadcn-shaped Radix Dialog, Headless
  UI v2, a native `<dialog>`, a chat panel), driven like a person: the button
  works over an open Radix / Headless UI modal without dismissing it; the
  screenshot has the whole modal; the feedback form is on top and typeable;
  Escape closes the form, not the host modal; the shortcut works over a native
  `<dialog>`; wheel scrolling in the form is not cancelled by a scroll lock.
- **`feedback-host-regressions.spec.ts`** — the host-interaction defects from
  the same review: the board ticket panel's Send button stays clickable; a
  React-controlled secret re-rendering mid-capture never reaches the pixels and
  live values are never touched; a platform-initiated close (mobile back) keeps
  React in sync; focus returns to where the reporter was; Escape works with
  focus on `<body>`; an IME's Escape is ignored; a click-away panel survives;
  host CSS for its own dialogs cannot reshape the form; the submitted click
  trail never quotes sensitive or ignored content or the widget's own clicks.

Negative controls: run against the widget as it was before the 2026-09-23 work
(the first port), 16 of the 18 host-app tests and 14 of the 15 capture
regressions FAIL — a test that passes either way guards nothing.

## What `feedback-board.spec.ts` proves

`@adminigloo/feedback`'s board and ticket panel, bundled from source (dev React,
StrictMode) inside an admin shell whose `<main overflow-y:auto>` the document
scrolls past, with a fake server that can resolve, reject, hold or partly fail
moves and refreshes the board afterwards. It covers drag-and-drop landing and
rollback with `onMoveError`, server changes winning over the board's own moves,
bulk selection (the bar is on screen, painted, and every target is 44px),
partial bulk failure, keyboard moves with focus and live-region announcements,
`ticketHref` modified clicks, the "Unrecognised status" column, the theme
prop, host token overrides beating the package stylesheet, axe WCAG 2.1 AA in
both themes, and the panel's focus trap and failed-send handling.

The 0.9.0 review fix pass added 27 more: the panel stays above the feedback
widget's launcher and a host's `--aib-z-panel` moves scrim and dialog together;
a native `<dialog>` opened above the panel keeps its own Tab and Escape; Escape
during IME composition (or already handled) doesn't close it; the Status select
sends one move on Enter or blur, not one per arrow key; a card moved twice
before the refetch lands never snaps back; `onMoveMany` can resolve
`{ failed }`; focus never falls to `<body>` after Apply, Clear or closing the
panel; columns are named groups with real lists; repeated announcements are
spoken again; and forced colours, control-edge contrast, host link colours and
the checkbox hit area all hold.

Set `AIB_BOARD_SRC=<path>` to run it against another `board.tsx` (copy
`board-tokens.ts` next to it). Against 0.8.0 the stale-status, bar-on-screen
and token tests fail. Against the board as it was before the fix pass, all 27
fix-pass tests and the two axe tests fail, and the other 22 pass.

## What `audience-ui.spec.ts` proves

`@adminigloo/audience`'s admin components (`./ui`), bundled from source (dev
React, StrictMode) into an analytics page with a KPI card, the rules panel, the
Mark this browser button and the unfiltered-sources note, fed by a fake server
that can resolve, reject, hold, or resolve `{ error }` (how a server action
keeps its reason in a production Next build) for each callback. It covers axe (WCAG 2.x AA) in
both themes at rest, with a preview showing and mid-removal, and for the
analytics role's masked view; 44px targets on every control; Add staying
disabled until the same draft has been previewed (and again after an edit);
duplicate and visit-only previews; failed preview, add, remove and mark, thrown
or resolved as `{ error }`; a
keyboard-only add and remove (Enter to preview, Escape out of the confirm,
focus kept); `maskEmails` with view-only showing no address anywhere; the
include-internal switch (a real link, Space works, banner while on); no
sideways page scroll at 390px; host token overrides; `theme="dark"` in a light
host; and forced colours.

Set `AIU_UI_SRC=<path>` to run it against another `ui.tsx` (copy
`core/labels.ts`, `core/words.ts`, `ui-tokens.ts` and `views.ts` beside it).

## What `scheduling-scenario.spec.ts` proves

The business scenario scheduling is sold on, end to end, in a browser. A
window-cleaning business in Salt Lake City (America/Denver) runs its week
through the REAL widgets (bundled from `@adminigloo/scheduling-widget`'s source)
against the REAL handlers and comms listener (`@adminigloo/scheduling` and
`@adminigloo/comms`, from their built `dist`) on PGlite, wired the way a
generated `--scheduling --comms --email` project wires them
(`fixtures/scheduling-scenario-server.ts`). Every email goes to an in-memory
outbox the test reads; the clock is one scenario clock the test moves, shared
by the server and each browser (Playwright's clock); Google Maps is a fake
`fetch` behind the real Google provider.

It walks the steps as the people involved, checking what each one sees and
receives: customers book at 390px from New York (the page must show the
business's 9:00 AM, not New York's 11:00 AM) and get the acknowledgement with a
working manage link; the office accepts one request, declines another with a
note, drags a visit two hours later with a real mouse and reassigns its crew,
and each customer is emailed; an unanswered request expires after 24 hours and
its customer is told; the reminder arrives 24 real hours before the visit across
the 2026-11-01 fall-back, with a link minted at send time, and the customer
reschedules from it; another customer cancels; inside the 12-hour cutoff the
link shows the phone number instead of the buttons and the API refuses
`too_late`; the crew opens today's route on a phone and sees the stop, its
directions link and Google's drive time, and starts and completes it. Finally,
every subject is in MST and the delivery log holds no manage key.

Negative controls (break one piece of wiring, run, restore): with no
`beforeSend` on the comms cron, no `redactSent` after it, `emailsEnabled:
false`, the staff handler not given `onEvent`, or the expiry cron not given
`onEvent`, the spec fails at the step that guards that piece — 5 of 5.

It needs `packages/scheduling` and `packages/comms` built (`pnpm --filter
@adminigloo/scheduling build`, same for comms), because their `dist` is what runs.

## What `estimator-scenario.spec.ts` proves

The business scenario the estimator is sold on, end to end, in a browser.
Summit Ramps, a wheelchair-ramp company in Salt Lake City, runs through the
REAL widgets (bundled from `@adminigloo/estimator-widget`'s source, and the
scheduling widget's for the booking page) against the REAL handlers and comms
listener (`@adminigloo/estimator`, from its built `dist`) on PGlite, with the
customer's photo kept through `@adminigloo/storage`'s real `storeFile`, the
invoice made by `@adminigloo/invoicing` and the visit booked through
`@adminigloo/scheduling` — wired the way a generated `--estimator --scheduling
--invoicing --comms --email --storage --ai` project wires them
(`fixtures/estimator-scenario-server.ts`, which imports create-app's own
`estimator-config.ts` for the staff keys, links, delivery status and visit
listing). Every email goes to an in-memory outbox; the photo is read by a fake
model that reports only OBSERVATIONS (the founder's porch: three risers, 7.5–8.5
in, medium confidence), so every number on screen is the package's code.

It walks the steps as the people involved: a customer finds /estimate not set
up until the owner loads the sample price book on purpose; the owner tests a
quote (cost and margin beside the price); a customer on a phone is asked how
many steps go up to the door and the height of one (never a "length of run"),
sees the price with the assumed step height said plainly, collapses the range
by entering a measured height, adds a real 1600 × 1200 photo the browser
shrinks to 768 × 576, sees the photo and "We counted 3 steps", the count
filled in and the code's working ("3 steps × 7.5–8.5 in each (from your photo)
= 22.5–25.5 in rise → … 23–26 ft of ramp"), corrects it to 2 and watches the
measurement and price follow, and saves; the lead is stored with the photo
(a stored_files row), the reading (observations only) and the correction, and
the office and the customer are emailed; office staff (prices, no costs) read
the lead with the photo and the AI's reading beside "steps 3 → 2", re-price it
from a measured height, add a line and send the quote; the customer accepts
from the emailed link, the office is told and the follow-up is withdrawn; the
accepted quote books the visit (listed on the estimate in the business's zone)
and becomes an invoice for exactly the accepted total, once; another customer
who never answers gets the follow-up on its day with a fresh link, and the
quote lapses on the estimator cron. One model call in the whole scenario, no
failure reported, no quote key in the delivery log.

Negative controls (break one piece of wiring, run, restore): the comms cron
without `beforeSend`, the public route without the photo store, the listener
without `bookUrl`, no `convertToInvoice`, the staff handler not given
`onEvent`, or office staff holding the costs key — the spec fails at the step
that guards that piece, 6 of 6.

It needs `packages/estimator`, `comms`, `storage`, `invoicing` and
`scheduling` built (their `dist` is what runs).

## What `tenancy-scenario.spec.ts` proves

The business scenario companies (Tenancy 1) are sold on, end to end, in a
browser. Summit Window Co. signs up for "Igloo Back Office" through the REAL
screens (bundled from `@adminigloo/tenancy-widget`'s source) against the REAL
service and HTTP handlers (`@adminigloo/tenancy` 0.4, from its built `dist`),
the permissions package's loaders and deploy seed, on PGlite — wired the way a
generated `--tenant-noun Company` project wires them
(`fixtures/tenancy-scenario-server.ts`: the company gate, the admin layout's
first-administrator self-heal, a fake sign-in that can arrive as the Clerk
webhook or as the first page request, an outbox for invitation emails, an
in-memory logo store). The fixture bundles its own host page in memory;
`bundle.mjs`'s `tenancy-widget` entry (Tenancy 2a) only proves the package
still bundles for a browser on its own.

It walks the steps as the people involved, with an axe check (no serious or
critical violations) on every screen it lands on:

1. Olivia signs up (the webhook arrives first) and lands on "What's your company
   called?"; a reserved web address is refused with a free one offered; the
   first answer is lost after the save (the fixture drops it, fails the page's
   next session check too, and ages the company past the server's 10-minute
   same-name window, so only the request key protects the retry) and she
   presses again, twice — one company.
2. The setup checklist starts at 0 of 3; "Add details" lands on the details
   section; saving the time zone and contact ticks one off.
3. A brand colour that reads well, and a logo that appears in the header switcher.
4. An invitation is emailed; Sam opens it signed out, creates an account, sees
   which company and role it is for, accepts, and never sees onboarding.
5. Olivia promotes Sam (with a confirmation), then removes him: his open tab is
   refused in a sentence on its next action, and his next page sends him to
   onboarding, which names the company he was removed from.
6. Sam rejoins, starts Side Gig through "Create another company" (its answer
   lost too: still one Side Gig), and switches between the two; each team page
   shows only its own people.
7. Olivia hands Summit to Sam (the button stays disabled until the name is
   typed) and leaves; the new owner can't just leave.
8. Ava (BOOTSTRAP_ADMIN_EMAIL) is let into the console, finds Summit, suspends
   Side Gig (Sam sees "Side Gig is suspended" with a way back to Summit) and
   reactivates it, and gives Olivia a staff role on People — her own row locked,
   with the reason shown.
9. At 390, 360 and 320 px: onboarding, the dashboard, the switcher menu, the
   team page and the settings page — nothing scrolls sideways, the account
   button stays on screen, and every control is at least 44 px tall.

A separate test (`lostAnswer: "check"`) loses the create answer while the
session still answers: the page says the company was made and opens it, for
onboarding and for "Create another" — no retry, no twin (review R2 T1BO-01).

Negative controls run in the same file, with `test.fail()`, against a
deliberately broken FIXTURE (the packages carry no bug switches):
`break: "fresh-key"` (a new request key on every create: the retry after a lost
answer makes a second Side Gig) and `break: "cached-gate"` (company pages from
the session cached at sign-in: a removed member keeps the company). Both must
fail, and do.

It needs `packages/tenancy`, `auth`, `permissions`, `observability` and
`testing` built (their `dist` is what runs).

### What it does NOT prove (review R2 T1BO-05)

"End to end" here means **the packages, wired the way we believe create-app
wires them** — not the generated project's own pages. The fixture draws its
own host pages (`HOST_APP`, `PAGE_CSS`, `signInPage`, the signed-out invite
page): the generated `src/components/CompanyGate.tsx`, `AuthHeader.tsx`,
`app/(site)/invite/[token]/page.tsx`, `app/admin/layout.tsx` (with
`AdminUnavailable`), the dashboard's link cards and the Clerk redirects are
never rendered in a browser by any test. What covers them instead:

- the generated project's own `tsc`, `next build` and unit suite (its emitted
  isolation, provisioning, override and webhook proofs run on PGlite);
- `scripts/verify-generated.mjs`'s route sweep, with Clerk unconfigured;
- create-app's generator tests, which read the emitted pages' text.

Where the fixture copies a generated page's WORDS (the signed-out invite page)
or its CATALOG (the staff permission defaults), it is kept in step by hand, and
says so where it does it. Running this scenario against a generated project
under `next start` needs a sign-in seam that bypasses Clerk, and that seam
must never ship in a buyer's project — so it is not done here.

The confirmations an owner reads after removing someone, changing a role or
handing over ownership are asserted ON SCREEN (`seenOnScreen`: a box larger
than a pixel), because Playwright counts a clipped screen-reader line as
"visible" (review R2 T1BO-04).

## What `tenancy-2a-scenario.spec.ts` proves

The business scenario Tenancy 2a is sold on (contract section 14, acceptance
item 9): two lawn-care companies run their own schedule, estimates, invoices
and messages on one "Igloo Back Office", and neither can see the other. The
REAL screens — every widget a companies project mounts, bundled from source by
`bundle.mjs`'s `tenancy2aScenarioTarget` (`fixtures/tenancy-2a-scenario-host.tsx`)
— in a real browser, against the REAL backend from the packages' built `dist`
(`fixtures/tenancy-2a-scenario-server.ts`): `@adminigloo/tenancy` 0.5's service,
handlers and route seams; scheduling, the estimator, invoicing and comms with
their private (`/api/app/{company id}/…`), public (`/api/t/{web address}/…`)
and embed handlers and their comms listeners; the permissions loaders and the
deploy seed (Crew included); `@adminigloo/email`'s real sender over a
capturing transport — on PGlite with every one of those packages' tables. It is
wired the way a generated `--tenant-noun Company --estimator --scheduling
--invoicing --comms --email` project wires them (contract 11.5: the company
route seams, first-time company setup, company links, per-company sender
identity and the three every-company crons); the generator's own shared
decisions (`scheduling-config.ts`, `estimator-config.ts`) are compiled from
create-app's source and called as they are.

Gail owns Green Acres (`green-acres`, Mountain Time), Sam owns Summit Lawn
(`summit-lawn`, Central Time), Pat is Green Acres' customer, Cam its crew
member, Mia a member, Vic a viewer, Ava the platform owner. An axe check (no serious or
critical violations) runs on every screen a step lands on.

1. **Two companies set up, each in its own area.** Each signs up and names
   the company; in `/settings/company` sets the time zone, contact email and
   phone, brand colour and — in the Invoices section, invoicing's settings
   fragment — how customers pay. Gail loads the sample price book on purpose
   — the LAWN CARE one, picked in the dialog, with nothing about ramps in it —
   and puts one product on her website; Sam adds one by hand. Each saves the
   estimate settings (the first-run form asks only the tax rate: the name and
   contact are the company's, shown read-only with the link) and, in schedule
   settings (the same read-only basics), switches online booking on and adds a
   crew with its hours. Sam's "Your website" offers a button and a page frame
   any site takes, in Summit's colour and pointing at Summit's own estimate
   page; under "For developers" he makes a key: shown once, with both snippets
   pointing at this deployment's `/api/estimator` and carrying the key, and
   "Test this key" answers with Summit's one product.
   Gail invites Cam as Crew (the Team page offers it), Mia as Member and Vic
   as Viewer; Sam invites one member. Both dashboards' checklists (0 of 9 at
   the start) reach "You're all set": Gail's with the website embed marked
   "Not needed", Sam's with it done.
2. **Public pages.** `/t/green-acres/estimate` carries Green Acres' name and
   colour and only its product, and its tab says "Instant estimate · Green
   Acres" (as the generated pages' `publicCompanyMetadata` sets it); `/t/summit-lawn/book-visit` offers times in
   Central Time and `/t/green-acres/book-visit` in Mountain Time, to a visitor
   in New York; `/t/green-acres` has a button per public page. The estimator
   embed called from Summit's own website with Summit's key (no cookie, no web
   address) answers as Summit: its name, its zone, only its product.
3. **One customer of Green Acres, end to end.** Pat gets an estimate and sends
   it, books a visit tied to it, Gail accepts the visit (Pat's manage-visit
   link opens `/t/green-acres/visit/…`: Green Acres' brand bar, the time in
   MST whatever Pat's own zone; the same token under `/t/summit-lawn/visit/`
   opens nothing) and sends the quote,
   Pat accepts it on `/t/green-acres/quote/…`, Gail turns it into an invoice
   and sends it, and Pat opens `/t/green-acres/invoice/…` and sees Green
   Acres' payment instructions. THE OUTBOX: every email to Pat has From name
   "Green Acres" on the platform's address, Reply-To Green Acres' contact
   email, and links only under `/t/green-acres/`; every office notice went to
   Green Acres' address and none to the platform owner; the delivery log rows
   say the same. Summit's estimates, schedule, invoices and Messages show none
   of it, and Sam's browser gets `403` for Green Acres' id through every
   private route tried. A Summit invoice token under `/t/green-acres/invoice/`
   is "isn't available" (D13) and opens under Summit's own address.
4. **Roles.** Cam accepts and his header shows only Dashboard and Today's
   route; joining as Crew of a company with one free crew, he is put on it
   (Gail's picker shows him picked, and lists only Green Acres' people); on the
   visit's morning his route lists Pat's visit, offers no other day, and the
   route refuses another day asked for directly; `/app/estimates`
   says "You don't have access to this page" and the routes answer 403. Mia
   creates an estimate and sends its quote, but the price book offers her no
   add, edit or retire control and estimate settings are read-only (the
   server refuses her save too). Vic's header shows Dashboard, Schedule,
   Estimates, Invoices, Messages, Team and Settings; every list shows Green
   Acres' work, and nothing is offered to change it — no New visit, no New
   estimate, no action on an estimate (a "your role can't change it" notice
   instead), no New invoice, no Send or Record payment — while the owner's
   same screens offer each; his POSTs to every feature's routes answer 403.
5. **Crons and suspension.** Ava looks into Green Acres in `/admin` (its
   people) and suspends Summit Lawn; `/t/summit-lawn/book-visit` says "Summit
   Lawn isn't taking requests online right now" with how to reach it, mounts
   no widget, and its API answers `409 booking_closed`; its estimator embed,
   called with Summit's key, answers `409 estimates_closed` with the same
   sentence. With a request
   overdue at each company and a third company active, the scheduling cron
   reports two companies, expires Green Acres' request (its customer emailed
   as Green Acres) and leaves Summit's untouched; with `failCompany=<Green
   Acres>` it reports Green Acres in `failed` and still runs the third. The
   estimator and comms crons walk the same list.
6. **Phone width (390 px).** `/app/schedule/today`, `/t/green-acres/book-visit`,
   `/t/green-acres/invoice/…` and `/app/invoices`: nothing scrolls sideways,
   every widget control is at least 44 px.

**Negative controls** run in the same file, each as a pair on fresh fixtures:
the assertion once on the fixture as wired (it must pass) and once on a
deliberately broken FIXTURE with `test.fail()` (it must fail — the packages
carry no bug switches):

- `break: "shared-identity"` — the comms senders get no `identity`, so every
  company's email goes out as the platform. Step 3's outbox assertion fails
  ("Igloo Back Office" where "Green Acres" was expected).
- `break: "unscoped-invoice-token"` — the public invoicing handler finds the
  company from the TOKEN's invoice instead of the web address in the URL (the
  read D13 forbids). Opening a Summit invoice token under
  `/t/green-acres/invoice/…` then shows Summit's invoice, and the "isn't
  available" assertion fails.

Both fail, and do, for those reasons.

It needs `packages/tenancy`, `auth`, `permissions`, `observability`, `testing`,
`email`, `comms`, `scheduling`, `estimator` and `invoicing` built (their
`dist` is what runs).

### What it does NOT prove

- **One database connection.** PGlite is one connection, so two companies'
  requests never truly overlap; races are covered as sequential interleavings
  in the packages' own tests.
- **Real email delivery.** No Resend: the transport records what the provider
  would have been handed (From, Reply-To, subject, text). Verifying the sending
  domain and deliverability are the deployment's.
- **Real sign-in.** No Clerk: a fake identity sets a cookie, as in the
  Tenancy 1 scenario. The same caveat as there holds for the pages: the
  fixture draws its own host pages and gates (`CompanyGate`,
  `PublicCompanyGate`, `AuthHeader`'s permission filter, the switch route) the
  way the generated ones do; the generated files themselves are covered by
  the project's own `tsc`, `next build`, unit proofs (`feature-isolation`,
  `company-crons`, `company-email`) and `scripts/verify-generated.mjs`'s route
  sweep.
- **Photo reading and photo storage.** The fixture connects neither (no AI
  key, no file storage), so the estimate page asks the customer to count; the
  estimator scenario covers both.
- **Real time.** One scenario clock, moved by the test; the browsers get the
  same time through Playwright's clock.

## What `tenancy-2b1-scenario.spec.ts` proves

The business scenario Tenancy 2b-1 is sold on (contract section 16): the two
lawn companies of the 2a scenario now hear about their work in the app and by
email, and keep photos and files against their visits, estimates and
invoices — each company only its own, and every file private. The REAL
screens (the 2a ones plus the bell in every company page's header,
`/app/alerts`, `/app/alerts/settings`, `/app/files`, a visit's photos and
files, and "Photos and files" under the estimate and invoice editors; bundled
from source by `bundle.mjs`'s `tenancy2b1ScenarioTarget`,
`fixtures/tenancy-2b1-scenario-host.tsx`) in a real browser, against the REAL
backend from the packages' built `dist` (`fixtures/tenancy-2b1-scenario-server.ts`):
the 2a fixture's backend (whose pieces it reuses; the 2a files are not edited)
plus `@adminigloo/notifications` 0.2 (the alerts, their handlers at
`/api/app/{company id}/alerts/…`, every installed package's producer first in
each listener list, the office emails claimed with `claimEmails` and handed
back with `releaseClaim`, the comms senders' `onFailed`, tenancy's team
events) and `@adminigloo/storage` 0.2 (the files over two in-memory stores —
PRIVATE, and PUBLIC served at `/__blob/{key}` as a CDN would — with a signing
key and `stillValid` checking the maker and the company on every open, its
handlers at `/api/app/{company id}/files/…`, the signed links and public files
at `/api/files/…`, the logo store tenancy uses and the estimator's photo
store), wired the way create-app 0.24 wires a `--tenant-noun Company
--estimator --scheduling --invoicing --comms --email --storage
--notifications` project. The test's own doors: `/__test/outbox` (each email
with its comms template), `/__test/blobs`, `/__test/clock`,
`/__test/cron/{alerts|files|scheduling|estimator|comms}` and
`/__test/replay-last-event`.

Gail owns Green Acres (business email `office@greenacres.test`), Mia is a
member, Cam the crew member on crew "North", Vic a viewer; Sam owns Summit
Lawn; Pat and Kim are customers; Ava is the platform owner. An axe check (no
serious or critical violations) runs on the screens a step lands on.

0. **Set up as in 2a**, through the screens: both companies, Green Acres'
   details, price book and estimate settings, booking on with crew "North"
   (same-day visits allowed in Schedule settings), Cam, Mia and Vic invited
   and in (Cam put on North as he joins). Gail reads her team's alerts.
1. **Alerts.** Pat asks Green Acres for an estimate, with a photo: Gail's bell
   shows 1 ("New estimate request: Pat Rivera…"), Sam's nothing. The outbox
   has ONE `estimate_lead_staff`, to the business email, From "Green Acres".
   With the dashboard open in a second tab, opening the alert takes Gail to
   the estimate and the other tab's badge follows without a reload. Alert
   settings' estimates card says "Emails go to office@greenacres.test, the
   business email in company settings." Pat asks for a visit today (it goes on
   North); Gail gets "New visit request" and accepts it; Pat moves it, still
   today: Gail gets "Pat Rivera moved their visit to …"; Cam's bell has ONLY
   the move (a sheet on his phone), opening Today's route, and his email is a
   `team_alert`, never the office notice. Mia has nothing; Vic's bell says
   "You're not on any alert lists yet…" (review BO-12; Mia holds
   `schedule.route` by default, so she counts as reachable). Replaying the
   last event to the listeners writes no new alert and sends no new email at
   all — Pat's own "your visit moved" included (scheduling 0.6 sends it once
   per event).
2. **Choices.** Gail sets "A customer moves a visit" to "In the app": the next
   move emails neither her nor the office. She puts Mia and
   `dispatch@greenacres.test` on the visits list: Kim's request alerts Mia,
   not Gail, and the office notice goes to Mia and to dispatch, once each.
   Back to "The owner", the business-email line returns.
3. **Housekeeping.** Gail keeps a PDF on `/app/files`; Mia opens it and copies
   a link (it opens). Gail removes Mia: Mia's `alerts` count answers 403, her
   alerts in Green Acres are gone, and her copied link shows "This link has
   expired, or the file was removed." (review G2). Ava suspends Summit: its
   booking page is closed and nothing is written for it. 31 days later the
   alerts cron clears Gail's read alerts and keeps her unread ones. The bell's
   count is the server's; at 390 px it opens as a sheet with nothing scrolling
   sideways, at 1280 px as a popover.
4. **Files.** Gail's logo is the one public file, at `/__blob/p/…` (public in
   `/__test/blobs`). Cam, on his phone, taps "Photos" on today's stop and adds
   a photo through "Take a photo"; Gail sees it on the visit's files page.
   Gail attaches a PDF to an invoice ("Your team sees these; they aren't sent
   to the customer.") and a photo to the estimate's "Other files". Pat's photo
   is on the estimate, PRIVATE. `/app/files` lists them all, says "Using … of
   5 GB", links Pat's photo to "Estimate … · Pat Rivera" (review BO-13) and
   its "Invoices" filter shows only the PDF. With the signal cut, Cam's next
   photo keeps its card with "Try again" and "Save to phone", and Try again
   adds it (review BO-05).
5. **Files are private.** Anonymously, Cam's photo's content route answers 401 or
   403 and `/__blob/{its key}` 404; a copied link opens it and, 61 minutes later,
   doesn't. Sam's browser gets 403 from Green Acres' files route with Green
   Acres' file id, and 404 from his own company's. Gail removes the invoice's
   PDF and its bytes leave the store. Mia (removed) gets 403. A 5 MB PDF says
   "That file is too big…", an SVG "That kind of file can't be kept here…".

**Negative controls** run in the same file, each as a pair on fresh fixtures
(the assertion on the fixture as wired, which passes, and on a deliberately
broken FIXTURE with `test.fail()`, which must fail; the packages carry no bug
switches):

- `break: "no-dedupe"` — every draft's `dedupeKey` gets a random suffix. The
  replay assertion fails: the replayed request writes a second alert.
- `break: "no-crew-scope"` — the alerts' `people()` ignores the permission.
  "Cam hears only about the move" fails: he also gets the team's alert about
  Mia joining.
- `break: "private-as-public"` — the private slot is the PUBLIC memory store,
  wrapped to say "private" (so createStorage's own check doesn't stop the
  fixture). "`/__blob/{private key}` → 404" fails: the file is served (200).
- `break: "link-ignores-maker"` — `stillValid` always answers yes. "A removed
  member's copied link shows the expired sentence" fails: the file opens.

All four fail, and do, for those reasons.

It needs every package the 2a scenario needs plus `notifications`,
`notifications-widget`, `storage` and `storage-widget` built.

### What it does NOT prove

- **One database connection.** PGlite is one connection (as in 2a).
- **Real email.** No Resend: the transport records what the provider would
  have been handed; the comms template of each email is read back from the
  delivery log.
- **Real file stores.** No Vercel Blob, S3, R2 or MinIO: two in-memory stores
  stand in, and the public one is served by the fixture as a CDN would. The S3
  signer is proven only by AWS's two published vectors (in the storage
  package's own tests, review BO-16).
- **Real sign-in.** No Clerk: a fake identity sets a cookie, as in 2a; the
  pages and gates are the fixture's renderings of the generated ones.
- **A real phone camera.** "Take a photo" is fed a file; the photo is shrunk
  by the browser as on a phone.
- **Real time.** One scenario clock, moved by the test.

## What `assistant-scenario.spec.ts` proves

A company's AI assistant (Tenancy 2b-3), end to end: the real launcher, chat
and settings bundled from `@adminigloo/assistant-widget`'s source, against
`@adminigloo/assistant`'s real company handler on PGlite, with the allowance
and ledger from `@adminigloo/ai/server` — and a SCRIPTED model, never a real
call (`fixtures/assistant-scenario-server.ts`, on a free port the system picks). At 1280 and 390:

- The "Ask the assistant" button opens a labelled dialog with focus in the
  question box; Tab stays inside; Escape closes it and focus returns to the
  button. On a phone it is full screen and nothing scrolls sideways.
- A starter question is answered from a tool, as rendered Markdown (bold, a
  list, a link to the site), with the figures the tool worked out.
- "Remember…" shows the "ask before acting" card; nothing is saved until
  "Yes, do it" — double-clicked, it saves one answer — and asking that
  question again is answered with the owner's words and no model call.
- Stop ends an answer where it is.
- The settings show the month's use, take a profile and a house rule; a spent
  month says so in plain words without calling the model; history reopens a
  conversation; on a dark host the widget is dark.

Needs `packages/assistant`, `packages/assistant-widget` and `packages/ai` built.

## What `estimator-widget.spec.ts` proves

`@adminigloo/estimator-widget` on its own, against a fake server answered with
`page.route`: the ramp flow at 390px (the stepper, the live price, the assumed
step height said plainly, no "length of run"); a real photo shrunk by the
browser's canvas to 768 px (the request's JPEG decoded here), the reading
beside the photo, the count pre-filled and corrected; the quote page's
Accept; the price book's sample load and test quote with the margin; the
host's light or dark theme and a brand colour; axe on the estimate tool, the
quote page and the price book.

## What `seo-jsonld.spec.ts` proves

@adminigloo/seo's JSON-LD escaping holds in a real HTML parser. The page HTML
is rendered in Node the way a Server Component renders it (`renderToStaticMarkup`
of `<JsonLd/>` from the package source), served to Chromium and parsed there.
For a `</script>` breakout, a `<!--<script>` that pulls the parser into its
double-escaped state, an upper-case `</SCRIPT >`, an image handler and
U+2028/U+2029, the page keeps exactly one ld+json block, no injected script
runs, the content after it survives, and `JSON.parse` of the block equals the
graph that was built. Its negative control writes the same payload with plain
`JSON.stringify` (how trailcards, Riddler Go and the AdminIgloo site wrote it)
and watches it break out.

`bundle.mjs` also bundles each of the five widgets a companies project mounts
(`tenancy-widget`, `scheduling-widget`, `estimator-widget`,
`invoicing-widget`, `comms-widget`) on its own, from source, customer and staff
entries together: a widget that picks up a server-only import stops bundling
for a browser, and this names the package. Imported (rather than run), it
exports `buildTarget` and `tenancy2aScenarioTarget`, which the Tenancy 2a scenario
fixture uses to build its host page in memory.

To add a browser test for another package, add a target to `bundle.mjs` and a
spec under `tests/`.
