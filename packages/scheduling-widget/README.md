# @adminigloo/scheduling-widget

The screens for AdminIgloo scheduling: the business whose crews drive to the
customer (window cleaners, cleaners, field techs). Customers pick a time on the
business's website and manage their visit from the link in their email. Staff run
the day from a calendar, crews open today's route on a phone, and the owner sets
it all up in one settings page.

```
<VisitPicker baseUrl="/api/schedule" />                    the booking page: service, day, time, details
<ManageVisit baseUrl="/api/schedule" token={t} />          the page behind the link in the customer's email

<ScheduleCalendar baseUrl="/api/admin/schedule" />         day / week calendar per crew, drag to move   (./admin)
<CrewDay baseUrl="/api/admin/schedule" />                  today's route, on a phone                    (./admin)
<SchedulingSettings baseUrl="/api/admin/schedule" />       business, online booking, messages, crews, hours (./admin)
```

React (18 or 19) is the only peer. Everything styles itself (no Tailwind, no CSS
import) and follows the host page's light or dark theme.

It talks to `@adminigloo/scheduling` 0.4's HTTP handlers (`createSchedulingHandlers`
for the customer pages, `createSchedulingAdminHandlers` for staff) over a small
JSON contract. The contract's types are declared in this package; it does **not**
depend on the server package, so a marketing site that embeds the picker installs
nothing but this.

## What each install gets you

| You install | You get | You wire yourself |
| --- | --- | --- |
| `@adminigloo/scheduling-widget` | `<VisitPicker>` and `<ManageVisit>`: a customer books a visit in the business's time zone and gets a confirmation with calendar links; from the email link they see, move or cancel it, up to the business's cutoff. | Two pages that render them, and the server handlers (`@adminigloo/scheduling`) mounted at one route. |
| `@adminigloo/scheduling-widget/admin` | `<ScheduleCalendar>`, `<CrewDay>` and `<SchedulingSettings>`: the staff calendar with drag-to-move and the request inbox, today's route for a crew, and every setting the owner needs. | Three admin pages, the staff handlers mounted behind your sign-in, and the `authorize` check. |
| `+ @adminigloo/notifications` and `@adminigloo/storage` on the server (Tenancy 2b-1) | An alert's link opens its visit on the calendar (`initialVisitId`); "Photos and files" on a visit and "Photos" on each stop of today's route; Schedule settings pointing to Alert settings for who hears about new requests. | Pass `initialVisitId` from the page's `?visit=`, the visit files page's address as `visitFilesHref` / `filesHref`, and `alertsHref` to the staff handlers. See [Alerts and files](#alerts-and-files-tenancy-2b-1). |

## Install

The package is private, published to GitHub Packages. Add the scope to your
project's `.npmrc` (commit this line, it holds no secret):

```
@adminigloo:registry=https://npm.pkg.github.com
```

and your token to your **user-level** `~/.npmrc`, never the repo:

```
//npm.pkg.github.com/:_authToken=<a GitHub token with read:packages>
```

Then, with any package manager:

```sh
npm install @adminigloo/scheduling-widget     # pnpm add / yarn add work the same
```

Without the `.npmrc` line npm looks on npmjs.org and answers 404.

## Mount it: a Next.js app

Mount the handlers from `@adminigloo/scheduling` on two catch-all routes (see that
package's README for every option):

```ts
// app/api/schedule/[...path]/route.ts — the customer pages talk to this
import { createSchedulingHandlers, selectMapsProvider } from "@adminigloo/scheduling";
import { db } from "@/db";
import { schedulingComms, mailerConfigured } from "@/server/scheduling"; // the emails: see the scheduling README
import { rateLimit } from "@/server/rate-limit";                          // yours: see the scheduling README

const schedule = createSchedulingHandlers({
  db,
  tenantId: "primary",
  manageUrl: (token) => `https://example.com/visit/${token}`,
  maps: selectMapsProvider({ googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY, db }),
  // The customer's emails. Leave it out and the widget promises none, and
  // hands the customer the manage link to keep instead.
  onEvent: schedulingComms.onEvent,
  emailsEnabled: mailerConfigured,     // false until your sender can really send
  rateLimit,                           // (req, "read" | "request" | "manage") => boolean
});

