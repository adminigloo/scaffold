---
"@adminigloo/scheduling": minor
---

Make scheduling something a service business can sell and run: customers book
and manage their own visits, staff run the week from a calendar, crews follow a
route, everyone is emailed, and all of it happens in the business's own time
zone.

**The business's time zone.** Each business has an IANA zone in its settings.
Every visit keeps its wall-clock date and times and gains `starts_at` /
`ends_at` instants read in that zone. Notice, the horizon, the change cutoff,
reminders and expiry are measured on the instants, so a 24-hour notice is 24
real hours on the weekend the clocks change, and "today" is the business's
today. Changing the zone keeps every visit at its wall-clock time, and tells
the customers the corrected time only when asked (`notify: true`).
`visitInstants`, `instantsOf`, `todayIn` and the zone helpers are
exported (the same `zone.ts` as `@adminigloo/booking`).

**Settings in the database.** `getSchedulingSettings` / `updateSchedulingSettings`:
zone, business name, contact, office notice addresses, services (key, name,
length, description, skill), grid, notice, horizon, travel buffer, daily offer
cap, waiting-request cap, address required, auto-confirm, online booking on/off,
request expiry, reminder lead and change cutoff. Every range is checked with a
field path. A business that never saved settings reads the defaults (UTC).

**Customers book a service and manage their visit.** `findPublicSlots` and
`requestPublicBooking` take a `service`. A request returns a manage token (only
its hash is stored; every email mints its own). `getVisitByToken`,
`rescheduleVisitByToken` and `cancelVisitByToken` let the customer move or
cancel up to the cutoff; after it, `too_late` with the business's phone. A move
can land right next to the visit's own time. Online booking switched off
(`booking_closed`) still lets a customer cancel.

**Requests expire.** A pending request holds its time until
`pendingExpiryHours` after it was made (or its start). From that instant its
time is free again, before any sweep; `expirePendingRequests` flips it to
`expired` and the customer is told. Accepting one after its deadline is checked
like a restore.

**Staff run the week.** `bookVisit` (with warnings), `rescheduleBooking`,
`assignBooking` (an unassigned visit can finally get a crew) and
`updateBookingDetails` (never refuses; warns), all under the crews' locks, keys
sorted. Several hours windows a day (split shifts), weekly-only saves that keep
days off, `addTimeOff` (returns the visits already booked on those days),
`removeTimeOff` and `getAvailabilitySummary`. `listCalendar` (a range × the
crews, five queries) and `listCrewDay` (ordered stops, drive times, directions,
call links, the whole route). `setBookingStatus` takes a `reason` and stamps
`cancelled_*`, `started_at` and `completed_at`.

**Events.** Every change emits one event (`visit.requested`, `confirmed`,
`declined`, `rescheduled`, `reassigned`, `cancelled`, `expired`, `started`,
`completed`) after commit, awaited, in order, contained, and with no secrets.

**Emails: `@adminigloo/scheduling/comms`.** `createSchedulingCommsListener`
sends the acknowledgement, the confirmation with a manage link, declined,
moved, new crew, cancelled and released notes, office notices (including
"Request expired"), and a reminder queued for the cron run before it is due
(`reminderRuns`) and withdrawn when the visit moves or stops. `beforeSend`
re-renders a reminder from the visit at send time and adds a fresh link; no
manage link is left in the delivery log. Nine plain-text templates, inserted
once and never overwritten. `@adminigloo/comms` is an optional peer.

**Google Maps.** `createGoogleMapsProvider` (Geocoding and Distance Matrix over
plain `fetch`, no SDK) and `selectMapsProvider`: a key and a database give
cached Google drive times; no key gives straight-line estimates
(`MapsProvider.estimates`). Addresses are geocoded on requests, staff writes
and crew home bases. The key never appears in an error, message or `onError`
payload. A geocoder that is down books a customer's request without
coordinates; "no such place" refuses it.

**HTTP.** `createSchedulingHandlers` (config, slots, request, the customer's
visit, reschedule, cancel, `.ics`) and `createSchedulingAdminHandlers` (calendar,
crew day, suggestions, visits, settings, crews, hours, time off), each one
`handle(req)` with a `resolveTenant` seam. The public one has a honeypot and a
fill-time check, rate-limit buckets, opt-in CORS and the CSRF check; the staff
one asks your `authorize` for one permission per route and never sends CORS
headers. The wire types are exported and shared with
`@adminigloo/scheduling-widget`.

### Breaking (0.x minor)

- Two new statuses, `declined` and `expired`; neither holds time. Staff can't
  set `expired`. `pending` may move to `declined`, and `declined` / `expired` to
  `confirmed` (re-validated).
