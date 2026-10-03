# @adminigloo/booking

Book-a-call for an app's own site. Hosts keep their weekly hours in their own
time zone. Prospects pick a time from a slot engine that holds up across daylight
saving changes, hold it for ten minutes while they fill in the form, and manage
the booking afterwards from a token link, with no account. The host's real calendar
is read through its secret iCal address, so nobody gets offered a time the host
already has something else in.

This is the server half. The React picker that talks to it is
[`@adminigloo/booking-widget`](../booking-widget). The design is ported from the
Ask Lou (SquireSolutions) demo scheduler, rebuilt on Postgres and `Intl`. The defects
listed at the end were fixed rather than carried over.

Besides the engine and the HTTP handler, the package ships the pieces a real
deployment needs around them: a per-visitor **sandbox** you can put on a marketing
page (`createSandboxBookingHandlers`), the **emails** as plain-data templates with
their variables built from booking events (`bookingEmailTemplates`,
`bookingEmailVars`), and the **admin** functions for hours, time off, calendar
connection, the bookings list, moving and cancelling calls, and outcomes.

```
@adminigloo/booking          functions + types (no tables)
@adminigloo/booking/schema   the drizzle pgTables
```

Depends on `@adminigloo/db` and `@adminigloo/license`. Peers: `drizzle-orm`, `zod`.
No date library, no email vendor, and no AI SDK.

## Concepts

**Hosts** take calls. Each host has an IANA time zone, which is checked with `Intl`
on every write. A host also has an optional standing video link, an optional
caller-ID phone number, an optional mailbox for invites the prospect sends, and an
optional secret iCal address.

**Availability** is written in the host's own wall-clock time, in 15-minute steps.
It's resolved for each date in this order:

1. A tenant **blackout** (a holiday) means nothing is bookable that day.
2. An **`off`** exception wins over everything else.
3. **`hours`** exceptions *replace* the weekly windows for that date.
4. Otherwise the **weekly windows** for that weekday apply.
5. **`block`** exceptions are then cut out (for example, "dentist 12:00–14:00").

A host who hasn't entered any hours can't be booked. There's no default
Monday-to-Friday.

**Types** define what can be booked: duration, buffers, the slot step, minimum
notice, horizon, a per-day cap, the meeting media on offer (`video`, `phone`,
`prospect_hosted`), and a host pool. An empty pool means every active host.

**Slots** are calculated in absolute instants. The grid starts at each window's
start, so a day that opens at 08:15 offers 08:15, 08:45, and so on. A start is
offered only if all of these hold:

- The meeting itself fits inside the window. Buffers don't have to: they're
  clear time between calls, not hours the host promised. A 09:00–17:00 day
  with 15-minute buffers still offers 09:00 and 16:30.
- The meeting keeps clear of every busy interval by the gap both sides ask
  for. Where it follows an existing booking, the gap must be at least the
  larger of its own before-buffer and that booking's after-buffer. Where it
  comes before one, the gap must be at least the larger of its own
  after-buffer and that booking's before-buffer. The buffers don't add
  together: 15 minutes of lead-in next to 30 minutes of write-up is 30
  minutes clear, not 45. Each booking keeps its *own* type's buffers. A
  calendar event asks for none, but the candidate's own buffers still apply,
  even across the edge of the window. This is Squire's test-log D17 rule.
- The start is after `now + notice` and inside the horizon. The horizon counts
  whole days in the host's zone, today included.
- The day is under the type's `maxPerDay`.

With a host pool, slots are the union across the pool. The prospect picks a time,
never a person. The booking goes to the free host with the fewest live bookings in
the next seven days.

**Holds** reserve a start for 10 minutes. Hold, book and reschedule each run in a
single transaction. That transaction takes per-host advisory locks
(`pg_advisory_xact_lock(hashtext('booking:'||tenant||':'||host))`, in sorted
order), re-checks the exact start with the same engine that offered it, and only
then writes. Two prospects racing for 10:00 end up with one booking and one
`slot_taken`. The invitee's reschedule and the host's reschedule share one
transaction (`services/move.ts`), so they can't disagree about what is free.

