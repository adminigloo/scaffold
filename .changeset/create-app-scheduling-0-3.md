---
"@adminigloo/create-app": minor
---

Generated `--scheduling` projects pin `@adminigloo/scheduling` 0.3.0 and use its
public-safe API.

- The public `scheduling.slots` route returns `PublicSlot`s from
  `findPublicSlots`: a slot id, date, start and end. Before, it returned the
  staff slots, including the previous customer's street address and the crew's
  name. It takes no address any more, so the list is the same for every
  visitor.
- `scheduling.requestBooking` takes a slot id, a visit length and the
  customer's details. The server works out the times and the crew, geocodes
  the address itself, and re-checks the slot under the crew's lock. The visit
  lands `pending` for staff to accept. Before, the client chose start, end and
  coordinates, and the visit was written `confirmed`.
- One caller can't flood the calendar: `requestBooking` is limited to 5 an hour
  per IP, and the package refuses a caller who already has 3 requests waiting
  (counted in the database, so it holds across serverless instances).
- The rules are one `PUBLIC_POLICY` in the new `src/server/scheduling-policy.ts`
  (a day's notice, a 30-day horizon, a 30-minute grid, 30–240 minute visits, a
  30-minute travel buffer), and both public inputs are derived from it, so a
  picker built from their types can't offer a length the server refuses. The
  module's test ships with the project.
- Every staff call passes the tenant to the package's by-id functions.
  Refusals come back as 409 only when another visit is in the way, 429 for too
  many requests, and 400 with their reason otherwise — not as 500, and not as a
  409 a form would retry for ever.
- `/admin/schedule` has these changes:
  - It lists today's visits all day. It used to start at the current moment,
    so a visit dropped off the board on the day it happened.
  - Requests show as "Requested", with Accept and Decline buttons. Other
    statuses read as words ("In progress", "No-show"), and the status menu
    offers only the moves the package allows. Un-cancelling a visit whose time
    was taken shows why it can't come back.
  - Each crew has a "Pause online booking" switch.
  - A crew's row says when it works: "Works 3 days a week", "Off every day",
    or its default Mon–Fri hours.
  - The hours editor starts from the crew's own hours and waits for them to
    load before it can be edited. Saving with no days ticked turns the crew off
    and keeps it off. Saving keeps the crew's dated time off.
  - Crew actions that fail say so instead of failing silently.
  - The copy no longer promises drive-time clustering, an add-visit form or a
    maps key the project doesn't have.
- The demo crew is seeded only for a tenant that has never had a crew. Removing
  every crew no longer brings a "Field crew" back on the next cold start.
- The router header, the comms cron header and DEPLOYMENT.md describe the comms
  wiring for a pending request: send an acknowledgement on request, then the
  confirmation and reminder when staff accept.
- The `scheduling.booking` capability is proven by the router calling
  `findPublicSlots` and `requestPublicBooking` and not the staff finder; before,
  any router that mentioned `requestBooking` passed, the 0.2 one included.