- `PublicSlot` gains `startsAt` and `endsAt`. The public request's receipt gains
  `startsAt`, `endsAt`, `timeZone`, `manageToken` and `repeated`; a repeated
  request gets `manageToken: null` (the first answer carried it).
- A new permission, `schedule.route` (a crew's own route), asked for on
  `crew-day` and on a stop's progress. An `authorize` that maps permissions to
  roles needs a line for it.
- `createSchedulingHandlers`' `emailsEnabled` defaults to whether `onEvent` was
  given (it was always true), and the default requester key is the LAST
  `X-Forwarded-For` entry (it was the first).
- The public name, phone and address are single lines, and the name and
  address refuse web addresses. Staff-entered names and addresses are single
  lines too.
- The public functions read the business's settings. A 0.3 caller's
  `options.policy` still wins field by field; the zone always comes from
  settings. A business that never saved settings keeps 0.3's lengths for
  `durationMinutes` callers.
- `findPublicSlots` costs one more query (the settings), four in all.
- `resolveDayWindow` returns only the first of a day's windows; use
  `resolveDayWindows`. A visit must fit inside one window.
- `MapsProvider.geocode` may throw for an outage; a request is then booked
  without coordinates instead of refused.
- `createCachedMapsProvider` falls through to the provider when its cache can't
  be read or written, instead of throwing.

### Schema: run your `db:generate` + `db:migrate`

Two new tables, `scheduling_settings` and `scheduling_visit_tokens`, and ten new
columns on `scheduling_bookings` (`starts_at`, `ends_at`, `origin`, `sequence`,
`pending_expires_at`, `cancelled_at`, `cancelled_by`, `cancel_reason`,
`started_at`, `completed_at`) with two indexes. All nullable or defaulted, so
the migration is plain `ALTER`s and `CREATE TABLE`s.

Then backfill each business once: `backfillVisitInstants(db, tenantId)` (the
README also has it as SQL), and save the business's time zone. Until the
backfill runs, instants are worked out from the wall clock, so nothing breaks
in between.

### From the owner and integrator reviews

Thirty-six findings from a business owner walking the scenario and from an
outside developer integrating it on a stack that isn't ours, each fixed with a
test that failed before the fix:

- **Reminders on a once-a-day cron.** `reminderRuns: { dailyAtUtc }` or
  `{ everyMinutes }` queues each reminder for the run before it is due, and
  never later than an hour before the change cutoff, so its "reschedule or
  cancel" link still works when it arrives. One that arrives inside the cutoff
  anyway offers the phone instead. A reminder whose visit lost its email, or
  whose business switched reminders off, is skipped at send time.
- **A corrected email address re-sends the visit** with a fresh link, revokes
  every link sent to the old address, and moves the reminder.
- **Nothing a stranger types becomes a link in the business's email.** Links
  are refused in the public name and address, and anything a customer typed is
  shown with links broken.
- **Expired means expired.** A request past its deadline reads "expired" to the
  customer and can't be moved online before the cron releases it; staff moving
  one give it a fresh deadline. The office is told when a request lapses.
- **The per-caller cap holds:** keyed on the address your proxy saw
  (`clientIpKey(req, { trustProxy })`, `createClientIpKey`), counting
  confirmed online visits under auto-confirm, and a repeat without a requester
  key is just a taken time, never a key to somebody else's visit.
- **An address the map can't find can be sent anyway** (`addressAsTyped`),
  flagged to the office (`addressUnverified`).
- **A zone change racing a booking is refused,** not stored an hour off; zone
  changes re-queue reminders eight at a time and can email customers the
  corrected time.
- **Crews:** `POST visits/:id/progress` (start, done, couldn't do it with a
  note, undo; never emails the customer), `crew-day` on the crew's own
  permission, user ids compared as text, `GET people` and
  `onCrewMemberChange` so an owner links a crew member by name.
- **The office is told the truth:** `GET status` and `delivery` (are emails
  and reminders really going out, what failed, what's left to set up), as
  plain-word notices (`adminNotices`). Refusals read as an owner would say them
  ("Crew A doesn't work on Saturday, March 7").
- **Email failures are never silent:** `onError` defaults to `console.error`,
  missing comms tables say which migration to run (`COMMS_TABLES_MISSING`,
  `verify()`), each send gives up waiting after `sendTimeoutMs` (10 s), office
  notices go out in parallel, and `redactSent()` sweeps the last 14 days of the
  log for a link a crashed run left behind.
- The README covers the comms tables in the Prisma path, any mail provider
  (nodemailer with timeouts), a cron route for any platform, proxies, server
  callers and integer user ids.