**Holds are capped per requester.** Holds are anonymous and free, and each one
takes a start (and, through the buffers, its neighbours) off the market for ten
minutes. Without a cap, one script could keep a host's whole calendar held so no
real prospect is ever offered a time. Pass `holdSubject` to the handler factory
(usually the client IP's rate-limit key). One subject can then hold at most
`maxHoldsPerSubject` times at once (default 2), and a third is refused with
`rate_limited`. The count runs under the host lock, after any hold being replaced
was released, so moving a hold from 10:00 to 10:15 is never refused. Only a
SHA-256 of `tenant:subject` is stored, on the hold row (`hold_subject_hash`), and
it is cleared when the hold becomes a booking. An IP's hash can be brute-forced,
so treat the column as personal data anyway. `countLiveHolds(ctx)` returns
`{ live, subjects }` so the admin can show held time, or the app's `rateLimit`
can refuse holds above a ceiling of its own.

**Tokens** are capabilities: 32 random bytes, base64url, and only the SHA-256 hash
is stored. A *manage* token is the prospect's whole identity. It lets them read,
reschedule, cancel and download the `.ics` for one booking. A *feed* token lets a
host subscribe to their upcoming calls. Unknown tokens get the same `not_found` as
everything else.

**Reschedule moves the same row.** The start and end change and `sequence` goes up
by one. The manage token stays the same and the `.ics` UID stays
`${bookingId}@${uidDomain}`, so the prospect's link keeps working and their
calendar updates the existing event instead of adding a second one. The conflict
check excludes the booking being moved.

**Moving a call can land next to itself.** The slot list and the hold take the
prospect's manage token as an option (`manage` on `/v1/slots`, `manageToken` on
`/v1/hold`). When the token opens a booking of that type that can still move,
that booking stops counting as busy, buffers included. So "half an hour later"
is offered and can be held, instead of being blocked by the call being moved.
The reschedule then applies the same exclusion. A token that opens nothing is
ignored by the slots route, which returns the same list either way, so it can't
be used to test tokens. On the hold route the same token is `not_found`.

**A form sent twice books once.** When a hold has already become a booking that
still stands, a second `book` with the same hold token within ten minutes
answers `already_booked`. That covers a double click, or a retry after a
response that never arrived. Before this, the second request found the time
taken by its own booking and said the hold had expired. With a host pool it
could even book the prospect a second time on another host. The booked row
keeps its hold's token hash for this check. Every release, purge or conversion
by hold token also requires `status = 'hold'`, so a booked row is never
touched that way.

## The busy source (a host's real calendar)

```ts
import { createIcsBusySource } from "@adminigloo/booking";
const busySource = createIcsBusySource(); // ttlMs 5 min, timeoutMs 5 s
```

To find a Google Calendar's secret address, open **Settings → (your calendar) →
Integrate calendar → "Secret address in iCal format"**. Paste it into the host's
`busyIcsUrl`. Outlook published calendars, iCloud and Fastmail ICS links work the
same way, and `webcal://` is accepted.

