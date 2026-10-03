# @adminigloo/booking-widget

The client half of AdminIgloo booking. A visitor picks a time **in their own time
zone**, the time is **held for ten minutes** while they fill in the form, and they
leave with a full confirmation: when (with the zone), how you will meet, **Add to
Google Calendar**, **Download .ics**, and a **manage link** to reschedule or cancel
without an account. A **sandbox mode** turns the same widget into a live demo that
books nothing and emails nobody. The **admin screens** the host runs it from ship
here too, as a second entry.

```
<BookingWidget baseUrl="/api/booking" />            the public booking flow
<ManageBooking baseUrl="/api/booking" token={t} />  the page behind the manage link
<BookingAdmin adapter={adapter} />                  the host's admin  (@adminigloo/booking-widget/admin)
```

React (18 or 19) is the only peer. Everything styles itself — no Tailwind, no CSS
import — and follows the visitor's light/dark preference.

It talks to `@adminigloo/booking`'s `createBookingHandlers` over a small JSON
contract (declared in this package's types; it does **not** depend on the server
package, so a marketing site embedding it installs nothing but this).

## Install

```sh
pnpm add @adminigloo/booking-widget   # from the AdminIgloo GitHub Packages registry
```

## Real bookings

Mount the server handlers (from `@adminigloo/booking`) on a catch-all route:

```ts
// app/api/booking/[...path]/route.ts
import { createBookingHandlers } from "@adminigloo/booking";
import { db } from "@/db";

const booking = createBookingHandlers({
  db,
  tenantId: "my-company",
  uidDomain: "example.com",
  manageUrl: (token) => `https://example.com/booking/manage/${token}`,
  // Say whether you really send email — the widget's copy depends on it.
  emailsEnabled: Boolean(process.env.RESEND_API_KEY),
  contactEmail: "hello@example.com", // optional: a person to write to
  onEvent: async (event) => {
    /* send the confirmation email, notify the host … */
  },
});

export const GET = (req: Request) => booking.handle(req);
export const POST = (req: Request) => booking.handle(req);
```

Then render the widget wherever people should book:

```tsx
"use client";
import { BookingWidget } from "@adminigloo/booking-widget";

export function BookACall() {
  return (
    <BookingWidget
      baseUrl="/api/booking"
      onBooked={(result) => console.log("booked", result.booking.start)}
    />
  );
}
```

…and the manage page the `manageUrl` points at:

```tsx
// app/booking/manage/[token]/page.tsx
import { ManageBooking } from "@adminigloo/booking-widget";

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <ManageBooking baseUrl="/api/booking" token={token} realBookingHref="/book" />;
}
```

The token in that URL is the invitee's whole credential: keep the page free of
third-party scripts, and serve it with `Referrer-Policy: no-referrer` (the API
routes already send it).

## When the server sends no email

A deployment without a mail provider still takes bookings — and then every "check
your confirmation email" is a promise nobody keeps. The server says so in its
config (`emailsEnabled: false`, from the handler option of the same name; absent
means `true`, the old behaviour), optionally with a `contactEmail` to point people
at instead. With email off:

- the confirmation drops "A confirmation is on its way" and shows the **manage URL
  as a copyable field** with a **Copy your private link** button and the line
  *"This is the only way to move or cancel. Bookmark it, or add the call to your
  calendar (the link is inside)."*;
- a form sent twice (`already_booked`, whose answer never carried the link) says
  *"To move or cancel it, email {contactEmail}"* — or *"contact {host} directly"*;
- the manage page's "reply to your confirmation email" hints, the not-found page
  and the "awaiting confirmation" notice point at the page itself or the contact
  address instead (the manage page fetches the config alongside the booking for
  this; if the config can't be read it assumes **no** email rather than claim one).

Whatever the email setting, a video call with no meeting link saved on the host
says *"{host} will send you the link before the call."* — never that the link is in
an email. A `confirmationNote` you pass still replaces the line under "You're
booked".

## Sandbox (live demo) mode

Give each demo visitor their own sandbox tenant on the server and pass
`sandbox: true` to `createBookingHandlers` — the server then never calls
`onEvent` or the calendar busy source, says `sandbox: true` in its config, and
marks its calendar exports as sandbox events. The widget sees that and switches
modes on its own (or force it with the `sandbox` prop):

```tsx
<BookingWidget
  baseUrl="/api/demo-booking"
  realBookingHref="/book"                       // the prominent "book a real call" button
  realBookingLabel="Book a real call with Dallin →"   // default: "Book a real call with {host} →"
  sandboxNotice="Sandbox: a sample business's calendar. Nothing is booked and nobody is emailed."
