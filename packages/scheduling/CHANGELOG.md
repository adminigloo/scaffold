# @adminigloo/scheduling

## 0.4.0

### Minor Changes

- fd0f460: Make scheduling something a service business can sell and run: customers book
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

### Patch Changes

- Updated dependencies [fd0f460]
  - @adminigloo/comms@0.2.1

## 0.3.0

### Minor Changes

- 737fb77: Make scheduling safe to put in front of the public and in front of more than
  one business, and make an empty day bookable all day.
  
  **Public slots carry no one else's data.** New `findPublicSlots(db, input,
  { now, policy })` returns `PublicSlot`s — `{ slotId, date, startTime, endTime }`
  and nothing else. The staff `ScoredSlot` (crew name, score, drive minutes and
  the previous job's street address) is no longer what a public route can get:
  0.2's generated `slots` route returned it as it came, so every slot after a
  booked visit told an anonymous caller where the customer before lived.
  `toPublicSlot` is the projection.
  
  **The public list is the same for every visitor.** `findPublicSlots` takes no
  address. Every booked visit is padded by the policy's `travelBufferMinutes`
  (default 30) instead of scoring the visitor's own drive: a list worked out from
  a typed address said how far that address was from the customer booked before,
  so typing addresses located other customers. The visitor's real drive is
  checked when they make the request.
  
  **Public requests are decided by the server.** New `requestPublicBooking(db,
  { tenantId, slotId, durationMinutes, customerName, customerEmail, ... },
  { maps, now, policy, requesterKey })`:
  
  - A slot id names a day and a start, nothing else. The crew is the one the
    public list gives that time to; the end is start + duration; the address is
    geocoded server-side. The request has no time, crew or coordinate fields.
  - The public list is worked out again under the crew's lock, and the slot must
    be in it on that crew: the grid, hours, overlap, the travel buffer,
    `minNoticeMinutes`, `horizonDays`, `maxJobsPerDay`, `requiredSkill` (new on
    the request) and `maxSlotsPerDay`. Then the visitor's real drive from the
    neighbouring visits must fit. A forged or edited slot id gets no more than
    the list would have offered.
  - Validation and insert run in one transaction under
    `pg_advisory_xact_lock` on (tenant, resource). Two visitors racing for one
    time get one booking and one `slot_unavailable`.
  - With a `requesterKey` (the caller's IP, say), a caller who already has
    `maxOpenRequestsPerRequester` (default 3) requests waiting is refused
    `too_many_requests`. A pending request holds its time, so without this one
    script could empty a crew's calendar. It is stored on the visit
    (`requester_key`) and counted in the database.
  - The same request repeated within ten minutes (a double click, a retry) gets
    the first receipt back instead of "that time is gone".
  - With a provider that geocodes, an address it can't place is refused
    `address_unresolved` rather than booked with no coordinates, which every
    later drive check would have skipped. `requireAddress` refuses a request with
    no address. `MapsProvider` gains an optional `geocodes`; the Haversine
    provider sets it to `false`.
  - Visits land `pending` unless the policy says `confirmed`, and
    `customerEmail` must be an email. `durationMinutes` must be one of the
    policy's `durationsMinutes`.
  - Refusals are `BookingNotBookableError` with a `code`. An unknown slot,
    another tenant's slot, a paused crew and a taken time all read as
    `slot_unavailable`, so a refusal never confirms that an id exists.
  
  `PublicBookingPolicy` / `DEFAULT_PUBLIC_BOOKING_POLICY`: a day's notice, a
  30-day horizon, a 30-minute grid, 30–240 minute visits, a 30-minute travel
  buffer, 3 waiting requests per requester, `pending`.
  
  **Nothing slow under the lock.** Every writer (`requestPublicBooking`,
  `createBooking`, un-cancelling in `setBookingStatus`) looks drive times up
  before it takes the crew's lock. A paid provider's round trips used to run
  inside the transaction, and `createCachedMapsProvider(real, db)` read its cache
  on a second connection from there, which never returned on a one-connection
  handle and could exhaust a pool.
  
  **Fewer queries.** The finders read a whole range's hours and visits in one
  query each. A 30-day public list on ten crews was some 220 queries; it is three.
  
  **A grid, not one start per gap.** `findFreeSlots` takes a `stepMinutes` (default
  30) and offers every start that fits. 0.2 offered only the first minute of each
  gap, so an empty day showed 08:00 and nothing else. Starting right after a job
  is still preferred: `scoreSlot` gives `isGapStart` +5. Pass `Infinity` for one
  start per gap. A gap no longer runs past the window's end. Free slots now carry
  `nextJob`, `previousJob.endTime` and `isGapStart`. With job coordinates, the
  staff finder drops starts the drive buffer can't make, the same rule
  `validateBookingSlot` enforces. The daily cap is all or nothing. 0.2 sliced a
  day's offers down to its remaining capacity, which with a grid would have
  offered only the first few times.
  
  **Explicit hours.** `resources.hours_configured` is set by `setAvailability`. The
  Mon–Fri fallback applies only while it is false and the crew has no weekly
  rows. Unticking every day and saving now turns a crew off. 0.2 read "no rows"
  as "never configured" and switched it back on Mon–Fri. A never-configured crew
  with one dated exception also keeps its other weekdays.
  `resources.accepts_public_bookings` pauses online booking per crew. Staff can
  still book it.
  
  **Status transitions.** `BOOKING_STATUS_TRANSITIONS`, `canTransitionBooking` and
  `nextBookingStatuses` define the moves. `setBookingStatus` refuses an illegal
  move with `BookingStatusTransitionError` (completed → pending, say). Bringing a
  visit back from `cancelled` or `no_show` re-validates its slot under the lock,
  so un-cancelling can't double-book a time somebody has taken since.
  
  **Staff bookings.** `createBooking` validates and inserts under the same lock,
  and stores `scheduledDate` as its UTC day's midnight. `validateBookingSlot` now
  also refuses a day past `maxJobsPerDay`, a removed crew, and an end that isn't
  after the start, and takes `excludeBookingId`. The stored `durationMinutes` is
  end − start. `customerEmail` must be an email. Staff refusals say what kind:
  `slot_unavailable` only when another visit is in the way, and
  `outside_hours`, `invalid_window` or `resource_unavailable` otherwise (on the
  error's `code`, and on `validateBookingSlot`'s result).
  
  **Times are real times.** `HH:MM` must be zero-padded and valid (`16:99` and
  `99:99` used to pass, and the hours check compared text, so a staff visit could
  run past closing). An end may be `24:00`. `timeOfDaySchema` and `endTimeSchema`
  are exported for a host's own forms.
  
  **A day is a whole day.** A visit stamped in the last second of its day
  (23:59:59.500) used to fall outside every day's range and escape the overlap
  check and the cap.
  
  **Removed crews.** A crew taken off with `deactivateResource` now refuses staff
  bookings and un-cancels too, not only the finders. New
  `reactivateResource(db, tenantId, id)` puts it back.
  
  **Permissions.** New `schedulingPermissions` (`schedule.view`, `schedule.manage`,
  `schedule.resources.manage`), a tenant-scope fragment in the same shape as
  booking's.
  
  **README.** The package now has one, with a foreign-app install path (zod and
  drizzle-kit versions, a Prisma migration order, a pg Pool for a Prisma app).
  
  ### Breaking (0.x minor)
  
  - **Tenant scoping.** Every by-id function takes the tenant and filters on it.
    Another tenant's id is "not found" (`null`/`false`, or `[]` for a list).
    - `updateResource(db, id, patch)` → `updateResource(db, tenantId, id, patch)`.
      The patch is parsed by `updateResourceSchema`, which has no `tenantId`, `id`,
      `hoursConfigured` or `isActive`.
    - `deactivateResource(db, id)` → `deactivateResource(db, tenantId, id)`.
    - `listAvailability(db, resourceId)` → `listAvailability(db, tenantId, resourceId)`.
    - `setBookingStatus(db, { id, status })` → `setBookingStatus(db, tenantId, { id, status }, { maps })`.
    - `setAvailability` returns `boolean`. It is `false`, with nothing written,
      when the resource isn't the tenant's. 0.2 deleted by resource id alone.
    - New `getBooking(db, tenantId, id)` and
      `listResources(db, tenantId, { includeInactive })`.
  - `findFreeSlots` returns a grid by default (see above).
  - `resolveDayWindow` reads `resource.hoursConfigured`.
  - Times are validated strictly (see above).
  - Public routes must move from `findAvailableSlots` + `createBooking` to
    `findPublicSlots` + `requestPublicBooking`. The generated overlay does. A
    project that copied the old router needs the same change.
  
  ### Schema: run your `db:generate` + `db:migrate`
  
  Three new columns, all nullable or with defaults, so no backfill is required:
  
  - `scheduling_resources.hours_configured boolean NOT NULL DEFAULT false`
  - `scheduling_resources.accepts_public_bookings boolean NOT NULL DEFAULT true`
  - `scheduling_bookings.requester_key text`
  
  Nothing else is required. The scheduler already treats a crew with weekly rows
  as configured. Optionally, set the flag on those crews so it matches the data:
  
  ```sql
  UPDATE scheduling_resources SET hours_configured = true
  WHERE id IN (SELECT DISTINCT resource_id FROM scheduling_availability WHERE specific_date IS NULL);
  ```
  
  A crew someone "turned off" under 0.2 has no rows left, so it looks
  never-configured and still works Mon–Fri. Save its hours again with no days
  ticked, or pause its online booking.

## 0.2.0

### Minor Changes

- 834bd84: Guard the direct booking path. `validateBookingSlot` now also refuses a slot
  outside the resource's working window (a day off, or a time like 3am the finder
  would never offer), not just overlaps and drive-buffer conflicts — and
  `createBooking` runs that validation before it writes, so an out-of-hours or
  double-booked slot can no longer be inserted by a caller supplying its own times
  (a public request form, a reschedule). Trusted callers pass `{ skipValidation: true }`
  for seeds and staff overrides; unassigned bookings (no resource) skip it. Also
  fixes the drive-time buffer for a job scheduled AFTER the new one to measure the
  correct direction (job → next), which matters with a real asymmetric provider.