The reader handles UTC, `TZID` and floating times, all-day dates, `DURATION`,
`RRULE` (DAILY/WEEKLY/MONTHLY plus plain YEARLY, with INTERVAL, COUNT, UNTIL,
BYDAY, BYMONTHDAY, BYMONTH, BYSETPOS and WKST), `RDATE`, `EXDATE`, and
`RECURRENCE-ID` overrides. It skips `STATUS:CANCELLED` and `TRANSP:TRANSPARENT`
events (Google's "Show me as free", and the default for its all-day events).
`VTIMEZONE` blocks are ignored and zones are resolved by name with `Intl`. Outlook's
Windows zone names are mapped. Expansion stays inside the requested window and is
capped at 5,000 instances.

**The reader only fetches the public internet (SSRF).** Staff type the address,
the server fetches it, and what comes back is shown: busy blocks in the public
slot list, plus an event count and the error text on "Test connection". So every
hop of every fetch is checked:

- **The literal host**, parsed rather than pattern-matched, so no spelling slips
  past: loopback (`127.0.0.0/8`, `::1`, `[0:0:0:0:0:0:0:1]`, `2130706433`, `0x7f.1`,
  `127.1`), unspecified (`0.0.0.0`, `[::]`), private (`10/8`, `172.16/12`,
  `192.168/16`), link-local and cloud metadata (`169.254/16`, `fe80::/10`), CGNAT
  `100.64/10` (which includes Alibaba's `100.100.100.200`), ULA `fc00::/7`,
  IPv4-mapped and -compatible IPv6 (`[::ffff:127.0.0.1]`, `[::ffff:a9fe:a9fe]`),
  NAT64 and 6to4 forms of a private IPv4, documentation, multicast and reserved
  ranges. Names that are private by construction are refused too: `localhost` and
  `*.localhost`, `.local`, `.internal`, `.home.arpa`, any single-label name (DNS
  search domains would complete it to an internal host), and all of these with a
  trailing dot (`localhost.`). URLs carrying a username or password are refused.
  `upsertHost` refuses such an address when it's saved, with a sentence.
- **Every address the name resolves to** (`node:dns` `lookup(…, { all: true })`,
  imported lazily, so the module still loads on runtimes without it). One private
  answer is enough to refuse. This check is **best-effort against DNS
  rebinding**: `fetch` resolves the name again on its own, so a hostile DNS server
  that answers public and then private inside that gap is not stopped. It does
  close every name that simply points inside (`localtest.me`, a mistyped internal
  host). On a runtime without `node:dns` the check is skipped. Pass `resolveHost`
  to supply a resolver there, or `resolveHost: null` to turn it off on purpose
  (say, behind an egress proxy).
- **Every redirect.** Redirects are followed by hand, at most three
  (`maxRedirects`), and each `Location` goes through all of the above again. `fetch`
  is never left to follow them.
- **The body** is streamed with a running byte count and abandoned the moment it
  passes `maxBytes`, whatever `Content-Length` claimed.

**If the calendar can't be read, the page still works.** A failed fetch makes that
request use internal bookings only. The slots response then says
`busySync: "degraded"`, and the host row records `busySyncError` and
`busySyncFailingSince`, which `listHosts` shows the admin. Prospects never see the
error. With no busy source configured, only internal bookings count and the
response says `busySync: "off"`.

Any other calendar can be plugged in by implementing one method:

```ts
interface BusySource {
  busy(input: { host: { id: string; timezone: string; busyIcsUrl: string | null }; from: Date; to: Date }):
    Promise<Array<{ start: Date; end: Date }>>; // throw on failure; the caller degrades
}
```

## Sandbox

A marketing page can give every visitor their own throwaway calendar and let
them really book, reschedule and cancel, while nothing real is touched. The whole
thing is one call. It is framework-free: a `Request` in, a `Response` out, the
session in a `Set-Cookie` header.

```ts
// app/api/book-demo/[...path]/route.ts
import { createSandboxBookingHandlers } from "@adminigloo/booking";

const production = process.env.NODE_ENV === "production";
const demo = createSandboxBookingHandlers({
  db,
  uidDomain: "demo.acme.com",                        // a sandbox UID never looks like a real call's
  manageUrl: (token) => `https://acme.com/demo/manage/${token}`,
  cookieName: production ? "__Host-acme_bookdemo" : "acme_bookdemo",
  secureCookie: production,
  tenantPrefix: "bookdemo:",                         // every visitor sandbox is bookdemo:<sha256>
  previewTenant: "bookdemo-preview:v1",              // shared, read-only; bump the suffix when `seed` changes
  ttlHours: 24,
  seed: {                                            // a sample business, not you
    host: { displayName: "Maya at Northwind Dental (sample)", email: "host@example.com",
            timezone: "America/Denver", inviteMailbox: "invites@example.com" },
    weekly: [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, startMinute: 540, endMinute: 1020 })),
    types: [{ key: "consultation", name: "New-patient consultation (sample)", durationMinutes: 30,
              media: ["video", "phone"], minNoticeMinutes: 60 }],
  },
  realBookingUrl: "https://acme.com/book",           // appended to sandbox calendar exports
  ceilings: { newSandboxesPerHour: 300, holdsPerHour: 1200 },
  rateLimit: (req, bucket) => limiter.allow(req, bucket),   // read | hold | book | manage | mint
  defer: (task) => after(task),                      // Next's after(); Workers' waitUntil
  onBooked: ({ headers }) => recordDemoConversion(headers),
});