export const GET = (req: Request) => schedule.handle(req);
export const POST = (req: Request) => schedule.handle(req);
export const OPTIONS = (req: Request) => schedule.handle(req);
```

```ts
// app/api/admin/schedule/[...path]/route.ts — the staff screens talk to this
import { createSchedulingAdminHandlers } from "@adminigloo/scheduling";
import { db } from "@/db";
import { currentUser, can } from "@/auth";
import { schedulingComms } from "@/server/scheduling";

const admin = createSchedulingAdminHandlers({
  db,
  tenantId: "primary",
  onEvent: schedulingComms.onEvent,    // "Email the customer about this" really emails them
  // Check the permission each route asks for. Signed in is not enough: a
  // crew member's login must not change the time zone or cancel customers.
  authorize: async (req, permission, tenantId) => {
    const user = await currentUser();
    if (!user) return new Response("Sign in first", { status: 401 }); // shown as "You've been signed out"
    return can(user, permission, tenantId) ? { userId: String(user.id) } : false;
  },
});

export const GET = (req: Request) => admin.handle(req);
export const POST = (req: Request) => admin.handle(req);
```

Then the pages. The components are client components (the bundle carries
`"use client"`), so a server page can render them directly:

```tsx
// app/book/page.tsx
import { VisitPicker } from "@adminigloo/scheduling-widget";

export default async function Page({ searchParams }: { searchParams: Promise<{ estimate?: string }> }) {
  const { estimate } = await searchParams;
  return <VisitPicker baseUrl="/api/schedule" estimateId={estimate} />;
}
```

```tsx
// app/visit/[token]/page.tsx — the link in every customer email points here
import { ManageVisit } from "@adminigloo/scheduling-widget";

export const metadata = { robots: { index: false } };

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <ManageVisit baseUrl="/api/schedule" token={token} bookHref="/book" />;
}
```

```tsx
// app/admin/schedule/page.tsx, …/route/page.tsx, …/settings/page.tsx
import { CrewDay, ScheduleCalendar, SchedulingSettings } from "@adminigloo/scheduling-widget/admin";

export function SchedulePage() {
  return <ScheduleCalendar baseUrl="/api/admin/schedule" bookingPageUrl="https://example.com/book" />;
}
export function RoutePage() {
  return <CrewDay baseUrl="/api/admin/schedule" />;
}
export function SettingsPage() {
  return <SchedulingSettings baseUrl="/api/admin/schedule" bookingPageUrl="https://example.com/book" />;
}
```

The permissions it asks for, in plain terms: `schedule.route` is a crew member
(their own route only), `schedule.view` is look-only, `schedule.manage` is the
dispatcher, and `schedule.resources.manage` is the owner (settings, crews,
hours).

The token in a manage URL is the customer's whole key to their visit. Keep that
page free of third-party scripts; the API already sends `Referrer-Policy:
no-referrer` on every route that carries a token.

## Mount it: a plain React app (Vite, CRA, anything)

Same components, same props. Point `baseUrl` at wherever the handlers run:

```tsx
import { createRoot } from "react-dom/client";
import { VisitPicker, ManageVisit } from "@adminigloo/scheduling-widget";

const token = new URLSearchParams(location.search).get("visit");

