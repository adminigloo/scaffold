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

To add a browser test for another package, add a target to `bundle.mjs` and a
spec under `tests/`.