export const GET = demo.handle;
export const POST = demo.handle;
// daily cron: await demo.purgeExpired();
```

How it keeps a stranger away from everything real, in layers:

- The inner handlers run with `sandbox: true`. They **never call `onEvent`**, so
  nobody is emailed, and **never call a busy source**, so no real calendar is read,
  whatever else is passed in. The options type leaves out `onEvent`, `busySource`,
  `tenantId`, `resolveTenant`, `cors` and `rateLimit`, and the inner options are
  built field by field, so an untyped caller can't slip one in either.
- **One tenant per browser session.** The cookie holds 32 random bytes (httpOnly,
  `SameSite=Lax`, no `Max-Age`). The tenant is `tenantPrefix` plus its SHA-256, so
  the table never holds the capability. A cookie with no live sandbox behind it is
  cleared and never adopted. Every read and write is tenant-scoped, so a visitor
  sees only their own sandbox.
- **Reads don't create anything.** `config` and `slots` from a browser without a
  sandbox are served from the shared read-only preview tenant, so page views,
  crawlers and bots write no rows. The first hold or booking mints the sandbox.
  Manage, release and feed routes only ever open the visitor's own sandbox, and
  without one they get the package's ordinary 404.
- **Fenced like any anonymous write.** A cross-site POST is refused before
  anything else, so a forged request can't even mint a sandbox. The app's
  `rateLimit` is asked per bucket, plus `"mint"` for each new sandbox. There are
  hourly ceilings on new sandboxes and on claims (every hold and booking row),
  counted in Postgres, so they hold across serverless instances and no rotation of
  IPs or cookies gets past them. A ceiling answers 429 "The demo is busy" with
  `Retry-After: 300`.
- **A sandbox lives `ttlHours` from the moment it's made**, enforced where it's
  used. A request carrying an older one is treated as having none, and the old one
  is deleted after the response. `purgeExpired()` deletes the rest, a new sandbox
  sweeps a few stale ones on its way in, and `removeSandbox(id)` deletes one now (it
  only accepts a full sandbox id).

**Sandbox calendar exports are not events.** In sandbox mode the `.ics`
(`sandbox-not-a-real-booking.ics`) and the Google "add" link carry the title prefix
`[Sandbox — not a real booking] `. The description is replaced by "This was made
in a live demo. Nothing was booked and nobody will join.", plus "Book a real call:
…" when `realBookingUrl` is set. There is no location, `ORGANIZER`, `ATTENDEE` or
manage link, and the event is `STATUS:TENTATIVE` (`CANCELLED` once cancelled, so a
calendar that imported it removes it) and `TRANSP:TRANSPARENT`, so it never blocks
the visitor's time. `sandbox: true` is echoed in the config and on every booking,
so the widget labels its buttons and shows its banner.

The lower-level pieces are still exported for a custom setup:
`createBookingHandlers({ sandbox: true, resolveTenant })`,
`seedSandboxTenant(db, input, { now? })` (idempotent, safe on every request), and
`purgeTenants(db, { prefix, olderThan })`, which removes a tenant only once its
*newest* activity, across all booking tables, is older than the cutoff.

## Mounting the handler

```ts
// app/api/booking/[...path]/route.ts
import { createBookingHandlers, createIcsBusySource } from "@adminigloo/booking";
import { db } from "@/db";
import { env } from "@/env";
import { notifyBooking } from "@/server/booking-notices";

const { handle } = createBookingHandlers({
  db,
  tenantId: "adminigloo",
  busySource: createIcsBusySource(),
  onEvent: notifyBooking,                                   // awaited + caught
  rateLimit: (req, bucket) => limiter.allow(req, bucket),   // false → 429
  license: { key: env.ADMINIGLOO_LICENSE_KEY, publicKey: env.ADMINIGLOO_LICENSE_PUBLIC_KEY,
             mode: env.ADMINIGLOO_LICENSE_MODE },           // enforce → 402
  uidDomain: "adminigloo.com",                              // never change once bookings exist
  manageUrl: (token) => `https://adminigloo.com/book/manage/${token}`,
  emailsEnabled: Boolean(env.RESEND_API_KEY),               // false → no copy promises an email
  contactEmail: "hello@adminigloo.com",                     // a person prospects can write to
  holdSubject: (req) => clientIpKey(req),                   // caps live holds per requester
  // maxHoldsPerSubject: 2,
  // defaultCallingCode: "1",                               // read "801 555 0143" as +1; omit to require the "+"
  // cors: "*",                                             // only for keyed cross-origin embeds
});