createRoot(document.getElementById("booking")!).render(
  token ? (
    <ManageVisit baseUrl="https://api.example.com/schedule" token={token} bookHref="/book" />
  ) : (
    <VisitPicker baseUrl="https://api.example.com/schedule" />
  ),
);
```

A page on another origin needs the handlers' `cors` option set to that origin.

## `<VisitPicker>`

| prop | | |
| --- | --- | --- |
| `baseUrl` or `transport` | one is required | Where the public handlers are, or your own transport (below). With both, `transport` wins. |
| `service` | | Preselect a service by its key (Schedule settings shows each key). |
| `lockService` | | With `service`: don't offer the others. For a "Book a free estimate" button. |
| `estimateId` | | Sent with the request, so the visit links back to an estimate. |
| `title` | | The card's heading. Default "Book a visit". |
| `days` | | Days of times per window. Default 14. |
| `onRequested(result)` | | Once per successful request, with `{ visit, manageToken, manageUrl, repeated }`. |
| `locale`, `theme`, `nonce`, `className`, `style` | | See **Theme**. |

What the customer sees, step by step:

1. **What do you need?** The services as cards, with their length. Skipped when
   there's one, or when the page locks one.
2. **Pick a day and time.** Only days with open times, a window at a time, with
   earlier and later buttons. Times are grouped Morning, Afternoon and Evening, and
   **every time is the business's**, with one line saying so: "Times are Mountain
   Time (MST)". There is no time-zone picker: the crew comes to the customer's
   address, so 9:00 is 9:00 there.
3. **Your details.** Name, email, address (required when the business says so),
   phone and notes. Checked before sending, with errors on the fields.
4. **Done.** "Request received. Acme Windows will confirm it soon." or "You're
   booked.", when, where and what, **Add to Google Calendar** and **Download .ics**,
   what happens next, and the link to change it.

If the time was taken while they typed, they go back to the times with "That time
was just taken. Pick another." and nothing they typed is lost. An address the map
can't place is marked on the address field, with **Send it anyway** (the office
is told the map couldn't find it) and the business's phone. Someone at the
business's limit of visits booked or waiting hears "You already have visits
booked or waiting with us. Please call or email us to book another." A double
click shows the visit it already booked, without a second link. "Add to Google
Calendar" and the `.ics` appear only once a visit is confirmed, never on a
request that may still be declined. The name and address may not contain a web
address.

**Spam.** The form has a field people never see (a honeypot) and measures how
long it was open. A customer whose browser fills the form in an instant isn't
refused: the button says "Sending…" for the rest of the server's minimum, then
sends.

**Email honesty.** When the server says it sends no email (`emailsEnabled:
false`), nothing promises one. The confirmation hands over the manage link as a
field to copy, with "Keep this link to change or cancel your visit".

**Closed.** With online booking switched off, the card says "Online booking is
closed right now." with the business's phone and email.

## `<ManageVisit>`

`token` (required), `baseUrl` or `transport`, `bookHref` ("Book a new time" after a
cancelled, declined or expired visit, and on a link that opens nothing),
`onChange(visit)` after a reschedule or cancel, and `locale`, `theme`, `nonce`,
`className`, `style`.

Every state has its own words: "Waiting for Acme Windows to confirm", "Confirmed",
"In progress", "Done", "Cancelled", "Acme Windows couldn't make this time", "Not
confirmed in time", "Didn't happen" (a visit the crew couldn't do, with **Book a
new time**), and "This link doesn't open a visit." A request past its deadline
reads "Not confirmed in time" at once, before the cron releases it.

**Pick another time** opens the same day-and-time picker, asked as the visit, so
the slot right next to it is offered. The customer confirms with "Move to Tue,
Nov 3, 10:00 AM?". The same visit moves: same link, and the calendar entry updates
in place. **Cancel visit** asks first, with an optional note.

**The cutoff.** Inside the business's cutoff (24 hours by default) the buttons give
way to "This visit starts within 24 hours, so it can't be changed online. Call
(801) 555-0143." The server enforces the same rule.

## `<ScheduleCalendar>` (admin)

| prop | | |
| --- | --- | --- |
| `baseUrl` or `transport` | one is required | The staff handlers, or your own admin transport. |
| `initialView` | | `"day"` or `"week"`. Default: day under 720px wide, else week. |
| `initialDate` | | Default: today in the business's time zone. |
| `canManage` | | Default `true`. `false` is read-only: no accept, decline, move or new visit. |
| `pollMs` | | Background refresh, default 60000; `0` turns it off. It also refreshes when the window regains focus. |
| `bookingPageUrl` | | Shown in the empty state. |
| `onVisitChange(visit)` | | After any change made here. |
| `initialVisitId` | | Tenancy 2b-1: open this visit's panel once it's loaded. One outside the days on screen is fetched and the calendar moves to its day; one that isn't found shows "That visit couldn't be found." and no panel. |
| `visitFilesHref` | | Tenancy 2b-1: a pattern with `{id}` ("/app/schedule/visits/{id}/files"). The visit panel shows **Photos and files** linking there. Absent: no link. |
| `locale`, `theme`, `nonce`, `className`, `style` | | |

- **A banner says what's true about this deployment** (from `GET status`):
  "Customer emails are off: no email service is set up yet. Nobody is told
  about your answers, moves or cancellations, so call customers yourself until
  it's set up.", when reminders really go out (once a day, say), emails that
  failed this week, and what's left to set up (online booking off, no business
  name, no phone, the time zone). With customer emails off nothing offers
  "Email the customer", and a move says "Customer emails are off, so Pat won't
  be told about this change."

- **Day** has a column per crew (plus "Unassigned"), hours outside the crew's
  shaded, and a line at the current time. **Week** is a dispatch board: crews down
  the side, seven days across, days off shaded.
- **Drag** a request or a confirmed visit to move it: up or down for the time
  (snapped to the business's grid), sideways for the crew, or in the week to
  another day or crew. Mouse, touch and pen all work. Before the change goes out,
  staff are asked "Email the customer about this change?" (tick "Don't ask again
  this session" to stop the question). If the server refuses, the visit goes back
  and a message says why, such as "Overlaps 10:00–12:00".
- **Click a visit** for its panel: the customer with call and email links, the
  address with directions, status, and how it was booked. The buttons follow what
  the visit can do next: Accept and Decline on a request; Start, Complete, No-show
  and Cancel on a confirmed visit; Restore on one that no longer holds time. The
  panel also has **Move…** (the keyboard way to do anything a drag does),
  **Change crew** and **Edit details**. Anything the customer would hear about has
  "Email the customer about this", ticked by default.
- **Requests** lists every request waiting for an answer, soonest first, with
  when it is, the address, the first line of the customer's note, how long it
  has before it's released ("expires in 5 h"), and Accept and Decline right
  there.
- **New visit** takes a phone-in booking: the service, the customer, then **Find
  times**, which suggests the best openings for that address with each crew and
  the drive from the job before ("about 12 min (estimate)" when there's no maps
  key). Pick one, or type a day, a time and a crew.

## `<CrewDay>` (admin)

`resourceId` (default: the crew picked on this device, else the signed-in
person's crew as the server works it out; when it can't, the page says to ask
the office to link them to a crew), `date` (default: today), `canManage` (the
stop buttons; default `true`), `pollMs` (background refresh, default 120000),
`filesHref` (Tenancy 2b-1: a pattern with `{id}`; each stop shows **Photos**,
a 44 px button, so a crew member adds photos from the job),
plus `baseUrl` or `transport` and the usual `locale`, `theme`, `nonce`,
`className`, `style`.

Made for a phone at 390px: the crew, the date with previous and next, "5 stops · 1 h
40 min driving" ("(estimates)" without a maps key), and **Open route in Maps**. Each
stop shows its number, time, customer and service, the address as a directions
link, a **Call** button, notes, and "18 min drive · 9.2 mi from previous stop". One
big button per stop: **Start**, then **Complete**, then "Done 10:42 AM", with
**Undo** for 15 minutes after a tap. **Couldn't do it** records a stop that didn't
happen (nobody home, no access) with a note for the office. None of it emails the
customer. An office user can switch crews; a crew member only ever sees their
own. It refreshes every two minutes and when the phone comes back to the page,
so a stop the office moved shows up.

## `<SchedulingSettings>` (admin)

`canManage` (`false` is read-only), `sections` (any of `"business"`, `"booking"`,
`"messages"`, `"crews"`, `"hours"`, in the order given; default all five),
`bookingPageUrl` ("Your booking page" with a copy button, and a direct link per
service), `signInUrl` (where a new crew member signs in once, so they appear in
the crew's people list), plus `baseUrl` or `transport` and the usual chrome
props. The same banner as the calendar sits on top.

- **Business:** name; time zone (US zones by name first, then "Other…" for every
  zone; "Changing it keeps every visit at the same clock time."); contact phone and
  email; up to five addresses for new-request alerts (with alerts installed,
  "Who gets new-request alerts is chosen in Alert settings." and a link
  instead, and a save never sends the list). Changing the zone with
  visits booked says how many will move, and offers "Email those customers the
  corrected time".
- **Online booking:** on or off; auto-confirm ("On: requests go straight onto the
  calendar. Off: you accept each one."); services (name, length, description, the
  skill a crew needs, add, reorder, remove); notice in hours or days; how far ahead;
  the start-time grid; travel time kept free; the most requests one person can have
  waiting; address required.
- **Customer messages:** when unanswered requests are released, the reminder, and
  how late customers can change or cancel online. It says when reminders really
  go out on this deployment (once a day, say), or that they're off and why.
- **Crews:** add and edit (name, home base, usual hours, most visits a day, skills,
  "Who opens this crew's route", a list of the people who have signed in); pause
  online booking for a crew; remove and restore (removed crews sit folded away).
- **Hours:** each crew's week, Monday first, with "+ Add hours" for a split shift. A
  crew whose hours were never saved starts from the hours it actually has now, not a
  made-up 8 to 5. Saving changes the week only, so days off stay. **Days off** are
  added as a range with a note; if visits are already booked on those days it says
  "3 visits are booked on those days. Move them from the calendar." Consecutive days
  off are listed, and removed, as one range.

Each card saves on its own, marks unsaved changes, says "Saved", and shows the
server's objections on the fields they're about. A crew whose hours were never
saved says "Using the crew's usual hours — save to keep them." rather than
claiming unsaved changes.

## Theme

Every component takes `theme`: `"auto"` (default), `"light"` or `"dark"`. **Auto
follows the host page**, in this order:

1. `data-theme="dark"` or `"light"` on the nearest parent of the widget, then
   `<body>`, then `<html>`;
2. a `dark` or `light` class on `<body>` or `<html>`;
3. `color-scheme` on `<html>`, when it is exactly `dark` or `light`;
4. the background the widget actually sits on: the nearest parent with a solid
   background colour, dark under a dark one, light under a light one;
5. with no background anywhere, light, unless the page's `color-scheme` lets
   the browser go dark; only then the visitor's system setting.

Rules 4 and 5 are for Tailwind's `class` strategy, which says dark with a
`dark` class and light by having none: a visitor with a dark system setting
used to get a dark card on a white page. A host that knows its theme on the
server can still pass `theme={isDark ? "dark" : "light"}`.

It follows changes live (a theme switch on the page, or the system going dark at
sunset). On the server and before the page hydrates there's no `data-theme`, so the
system setting decides: no flash on a page that already matches it.

Every colour is a CSS custom property on `.aisw-root`, declared at zero specificity,
so one ordinary rule re-themes every component, admin included:

```css
.aisw-root {
  --aisw-accent: #7c3aed;         /* buttons, selected times */
  --aisw-accent-strong: #6d28d9;  /* hover */
  --aisw-accent-soft: #ede9fe;    /* selected tints */
  --aisw-on-accent: #ffffff;      /* text on buttons */
  --aisw-font: "Inter", sans-serif; /* default: your page's font */
}
```

Tokens (all `--aisw-`): `ground surface ink muted faint line line-strong accent
accent-strong accent-soft on-accent ok ok-soft warn warn-soft danger danger-soft
on-danger focus radius radius-sm shadow font`; the calendar's `pending pending-soft
progress progress-soft done done-soft inactive`; crew colours `crew-1` … `crew-8`;
and `scrim shadow-lg` for dialogs. Every pair the widget prints text with passes
WCAG AA in light and dark (a test checks each one). Wrap an override in your own
`@media (prefers-color-scheme: dark)` or `[data-theme="dark"]` rule to change one
theme only.

**Styles** are added once as `<style id="aisw-styles">` (and `aisw-admin-styles` for
the admin) when the first component mounts. Pass `nonce` for a strict
Content-Security-Policy. `schedulingWidgetCss()` and `schedulingAdminCss()` return
the text if you render it yourself (a shadow root, say). `--aisw-scroll-margin`
(default 96px) keeps a step's heading clear of a sticky header when focus moves to
it.

## Transports

Every component takes `baseUrl` **or** `transport`. `createSchedulingClient({ baseUrl,
fetch?, headers? })` and `createSchedulingAdminClient(...)` are what `baseUrl` builds
for you. Each method returns `{ ok: true, data }` or `{ ok: false, error }`, and
never throws: a fetch that fails is `network`, a proxy's HTML error page is
`bad_response`, a 401 (or a redirect to a login page) is "You've been signed
out. Sign in again to keep working.", and the server's own refusals keep their
code and message.

**Mount the staff handler; don't re-implement it.** An app on tRPC or server
actions still mounts `createSchedulingAdminHandlers` at one route behind its own
`authorize`: the screens' answers are the handler's wire shapes (visit
snapshots, the default crew, refetches after a status change, settings on the
wire, refusal codes), not what the underlying functions return, so a transport
written method by method over the functions doesn't type-check and drops the
refusal codes. To keep the HTTP route private to your app, pass a `transport`
built on `createSchedulingAdminClient({ baseUrl, fetch })` with your own
`fetch` (an extra header, a server action that forwards the request). A
custom transport answers in the same wire types, with refusals as `{ ok: false,
error: { code, message, status } }`; the server's `toWireError(error)` and
`WIRE_ERROR_STATUS` turn a thrown error into that, and never pass a raw
database message to staff.

## Pure helpers

Exported for tests and for anyone building their own screens on the same rules.
Customer side: `groupSlotsByDay`, `partOfDay`, `formatTimeRange`, `zoneLabel`,
`validateVisitForm`, `buildVisitRequest`, `friendlyError`, `googleCalendarUrl`,
`toPublicStatusLabel`, `cutoffMessage`, `resolveHostTheme`, and every wire type.
Staff side: `positionVisit`, `snapMinutes`, `layoutLanes`, `weekDates`, `dragStart`,
`visitActions`, `adminErrorText`, `groupTimeOff`, `weekProblem`, and every wire
type.

## Accessibility

Real buttons, radios and labels throughout. Focus moves to each step's heading
when the customer moves on (never on page load). Dialogs and the visit panel trap
focus, close with Escape (the top one first, wherever focus is), and put focus
back on the visit you opened. Results and
errors are announced, and errors are linked to their fields. Colour is never the
only signal: a request is dashed and says "Request", a finished visit has a check,
a no-show is struck through. Every touch target is at least 44px, and everything
works at 390px wide without the page scrolling sideways. Every drag has a keyboard
path (**Move…**).

## Companies (Tenancy 2a)

`<CrewDay>` remembers the crew picked on a device PER SCHEDULE (its
`baseUrl`, which names the company), forgets a remembered crew that isn't
there any more and shows the person's own route instead, and offers no other
day when the server says the route is today-only (a crew member). Notices show
the server's "where to fix it" link, and an empty office-alerts list says
where alerts go instead.

The same screens serve every company on a site. Point each at its company's
routes, and pass what the company page already knows:

```tsx
// app/t/[slug]/book/page.tsx: the company's booking page
const found = await tenancy.resolvePublicCompany(slug);
if (!found) notFound();
const company = publicCompanyToWire(found);
if (company.status === "suspended") return <CompanyUnavailable company={company} />;     // @adminigloo/tenancy-widget
return (
  <>
    <CompanyBrandBar company={company} />
    <VisitPicker baseUrl={`/api/t/${company.slug}/schedule`} accentColor={company.brandColor} />
  </>
);
```

```tsx
// app/app/schedule/settings/page.tsx: staff
<SchedulingSettings baseUrl={`/api/app/${company.id}/schedule`} inviteHref="/app/team" />
```

- **`accentColor`** on `<VisitPicker>` and `<ManageVisit>`: the company's
  `#rrggbb` becomes the accent, with the text on it, its shades and the focus
  ring worked out to stay readable (a colour too light to read as text gets a
  darker shade for links and headings). null or undefined: the stylesheet's
  accent.
