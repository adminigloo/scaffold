# @adminigloo/scheduling-widget

## 0.5.0

### Minor Changes

- 2de60cb: A screen's primary action can sit in its host page's header, beside the page title, like every other page's. Each screen takes `actionsInHeader` and stops drawing its own buttons; the page renders the screen's companion in its header — `<InvoicesLedgerActions>` (New invoice), `<EstimatesQueueActions>` (New estimate, "Starting…" while it starts), `<ScheduleCalendarActions>` (New visit), `<CustomersActions>` (Add customer, Import, Export), `<FeedbackEpicsActions>` (New epic) — which opens the screen's own form below. The two halves talk through DOM events, so they need no shared parent (separate client islands on a server page). `<StoreAdmin>` and `<BookingAdmin>` take `actionsInHeader` to leave "See your store" and "Open the booking page" to the page's header. Each companion takes the host's button class.
  
  invoicing-widget also: `<InvoicesLedger initialFilter="overdue">` opens on a filter (any of the chips' statuses; anything else opens All) and follows a new one, so a page can open on `?status=overdue`; and a payment's line names its method once — "$810.81 · Check #1042", not "Check · Check #1042" (`paymentWords`, exported). estimator-widget's `initialFilter` now ignores a value that isn't a filter and follows a new one. The New invoice form puts the cursor in its first field.
  
  commerce also: `<StoreAdmin>`'s own "See your store" (without `actionsInHeader`) carries ↗, "(opens in a new tab)" for screen readers and rel="noopener noreferrer", like the booking page link.

### Patch Changes

- ed86e90: Past records say so (invoicing 0.7, scheduling 0.7): an invoice, a payment or a visit typed in later from the business's records shows "Entered from past records on {day}" — on the invoice under its title, beside the payment, and in the visit's panel (the company's own calendar day) — read from the server's `enteredLater`, and parsed (a malformed one is dropped).
- 2de60cb: No "Something went wrong" where the cause is knowable. An answer that isn't the package's own (a platform's error page, a proxy, a timeout) is read by its status — signed out (401), no permission (403), not here any more (404), too big (413), too many tries (429), the site not answering (502, 503) or too slow (504) — instead of "Unexpected answer from the server (502)." or the generic line; the generic sentence is left for a truly unknown failure. A dropped connection on the customer's invoice page says so, and "Couldn't reach the server." tells the person to check their internet connection.

## 0.4.0

### Minor Changes

- 3c427cc: The showroom: the calendar's and settings' notices are one collapsed, dismissible "N things to finish" card, with links where the office can fix something and the operator's jobs (emails, reminders) in one plain sentence (`showTechnical` adds the detail for staff). Switch help describes the current state. An empty week says what the schedule does and offers "Book a visit" and the booking page.

## 0.3.0

### Minor Changes

- 786a643: Alerts and files (Tenancy 2b-1).
  
  - **The alert list managed elsewhere**: when the server says who gets
    new-request alerts is chosen in Alert settings, Schedule settings shows that
    sentence with "Open Alert settings" instead of the address list, and a save
    never sends the list.
  - **`initialVisitId`** on `<ScheduleCalendar>`: an alert's link opens its
    visit. One from another week is fetched and the calendar moves to its day;
    one that's gone shows a plain notice.
  - **Photos and files links**: `visitFilesHref` on `<ScheduleCalendar>` adds
    "Photos and files" to the visit panel, and `filesHref` on `<CrewDay>` adds a
    "Photos" button to each stop of today's route.

## 0.2.0

### Minor Changes

- 2df95e8: Company features (Tenancy 2a).
  
  - **`accentColor`** on the booking picker and the manage-your-visit page: the
    company's colour on buttons and highlights, with a text colour that stays
    readable (and a darker or lighter shade where the colour itself wouldn't be).
  - **The closed message**: when the business isn't taking bookings online, the
    picker says so in its own words, with how to reach them, instead of an error.
  - **Company-owned fields read-only** in schedule settings (name, time zone,
    contact details), with a link to company settings.
  - **`inviteHref`**: "invite them on the Team page" where a crew needs someone
    to open its route.
  - **Deep links** to a settings section (`#hours`, `#crews`, …) focus it.
  
  After review: Today's route remembers the picked crew per schedule (so one
  person in two companies never carries a crew between them), forgets a crew
  that isn't there and shows the person's own route, and offers no other day to
  a crew member; notices can carry a "where to fix it" link; an empty alerts
  list says where alerts go.

## 0.1.0

### Minor Changes

- fd0f460: First release: the screens for `@adminigloo/scheduling` 0.4, for a business whose
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