export { handle as GET, handle as POST, handle as OPTIONS };
```

Then embed the widget: `<BookingWidget baseUrl="/api/booking" />`.

**Without email, say so.** `emailsEnabled: false` is echoed in the config, so the
widget stops promising a confirmation email and makes the manage link on the
confirmation page the thing to keep. The package's own copy changes too:
`already_booked` points at the confirmation page and `contactEmail` instead of the
inbox. A video call with no saved meeting link now reads "{host} will send you the
link before the call." in the `.ics` and the Google link, with no claim about how.
`contactEmail` must be an address (anything else throws at construction), and an
empty string means none.

### CSRF

Every POST changes state: a hold on the host's calendar, a booking, a cancel or a
move. The body parser accepts `text/plain` (for `sendBeacon`), which is a "simple
request" a browser sends cross-site **without** a CORS preflight. Leaving out CORS
headers only stops another site reading the answer, not sending the request. So,
unless `cors` is configured, `handle` refuses a cross-site POST with **403
`forbidden`** before it routes, resolves a tenant or touches the database
(`isCrossSiteRequest(req)` is exported for an app's own routes):

1. **`Sec-Fetch-Site`**, when present, is the browser's own verdict and a page
   can't set it. `same-origin`, `same-site` and `none` pass. `cross-site` is
   refused. `same-site` includes sibling subdomains of your registrable domain,
   so don't host untrusted pages on one.
2. **Otherwise** (older browsers), the `Origin` host, or failing that the `Referer`
   host, must equal the request URL's host. `X-Forwarded-Host` also counts, for
   apps behind a proxy that rewrites `Host`: a page can't add that header to a
   cross-site request without a preflight, and the preflight fails. `Origin: null`
   (a sandboxed iframe, a `file:` page) is refused.
3. **With neither header**, the request passes only if it carries no `Sec-Fetch-*`
   header at all, i.e. it isn't from a browser (a server, a test, curl). A
   non-browser caller can forge any header, but CSRF is about a visitor's browser
   being driven by another site, and that browser can't.

With `cors: "*"` the check is off. With a single origin, POSTs from exactly that
origin pass. GETs are never checked: they change nothing.

### Notifications

`onEvent` receives `booking.created`, `booking.rescheduled` (with
`previousStart`, and `by`: `"invitee"` or `"host"`), `booking.cancelled` (with
`by`), and `booking.confirmed` (when a host accepts a request). Each event carries
`{ tenantId, booking (AdminBooking, every invitee field), host: { displayName,
email, timezone, meetingLink, phone, inviteMailbox }, type }`. `created` and an
invitee's `rescheduled` also carry the plaintext `manageToken` so the email can
link to the manage page, so don't log the event object as a whole. A host's
reschedule has no token to give (only its hash is stored). Holds emit nothing. The
discriminator is `event` because `type` is already the booking type.

### Emails

The package sends nothing and depends on no mail vendor (or on
`@adminigloo/comms`). It ships the words as plain data plus the variables, so an
app wires `onEvent` to whatever sends its mail:

```ts
import { bookingEmailTemplate, bookingEmailVars, renderBookingTemplate, type BookingEvent } from "@adminigloo/booking";