/>
```

In sandbox mode:

- a **persistent banner** sits at the top of every step (copy via `sandboxNotice`;
  the default names the host from the server's config), with a link to
  `realBookingHref`;
- the times are labelled **Sample times · sandbox** and the button reads
  **Confirm booking (sandbox)**;
- the confirmation becomes **"This is what your customer would see"** — the real
  confirmation, framed as a preview, whose own line reads *"In a real booking, a
  confirmation goes to {email}."* — followed by **"What happens on a real
  booking"** (replace the list with `realBookingSteps` if your server wires
  different follow-ups) and a large primary button to `realBookingHref`;
- the calendar buttons read **Add sandbox event to Google Calendar** and
  **Download sandbox .ics** (`sandbox-booking.ics`) — the event lands in the
  visitor's real calendar, so it must not look like a real call;
- the manage link and calendar links still work against the sandbox tenant, so a
  visitor can try rescheduling and cancelling too.

The sandbox's manage page should pass `sandbox` (and a `sandboxHref` back to the
demo) to `<ManageBooking>`. A sandbox link only resolves in the browser that made
it, for as long as the sandbox lives — opened on the phone the calendar event
synced to, or the next day, it loads nothing. With the prop, that visitor still
sees the sandbox banner, *"Sandbox calls only open in the browser that booked
them, for 24 hours. Nothing real was booked."*, a primary button labelled as the
REAL booking (`realBookingLabel` → `realBookingHref`), and a secondary **Try the
demo again** link (`sandboxHref`) — not a "Book a new time" button into the real
calendar.

```tsx
<ManageBooking baseUrl="/api/demo-booking" token={token} sandbox sandboxHref="/features/booking" realBookingHref="/book" />
```

## `<BookingWidget>` props

| prop | | |
| --- | --- | --- |
| `baseUrl` | required | Where the handlers are mounted, e.g. `/api/booking` or an absolute URL. |
| `clientKey` | | For keyed cross-origin embeds; sent as `x-adminigloo-key`. |
| `sandbox` | | Force sandbox mode (the server's `config.sandbox` also turns it on). |
| `sandboxNotice`, `realBookingHref`, `realBookingLabel`, `realBookingSteps` | | Sandbox copy and the real-booking CTA (above). |
| `confirmationNote` | | The line under "You're booked": a string replaces the default, `null` drops it. |
| `defaultTimezone` | | IANA zone to open in. Default: the visitor's browser zone. |
| `defaultCallingCode` | | Country calling code (`"1"`) for a phone number typed without `+`. `801 555 0143` is sent as `+18015550143`. Default: the server's `defaultCallingCode` from its config. With neither, the `+` and country code are required. See **Phone numbers** below. |
| `source` | | Attribution. Default: `?src=`, else the UTM tags, from the page URL. |
| `onBooked(result)` | | Called once per booking with `{ booking, manageToken, manageUrl }`. |
| `typeKey` | | Preselect a booking type when there are several. |
| `title` | | Override the heading — e.g. `"Pick a time"` on a page that already pitches the call. |
| `hideDescription` | | Leave the type's description out of the header, so a page that already says it doesn't repeat it. |
| `locale` | | Date/time formatting locale. Default `en-US` (the copy is English). |
| `theme` | | `"auto"` (default, follows `prefers-color-scheme`), `"light"` or `"dark"`. |
| `className`, `style` | | On the widget's root (`.aibk-root`). |

## `<ManageBooking>` props

`baseUrl`, `token` (required), `clientKey`, `realBookingHref` ("Book a new time"
after a cancellation, and the real-booking CTA on a sandbox booking),
`realBookingLabel`, `sandboxNotice`, `sandbox` (this page serves sandbox links —
see above), `sandboxHref` (the sandbox's "Try the demo again"), `defaultTimezone`
(default: the zone the booking was made in), `locale`, `theme`, `className`,
`style`, and `onChange(booking)` after a reschedule or cancel.

It handles every state: confirmed, awaiting confirmation, cancelled, already
happened, and not found. Unknown, expired and cancelled links may all get the
same answer from the server on purpose, so the page never claims to know which.

Rescheduling reuses the booking picker, but it asks as the booking. It finds
the type from the booking's `typeKey`, and only falls back to matching the name
and duration for a server too old to send `typeKey`. It also sends the manage
token with every slot request and hold, so the server leaves the booking being
moved out of busy. That way a time half an hour later is offered rather than
blocked by the call itself. If a hold for the booking comes back `not_found`
(it was cancelled or started in the meantime), the page reloads the booking and
shows its current state.

## The admin screens — `@adminigloo/booking-widget/admin`

```tsx
"use client";
import { BookingAdmin, type BookingAdminAdapter } from "@adminigloo/booking-widget/admin";

