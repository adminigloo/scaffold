---
"@adminigloo/create-app": minor
---

Epics on the feedback boards (feedback 0.12), with `--feedback`:

- **Each company's epics** at `/app/feedback/epics` and `/app/feedback/epics/{id}`,
  and **this site's own** at `/admin/feedback/epics` (and `/{id}`) — thin pages
  over `@adminigloo/feedback/epics`, on the board's own keys (`feedback.view`
  to look, `feedback.manage` to change; `staff.feedback.view` /
  `staff.feedback.manage` on this site's own board). Nav entries for both.
- **On the boards:** each card shows its epic, the toolbar filters by epic
  ("No epic" too), the ticket panel and New ticket pick one, and the toolbar
  links to the epics page.
- **The isolation proof drives the epic routes** from the package's route
  table: company B with A's epic ids, A's ticket put into B's epic, A's
  person as the owner of B's epic, A's epic on B's ticket — each "not found"
  or refused, with A's epics in the snapshot that must not change.
- Pins `@adminigloo/feedback` 0.12.0. Upgrading a 0.27 project: `pnpm
  db:generate` and `pnpm db:migrate` (additions only — the epics table, a
  ticket's epic, a column's "waiting" flag).

Not included: sprints, swimlanes by epic, saved views per person.