export async function notifyBooking(e: BookingEvent) {
  const mail = bookingEmailVars(e, { baseUrl: "https://acme.com", includeManageLink: true });
  const { invitee, host } = mail.templateFor;          // which template this event calls for, per side
  if (invitee && mail.to.invitee) await sendEmail(mail.to.invitee, renderBookingTemplate(bookingEmailTemplate(invitee), mail.invitee));
  if (host) await sendEmail(mail.to.host, renderBookingTemplate(bookingEmailTemplate(host), mail.host));
  if (e.event === "booking.created" && e.booking.status === "confirmed") {
    const queued = bookingEmailVars(e, { baseUrl: "https://acme.com", includeManageLink: false });
    await queueEmail({ sendAt: dayBefore(e.booking.start), to: mail.to.invitee, template: "booking_reminder", vars: queued.invitee });
  }
}
```

`bookingEmailTemplates` is an array of `{ key, audience: "invitee" | "host",
subject, body }` with `{{vars}}`: `booking_confirmation`, `booking_requested`,
`booking_confirmed`, `booking_rescheduled`, `booking_cancelled` (by the invitee),
`booking_host_cancelled` (by the host, with their note), `booking_reminder`, and
`booking_host_notice` (new, moved or cancelled, with the invitee's details and a
one-click add to the host's Google Calendar). The words are product-neutral: they
speak as the host, name nobody, and say "before the call", never "tomorrow".
Seed them into your own template store if staff should be able to edit them.

`bookingEmailVars(event, { baseUrl, includeManageLink, hostZone?, manageUrl?,
apiBase?, bookUrl?, adminUrl?, locale? })` returns `{ invitee, host, templateFor,
to }`. Times are in each reader's own zone ("Wednesday, October 14, 2026,
4:00 – 4:30 PM GMT+1 (Europe/London)"). The host isn't emailed about a call they
moved or cancelled themselves.

**The manage link is a key.** Its plaintext token opens, moves and cancels the
booking, and the package stores only its hash. Use `includeManageLink: true` only
for a message sent right now. Anything that will sit in a table, such as a queued
reminder or a delivery log, must be built with `includeManageLink: false`. The
manage URL, the `.ics` URL and the Google link's description then say "the private
link in your booking confirmation" instead, so nobody reading the database can open
the booking from a log row.

## The wire contract

This contract is shared with `@adminigloo/booking-widget`. Change both packages or
neither.

| Route | Body | Response |
|---|---|---|
| `GET {base}/v1/config` | — | `{ sandbox, hostDisplayName, hostTimezone, types: [{ key, name, description, durationMinutes, media, minNoticeMinutes, horizonDays }], defaultCallingCode?, emailsEnabled?, contactEmail? }`. `defaultCallingCode` is present only when the option is set. A client must read a missing `emailsEnabled` as `true` (a server older than the field) and a missing `contactEmail` as `null`. |
| `GET {base}/v1/slots?type=KEY&from=ISO&to=ISO&manage=TOKEN?` | — | `{ slots: [{ start, end }], busySync: "ok" \| "degraded" \| "off" }`. Clamped to notice and horizon, at most 31 days per call. With `manage`, the invitee's own booking isn't busy. An unknown token is ignored. |
| `POST {base}/v1/hold` | `{ type, start, previousHoldToken?, manageToken? }` | `{ holdToken, expiresAt, start, end }`. With `manageToken`, the invitee's own booking doesn't block the hold. A token that opens no movable booking is `not_found`. |
| `POST {base}/v1/hold/release` | `{ holdToken }` (text/plain from sendBeacon is accepted) | `{ ok: true }` |
| `POST {base}/v1/book` | `{ type, start, holdToken?, name, email, phone?, company?, notes?, medium, timezone, source? }` | `{ booking, manageToken, manageUrl }` |
| `GET {base}/v1/manage/:token` | — | `{ booking }` |
| `POST {base}/v1/manage/:token/cancel` | `{ reason? }` | `{ booking }` (idempotent) |
| `POST {base}/v1/manage/:token/reschedule` | `{ start, holdToken? }` | `{ booking }` |
| `GET {base}/v1/manage/:token/ics` | — | `text/calendar`, as an attachment. PUBLISH, or CANCEL once cancelled. |
| `GET {base}/v1/feed/:feedToken.ics` | — | `text/calendar`, the host's subscribable feed: first name and company only |

`booking` is a `PublicBooking`: `{ status, start, end, typeName, typeKey,
durationMinutes, hostDisplayName, hostTimezone, inviteeName, inviteeTimezone,
medium, meetingLink, hostPhone, inviteMailbox, googleCalendarUrl, canCancel,
canReschedule, sandbox }`. `typeKey` is what the slots and hold routes take, so
a reschedule picker asks for the right type. It's `""` only when the type row
is gone.
It contains only what the chosen medium needs: the video link for `video`, the
caller ID for `phone`, the mailbox to invite for `prospect_hosted`. It never
includes the host's email (except as the invite mailbox for `prospect_hosted`) or
any token.

Errors use the shape `{ error: { code, message, issues? } }`:

| Code | Status | Meaning |
|---|---|---|
| `not_found` | 404 | Unknown route, type, token or id. The same response for all of them. |
| `slot_taken` | 409 | The time is no longer free. |
| `hold_expired` | 409 | The request carried a hold token, but the hold had lapsed and the time was taken. |
| `already_booked` | 409 | The same form was sent twice. Its hold became a booking in the last ten minutes, and that booking still stands. The message tells the prospect to check their email for the confirmation and manage link. With `emailsEnabled: false` it points at the private link on the confirmation page and, when set, `contactEmail`. In sandbox mode it says nothing was emailed. |
| `invalid` | 400 | The input failed validation. `issues: [{ path, message }]` uses the wire's field names. |
| `rate_limited` | 429 | Your `rateLimit` returned false (buckets are `read`, `hold`, `book` and `manage`), or the requester already has `maxHoldsPerSubject` live holds. |
| `unlicensed` | 402 | `license.mode` is `"enforce"` and there's no valid `booking` license. |
| `forbidden` | 403 | A POST sent by a browser from another site (see [CSRF](#csrf)). Refused before any work. |

Every response is sent with `Cache-Control: no-store`. Routes with a token in the
URL also send `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex`. That
means the path, or the `manage` query on slots. CORS headers are only sent when
`cors` is set.

Phone numbers are normalized to `+` followed by 7–15 digits, and are required
when `medium` is `phone`. By default they need a country code
(`+1 801 555 0143`). With `defaultCallingCode`, a number typed without `+` or `00`
is read in that country, and **anything that can't be normalised with confidence
is refused rather than guessed**. Refusing costs the prospect one edit. A wrong
guess costs the host a call to a stranger. The rules:

- **Code `1` (US, Canada, the Caribbean):** the national number must be a real
  North American shape, ten digits with the area code and exchange each starting
  2–9 (`/^[2-9]\d{2}[2-9]\d{6}$/`). One leading `1` is dropped from an eleven-digit
  entry (`1 801 555 0143`). A leading `0` is **never** stripped, because North
  America has no `0` trunk prefix: the UK's `020 7946 0958` typed on a US form is
  refused, where it used to become `+1 207 946 0958`, a valid-looking Maine number.
  `011` (how North Americans dial abroad) reads as international: `011 44 20 7946
  0958` becomes `+442079460958`.
- **Other codes:** one domestic trunk `0` is dropped (`020 7946 0958` with `"44"`
  becomes `+442079460958`), and a second leading `0` is refused. Italy and San
  Marino keep their leading `0`, because there it's part of the number.
- **International numbers** (`+` or `00`) are read as written, except that a
  literal `(0)` right after the country code is dropped (`+44 (0) 20 7946 0958`
  becomes `+442079460958`; Italy keeps the digit). **Any number in country code 1
  must have the North American shape**, however it was typed, so `+1 801 555
  01434` is refused.

The code is advertised in the config, so the widget checks numbers the same way. A
value that isn't a one-to-three-digit calling code throws when the handlers are
created, and an empty string means unset. Hosts' own numbers always need the `+`.

## Staff admin calls

Every admin function takes a `BookingContext` (`{ db, tenantId, now?, busySource?,
onEvent? }`). Call them from your staff router behind the `booking.*` permissions:

```ts
import {
  bookingPermissions, upsertHost, listHosts, setWeeklyAvailability, addException, addBlackout,
  upsertType, listBookings, getBooking, hostCancelBooking, hostRescheduleBooking, confirmBooking,
  setOutcome, countLiveHolds, rotateHostFeedToken, testBusySource, createIcsBusySource,
} from "@adminigloo/booking";

