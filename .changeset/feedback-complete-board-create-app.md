---
"@adminigloo/create-app": minor
---

The complete feedback board (feedback 0.11), with `--feedback`:

- **Search and filters on every board** — each company's `/app/feedback` and
  this site's own `/admin/feedback`: status, priority, category, who it's
  assigned to (Mine and Unassigned in one click), where it came from and when
  it was sent, kept in the page's address and remembered per browser, with
  "Showing X of Y". **New ticket** for the team, and a **+** on each column.
  The ticket panel edits the title, priority, category and assignee, and shows
  the ticket's activity trail.
- **The reply box never promises an email that won't go**: a company's board
  is told by the generated `FEEDBACK_EMAILS_REPORTERS` (true with `--comms`),
  this site's own board emails nobody.
- **The assignee picker lists the right people**: a company's active members
  on its board, this site's staff on its own (`listPeople` in
  `src/server/feedback.ts`), by their display name — never a sign-in address.
  An assignee from anywhere else is refused.
- **The settings pages are the package's own screens**:
  `/app/feedback/settings` and `/admin/feedback/settings` render
  `@adminigloo/feedback/admin`'s `FeedbackSettingsPanel` (columns — a column
  with tickets asks where they go before it's deleted — categories and website
  keys). `src/components/FeedbackSettings.tsx` is no longer generated.
- **The isolation proof drives the new routes** from the package's route
  table: New ticket, editing, the activity trail, the people list, and the
  board with another company's search, category and assignee. Company A's
  planted ticket is filed under its category and assigned to its person, so a
  filter that forgot the company would hand it to B; A's trail is in the
  snapshot that must not change.
- Pins `@adminigloo/feedback` 0.11.0. Upgrading a 0.26 project: `pnpm
  db:generate` and `pnpm db:migrate` (additions only — four ticket columns, the
  trail table and the board-set-up table), and delete `src/components/FeedbackSettings.tsx` once the
  settings pages import `FeedbackSettingsPanel`.

Not included: epics (the feedback board's next release), saved views per
person, custom fields.
