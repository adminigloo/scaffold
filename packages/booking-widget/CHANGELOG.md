# @adminigloo/booking-widget

## 0.4.0

### Minor Changes

- 2de60cb: A screen's primary action can sit in its host page's header, beside the page title, like every other page's. Each screen takes `actionsInHeader` and stops drawing its own buttons; the page renders the screen's companion in its header — `<InvoicesLedgerActions>` (New invoice), `<EstimatesQueueActions>` (New estimate, "Starting…" while it starts), `<ScheduleCalendarActions>` (New visit), `<CustomersActions>` (Add customer, Import, Export), `<FeedbackEpicsActions>` (New epic) — which opens the screen's own form below. The two halves talk through DOM events, so they need no shared parent (separate client islands on a server page). `<StoreAdmin>` and `<BookingAdmin>` take `actionsInHeader` to leave "See your store" and "Open the booking page" to the page's header. Each companion takes the host's button class.
  
  invoicing-widget also: `<InvoicesLedger initialFilter="overdue">` opens on a filter (any of the chips' statuses; anything else opens All) and follows a new one, so a page can open on `?status=overdue`; and a payment's line names its method once — "$810.81 · Check #1042", not "Check · Check #1042" (`paymentWords`, exported). estimator-widget's `initialFilter` now ignores a value that isn't a filter and follows a new one. The New invoice form puts the cursor in its first field.
  
  commerce also: `<StoreAdmin>`'s own "See your store" (without `actionsInHeader`) carries ↗, "(opens in a new tab)" for screen readers and rel="noopener noreferrer", like the booking page link.

### Patch Changes

- 2de60cb: No "Something went wrong" where the cause is knowable. An answer that isn't the package's own (a platform's error page, a proxy, a timeout) is read by its status — signed out (401), no permission (403), not here any more (404), too big (413), too many tries (429), the site not answering (502, 503) or too slow (504) — instead of "Unexpected answer from the server (502)." or the generic line; the generic sentence is left for a truly unknown failure. A dropped connection on the customer's invoice page says so, and "Couldn't reach the server." tells the person to check their internet connection.

## 0.3.0

### Minor Changes

- 3c427cc: The showroom: "Finish setting up" is one collapsed, dismissible "N things to finish" card; email being off is the operator's job, said plainly with no button. `title={false}` for a host page with its own header. "Confirm bookings automatically" describes the state it's in. An empty calls list offers the booking page.

## 0.2.0

### Minor Changes

- 00e66a7: Book a call, per company (booking-widget 0.2.0, Tenancy 2b-4c).
  
  - `createBookingAdminFetchAdapter({ baseUrl, emailsEnabled })` in `./admin` speaks booking 0.2's admin routes, so `<BookingAdmin>` mounts on any company's `/api/app/{id}/calls` with no glue. It returns null for another business's booking and shows the server's own words on a refusal (`BookingAdminRequestError`).
  - The booking form carries an off-screen honeypot field (`website`), which is sent only when something filled it.
  - A business that isn't taking bookings (`closed`) is shown in its own sentence, with no "Try again".
  - `AdminHost.userId` (optional): the person a host is.
  - **Review fixes:**
    - A host's card is titled with their name and has an on/off switch.
    - "Add a person" picks from the team (`TeamCard`, `listTeam`) and shows the plan's limit sentence.
    - Each call has "Cancel all from this email" (`cancelAllFromEmail`).

## 0.1.0

### Minor Changes

- 0544dff: First release: the embeddable booking widget for `@adminigloo/booking`. React
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
