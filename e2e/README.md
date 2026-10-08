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

To add a browser test for another package, add a target to `bundle.mjs` and a
spec under `tests/`.
