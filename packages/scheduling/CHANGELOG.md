# @adminigloo/scheduling

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
