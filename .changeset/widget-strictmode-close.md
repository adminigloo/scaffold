---
"@adminigloo/feedback-widget": patch
---

The feedback form no longer shuts the instant it opens under React StrictMode in development (every `next dev`, since Next turns StrictMode on by default). StrictMode's effect re-run called the dialog's `close()` then `showModal()`, and the queued `close` event arrived at the re-opened dialog; the form now acts only on a dialog that is actually closed. A platform close (a mobile back gesture), the Close button and Escape still close it. New e2e spec runs the widget on a development React build.