export function CallsAdmin({ adapter }: { adapter: BookingAdminAdapter }) {
  return <BookingAdmin adapter={adapter} bookingPageUrl="/book" />;
}
```

Everything a host runs their calls from, in one component, as its own entry so a
marketing page never ships it:

- **Finish setting up**, above the tabs, naming what is still unfinished — each
  with a button to the card that fixes it: no active call type; video offered
  with no meeting link saved; the real calendar not connected; the hours still
  your app's placeholder defaults (`adapter.hoursAreDefault`); no feed link yet;
  and email not configured. A failing calendar sync and the number of live holds
  (`adapter.countLiveHolds`) are shown too, so a calendar kept full of holds is
  visible rather than silent.
- **Upcoming / Past** — every call in the host's zone with the invitee's clock
  beside it; confirm a request, **Move call** (the same picker the invitee uses,
  in the host's zone, the call's own time hidden), cancel with a note, record an
  outcome (only once the call has **started** — on a future call it closed the
  call out early and reopened its slot), and the audit trail.
- **Availability** — the week on the 15-minute grid; time off and one-off hours
  for a date **or every date up to an optional "Until"** (a week off is one add,
  listed as one row — "Mon, Oct 12 – Sun, Oct 18 · Day off · 7 days" — and removed
  in one click); holidays with ranges the same way.
- **Settings** — the host (or, on a fresh install, the form that creates one),
  the real calendar's secret iCal address with **Test**, the subscribable feed
  link (generated or rotated, **shown once**), and every call type (create, and
  edit name, length, description, buffers, start-time grid, notice, horizon, max
  per day, ways to meet, bookable).

Every button says what it does to the other person, from `adapter.emailsEnabled`:
"Cancel the call **and email them**", "Confirm and email them", "Move the call and
email them" only when email is wired; otherwise "Cancel the call" / "Confirm" /
"Move the call", with a prefilled `mailto:` so the host tells the invitee
themselves.

### The adapter

A plain object of async functions that mirror `@adminigloo/booking`'s admin
services, so it works with tRPC, server actions or `fetch`. Each may throw; the
message is shown beside the control that called it. Instants may be `Date`s or
ISO strings.

| adapter | server function |
| --- | --- |
| `emailsEnabled` | whether your booking events really send email |
| `listBookings({ scope })` | `listBookings(ctx, …)` — upcoming: not yet ended, soonest first; past: ended, newest first |
| `getBooking(id)` | `getBooking(ctx, id)` |
| `cancelBooking({ id, reason })` | `hostCancelBooking(ctx, …)` |
| `confirmBooking(id)` | `confirmBooking(ctx, id)` |
| `setOutcome({ id, outcome, status? })` | `setOutcome(ctx, …)` |
| `rescheduleBooking({ id, start })` | `hostRescheduleBooking(ctx, …)` |
| `listRescheduleSlots({ id, typeKey, from, to })` | `listOpenSlots(ctx, { typeKey, from, to })` |
| `listHosts()`, `upsertHost(input)` | `listHosts`, `upsertHost` |
| `testCalendar(hostId)` | `testBusySource(ctx, hostId)` |
| `rotateFeed(hostId)` | `rotateHostFeedToken` → build `{ httpsUrl, webcalUrl? }` from the token |
| `getAvailability(hostId)`, `setWeekly(input)` | `getAvailability`, `setWeeklyAvailability` |
| `addException`, `removeException` | same names |
| `listBlackouts`, `addBlackout`, `removeBlackout` | same names |
| `listTypes()`, `upsertType(input)` | same names |
| `countLiveHolds?()` | `(await countLiveHolds(ctx)).live` |
| `hoursAreDefault?` | `boolean`, or `(host) => boolean \| Promise<boolean>` — only your app knows its seeded hours (`sameWeekly` helps) |

`listOpenSlots` does not yet leave the call being moved out of busy for the host
(the invitee's version does, via its manage token, which the host doesn't have),
so times right next to the call — inside its own buffers — aren't offered in
**Move call**; `hostRescheduleBooking` itself accepts them.

A tRPC-shaped sketch:

```ts
const adapter: BookingAdminAdapter = {
  emailsEnabled: overview.emailConfigured,
  listBookings: (input) => trpc.booking.bookings.query(input),
  getBooking: (id) => trpc.booking.booking.query({ id }),
  cancelBooking: (input) => trpc.booking.cancel.mutate(input),
  confirmBooking: (id) => trpc.booking.confirm.mutate({ id }),
  setOutcome: (input) => trpc.booking.setOutcome.mutate(input),
  rescheduleBooking: (input) => trpc.booking.reschedule.mutate(input),
  listRescheduleSlots: (input) => trpc.booking.rescheduleSlots.query(input),
  listHosts: () => trpc.booking.hosts.query(),
  upsertHost: (input) => trpc.booking.upsertHost.mutate(input),
  testCalendar: (hostId) => trpc.booking.testCalendar.mutate({ hostId }),
  rotateFeed: (hostId) => trpc.booking.rotateFeed.mutate({ hostId }),
  getAvailability: (hostId) => trpc.booking.availability.query({ hostId }),
  setWeekly: (input) => trpc.booking.setWeekly.mutate(input),
  addException: (input) => trpc.booking.addException.mutate(input),
  removeException: (id) => trpc.booking.removeException.mutate({ id }),
  listBlackouts: () => trpc.booking.blackouts.query(),
  addBlackout: (input) => trpc.booking.addBlackout.mutate(input),
  removeBlackout: (id) => trpc.booking.removeBlackout.mutate({ id }),
  listTypes: () => trpc.booking.types.query(),
  upsertType: (input) => trpc.booking.upsertType.mutate(input),
  countLiveHolds: () => trpc.booking.liveHolds.query(),
  hoursAreDefault: (host) => trpc.booking.hoursAreDefault.query({ hostId: host.id }),
};
```

### `<BookingAdmin>` props

`adapter` (required), `title` (default "Calls"), `bookingPageUrl` (linked as
"Open the booking page ↗"), `initialTab` (`"upcoming" | "past" | "availability" |
"settings"`), `locale`, `theme`, `className`, `style`. The admin root is
`.aibk-root.aibk-admin`: the widget's tokens re-theme it too. Its pieces
(`BookingsPanel`, `BookingRow`, `MovePanel`, `AvailabilityPanel`, `TimeOff`,
`Holidays`, `SettingsPanel`, `HostCard`, `CalendarCard`, `FeedCard`, `TypeCard`)
and pure rules (`setupChecklist`, `canRecordOutcome`, `canCancel`, `canMove`,
`datesInRange`, `groupExceptions`, `groupBlackouts`, `sameWeekly`, the label
helpers) are exported for an app that wants to arrange them differently.
`bookingAdminCss()` returns its stylesheet (render `bookingWidgetCss()` first).

## How it behaves

- **Time zones.** Every time is cut from the UTC instant in the zone being viewed —
  a 10:30 PM Denver slot shows as 12:30 AM the next day in New York, on the next
  day's tile, in its morning group. The zone selector lists every IANA zone the
  browser knows (`Intl.supportedValuesOf`), the visitor's and host's first. The
  zone chosen is sent with the booking. On a fall-back night, the repeated hour's
  two buttons would read the same, so each repeated label gets its zone's short
  name: "1:30 AM MDT", "1:30 AM MST".
- **Holds.** Picking a time holds it (a countdown shows how long). Picking another
  time hands the first back in the same request (`previousHoldToken`). Switching
  type, leaving the page or unmounting releases the hold best-effort (a keepalive
  `fetch`, with `sendBeacon` as the fallback); a release that never lands just
  expires. A hold that runs out is not the end — the visitor can hold it again or
  book anyway while the time is free.
- **Lost times.** If the time is taken (`slot_taken`) or the hold lapsed and the
  time went (`hold_expired`), the visitor is told plainly, the times are
  refetched, and everything they typed is kept.
- **A form sent twice.** If the first submit already booked the time
  (`already_booked`), for example after a double click or a retry when the
  first answer never arrived, the visitor is told they're already booked and
  where to turn — their confirmation email, or (with email off) the contact
  address. They aren't sent back to pick a time, and the hold isn't released.
  In sandbox mode the message says nothing was emailed.
- **Days.** The strip starts at the first day that has a time (leading empty days
  are dropped; closed days between open ones stay, dimmed) and runs to the last
  bookable day. **‹ ›** buttons either side scroll it one strip-width at a time,
  are disabled at each end, and disappear when every tile fits (on a phone they
  sit above the strip). A server that sends the type's `horizonDays` gets a strip
  that ends exactly at the horizon, counted in the host's zone and read on the
  visitor's clock. It stops at whatever has been fetched so far, so unfetched
  days never look empty. Its "Show later dates" button appears exactly when the
  horizon runs past the first 30-day fetch. An older server without
  `horizonDays` gets a strip that ends at the last day with a time, at least a
  week long, and the button is inferred from where the times stop.
- **Phone numbers.** By default a number needs its country code. When the
  `defaultCallingCode` prop is set, or the server advertises one, a number
  typed without `+` is read in that country — by the server's rule, exactly.
  With code `1` (North America) a national number must be ten digits with an
  area code and exchange starting 2–9 (one leading `1` is dropped from an
  eleven-digit entry); a leading `0` is **refused**, not stripped — UK "020 7946
  0958" used to become +1 207 946 0958, a stranger's number in Maine — and
  `011` reads as dialling abroad ("011 44 20 7946 0958" → +44 20 7946 0958).
  Other codes drop one domestic `0` (except Italy and San Marino). A "(0)"
  right after a leading `+CC` is dropped, and any `+1` number must be
  North-American-shaped. A refused number gets a message that says how to fix
  it. The confirmation shows the number **as stored** (E.164), so a misread
  number is caught by the visitor on the spot.
- **Accessibility.** Real buttons and radios throughout, focus moves to each
  step's heading as it opens (never on page load) and the heading keeps clear of
  a sticky header (see `--aibk-scroll-margin`), errors are announced
  (`role="alert"`), the countdown speaks at a few thresholds rather than every
  second, touch targets are at least 44px, and the layout holds at 390px.

## Theming

Every colour is a CSS custom property on `.aibk-root`, declared at zero
specificity, so one ordinary rule re-themes the widget and the admin:

```css
.aibk-root {
  --aibk-accent: #7c3aed;        /* filled buttons, selected times */
  --aibk-accent-strong: #6d28d9; /* hover */
  --aibk-accent-soft: #ede9fe;   /* selected tints */
  --aibk-on-accent: #ffffff;     /* text on filled buttons */
  --aibk-font: "Inter", sans-serif; /* unset by default: inherits your page's font */
}
```

Tokens: `ground surface ink muted faint line line-strong accent accent-strong
accent-soft on-accent ok ok-soft warn warn-soft danger danger-soft on-danger focus
radius radius-sm shadow` (all prefixed `--aibk-`). The defaults are AdminIgloo's
"Ink & Snow" palette in light and dark. A rule on `.aibk-root` applies to both
themes; wrap it in your own `@media (prefers-color-scheme: dark)` to change only
one. `bookingWidgetCss()` returns the stylesheet text if you need to render it
yourself (a shadow root, say).

`--aibk-scroll-margin` (default `96px`) is how far below the top of the viewport a
step's heading lands when focus moves to it — set it to your sticky header's
height. It is deliberately not declared on `.aibk-root`, so you can set it once
anywhere above, e.g. `:root { --aibk-scroll-margin: 72px; }`.

## Keyed cross-origin embeds

Pass `clientKey` and serve the handlers with `cors: "*"`. The key travels in the
`x-adminigloo-key` header, so the server's CORS preflight must allow that header
along with `content-type`. Plain links cannot carry a header, so with a key the
**Download .ics** button fetches the file and hands the browser a blob.

## Pure helpers

Exported for tests and for anyone building their own picker on the same rules:
zone math (`zonedParts`, `zoneOffsetMinutes`, `zoneDisplayName`,
`zoneOptionLabel`, `listTimeZones`, `isValidTimeZone`), grouping
(`groupSlotsByDay`, `groupByPartOfDay`, `partOfDay`, `buildDateStrip`,
`stripStartDay`, `timeLabels`), the horizon (`horizonEndMs`, `lastBookableDay`,
`startOfDateIn`), the hold countdown (`holdDeadline`, `formatCountdown`,
`holdAnnouncement`), the form (`validateBookForm`, `normalizePhone`,
`phoneProblem`, `normalizeCallingCode`, `buildBookRequest`, `sourceFromSearch`),
email honesty (`emailsOn`, `reachHost`, `alreadyBookedMessage`,
`defaultConfirmationNote`), error mapping (`toBookingError`, `friendlyError`,
`issuesToFieldErrors`), the `BookingClient` transport, the `Picker` (over any
`SlotSource`), and every wire type.

Fields added to the contract after its first cut are optional in these types:
`typeKey` on a booking, `minNoticeMinutes` and `horizonDays` on a type, and
`defaultCallingCode`, `emailsEnabled` and `contactEmail` on the config. A server
that predates them still works, and the widget falls back to what it did before
(for `emailsEnabled`: email assumed on).
