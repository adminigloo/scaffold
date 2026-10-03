---
"@adminigloo/booking-widget": minor
---

First release: the embeddable booking widget for `@adminigloo/booking`. React
is its only peer. It needs no Tailwind and no CSS import, follows the visitor's
light or dark preference, and every colour is a CSS token.

- `<BookingWidget>`: pick a type, a day and a time in the visitor's own zone,
  with a zone selector. `timeZones={US_TIME_ZONES}` (or any `{ zone, label }`
  list) narrows it to named zones: "Mountain Time", not "Denver (UTC−6)". Times are grouped Morning / Afternoon / Evening. The
  date strip runs exactly to the type's horizon when the server sends
  `horizonDays`. A picked time is held for ten minutes with a countdown, and
  picking another time hands the first hold back in the same request. Leaving
  the page releases the hold, with a keepalive fetch and a beacon as fallback.
- The form covers name, email, how to meet (video, phone, or the prospect's own
  meeting link), phone, company and notes. Its checks mirror the server's. A
  `defaultCallingCode` prop, defaulting to the server's config, reads numbers
  typed without `+`.
- Clear recovery: `slot_taken` and `hold_expired` refetch the times and keep
  everything typed. `already_booked`, the same form sent twice, says the first
  submit worked and where the confirmation is.
- The confirmation shows the time and zone, how you'll meet, Add to Google
  Calendar, Download .ics, and the manage link.
- `<ManageBooking>` shows the booking and handles add-to-calendar, reschedule
  and cancel, plus the cancelled, past and not-found states. Rescheduling finds
  the type by the booking's `typeKey` (name matching only for older servers)
  and sends the manage token with slots and holds, so a call can move to a
  time right next to itself.
- Sandbox mode, from the server's config or the prop, turns the widget into a
  live demo. A persistent banner sits on every step, the confirmation is
  framed as a preview ("In a real booking, a confirmation goes to …"), the
  calendar buttons say "sandbox", and a "what happens on a real booking" list
  leads to a prominent button to book a real call. `<ManageBooking sandbox
  sandboxHref>` keeps a sandbox link that no longer resolves inside the
  sandbox, with the real CTA labelled as real and "Try the demo again".
- Honest without email: when the server's config says `emailsEnabled: false`,
  the confirmation hands over the manage link as a copyable field instead of
  promising an email, and every "check your email" points at the link or the
  config's `contactEmail`. A video call with no meeting link says who sends
  the link, never that it is in an email.
- Phone numbers follow the server's rule exactly: with code 1, a leading 0 is
  refused (not stripped), national numbers must be NANP-shaped, `011` dials
  abroad, and "(0)" after `+CC` is dropped. The confirmation shows the number
  as stored.
- The date strip starts at the first day with a time and has earlier/later
  buttons; repeated fall-back labels carry their zone name; step headings
  keep clear of a sticky header (`--aibk-scroll-margin`); `hideDescription`.
- `@adminigloo/booking-widget/admin`: `<BookingAdmin adapter>` — the host's
  bookings (confirm, move with the same picker, cancel, outcome once a call
  has started, history), availability (the week, time off and holidays with
  ranges), settings (host, real calendar with test, feed link shown once,
  call types) and a "Finish setting up" list, over a plain adapter of async
  functions that mirror `@adminigloo/booking`'s admin services. Every button
  that would email says so only when email is wired.
- Accessibility: real buttons and radios, focus moved to each step's heading,
  announced errors, a countdown that speaks only at a few thresholds, 44px
  touch targets, and a layout that works at 390px. The pure helpers and every
  wire type are exported.