// staff catalog: definePermissions("staff", { ...bookingPermissions, ... })
const ctx = { db, tenantId: "adminigloo", busySource: createIcsBusySource(), onEvent: notifyBooking };

const host = await upsertHost(ctx, {
  displayName: "Dallin", email: "dallin@adminigloo.com", timezone: "America/Denver",
  meetingLink: "https://meet.google.com/abc-defg-hij", phone: "+1 801 555 0143",
  busyIcsUrl: "https://calendar.google.com/calendar/ical/…/private-…/basic.ics",
});                                               // busyIcsUrl comes back masked: "https://calendar.google.com/…ics ✓"
await setWeeklyAvailability(ctx, { hostId: host.id, windows: [{ dayOfWeek: 1, startMinute: 540, endMinute: 1020 }] });
await addException(ctx, { hostId: host.id, date: "2026-11-26", kind: "off", note: "Thanksgiving" });
await upsertType(ctx, { key: "intro", name: "Intro call", durationMinutes: 30, media: ["video", "phone", "prospect_hosted"] });
await testBusySource(ctx, host.id);               // { ok: true, events: 12 } or { ok: false, events: 0, error }
const { feedToken } = await rotateHostFeedToken(ctx, host.id); // shown once: webcal://…/api/booking/v1/feed/${feedToken}.ics