- **The closed message.** When the server answers `booking_closed` (the
  company is suspended), the picker and the manage page show the server's
  sentence ("Summit Window Co. isn't taking requests online right now. Call …")
  in place of the form, not an error.
- **Company-owned fields read-only.** When the server says the business
  details come from the company (`managedByCompany`), `<SchedulingSettings>`
  shows the name, time zone and contact details as text with a link to company
  settings, and doesn't send them.
- **`inviteHref`** on `<SchedulingSettings>`: the crew-person picker's hint
  becomes "Not listed? Invite them on the Team page." In a company the picker
  lists the company's own people, and the way in is an invitation.
- **Deep links**: `#booking`, `#crews`, `#hours`, `#business` and `#messages`
  on the settings page scroll to that section and focus its heading (the
  setup checklist links there).

A foreign host passes the same props from its own business record.

## Alerts and files (Tenancy 2b-1)

With `@adminigloo/notifications` and `@adminigloo/storage` on the server,
scheduling-widget 0.3 adds three small things. Every one is a prop; without
them, 0.2's screens.

```tsx
// app/app/schedule/page.tsx: an alert links to "/app/schedule?date=2026-11-03&visit=…"
const visit = typeof searchParams.visit === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(searchParams.visit) ? searchParams.visit : undefined;
<ScheduleCalendar baseUrl={`/api/app/${company.id}/schedule`} initialVisitId={visit} visitFilesHref="/app/schedule/visits/{id}/files" />

// app/app/schedule/today/page.tsx
<CrewDay baseUrl={`/api/app/${company.id}/schedule`} filesHref="/app/schedule/visits/{id}/files" />
```

