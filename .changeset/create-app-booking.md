---
"@adminigloo/create-app": minor
---

Book a call (create-app 0.32.0, Tenancy 2b-4c): `--booking` and `create-app add booking`.

- **Companies mode**: each company's calls are at `/app/calls` (the package's `<BookingAdmin>` over `/api/app/{id}/calls`, through `companyAuthorizer`). Its booking page is at `/t/{web address}/book`, with the manage page at `/t/{web address}/book/manage/[token]`, over `/api/t/{web address}/calls`, through `resolvePublicTenant` and `admitPublic`. A suspended company, or one whose plan ended, takes no new bookings. Links it already sent stay open while its plan is closed. "Book a call" is on the company's public home and "Calls" is in its nav. Only the company's members can take calls (their user id is linked).
- **Single business**: `/admin/calls` on the package's staff keys, and `/book` with `/book/manage/[token]`.
- **Permissions**: `bookingCompanyPermissions` (tenant) for companies and `bookingPermissions` (staff) for a single business. Plans sell "people taking calls" (`booking_hosts`: 1 / 5 / unlimited) through `bookingHostLimit`.
- **Emails** (with `--email`) go out as the company, with its name and its reply-to: the confirmation, a move, a cancel, the host's notice, and a reminder the day before. The reminder comes from the daily `/api/cron/booking` (CRON_SECRET), which also clears abandoned holds and ends by 50 seconds.
- The isolation proof drives `BOOKING_ADMIN_ROUTES` and `BOOKING_PUBLIC_ROUTES` as another company, with a host, hours, a day off, a holiday, a call type, a call, a hold and a feed planted for each.
- Robots and search: `/book/manage/` and `/t/*/book/manage` stay out. A single business's `/book` is in the sitemap.
- `--booking --tenant-noun none --admin none` is refused (nobody could see a call).
- Versions: booking 0.2.0, booking-widget 0.2.0. Upgrade notes for 0.32.
- **Review fixes:**
  - **Emails:** a company's booking emails go through `platformBookingEmails` ("{company} via {site}", replies to the owner's sign-in address only), and a company on a trial sends at most 20 booking emails a day.
  - **Hosts:** a host whose person left the company is off, and "Add a person" picks from `tenancy.listMemberPeople`.
  - **Rate limits:** callers on IPv6 are rate-limited by /64.
  - **Reminders:** reminders that fail are retried, and no reminder starts unless it and a margin fit before 50 s.
