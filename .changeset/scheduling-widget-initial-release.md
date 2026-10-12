---
"@adminigloo/scheduling-widget": minor
---

First release: the screens for `@adminigloo/scheduling` 0.4, for a business whose
crews drive to the customer. React is its only peer. It needs no Tailwind and no
CSS import, follows the host page's light or dark theme, and every colour is a CSS
token that passes WCAG AA in both.

**For customers** (`@adminigloo/scheduling-widget`):

- `<VisitPicker>`: what they need (a service card per service, skipped when there's
  one or the page locks one), then the days that have times and the times grouped
  Morning / Afternoon / Evening, always on the business's clock with one line saying
  which ("Times are Mountain Time (MST)"), then name, email, address, phone and
  notes. The confirmation says what happens next, adds the visit to Google
  Calendar or downloads an .ics, and gives the link to change it. A time taken
  while they typed sends them back to the times with everything they typed kept.
  A honeypot and a fill-time check stop bots without ever refusing a fast
  autofill: the button waits out the server's minimum. With email off, nothing
  promises an email and the manage link is handed over to keep. With online
  booking off, the card says so and gives the phone number.
- `<ManageVisit>`: the page behind the email link. Every status in plain words;
  reschedule with the same picker, asked as the visit so the time next to it is
  offered, confirmed with "Move to Tue, Nov 3, 10:00 AM?"; cancel after an in-page
  confirmation. Inside the business's cutoff the buttons give way to "This visit
  starts within 24 hours, so it can't be changed online. Call (801) 555-0143."

**For staff** (`@adminigloo/scheduling-widget/admin`):

- `<ScheduleCalendar>`: day (a column per crew, off-hours shaded) and week (a
  dispatch board). Drag a request or a confirmed visit to move it or give it to
  another crew, with mouse, touch or pen; staff are asked whether to email the
  customer; a refusal puts the visit back and says why ("Overlaps 10:00–12:00").
  The visit panel has Accept / Decline / Start / Complete / No-show / Cancel /
  Restore as the visit allows, plus Move… (the keyboard way to do any drag),
  Change crew and Edit details. The Requests inbox shows how long each request has
  before it's released. New visit suggests the best times for an address, with the
  drive from the job before.
- `<CrewDay>`: today's route on a phone. Stops in order with directions, Call, the
  drive from the stop before, Open route in Maps, and one big Start / Complete
  button per stop.
- `<SchedulingSettings>`: business and time zone, online booking and services,
  customer messages (release, reminder, cutoff), crews (pause, remove, restore),
  and each crew's hours with split shifts and days off. It warns when days off
  land on booked visits.

`createSchedulingClient` and `createSchedulingAdminClient` never throw, and every
component takes a `transport` instead of `baseUrl`, so the staff screens can run on
tRPC or server actions. Keyboard everything, dialogs that trap and return focus,
44px targets, and layouts that work at 390px.

**After the owner and integrator reviews:**

- A banner on the calendar and settings says what's true about the deployment
  (customer emails off and why, reminders once a day, failed emails, setup
  left), and with emails off nothing offers "Email the customer".
- `<CrewDay>`: Undo for 15 minutes, "Couldn't do it" with a note for the
  office, a crew switcher for the office, a plain message for a crew member
  not yet linked to a crew, and a refresh every two minutes.
- `<SchedulingSettings>`: "Who opens this crew's route" picks from people by
  name (`signInUrl` says where a new one signs in), a time-zone change says how
  many visits move and can email those customers, per-service booking links,
  and an honest note on when reminders go out.
- `<VisitPicker>`: "Send it anyway" for an address the map can't find, calendar
  links only once a visit is confirmed, a double click shows the visit it
  already booked, and links are refused in the name and address.
- `<ManageVisit>`: a visit the crew couldn't do reads "Didn't happen" with Book a
  new time; an overdue request reads "Not confirmed in time" at once.
- The Requests inbox shows when, where and the customer's note; Escape closes
  the top dialog wherever focus is; a fresh Hours card no longer claims unsaved
  changes; a 401 or a login redirect reads "You've been signed out. Sign in
  again to keep working."
- `theme="auto"` reads the background the widget sits on, so Tailwind's class
  strategy (light = no class) no longer gets a dark card from a dark OS.
