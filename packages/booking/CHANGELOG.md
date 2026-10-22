# @adminigloo/booking

## 0.3.1

### Patch Changes

- 5316977: A busy server no longer empties a host's booking page. The calendar feed's
  wall-clock backstop is one second, not 100 ms: at 100 ms it refused ordinary
  feeds whenever the server was slow (GitHub's runner took longer than that over
  a 4,000-event calendar), and a refused feed fails closed, so the page offered
  no times. The step budget still stops runaway feeds; the clock only catches a
  walk that runs away anyway.

## 0.3.0

### Minor Changes

- ed86e90: Delete a company (create-app 0.37): `forgetTenant(db, tenantId)` from the root takes every row this package keeps for one company — its calls and their history, hosts, hours, time off, holidays and call types — children first, each statement filtered by the company's id, on the caller's transaction. Returns the rows each table lost; refuses an empty id and the site's own ("*"). Proved per package on PGlite with `@adminigloo/testing/forget`: every table planted for two companies, the first forgotten, nothing of the second touched.

## 0.2.0

### Minor Changes

- 00e66a7: Book a call, per company (booking 0.2.0, Tenancy 2b-4c).
  
  - **Admin handlers** `createBookingAdminHandlers` and `BOOKING_ADMIN_ROUTES`: bookings (list, one, cancel, confirm, outcome, move, the move picker's times), the people taking calls, their hours and time off, holidays, call types, live holds. The business is the id in the path, asked of `authorize` for the route's one permission on every call. Another business's booking, host, time off, holiday or call type is "not found". `member` keeps hosts to the business's own people and stores their user id (`booking_hosts.user_id`). `hostLimit` is the plan's "people taking calls" (409 `limit_reached`, in words).
  - **Public handlers** `createBookingPublicHandlers` (the same factory as `createBookingHandlers`, which keeps working as before) and `BOOKING_PUBLIC_ROUTES`. `admit` closes new bookings (config, times, holds, booking) for a suspended business or one whose plan ended, as 403 `closed` with the business's own sentence. `admitExisting` covers the links it already sent (manage, cancel, reschedule, .ics, a reschedule's times and hold, the host feed). A plan that ended keeps those open (`bookingKeptOpenWhilePlanClosed`), and a suspension closes them. Manage, hold and feed tokens open only their own business's rows.
  - **Abuse caps**: live holds per business (`maxHoldsPerCompany`, default 30) beside holds per visitor, bookings per business per 24 hours (`dailyBookingLimit`, default 50), and a honeypot field (`website`) refused before any work.
  - **Emails**: `bookingEmailVars(event, { businessName, replyTo })` signs as the host and the business and returns `fromName` and `replyTo`. Invitee replies go to the business (else the host), never to the platform. Templates sign with `{{signature}}`.
  - **Reminders**: `dueReminders` and `claimReminder` (`booking_bookings.reminded_at`), claimed before sending, at most once, and cleared when a call moves.
  - **The calendar reader** meets the seo-reports `net.ts` standard. It connects to the checked address (node https, pinned), accepts only global-unicast IPv6 (2000::/3, without 2001::/23, 6to4, NAT64 or 3fff::/20) and refuses the old 6to4 relay and any named port. It fails closed where no resolver exists. `transport` can be swapped in tests. A custom `fetchImpl` still works, best-effort against DNS rebinding.
  - **SQL**: `sql/upgrade-0.1-to-0.2.sql` adds the two nullable columns and keeps every row (safe twice). `sql/booking-0.2.0.sql` is for a fresh install. Tenant ids don't change: adminigloo.com keeps passing `adminigloo-calls` (and `adminigloo-calls:<env>`); sandboxes keep `bookdemo:<hash>`.
  - `bookingCompanyPermissions`: the same four keys for a company's roles (owner, admin, member, viewer).
  - **Review fixes (2b-4c).**
    - **Calendars:** a COUNT rule with one instance per period jumps straight to the window. Each read has a budget: 5,000 events, 20,000 expansion steps and a 100 ms backstop. A feed over budget fails closed for its host (no times) with a plain sentence for the owner (`BusyFeedTooLargeError`). The expanded busy list is cached per feed and day window.
    - **Hosts:** a host whose person left the business is off (`hostMembers`). Switching off never needs membership. There is one host per person (a unique partial index), and the people limit is counted and written under one lock. A `team` route lists who could take calls.
    - **Bookings:** a booking requires a hold, and the daily cap counts live bookings only. An email may book 2 a day per business and 5 across the site. Rate-limit and hold keys count an IPv6 address by its /64 (`networkKeyOf`). Owners can clear junk with `cancelAllFromEmail`, and the `bookings-cancel-email` route calls it.
    - **Emails:** `platformBookingEmails` gives a fixed subject, "{business} via {app}", the call type quoted in the body only, meeting-link buttons only for known hosts, the owner's verified reply-to, and a footer.
    - **Reminders:** retried up to 3 times (`releaseReminder`, `reminder_attempts`).
    - Only a manage token that resolves gets the existing-links gate.
    - **The upgrade SQL must run before deploying 0.2.**

