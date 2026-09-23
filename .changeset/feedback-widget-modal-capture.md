---
"@adminigloo/feedback-widget": minor
---

Report a modal WITH the modal: the screenshot shows what was on screen, and the
widget works while a host modal is open. Every behaviour below is pinned by a
real-browser test in `scaffold/e2e` (48 tests), most of them written after an
adversarial review reproduced the defect in Chromium.

**The screenshot is what the reporter saw.**

- Every fixed layer on screen — modals and their backdrops, AI chat panels,
  toasts, popovers, fixed headers — is found by computed style (plus the browser
  top layer and sticky elements), whatever library drew it, captured on its own,
  and stitched back in true paint order (full stacking-context path, so stacked
  toasts keep the newest on top). A layer the page's own content paints over (a
  fixed background under the page) is left to the page capture.
- Centred dialogs are captured whole: `left:50%` plus a `-50%` shift (Tailwind
  v4's `translate` property, or v3's `transform`) left only the bottom-right
  corner; min/max sizes no longer squeeze a phone-width shadcn dialog.
- Backdrops are painted in their real colour; native `<dialog>` `::backdrop`
  colours are honoured; a chat panel under a modal's backdrop is dimmed too.
- Layers keep transparency (rounded corners), their scroll position (an AI chat
  shows its latest message), ancestor opacity, and nested fixed/sticky content
  (a fixed menu inside a modal). Open shadow roots and fixed SVGs are found.
- **Scrolled pages are right.** The page capture used to show content from twice
  the scroll offset (or blank), and an app shell with a fixed inset-0 root threw
  and lost the screenshot. Fixed.
- Slow images inside layers no longer hold the click for up to 30s; the button
  shows "Capturing…" while it works.

**Privacy.** Redaction now happens on the capture CLONE and never touches the
live page — the old value-swap could leak a React-controlled secret between
layer captures and permanently replace a field that matched two rules with
bullets. Secret field detection is case-insensitive (`apiKey`, `accessToken`),
covers textareas and `autocomplete` secrets, and `[data-sensitive]` content is
blacked out in every capture. The click trail no longer quotes
`[data-sensitive]` / `data-feedback-ignore` content or the widget's own clicks.

**Failed requests ride along.** fetch and XMLHttpRequest calls that answer
>= 400 or never arrive are recorded as `failedRequest` entries in the report's
`recentErrors` (method, path, status — never a body or query string; aborts and
the widget's own platform calls are left out). A "the button did nothing" report
now arrives with the 500 behind it. No platform change: `recentErrors` already
accepts any error type.

**The widget works over a host's open modal** (shadcn/Radix, Headless UI,
native `<dialog>`, MUI click-away):

- The button and the form live in widget-owned `<body>` containers that stop
  press/click/focus/wheel events from reaching host "outside click" and scroll
  lock listeners; the button stays clickable under a Radix body lock and does
  not dismiss the modal being reported.
- The form is a native `<dialog>` in the top layer: always above the host modal,
  and the host's focus trap cannot pull focus out of it. Focus returns to where
  the reporter was on close; a platform-initiated close (mobile back) keeps
  React in sync; Escape closes the form (not the host modal), even with focus on
  `<body>`, and an IME's Escape is ignored. Host CSS for its own dialogs cannot
  reshape it.
- New export `isFeedbackWidgetTarget(target)` for hosts whose modal library
  cannot be reached zero-config (the `focus-trap` library, Zag/Ark UI).

`overlaySelectors` is still honoured as an opt-in marker list; `data-feedback-ignore`
keeps an element out of every screenshot and the click trail.
