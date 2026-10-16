---
"@adminigloo/feedback-widget": minor
---

For a company's own feedback page (Tenancy 2b-2a).

- **`clientKey` is optional.** A company's public feedback page names the
  company in its address (`/api/t/{web address}/feedback`) and sends no key.
  "My reports" keeps a keyed install's list where it always was, and gives
  each keyless page its own list (`reportsInstallId`).
- **`screenshot: false`** opens the form straight onto "What happened?" — for
  a page whose whole purpose is the form, where nothing on screen is what the
  report is about.
- **`askContact: true`** asks for the reporter's name and email (both
  optional), so the team can answer by email too.
- **`FeedbackLauncher`**: "Send feedback" and "My reports (N)" inline on a
  page, where `FeedbackButton` floats in a corner. A closed form says why
  instead of offering to send, and still opens "My reports".
- A refused request shows the server's own sentence, whatever its shape
  (`errorSentence`), and a closed form's sentence shows in the form.
- The form carries a hidden field a person never fills (`website`), so the
  platform can refuse a report a script filled in.
