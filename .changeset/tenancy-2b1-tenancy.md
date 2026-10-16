---
"@adminigloo/tenancy": minor
---

Company events for alerts (Tenancy 2b-1).

- **Every event has an `id` and an `occurredAt`.** Stamped in one place when
  the event is told, so an alert about it can be keyed on it and never sent
  twice. `member.joined`, `member.removed` and `member.left` also name the
  **person** (`{ name, email }`, nulls for a deleted user), and
  `member.joined` says the role they joined with in words (`roleName`).
- **Events are settled before a handler answers.** `createTenancyHandlers` and
  `createTenancyOperatorHandlers` wait (at most 5 seconds) for the listeners a
  POST set off before answering, so on a serverless platform "Cam joined the
  team" isn't cut off with the response. `TenancyService.settleEvents(timeoutMs?)`
  does the waiting and never throws; calling the service directly is
  unchanged.
- **`listMemberPeople(tenantId, { holding })`**: only the active members who
  hold that permission now (their role, and their own overrides, exactly as a
  request decides), in three queries whatever the team size. Without it, the
  same list as before.
- **The logo store is told the company**: `put` gets `tenantId`, and `delete`
  gets `{ tenantId }`. A store that ignores them still works.
- **The team's alert kinds**, from the package root: `tenancyAlertKinds`
  ("Someone joins the team", "Someone leaves the team", for the people who can
  invite) and `tenancyAlertsFor(event, { teamHref })`: "Cam Rivera joined the
  team as Crew member", "Pat was removed from the team". `TenancyEvent` is now
  exported from the root too.
- **Bodies read with a cap**: the logo upload and every JSON route count a
  body's bytes as they arrive and stop at the limit (1.2 MB for a logo, 16
  KB otherwise) before parsing, so a chunked upload that never says its size
  is refused without being held in memory.
