---
"@adminigloo/create-app": minor
---

A generated `--scheduling` project is now a field-service booking system a
business can run, built from `@adminigloo/scheduling` 0.4 and
`@adminigloo/scheduling-widget` 0.1 with no code of its own beyond wiring.

**What a business gets**

- `/book-visit`: the booking page (`<VisitPicker>`), in the public nav and the
  sitemap. Customers pick a service, a day and a time in the business's own
  time zone, and leave their details. `?service=` and `?estimate=` work for
  links from elsewhere.
- `/visit/[token]`: the page behind the link in every customer email
  (`<ManageVisit>`): their visit in plain words, with reschedule and cancel up
  to the business's cutoff. Never indexed, no Referer, kept out of robots.txt.
- `/admin/schedule`: the day/week calendar per crew (`<ScheduleCalendar>`), with
  the request inbox, drag to move or reassign, and new visits by phone.
- `/admin/schedule/today`: today's route for a crew on a phone (`<CrewDay>`).
- `/admin/schedule/settings`: the time zone, services, notice, auto-confirm,
  request expiry, reminders, crews and hours (`<SchedulingSettings>`).
- With `--comms`: the acknowledgement, confirmation, reminder, moved,
  reassigned, declined, cancelled and expired emails, each with the customer's
  manage link, and notices to the office (`BOOTSTRAP_ADMIN_EMAIL` until the
  owner names addresses in Schedule settings).
- `/api/cron/scheduling`, scheduled in `vercel.json`: releases requests nobody
  answered in time and tells the customer.
- `GOOGLE_MAPS_API_KEY` (optional): Google geocoding and drive times, cached in
  the database; straight-line estimates without it. `SCHEDULING_TIME_ZONE`
  (optional) picks the zone the business starts in (America/Denver otherwise).

**Email actually sends with `--comms --email` (MN-04).** `src/server/comms-senders.ts`
is now generated: with `--email` it wires `createEmailSender` (Resend), and it
exports `commsEmailConfigured` so the booking page only promises an email a
deployment can send. Before, every `--comms --email` project shipped
`commsSenders = {}` and logged every message as skipped.

**The comms cron consults the features that queue messages.** The generated
`src/server/comms-hooks.ts` gives `runDueMessages` a `beforeSend` (scheduling
re-checks each reminder and puts a fresh manage link in it) and scrubs those
links from the delivery log after the run. The console's "send due now" uses
the same hooks.

**Breaking (0.x minor)**

- The tRPC `scheduling` router, `src/server/scheduling-policy.ts`,
  `src/server/scheduling-seed.ts` and the old `/admin/schedule` list page are
  gone. The widgets speak HTTP to the package's handlers at `/api/schedule`
  and `/api/admin/schedule`.
- Pins `@adminigloo/scheduling` `^0.4.0` and adds
  `@adminigloo/scheduling-widget` `^0.1.0`.
- `CRON_SECRET` is declared for scheduling as well as comms.
- The admin shell puts its sidebar below the page under the `md` breakpoint,
  so a phone shows the page first.

New capabilities: `scheduling.route` and `scheduling.reminders`.

**After the owner review:**

- `--scheduling --admin none` is refused, in plain words: nobody could answer a
  request. `--scheduling` brings `--comms` and `--email` unless declined.
- Reminders arrive the day before on Vercel Hobby's once-a-day cron:
  `vercel.json` and the listener's `reminderRuns` come from one constant. The
  next steps and DEPLOYMENT.md say when reminders really go out, and how to
  make them exact.
- One staff key per job (`staff.schedule.route`, `.view`, `.manage`,
  `.settings`) and a crew-only role. The owner picks a crew member by name in
  Schedule settings and they get today's route and nothing else, written to
  the audit log; no developer, no database.
- The staff screens are told whether email really goes out (sender, cron
  secret, failures this week, reminders overdue).
- Online booking starts off and nameless until the owner sets it up; the
  geocoder is biased to the US; the nine visit emails are in Messages from
  first boot; the comms cron scrubs sent links in a `finally`.
