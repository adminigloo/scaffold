---
"@adminigloo/scheduling": minor
---

Company features (Tenancy 2a): one deployment books visits for many companies.

- **`company(tenantId)`**: the business's name, time zone, contact details,
  logo and colour come from the host's company profile instead of scheduling's
  own settings. Those fields show as "managed in company settings".
  `resolveSchedulingSettings` overlays them, and when the company's time zone
  changes, scheduling's own zone follows it (visits keep their clock times;
  reminders are re-queued quietly).
- **`admit(tenantId, req)`**: a suspended company's booking routes answer
  409 `booking_closed` with a plain sentence saying how to reach the business,
  before any other work.
- **Per-company links and inbox**: the manage-your-visit and office links may
  be async (built from the company's web address), and staff notices go to the
  company's own people (`staffEmails`), never the platform's.
- **Crew**: `SCHEDULING_CREW_ROLE` for `defineTenantRoles`, and the
  `schedule.route` permission so a crew member opens only their own route.
- **Route tables** (`SCHEDULING_ADMIN_ROUTES`, `SCHEDULING_PUBLIC_ROUTES`)
  and **checklist items** (`schedulingChecklistItems`) for a host to wire.
- The comms peer is now `^0.3.0`.

After review:

- **A crew member opens today's route only**: another day is refused for a
  login that can't see the schedule, and the route says it is today-only
  (`todayOnly`).
- **Notices in a company's terms**: business details are changed in company
  settings, so the notices say so and link there (`AdminNotice.link`); a
  company with no time zone of its own is told, and online booking waits for
  it; a crew member who isn't on a crew yet is named, with a link to pick
  their crew (`listPeople` roles, `settingsHref`).
- A reply to an office notice reaches the customer.