## 0.1.0

### Minor Changes

- 0544dff: First release: book-a-call for an app's own site, ported from the Ask Lou
  (SquireSolutions) demo scheduler onto Postgres and `Intl`, with its known
  defects fixed rather than carried over.
  
  - Hosts keep weekly hours in their own IANA zone, with dated `off` / `hours` /
    `block` exceptions and tenant-wide blackouts. A pure slot engine (`now`
    injected, DST-correct) offers starts on each window's grid, honouring notice,
    horizon, `maxPerDay` and buffers. Only the meeting has to fit the hours.
    Where two calls meet, the clear time is the larger of the two buffers, not
    the sum (Squire's D17 rule).
  - Ten-minute holds, then booking, rescheduling and cancelling. Each runs in one
    transaction under per-host advisory locks and re-checks the exact start with
    the same engine that offered it, so two prospects racing for one time get one
    booking and one `slot_taken`.
  - Manage-by-token with no account. Tokens are stored as SHA-256 only.
    Rescheduling moves the same row, so the link keeps working and the `.ics` UID
    stays stable while SEQUENCE increments. The slot list and the hold accept the
    manage token, which lets a call move to a time next to itself. Unknown tokens
    get the same `not_found` as everything else.
  - A form submitted twice books once. The second submit answers `already_booked`
    and points the prospect to their email and manage link. It no longer says
    the hold expired, and it can't book them a second time on another host.
  - `.ics` invites, a subscribable per-host feed (first name and company only),
    and Google Calendar "add" links.
  - The host's real calendar is read through its secret iCal address
    (`createIcsBusySource`). If the fetch fails, that request falls back to
    internal bookings only, and the admin sees "Calendar sync failing since …".
  - `createBookingHandlers` is the JSON wire contract shared with
    `@adminigloo/booking-widget`. `PublicBooking` carries `typeKey`. The config
    carries each type's `minNoticeMinutes` and `horizonDays`, plus an optional
    `defaultCallingCode` that reads phone numbers typed without `+`. It also
    offers rate-limit buckets, an optional license gate, opt-in CORS, and a
    sandbox mode that never emails anyone and never reads a real calendar.
  - Admin services behind `booking.*` permissions, `seedSandboxTenant` and
    `purgeTenants` for per-visitor demo tenants, and `purgeExpiredHolds`.
  - Cross-site POSTs are refused with 403 `forbidden` (CSRF) unless `cors` is
    set. The check uses `Sec-Fetch-Site`, then Origin or Referer, and lets through
    only non-browser calls that carry neither.
  - Phone numbers are refused rather than guessed. NANP needs its real ten-digit
    shape and never loses a leading `0`, `011` reads as international, and a
    `(0)` after a country code is dropped.
  - The busy reader only fetches the public internet. It checks every spelling of
    a private address, every DNS answer (best-effort against rebinding), and
    every redirect (at most three, followed by hand), and caps the body while it
    streams.
  - Sandbox calendar exports are labelled, tentative, transparent non-events.
  - `emailsEnabled` and `contactEmail` are echoed in the config, so copy
    stops promising email that is never sent.
  - Live holds are capped per requester (`holdSubject`, `maxHoldsPerSubject`), and
    `countLiveHolds` reports them.
  - `hostRescheduleBooking` lets the host move a call. Outcomes need a started call,
    and host cancellation needs a call that hasn't ended.
  - `createSandboxBookingHandlers` is a framework-free per-visitor demo: a cookie
    maps to a tenant, a read-only preview serves visitors without one, and there
    are mint limits, Postgres-counted ceilings and a TTL purge.
  - `bookingEmailTemplates`, `bookingEmailVars` and `renderBookingTemplate` supply
    the booking emails as plain data. With `includeManageLink: false` the copy is
    safe for queued or logged messages.
