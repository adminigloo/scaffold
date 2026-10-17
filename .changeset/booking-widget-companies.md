---
"@adminigloo/booking-widget": minor
---

Book a call, per company (booking-widget 0.2.0, Tenancy 2b-4c).

- `createBookingAdminFetchAdapter({ baseUrl, emailsEnabled })` in `./admin` speaks booking 0.2's admin routes, so `<BookingAdmin>` mounts on any company's `/api/app/{id}/calls` with no glue. It returns null for another business's booking and shows the server's own words on a refusal (`BookingAdminRequestError`).
- The booking form carries an off-screen honeypot field (`website`), which is sent only when something filled it.
- A business that isn't taking bookings (`closed`) is shown in its own sentence, with no "Try again".
- `AdminHost.userId` (optional): the person a host is.
- **Review fixes:**
  - A host's card is titled with their name and has an on/off switch.
  - "Add a person" picks from the team (`TeamCard`, `listTeam`) and shows the plan's limit sentence.
  - Each call has "Cancel all from this email" (`cancelAllFromEmail`).