- **`initialVisitId`** opens that visit's panel without a click. A visit
  from another week is fetched (`visit-get`) and the calendar moves to its
  day; one that's gone (removed, or another company's) shows a plain notice.
- **`visitFilesHref`** (calendar) and **`filesHref`** (today's route): the
  visit's photos-and-files page, `{id}` filled in and URL-encoded. The page
  itself is `@adminigloo/storage-widget`'s `<RecordFiles>`; this package
  only links to it (a widget never imports another).
- **Alert settings.** When the server says who gets new-request alerts is
  chosen elsewhere (`SettingsWire.alertRecipients`, from the staff
  handlers' `alertsHref`), the Business card shows "Who gets new-request
  alerts is chosen in Alert settings." with **Open Alert settings**, and no
  save sends the old address list.

### Not included (Tenancy 2b-1)

- **The feedback board per company, and the complete board** — Tenancy 2b-2.
  It will keep screenshots as these private files and send its alerts through
  these notifications. Until then, feedback screenshots stay on the public
  Blob store as in 2a.
- **The AI assistant per company** — Tenancy 2b-3.
- **Website analytics, SEO/AEO and book-a-call (booking) per company** —
  Tenancy 2b-4.
- **Text (SMS) and push alerts.** Alerts come in the app and by email — S9.
- **Plans, limits and billing enforcement** — the billing chunk. Each
  company's storage allowance is one setting for everyone
  (`FILES_ALLOWANCE_MB`) until then; the seam the billing chunk fills is
  there.
- **Stripe Connect** (customers paying a company by card).
- **Custom domains.**
- **Virus scanning of uploads.** Files are checked for their type and size
  only.
- **Uploads over 4 MB, and uploads straight from the browser to storage.**
  Phone photos are made smaller before they're sent; other files over 4 MB are
  refused with a plain sentence.
- **Serving files straight from S3 or R2 by presigned link.** Every private
  file is sent through the site's own route.
- **Thumbnails.** Photos are shown at their (shrunk) size.
- **Turning a kind of alert off.** Each kind comes in the app, or in the app
  and by email; who gets the work alerts is the owner's choice.
- **Alerts from your other companies in the bell.** The bell shows the
  company you're working in.
- **A daily or weekly digest of alerts.**
- **Customers seeing files** (photos on their quote or invoice page).
- **Editing the wording of the team alert email** beyond the Messages screen
  (it is the `team_alert` message there).
- **Carrying 2a's per-feature alert address lists over.** With alerts
  installed, the people (and extra addresses) are chosen again in Alert
  settings; the old lists are no longer read.
- **Alert settings in a single-business project without an admin shell.** Its
  staff get the bell; the office emails keep 2a's lists.
- **A transactional outbox.** Alerts are written right after the change they
  report (D8); the events package (S2) brings the outbox.
- **Crew alerts when the office moves, reassigns or cancels their visit.**
  Only a customer's change alerts the crew.
- **An alert when a customer opens a quote** (invoices only).
- **A history of cron runs, and an alert when a cron fails.**
- **Alerts for the platform owner** (a new company, a company out of
  storage). A company's storage refusal is reported in `/admin/errors` once a
  day.
- **Giving one company more storage than the others.** `FILES_ALLOWANCE_MB`
  is one number until the billing chunk.
- **Checking an address before it gets a company's alert emails.** The owner
  adds up to five per group; the company's team sending allowance bounds what
  they get.

## Not included

- **Recurring visit plans** (weekly cleaning, quarterly service). Book each visit.
- **A customer account.** There's no "my visits" page and no CRM record; a visit
  keeps the name, email, phone and address as typed. Each visit has its own link.
- **SMS.** Every notice and reminder is email.
- **Deposits and payments.**
- **One calendar with `@adminigloo/booking`.** Booking (calls) and scheduling
  (visits) are separate, so one person on both can be double-booked.
- **What Tenancy 2b-1 leaves out**: see
  [Not included (Tenancy 2b-1)](#not-included-tenancy-2b-1). (These screens
  serve each company since 0.2: see [Companies](#companies-tenancy-2a).)
- **A scheduling embed** (a script for the company's own website). The booking
  page's address is shown to copy.
- **Payments to companies, plans and billing per company, custom domains,
  impersonation, per-company SEO.**
- **Holding a time while the customer types.** The time is checked when the form
  is sent, and a time taken meanwhile recovers with "pick another".
- **A time-zone picker for customers.** Times are always the business's.
- **Two-way calendar sync** (Google, Outlook) or a crew calendar feed.
- **Route optimisation.** Stops are in time order, with no reordering suggestions.
- **Partial days off.** Days off are whole days.
- **Visits that cross midnight.**
- **Checklists or signatures** on the crew's route. (Photos: **Photos** on
  each stop, with `filesHref`.)
- **Translations.** The words are English; `locale` changes date and time formats.
- **A license gate.**
