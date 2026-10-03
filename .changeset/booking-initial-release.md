---
"@adminigloo/booking": minor
---

First release: book-a-call for an app's own site, ported from the Ask Lou
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
