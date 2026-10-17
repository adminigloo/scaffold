---
"@adminigloo/booking": minor
---

Book a call, per company (booking 0.2.0, Tenancy 2b-4c).

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