const upcoming = await listBookings(ctx, { from: new Date(), status: ["confirmed", "requested"] });
await confirmBooking(ctx, upcoming[0]!.id);       // for hosts with autoConfirm: false
await hostRescheduleBooking(ctx, { id: upcoming[0]!.id, start: "2026-10-15T16:00:00Z" }); // emits booking.rescheduled (by: "host")
await hostCancelBooking(ctx, { id: upcoming[0]!.id, reason: "Sick today" }); // emits booking.cancelled (by: "host")
await setOutcome(ctx, { id: past.id, outcome: "won", status: "completed" });   // only once the call has started
await countLiveHolds(ctx);                        // { live: 3, subjects: 2 } — holds never appear in listBookings
```

The `booking.*` permissions are `booking.calls.view`, `booking.calls.manage`,
`booking.availability.manage` and `booking.settings.manage`.

**Moving a call.** `hostRescheduleBooking` runs the same transaction as the
invitee's reschedule, with actor `"host"`. The same row moves, the manage token
and `.ics` UID stay, `sequence` goes up, and `booking.rescheduled` (with `by:
"host"` and no `manageToken`) is emitted after the commit, so your listener emails
the invitee and re-queues the reminder just as it does for an invitee's move. The
new time has to obey the same rules as the slot list (hours, notice, horizon,
buffers, `maxPerDay` and the host's real calendar). To take a call outside the
usual hours, add an `hours` exception for that date first. A call that has
started, or is cancelled, is `invalid`.

**Guards on closing a call out.** `setOutcome` refuses `completed` / `no_show` for
a call that hasn't started (`invalid`). Marking a future call closed used to take
it out of every busy check, so its slot could be double-booked. It emitted nothing,
so the queued reminder stayed queued, and the invitee's manage page flipped to
"can't change". A free-text outcome alone can be noted at any time.
`hostCancelBooking` refuses a call that has already ended (`invalid`), so nobody is
told "sorry, I had to cancel" about a call that already happened.

### Maintenance

```ts
await purgeExpiredHolds(db, { olderThan: new Date(Date.now() - 3600_000) }); // every tenant, hourly
```

Expired holds stop blocking time the moment they lapse. This cron only keeps the
table small, and it never turns an abandoned hold into a cancellation.

## What was fixed from the original

- **D23: confirmations sent without the invite.** The `.ics` builder had been
  registered as a side effect. Here it's a pure function served at a token URL.
- **D2: reschedule left the prospect with a dead link.** Reschedule now updates
  the same row and keeps the same token. The UID stays the same and `SEQUENCE`
  increments, so the old calendar event is updated rather than left behind.
- **"Reschedule blocks itself."** The conflict check now excludes the booking
  being moved.
- **Non-transactional writes.** Every claim on time is one transaction under the
  host lock, and saving a week of availability is one transaction too.
- **Host zones saved as unchecked free text.** Zones are now validated as IANA
  names on write.
- **Abandoned holds counted as cancellations.** Holds now just expire.
- **Manage tokens stored in plaintext.** Only the SHA-256 hash is stored now.
- **External calendar failures logged and swallowed.** They're now recorded on the
  host so the admin can see them.

### Fixed after the first adversarial review (October 2026)

- **CSRF.** A cross-site `text/plain` POST could place holds, book, cancel or move
  calls on the host's real calendar. Cross-site POSTs are now refused with 403
  (see [CSRF](#csrf)).
- **Phone numbers changed into someone else's.** With calling code 1, the UK's `020
  7946 0958` became `+1 207 946 0958`, and `011 …` became garbage. NANP now never
  strips a `0`, requires the real ten-digit shape, reads `011` as international,
  drops a bracketed `(0)`, and refuses what it can't normalise.
- **SSRF in the busy reader.** It followed redirects anywhere (127.0.0.1 included)
  and matched private hosts by spelling only. Every hop, spelling and resolved
  address is now checked, and the body is capped while it streams.
- **Sandbox calendar exports looked like real calls.** They are now labelled,
  tentative, transparent non-events with no organizer.
- **Copy that promised email on deployments that send none.** See
  `emailsEnabled` and `contactEmail`.
- **Hold squatting.** Holds are now capped per requester (`holdSubject`), and
  `countLiveHolds` makes held time visible.
- **Admin closing out or cancelling the wrong calls.** Outcomes need a started
  call, cancellation needs a call that hasn't ended, and the host can now move a
  call instead of cancelling it.
- **The sellable pieces were site-only.** The per-visitor sandbox wrapper and the
  email templates now ship in the package.

**Migration.** This adds one nullable column, `booking_bookings.hold_subject_hash`,
and an index `booking_bookings_hold_subject_idx` on `(tenant_id,
hold_subject_hash)`. Generate a migration from `@adminigloo/booking/schema` as
usual. Nothing needs backfilling.

## Not in 0.1

Appointment products, allowances, billing modes, multi-host collective sessions,
the AI brief, the thank-you and auto-complete email sequence, and OAuth calendar
providers. The `BusySource` seam is where an OAuth provider would plug in.
