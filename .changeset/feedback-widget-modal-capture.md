---
"@adminigloo/feedback-widget": minor
---

Capture open modals, dialogs, and other `position: fixed` overlays in the
feedback screenshot. A full-page `domToCanvas` capture silently drops fixed
positioning, so a report submitted with a modal or an AI panel open used to show
only the page behind it — the one thing the reporter was not looking at. The
widget now captures each open overlay individually before its own UI opens
(where fixed positioning is moot because the overlay is the capture root),
records its viewport rect, and stitches the overlays back onto the page
screenshot over a dimmed backdrop. Accessible dialogs (`[role="dialog"]`,
`[role="alertdialog"]`) and anything tagged `[data-feedback-overlay]` are caught
by default; the new `overlaySelectors` config adds or replaces them (e.g. a
bespoke chat panel).
