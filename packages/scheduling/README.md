# @adminigloo/scheduling

Scheduling for a business whose people drive to the customer: window cleaners,
fitters, field techs. A customer picks a time on the business's website and
gets an email. The office sees the request on a calendar and accepts or
declines it. Staff drag a visit to a new time or give it to another crew, and
the customer is told. The customer gets a reminder, and can move or cancel the
visit from the link in their email, up to a cutoff. The crew opens today's
route on a phone. All of it runs in the business's own time zone.

Every function is scoped to a tenant (one business). This package is the
server: the functions, two HTTP handlers, and the emails (`./comms`). The
screens are `@adminigloo/scheduling-widget`. A project generated with
`create-adminigloo-app --scheduling` gets both, wired.

```
@adminigloo/scheduling          functions, types, permission keys, the two HTTP handlers (and the tables, re-exported)
@adminigloo/scheduling/schema   the drizzle pgTables
@adminigloo/scheduling/comms    the emails: confirmations, notices, the reminder (needs @adminigloo/comms)
```

Peers: `drizzle-orm` (^0.45) and `zod` (^3.25 or ^4; see [Install](#install)).
`@adminigloo/comms` is an optional peer, needed only for `./comms`.
No maps SDK and no date library: Google Maps is two plain `fetch` calls, and
time zones come from the runtime's own `Intl`.

It depends on `@adminigloo/db`, for three column helpers. Through it, npm also
installs `@adminigloo/env`, `@t3-oss/env-nextjs`, `uuidv7`, `ws` and the Neon
driver `@neondatabase/serverless` (a peer of `@adminigloo/db`; npm 7+ installs
it for you, Yarn classic doesn't, so add it there). Loading the package loads
`@adminigloo/db`, which sets the Neon driver's WebSocket class as it loads. That
is harmless in an app that never uses Neon.

## What each install gets you

| You install / import | You get | You wire yourself |
| --- | --- | --- |
| `@adminigloo/scheduling` + `./schema` | Crews ("resources") with weekly hours (several windows a day), time off, a daily cap and an online-booking switch. Business settings in the database: time zone, services, notice, horizon, auto-confirm, expiry, reminder, change cutoff. A **public** booking flow: the same times for every visitor, server-decided times and crew, requests that expire unanswered, a cap on how many one caller can have waiting, one transaction under a per-crew lock. Customer **manage links** (hashed tokens): view, move, cancel, up to a cutoff, and a `.ics`. **Staff** booking, moving, crew changes and detail edits, validated under the same locks. A **calendar** read model (range × crews) and a **crew day** (ordered stops, drive times, directions links). **Events** after every change. **Google Maps** (geocoding and drive times, cached) or keyless estimates. Two **HTTP handlers**, one public and one for staff. Permission keys. | The six tables in your schema, and a migration you generate and run. |
| `+ @adminigloo/scheduling/comms` (with `@adminigloo/comms`) | The emails: acknowledgement, confirmation with a manage link, declined, moved, new crew, cancelled, released, the reminder, and office notices (including "Request expired"). A reminder queued for the cron run before it is due and withdrawn when the visit moves or stops. No manage link is ever left in the delivery log. | Comms' three tables in the same migration. Your mail sender (any provider). Hand `onEvent` to the handlers, and run one cron route that calls `beforeSend`, `redactSent` and `expirePendingRequests` (see [The cron](#the-cron)). |
| `+ @adminigloo/scheduling-widget` | The screens: `<VisitPicker>` (booking page), `<ManageVisit>` (the customer's link), `<ScheduleCalendar>` (day and week, drag to move), `<CrewDay>` (today's route on a phone), `<SchedulingSettings>`. | Nothing beyond the two routes below. |
| `create-adminigloo-app --scheduling` | All of the above, wired, for one business. | — |

**In short, four steps:**

1. **Migrate:** the six scheduling tables, plus comms' three if you send emails
   (one config generates both, see [Schema and migration](#schema-and-migration)).
2. **Mount the two routes** (public and staff). Pass `onEvent` to both, and
   `authorize` (your permission check) to the staff route.
3. **Run the cron** at least daily (every 15 minutes if you can), and tell the
   email listener when it runs (`reminderRuns`).
4. **The owner opens Schedule settings once:** the business name, the time
   zone, a phone, the services, at least one crew with its hours, then "Take
   bookings online". Until then a business reads UTC, no crew and an optional
   address, so the booking page offers nothing or the wrong times. The
   calendar's banner (`GET status`) lists what's left.

### Not included

- **Recurring visit plans** (weekly cleaning, quarterly service). Book each visit.
- **A CRM record.** A visit stores the name, email, phone and address as typed.
  There is no contact id, no find-or-create, and no "my visits" account page.
- **SMS.** Every notice and reminder is email. `@adminigloo/comms` can send SMS,
  but scheduling ships no SMS templates.
- **Deposits and payments.**
- **A merge with `@adminigloo/booking`** (book-a-call). They are two engines with
  two calendars, so one person on both can be double-booked.
- **A multi-tenant create-app.** The handlers take `resolveTenant`; the generated
  app serves one business.
- **Two-way calendar sync** (Google or Outlook), or a crew `.ics` feed. Each
  customer gets a `.ics` for their own visit.
- **Route optimisation.** Stops are in time order, with no reordering
  suggestions.
- **Partial-day time off.** Time off is whole days; special hours for a day go
  through `setAvailability`.
- **Visits that cross midnight.** A visit ends by `24:00` on its own day.
- **Holds while the customer types.** The time is checked when they send the
  form, and a taken time recovers with "pick another".
- **A second reminder** (one hour before, say).
- **Job photos, checklists or signatures.**
- **A license gate.**
- Postgres only.

## Install

The package is private, published to GitHub Packages. Add the scope to your
project's `.npmrc` (commit this line, it holds no secret):

```
@adminigloo:registry=https://npm.pkg.github.com
```

Your token goes in your **user-level** `~/.npmrc`, never in the repo:

```
//npm.pkg.github.com/:_authToken=<a GitHub token with read:packages>
```

The same token covers `@adminigloo/db` and `@adminigloo/env`, which come with
this package.

**zod 3.25 or newer, or zod 4.** This package and `@adminigloo/db` both name
`zod ^3.25 || ^4` as a peer, so on zod 3.23 or 3.24 npm stops with `ERESOLVE`.
Bump zod first. It is a minor version for your own code:

```bash
npm install zod@^3.25          # only if you are on zod 3.23 or 3.24
```

Then:

```bash
npm install -E @adminigloo/scheduling@0.4.0   # -E pins exactly; without it npm saves ^0.4.0
npm install drizzle-orm@^0.45                 # if you don't have it; drizzle-orm 1.x (npm's beta tag) won't do
npm install @adminigloo/comms                 # only for the emails (@adminigloo/scheduling/comms)
```

**The types assume zod 4.** On zod 3.25 every function validates its input at
runtime exactly as on 4, but the input types are looser: an enum such as
`status` types as `unknown`, so `status: "teleported"` compiles and fails at
runtime with a `ZodError`. With `skipLibCheck: false`, tsc also reports errors
inside this package's `.d.ts` (`has no exported member 'core'`). Next's default
tsconfig sets `skipLibCheck: true`.

## Schema and migration

Six tables: `scheduling_resources`, `scheduling_availability`,
`scheduling_bookings`, `scheduling_drive_cache`, `scheduling_settings` (one row
per business) and `scheduling_visit_tokens` (hashed manage links). `tenant_id`
and `resource_id` are plain text with no cross-package foreign keys. The tenant
is whatever string you use for a business: a slug, or `String(brandId)`.

**With `./comms`, three more**, from `@adminigloo/comms/schema`, in the same
database: `comms_templates` (the nine visit emails, editable), `comms_messages`
(the delivery log) and `comms_scheduled` (the reminder queue). **Without them
no email is sent at all.** The listener says so through `onError` on every
event (`console.error` by default): "The @adminigloo/comms tables
(comms_templates, comms_messages, comms_scheduled) aren't in this database…".
Call `schedulingComms.verify()` at startup to hear it before the first customer
does.

**A drizzle host** spreads both schemas in and generates a migration as usual:

```ts
// src/db/schema.ts
export * from "@adminigloo/scheduling/schema";
export * from "@adminigloo/comms/schema";   // with ./comms
```

```bash
npx drizzle-kit generate   # then run it yourself (drizzle-kit migrate, or your deploy step)
```

**A host that doesn't use drizzle for its own tables** (Prisma owns the schema,
say) still needs these tables: six, or nine with `./comms`. **No `.sql` file
ships with the package yet.** Generate it from the schemas with drizzle-kit,
using a separate config that points only at the packages' schema entries:

```bash
npm install -D drizzle-kit@^0.31   # the drizzle-kit that pairs with drizzle-orm 0.45
```

```ts
// drizzle.scheduling.config.ts (not your app's config)
export default {
  dialect: "postgresql",
  schema: [
    "./node_modules/@adminigloo/scheduling/dist/schema.js",
    "./node_modules/@adminigloo/comms/dist/schema.js", // the emails' tables; leave out without ./comms
  ],
  out: "./scheduling-sql",
};
```

```bash
npx drizzle-kit generate --config drizzle.scheduling.config.ts
```

**Keep `scheduling-sql/` in your repo, `meta/` included.** drizzle-kit writes
each new migration as the difference from the snapshot in `meta/`. Delete the
folder and the next generate (for 0.4, say) is a full set of `CREATE TABLE`s
instead of the `ALTER`s your database needs.

Review the SQL and apply it as one of your own migrations.

**With Prisma**, apply it through Prisma's own history, in this order, so Prisma
never sees tables it doesn't know about:

1. `npx prisma migrate dev --create-only --name adminigloo_scheduling_0_4` makes
   an empty migration.
2. Paste the generated SQL (`scheduling-sql/0000_*.sql`) into that migration's
   `migration.sql`.
3. `npx prisma migrate deploy` applies it without comparing your schema.
4. `npx prisma db pull` adds the nine models to `schema.prisma` (six without
   `./comms`).
5. `npx prisma migrate dev` should now report that the schema is in sync.

Leave those models alone: the packages own their shape. For each upgrade,
generate the new SQL and repeat steps 1 to 4. In any other order it goes wrong:
`migrate dev` compares a `schema.prisma` without the models against a
database that has them and writes a migration that drops them, and SQL applied
outside Prisma's history (psql, a deploy script) shows up as drift, which
`migrate dev` offers to fix by resetting the database.

For reference, these are the tables as the package's own test suite creates them
from the drizzle schema. Use it for reading, not as your migration:

<details>
<summary>Reference DDL (0.4.0)</summary>

```sql
CREATE TABLE "scheduling_resources" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "name" text NOT NULL,
  "user_id" text,
  "home_base_address" text,
  "home_base_lat" double precision,
  "home_base_lng" double precision,
  "skills" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "work_start_time" text NOT NULL DEFAULT '08:00',
  "work_end_time" text NOT NULL DEFAULT '17:00',
  "max_jobs_per_day" integer NOT NULL DEFAULT 6,
  "hours_configured" boolean NOT NULL DEFAULT false,
  "accepts_public_bookings" boolean NOT NULL DEFAULT true,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX "scheduling_resources_tenant_idx" ON "scheduling_resources" ("tenant_id", "is_active");

CREATE TABLE "scheduling_availability" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "resource_id" text NOT NULL,
  "day_of_week" integer,
  "specific_date" timestamp with time zone,
  "start_time" text NOT NULL DEFAULT '08:00',
  "end_time" text NOT NULL DEFAULT '17:00',
  "is_available" boolean NOT NULL DEFAULT true,
  "note" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX "scheduling_availability_resource_idx" ON "scheduling_availability" ("resource_id");

CREATE TABLE "scheduling_bookings" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "resource_id" text,
  "service_type" text NOT NULL DEFAULT 'visit',
  "title" text,
  "customer_name" text,
  "customer_email" text,
  "customer_phone" text,
  "address" text,
  "lat" double precision,
  "lng" double precision,
  "scheduled_date" timestamp with time zone NOT NULL,
  "start_time" text NOT NULL,
  "end_time" text NOT NULL,
  "duration_minutes" integer NOT NULL DEFAULT 120,
  "status" text NOT NULL DEFAULT 'pending',
  "estimate_id" text,
  "notes" text,
  "requester_key" text,
  "starts_at" timestamp with time zone,
  "ends_at" timestamp with time zone,
  "origin" text NOT NULL DEFAULT 'staff',
  "sequence" integer NOT NULL DEFAULT 0,
  "pending_expires_at" timestamp with time zone,
  "cancelled_at" timestamp with time zone,
  "cancelled_by" text,
  "cancel_reason" text,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX "scheduling_bookings_tenant_date_idx" ON "scheduling_bookings" ("tenant_id", "scheduled_date");
CREATE INDEX "scheduling_bookings_resource_date_idx" ON "scheduling_bookings" ("resource_id", "scheduled_date");
CREATE INDEX "scheduling_bookings_tenant_starts_idx" ON "scheduling_bookings" ("tenant_id", "starts_at");
CREATE INDEX "scheduling_bookings_pending_expiry_idx" ON "scheduling_bookings" ("tenant_id", "status", "pending_expires_at");

CREATE TABLE "scheduling_drive_cache" (
  "id" text PRIMARY KEY,
  "origin_lat" double precision NOT NULL,
  "origin_lng" double precision NOT NULL,
  "dest_lat" double precision NOT NULL,
  "dest_lng" double precision NOT NULL,
  "duration_minutes" integer NOT NULL,
  "distance_miles" double precision NOT NULL,
  "fetched_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX "scheduling_drive_cache_key_idx" ON "scheduling_drive_cache" ("origin_lat", "origin_lng", "dest_lat", "dest_lng");

CREATE TABLE "scheduling_settings" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "time_zone" text NOT NULL DEFAULT 'UTC',
  "business_name" text NOT NULL DEFAULT '',
  "contact_email" text,
  "contact_phone" text,
  "staff_notify_emails" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "services" jsonb NOT NULL DEFAULT '[{"key":"visit","name":"Visit","durationMinutes":60}]'::jsonb,
  "slot_step_minutes" integer NOT NULL DEFAULT 30,
  "min_notice_minutes" integer NOT NULL DEFAULT 1440,
  "horizon_days" integer NOT NULL DEFAULT 30,
  "travel_buffer_minutes" integer NOT NULL DEFAULT 30,
  "max_slots_per_day" integer,
  "max_open_requests_per_requester" integer DEFAULT 3,
  "require_address" boolean NOT NULL DEFAULT false,
  "auto_confirm" boolean NOT NULL DEFAULT false,
  "public_booking_enabled" boolean NOT NULL DEFAULT true,
  "pending_expiry_hours" integer NOT NULL DEFAULT 48,
  "reminder_lead_hours" integer NOT NULL DEFAULT 24,
  "cancel_cutoff_hours" integer NOT NULL DEFAULT 24,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "scheduling_settings_tenant_idx" ON "scheduling_settings" ("tenant_id");

CREATE TABLE "scheduling_visit_tokens" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "visit_id" text NOT NULL,
  "token_hash" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "scheduling_visit_tokens_hash_idx" ON "scheduling_visit_tokens" ("token_hash");
CREATE INDEX "scheduling_visit_tokens_visit_idx" ON "scheduling_visit_tokens" ("tenant_id", "visit_id");

-- With ./comms: @adminigloo/comms 0.2's three tables.
CREATE TABLE "comms_templates" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "key" text NOT NULL,
  "channel" text NOT NULL DEFAULT 'email',
  "subject" text,
  "body" text NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "comms_templates_tenant_key_idx" ON "comms_templates" ("tenant_id", "key");

CREATE TABLE "comms_messages" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "channel" text NOT NULL,
  "to_address" text NOT NULL,
  "template_key" text,
  "subject" text,
  "body" text NOT NULL,
  "status" text NOT NULL,
  "error" text,
  "provider_id" text,
  "missing_vars" jsonb,
  "scheduled_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX "comms_messages_tenant_idx" ON "comms_messages" ("tenant_id", "created_at");
CREATE INDEX "comms_messages_recipient_idx" ON "comms_messages" ("tenant_id", "to_address", "template_key", "created_at");
CREATE INDEX "comms_messages_scheduled_idx" ON "comms_messages" ("scheduled_id");

CREATE TABLE "comms_scheduled" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "channel" text NOT NULL DEFAULT 'email',
  "to_address" text NOT NULL,
  "template_key" text NOT NULL,
  "vars" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "send_at" timestamp with time zone NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "ref_type" text,
  "ref_id" text,
  "dedupe_key" text,
  "min_interval_ms" bigint,
  "expires_at" timestamp with time zone,
  "attempts" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "claimed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX "comms_scheduled_due_idx" ON "comms_scheduled" ("status", "send_at");
CREATE INDEX "comms_scheduled_ref_idx" ON "comms_scheduled" ("tenant_id", "ref_type", "ref_id");
CREATE UNIQUE INDEX "comms_scheduled_dedupe_idx" ON "comms_scheduled" ("tenant_id", "dedupe_key") WHERE "comms_scheduled"."dedupe_key" is not null;
```

</details>

The `id` columns have **no database default**. The package generates a UUID v7
for each row it inserts, so write rows through its functions, not with raw
`INSERT`s.

## The database handle

Every function takes a drizzle Postgres handle (`SchedulingDb`, any
`PgDatabase`). The driver must support **interactive transactions**, because
bookings are validated and written in one transaction under an advisory lock.
`drizzle-orm/node-postgres`, `drizzle-orm/neon-serverless` (Pool) and PGlite all
do. `neon-http` doesn't.

An app that talks to Postgres through raw `pg` (or Prisma with the `pg` driver
adapter) makes a drizzle handle over the Pool it already has, just for these
calls:

```ts
// lib/scheduling-db.ts
import { drizzle } from "drizzle-orm/node-postgres";
import { pool } from "@/lib/pg"; // your existing node-postgres Pool

export const schedulingDb = drizzle(pool);
```

A Prisma app with no driver adapter has no Pool to reuse. Add `pg` and make one,
kept across hot reloads:

```bash
npm install pg && npm install -D @types/pg
```

```ts
// lib/scheduling-db.ts
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

// One pool per process. Next's dev server re-runs this module on every edit,
// and a new Pool each time leaks connections until Postgres refuses more.
const cache = globalThis as unknown as { schedulingPool?: Pool };
const pool = (cache.schedulingPool ??= new Pool({ connectionString: process.env.DATABASE_URL }));

export const schedulingDb = drizzle(pool);
```

## Concepts

**Resources** are the people or crews who go out: a name, an optional home base
(an address, geocoded when the maps provider can, or `homeBaseLat`/`homeBaseLng`),
skills, work hours, a daily cap (`maxJobsPerDay`), an optional `userId` (the
person whose phone shows this crew's route) and two switches:

- `acceptsPublicBookings` pauses online booking for that crew. Staff can still
  book it.
- `isActive` takes the crew off the schedule: `deactivateResource` hides it from
  the finders and `listResources`, and staff bookings and un-cancels onto it are
  refused (`resource_unavailable`). `reactivateResource` puts it back with its
  hours and switch as they were.

**Hours** are weekly rows plus dated rows, and a day may have several windows
(08:00–12:00 and 13:00–17:00, for a lunch break). For each day: a dated day off
wins; otherwise the dated special hours, if any, are the day; otherwise every
weekly row for that weekday. A visit must fit inside one window. A crew whose
hours were **never saved** (`hoursConfigured = false`) works Mon–Fri during its
work hours, so a new crew is bookable at once. `setAvailability` sets
`hoursConfigured`, and from then on the saved weekly rows are the whole week. A
weekday with no row is off, and saving an empty week turns the crew off every
day.

- `setAvailability(db, { …, scope: "weekly" })` replaces only the week, so the
  crew's days off survive. The default (`"all"`) is 0.3's full replace.
- `addTimeOff(db, { tenantId, resourceId, from, to, note })` adds whole days
  off (up to 62 at a time) and returns the visits already booked on them, so
  the screen can say "3 visits are booked on those days. Move them."
  `removeTimeOff` takes one back.
- `getAvailabilitySummary` is the hours screen's read: the saved week, what
  actually applies (the Mon–Fri default for a crew never configured), and the
  days off and special hours from today on.

**Times** are zero-padded 24-hour `HH:MM` text: `09:30`, not `9:30`, and never
`16:99`. An end or closing time may be `24:00` (midnight at the end of the day).
`timeOfDaySchema` and `endTimeSchema` are the checks, for your own forms.

**Slots** are offered on a grid (`slotStepMinutes`, default 30) inside each free
gap. The start right after a visit is also offered and scores a little higher,
so days still pack tightly. A crew at its daily cap offers nothing that day.

- The **staff** finder, `findAvailableSlots`, takes the job's address or
  coordinates and drops starts the crew can't drive to, or can't leave in time
  for the next job.
- The **public** finder, `findPublicSlots`, takes a service and no address. It
  keeps a fixed `travelBufferMinutes` (default 30) clear around every visit, so
  the list is the same for every visitor. The visitor's real drive is checked
  when they ask.
- A request nobody answers holds its time only until `pendingExpiryHours`
  after it was made (or its start, if sooner). From that instant the time is
  free again, before anything has flipped the request to `expired`;
  `expirePendingRequests` then flips it and the customer is told.

**Visits** move through `BOOKING_STATUS_TRANSITIONS`:

| From | May move to |
| --- | --- |
| `pending` | `confirmed`, `declined`, `cancelled`, `expired` (the system only) |
| `confirmed` | `in_progress`, `completed`, `cancelled`, `no_show` |
| `in_progress` | `confirmed`, `completed`, `cancelled` |
| `completed` | `in_progress` (reopen) |
| `cancelled` | `pending`, `confirmed`: the slot is re-validated first |
| `declined`, `expired` | `confirmed` (re-validated) |
| `no_show` | `confirmed` (re-validated), `cancelled` |

`cancelled`, `declined`, `expired` and `no_show` hold no time. Staff can't set
`expired`; `nextBookingStatuses(status)` (what a status menu should offer)
never offers it. Accepting a request whose deadline has passed is checked like
a restore, since its time may have been taken.

**Drive time** goes through a `MapsProvider` (see [Google Maps](#google-maps)).
`createHaversineMapsProvider()` is the keyless default; it sets
`geocodes: false` and `estimates: true`. `createCachedMapsProvider(real,
db)` caches a paid provider's answers in `scheduling_drive_cache` for a week.
Every writer looks drive times up **before** it takes a crew's lock, so a slow
provider never holds the crew up and the cache's own queries never run inside
the booking transaction.

**Refusals** are `BookingNotBookableError` with a `code`:

| Code | From | Means |
| --- | --- | --- |
| `slot_unavailable` | public and staff | Another visit is in the way: taken, overlapping, no time to drive, day full. The public request also says it for anything about the slot (unknown, paused crew, not on offer). Refetch and pick another time. |
| `too_soon`, `too_far` | public | Inside the notice, or past the horizon. |
| `invalid_duration` | public | A length the policy doesn't offer. |
| `address_unresolved` | public | The geocoding provider couldn't place the address, or the policy requires one and none came. |
| `too_many_requests` | public | This requester already has `maxOpenRequestsPerRequester` requests waiting. |
| `booking_closed` | public | The business has online booking off. |
| `unknown_service` | public | No such service. |
| `too_late` | customer link | Inside the change cutoff, or the visit is past or done. The message gives the business's phone. |
| `outside_hours` | staff | Not a working day, or outside the hours. |
| `invalid_window` | staff | The end isn't after the start, or the visit would run past midnight. |
| `resource_unavailable` | staff | No such crew in this tenant, or it was removed. |
| `not_changeable` | staff move | The visit's status doesn't allow a move (completed, in progress, cancelled…). |

A malformed input is a `ZodError`. `BookingStatusTransitionError` is a move the
status table doesn't allow.

## Time zones

Each business has one IANA time zone (`America/Denver`), saved in its settings.
Every visit is stored twice:

- as the business reads it: a calendar date (`scheduled_date`, the date's UTC
  midnight, a label) and `HH:MM` wall-clock times. The crew's day, the hours
  check and the calendar are built from these.
- as instants: `starts_at` and `ends_at`, that wall clock read in the
  business's zone. Notice, the change cutoff, reminders and expiry are measured
  against them.

So a 24-hour notice is 24 real hours, on the weekend the clocks change too. At
Saturday 10:00 MDT before the November fall-back, Sunday 09:00 MST is offered
and 08:30 isn't. "Today" is the business's today: at 20:00 in Denver it is
still today, though UTC has rolled over. 0.3 read every day in UTC, so for a
business at UTC−7 the notice behaved like 17 or 31 hours.

A wall time inside the spring-forward gap resolves forward (02:30 becomes 03:30
MDT); one inside the repeated fall-back hour is the earlier of the two. Crews
rarely start at 2 am, but the rule is fixed. The zone helpers (`zone.ts`) are
the same code as `@adminigloo/booking`'s.

**Changing the zone keeps every visit at its wall-clock time.** Those times are
what the customer was shown. Every pending, confirmed and in-progress visit gets
new instants in the new zone and a new `sequence`, and the upcoming ones emit a
quiet `visit.rescheduled` (`via: "time_zone"`, `notify: false`), so reminders
are re-queued and nobody is emailed. This is also the upgrade path from 0.3:
set the zone once.

`visitInstants(date, start, end, zone)`, `instantsOf(row, zone)` and
`todayIn(now, zone)` are exported for your own code.

## Settings

One `scheduling_settings` row per business. A business that never saved any
reads the defaults (`saved: false`), with the zone `UTC`, which is 0.3's
behaviour.

| Setting | Default | Range | Means |
| --- | --- | --- | --- |
| `timeZone` | `UTC` | an IANA zone | Every visit's wall clock is read in it. |
| `businessName` | `""` | ≤ 120 | Signs the emails; titles the `.ics`. |
| `contactEmail`, `contactPhone` | none | email; ≤ 40 | Shown to customers, in emails and in the "too late" message. |
| `staffNotifyEmails` | `[]` | ≤ 5 | Who gets "New request", "Visit moved" and "Visit cancelled". |
| `services` | `[{ key: "visit", name: "Visit", durationMinutes: 60 }]` | 1–20 | What a customer books: key, name, 15–720 minutes (multiple of 5), description, required skill. |
| `slotStepMinutes` | 30 | 5–240, ×5 | The grid of offered starts. |
| `minNoticeMinutes` | 1440 | 0–43200 | Earliest start, from now. |
| `horizonDays` | 30 | 1–365 | Latest start, from now. |
| `travelBufferMinutes` | 30 | 0–240 | Kept clear around every visit in the public offer. |
| `maxSlotsPerDay` | none | 1–100 | Offer only the best few starts a day. |
| `maxOpenRequestsPerRequester` | 3 | 1–50, or none | Requests one caller may have waiting. |
| `requireAddress` | false | | Refuse a request with no address. |
| `autoConfirm` | false | | On: requests land confirmed. Off: someone accepts each one. |
| `publicBookingEnabled` | true | | Off: no times are offered and no requests taken. Customers can still cancel. |
| `pendingExpiryHours` | 48 | 1–720 | An unanswered request is released after this (or at its start, if sooner). |
| `reminderLeadHours` | 24 | 0–168 | The reminder goes this long before a confirmed visit. 0: no reminder. |
| `cancelCutoffHours` | 24 | 0–168 | Customers can move or cancel online until this long before. 0: up to the start. |

```ts
import { getSchedulingSettings, updateSchedulingSettings } from "@adminigloo/scheduling";

const settings = await getSchedulingSettings(db, tenantId);              // never writes
await updateSchedulingSettings(db, tenantId, { timeZone: "America/Denver", autoConfirm: true });
```

A patch changes only the keys it names and drops unknown ones. A refusal is a
`ZodError` whose issues name the field ("Pick a time zone from the list.").

**Policy precedence.** The public functions run on the defaults, then the
settings, then any fields a 0.3 caller still passes in `options.policy`. A 0.3
caller keeps its numbers; the zone always comes from settings. A business that
never saved settings, called the 0.3 way with `durationMinutes`, also keeps
0.3's default lengths (30 to 240 minutes).

## HTTP handlers

Two factories, each one `handle(req)` routed by path suffix, so they mount at
any base with a catch-all route. Both answer `Cache-Control: no-store`, accept
JSON bodies up to 20,000 characters (`text/plain` too), and answer errors as
`{ error: { code, message, issues? } }`. `issues` name the fields and never
echo what was sent.

```ts
// app/api/schedule/[...path]/route.ts — the customer's side
import { createSchedulingHandlers, selectMapsProvider } from "@adminigloo/scheduling";

const { handle } = createSchedulingHandlers({
  db,
  tenantId: "acme",                                    // or resolveTenant: (req) => …
  manageUrl: (token) => `https://acme.com/visit/${token}`,
  maps: selectMapsProvider({ googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY, db }),
  onEvent: schedulingComms.onEvent,                    // the emails (see Emails)
  emailsEnabled: mailerConfigured,                     // true only when your sender really sends (see below)
  rateLimit: allow,                                    // below
  // requesterKey: createClientIpKey({ trustProxy: 2 }), // only behind two proxies (see "Who is asking")
});
export { handle as GET, handle as POST, handle as OPTIONS };

// A rate limit per caller and bucket ("read" | "request" | "manage"). This one
// counts in one process's memory: right for one server. Behind several
// instances, count in Redis or Upstash with the same limits.
const LIMITS = { read: [120, 60_000], request: [5, 3_600_000], manage: [30, 3_600_000] } as const;
const hits = new Map<string, { count: number; resetAt: number }>();
function allow(req: Request, bucket: keyof typeof LIMITS): boolean {
  const caller = clientIpKey(req);                     // from @adminigloo/scheduling
  if (!caller) return true;                            // no proxy headers: a laptop, a test
  const [limit, windowMs] = LIMITS[bucket];
  const key = `${bucket}:${caller}`;
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || entry.resetAt <= now) {
    if (hits.size > 50_000) hits.clear();              // never grow without bound
    hits.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  entry.count += 1;
  return entry.count <= limit;
}
```

**`emailsEnabled`** tells the booking page whether to say "We've emailed you".
It defaults to true only when `onEvent` is given. Pass false while the
listener is wired but the sender isn't (no mail credentials yet), so customers
are shown the manage link to keep instead. Base it on your own sender, not on
one provider's key: an SMTP host that keyed it on `RESEND_API_KEY` sent real
emails while the page said none would come.

| Route | Rate bucket | Answers |
| --- | --- | --- |
| `GET {base}/v1/config` | read | The business's name, zone, services, notice, horizon, cutoff, contacts, `emailsEnabled`, `minFillMs`. |
| `GET {base}/v1/slots?service=&from=&days=&manage=` | read | The times on offer (`days` ≤ 31, default 14; `from` defaults to today in the business's zone). `closed: true` when online booking is off. |
| `POST {base}/v1/request` | request | 201 with the visit, its manage token and link. 200 with `repeated: true` for a double click, with no token (the first answer carried it). |
| `GET {base}/v1/visit/:token` | read | The customer's visit. |
| `POST {base}/v1/visit/:token/reschedule` | manage | `{ slotId }` from `slots?manage=token`. |
| `POST {base}/v1/visit/:token/cancel` | manage | `{ reason? }`. |
| `GET {base}/v1/visit/:token/ics` | read | `visit.ics`, PUBLISH (or CANCEL once it's off). |

Routes with a token in the URL also send `Referrer-Policy: no-referrer` and
`X-Robots-Tag: noindex`. The request form carries a hidden `website` field and
how long the form was open (`fillMs`): a filled hidden field, or a form sent
faster than `minFillMs` (default 2000 ms), is `spam_suspected` before any
database work. A POST a browser sent from another site is refused 403 unless
`cors` names that origin.

**Server callers.** Node's built-in `fetch` sends `Sec-Fetch-Mode`, so a POST
from a server (an integration test, a backend route that forwards, a GitHub
Actions step) looks like a browser that won't say where it came from, and is
refused 403 "This request came from another site". Send `Origin` set to the
site the handler runs on (`Origin: https://acme.com`), or call the functions
directly. curl sends neither header and passes.

**Who is asking.** The per-caller cap and the double-click check key on
`requesterKey`, by default `clientIpKey`: the **last** `X-Forwarded-For` entry,
the address your nearest proxy saw. That is right on Vercel and behind one
proxy that appends to the header (nginx's `$proxy_add_x_forwarded_for`,
Render, Fly, Heroku). Behind two (a CDN in front of nginx) pass
`requesterKey: createClientIpKey({ trustProxy: 2 })`. **With no proxy in
front at all, every header is the client's own**: key on your platform's
socket address instead, and rate-limit at the edge. The first entry is never
used: a script sets it to whatever it likes, and keyed on it each made-up
address passed the cap.

```ts
// app/api/admin/schedule/[...path]/route.ts — the staff side
import { createSchedulingAdminHandlers } from "@adminigloo/scheduling";

const { handle } = createSchedulingAdminHandlers({
  db,
  tenantId: "acme",
  maps,
  onEvent: schedulingComms.onEvent,
  // Your auth. false → 403; a Response (your 401) is returned as is; { userId } passes.
  // Check the permission it asks for: a crew member's login must not reach settings.
  authorize: async (req, permission, tenantId) => {
    const user = await currentUser(req);
    if (!user) {
      return Response.json({ error: { code: "forbidden", message: "Sign in to see the schedule." } }, { status: 401 });
    }
    return can(user, permission, tenantId) ? { userId: String(user.id) } : false; // String(): integer ids too
  },
  // Optional, each one a screen that stops needing a developer:
  delivery: () => myDeliveryStatus(),                  // is email really going out? the calendar's banner
  listPeople: async () => (await listStaffUsers()).map((u) => ({ userId: String(u.id), name: u.name, email: u.email })),
  onCrewMemberChange: async (change) => grantRouteAccess(change.userId, change.previousUserId),
});
export { handle as GET, handle as POST, handle as OPTIONS };
```

The widget shows any 401 as "You've been signed out. Sign in again to keep
working.", so a dispatcher whose session ran out mid-day knows what to do
(a login page your middleware redirects to reads the same).

- **`delivery(tenantId)`** returns a `DeliveryStatus`: `{ customerEmails,
  customerEmailsOffReason?, reminders, remindersOffReason?, reminderRuns?,
  problems? }`. The calendar and settings show it as a banner in plain words,
  and with `customerEmails: false` no screen offers "Email the customer".
  Without it, emails and reminders count as on exactly when `onEvent` is given.
- **`listPeople`** turns "who opens this crew's route" in Schedule settings
  into a list of names instead of a box asking the owner for a user id.
- **`onCrewMemberChange(change)`** runs after the owner picks (or clears) a
  crew's person: `{ tenantId, resource, userId, previousUserId, changedBy }`.
  Give that person their route there (create-app grants a crew-only role).

Every staff route is under `{base}/v1/admin/` and asks `authorize` for exactly
one permission:

| Route | Permission |
| --- | --- |
| `GET crew-day?date=&resource=` (their own crew's day; another crew's also needs `schedule.view`), `POST visits/:id/progress` `{ status, note? }` (Start `in_progress`, Done `completed`, Couldn't do it `no_show` with a note, Undo `confirmed`; another crew's stop also needs `schedule.manage`) | `schedule.route` |
| `GET calendar?from=&to=&resources=a,b&include=inactive`, `GET status` (the banner: emails, reminders, setup left), `GET suggest?service=&minutes=&address=&lat=&lng=&from=&days=&resource=`, `GET visits/:id`, `GET settings`, `GET resources`, `GET resources/:id/availability` | `schedule.view` |
| `POST visits`, `POST visits/:id/accept`, `…/decline`, `…/status`, `…/reschedule`, `…/assign`, `…/details`, `POST expire` | `schedule.manage` |
| `POST settings`, `GET people`, `POST resources`, `POST resources/:id`, `…/deactivate`, `…/reactivate`, `POST resources/:id/availability` (the week), `POST resources/:id/time-off`, `POST resources/:id/time-off/:id/remove` | `schedule.resources.manage` |

The staff API never sends CORS headers. `crew-day` without `resource` shows the
signed-in person's crew (the crew whose `userId` is theirs, compared as text,
or your `currentResourceId`). Progress tells the customer nothing. `suggest`
is the one route that returns other customers'
addresses (the job before each gap), which is why it is staff-only. The
request and calendar routes also release overdue requests, at most once a
minute per business.

Status codes: `invalid`, `spam_suspected`, `too_soon`, `too_far`,
`invalid_duration`, `unknown_service`, `address_unresolved`, `outside_hours`,
`invalid_window`, `resource_unavailable` → 400; `forbidden`, `booking_closed` →
403; `not_found` → 404; `slot_unavailable`, `too_late`, `not_changeable`,
`transition_not_allowed` → 409; `rate_limited`, `too_many_requests` → 429;
anything unexpected → 500 `internal` with a fixed message.

## Customer links

When a customer asks for a visit, the receipt carries a **manage token**: the
key to that one visit, with no account. Only its SHA-256 is stored. Every email
that carries a link mints its own token (`issueManageToken`), and every token
for a visit keeps working, so a confirmation sent a day later still has a link.

```ts
getVisitByToken(db, tenantId, token)                         // PublicVisit | null
rescheduleVisitByToken(db, tenantId, token, { slotId })      // a slot from findPublicSlots({ manageToken })
cancelVisitByToken(db, tenantId, token, { reason })
```

- A customer can move or cancel a pending or confirmed visit until
  `cancelCutoffHours` before it starts. After that it is `too_late`, and the
  message gives the business's phone: "This visit starts within 24 hours, so
  it can't be changed online. Call us at (801) 555-0143." A crew plans its day
  the evening before; a same-morning cancel is a lost slot.
- `findPublicSlots({ manageToken })` offers the visit's own length and leaves
  the visit itself out, so the customer can move to the time right next to it.
- The same visit row moves, so its links keep working, and `sequence` goes up
  (the `.ics` updates instead of duplicating). A request moved is still a
  request.
- With online booking off, customers can still cancel, but not move.
- A request nobody answered by its deadline can't be moved or cancelled online
  even before the cron releases it: "This request wasn't confirmed in time, so
  it can't be changed online. Please book a new time." Moving it would hold no
  time while somebody else booked the slot.
- Correcting a customer's email (`updateBookingDetails`) revokes every link
  sent to the old address.
- A token that opens nothing, another business's token and a junk one all
  answer the same `null` (404 over HTTP).

## Staff moves

```ts
await bookVisit(db, { tenantId, resourceId, scheduledDate: "2026-11-02", startTime: "09:00", endTime: "10:00", address }, { maps });
await rescheduleBooking(db, tenantId, { id, date: "2026-11-03", startTime: "10:00", resourceId? });
await assignBooking(db, tenantId, { id, resourceId });
await updateBookingDetails(db, tenantId, { id, patch: { address: "12 Oak St", notes: "Gate code 1234" } });
```

- Dates and times are the business's wall clock. Each returns `{ visit,
  warnings }` (a tight drive, an address the map couldn't place), or null when
  the visit isn't this business's.
- Only pending and confirmed visits move (`not_changeable` otherwise, "This
  visit is completed, so it can't be moved."). The slot is checked against the
  target crew under the locks of both crews; a clash names it ("Overlaps
  10:00–12:00").
- A move bumps `sequence` and emits `visit.rescheduled`; a crew change alone
  emits `visit.reassigned` and doesn't; nothing changed emits nothing.
  `assignBooking` also gives an unassigned visit a crew.
- A details edit never refuses: an address that makes the drive impossible is
  recorded with a "Heads up" warning. Any status can be edited.
- **A corrected email address re-sends the visit.** Every manage link the
  visit has is revoked and `sequence` goes up (the old reminder is skipped),
  then the confirmation (or, for a request, the acknowledgement) goes to the
  new address with a fresh link, and the reminder is queued there (`via:
  "contact"`). Pass `notify: false` to change it quietly.
- Refusals read as the office would say them: "Crew A doesn't work on
  Saturday, March 7", "Crew A already has a visit 1:00 PM – 3:00 PM", "Not
  enough time to drive from the 8:00 AM visit (…)".
- `setBookingStatus` keeps its 0.3 signature and takes a `reason` for a
  decline or cancel.

## Events

Every change emits one event, after the transaction commits. Pass `onEvent`
to any writer, or to the handlers.

```ts
interface SchedulingEvent {
  id: string;                 // unique per event: use it as an idempotency key
  type: "visit.requested" | "visit.confirmed" | "visit.declined" | "visit.rescheduled" | "visit.reassigned"
      | "visit.cancelled" | "visit.expired" | "visit.started" | "visit.completed";
  tenantId: string; visitId: string; occurredAt: string;
  actor: { type: "customer" | "staff" | "system"; id: string | null };
  data: { visit: VisitSnapshot; notify: boolean; via?: string; previous?: {...}; reason?: string | null };
}
```

- **After commit.** A read inside the listener sees the new state; a refused
  write tells nobody.
- **Awaited, in order.** A serverless response doesn't end before the email is
  queued. An auto-confirmed request emits `visit.requested`, then
  `visit.confirmed`.
- **Contained.** A listener that throws never fails the action;
  `onEventError(error, event)` hears about it.
- **No secrets.** No manage token, token hash or requester key is ever in an
  event. Events are safe to log or queue.
- `notify` is true for what the customer should hear about, false for
  `started`/`completed` and time-zone moves. Staff mutations can pass it.
  A zone change can tell customers the corrected time:
  `updateSchedulingSettings(db, tenantId, { timeZone }, { onEvent, notify: true })`
  (the settings screen offers it as "Email those customers the corrected time").
- `data.addressUnverified` is true on a request the customer sent with an
  address the map couldn't find; the office notice says so.

## Emails (`./comms`)

```ts
// src/server/scheduling.ts
import type { CommsSenders } from "@adminigloo/comms";
import { createSchedulingCommsListener } from "@adminigloo/scheduling/comms";
import { sendMail } from "./mailer";                   // yours: Resend, SMTP, anything (below)

// Your senders. @adminigloo/comms exports the type, not an instance: you build
// it from your own mailer.
export const mySenders: CommsSenders = { email: sendMail };

export const schedulingComms = createSchedulingCommsListener({
  db,                                                  // the comms tables live in the same database
  senders: mySenders,
  manageUrl: (token) => `${APP_URL}/visit/${token}`,
  bookUrl: `${APP_URL}/book`,                          // "pick another time"
  adminUrl: `${APP_URL}/admin/schedule`,
  reminderRuns: { everyMinutes: 15 },                  // when your cron runs: see The cron
  onError: (error, context) => logger.error({ error, ...context }, "visit email failed"), // default: console.error
});

// At startup, or in a health check: throws a plain sentence when the comms
// tables are missing, instead of the first customer finding out.
await schedulingComms.verify();
```

### Any mail provider

The sender is one function: an `OutboundEmail` (`to`, `subject`, `body` as
plain text, `html`, `idempotencyKey?`) in, the provider's id out. A throw is
logged as a failed send. SMTP through nodemailer:

```ts
// src/server/mailer.ts
import nodemailer from "nodemailer";
import type { OutboundEmail } from "@adminigloo/comms";

const transport = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: 587,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  // Short timeouts: a relay that accepts the connection and never answers
  // would otherwise hold each send for minutes.
  connectionTimeout: 5_000,
  greetingTimeout: 5_000,
  socketTimeout: 10_000,
});

export async function sendMail(message: OutboundEmail) {
  const info = await transport.sendMail({
    from: process.env.MAIL_FROM,
    to: message.to,
    subject: message.subject,
    text: message.body,
    html: message.html,
  });
  return { messageId: info.messageId };
}
```

With Resend it is `email: (m) => resend.emails.send({ from, to: m.to, subject:
m.subject, text: m.body, html: m.html }, { idempotencyKey: m.idempotencyKey })`.

The customer's emails are sent inside the request that caused them (the
booking, the office's accept), so the page can say "we've emailed you" and
mean it. Each send may hold that request up for at most `sendTimeoutMs`
(default 10 seconds); past it the request answers, the send finishes in the
background, and `onError` hears about it. Office notices go out in parallel.

### The cron

Reminders, expiry notices and releasing unanswered requests all run from one
route. Run it at least once a day; every 15 minutes if you can.

```ts
// app/api/cron/scheduling/route.ts
import { runDueMessages } from "@adminigloo/comms";
import { expirePendingRequests } from "@adminigloo/scheduling";

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Not found", { status: 404 });
  }
  const expired = await expirePendingRequests(db, tenantId, { onEvent: schedulingComms.onEvent });
  try {
    const sent = await runDueMessages(db, mySenders, {
      beforeSend: async (row) => (await schedulingComms.beforeSend(row)) ?? "send",
    });
    return Response.json({ expired: expired.expired, sent });
  } finally {
    // In a finally: a run that throws part-way must not leave the links it
    // already sent readable in the delivery log.
    await schedulingComms.redactSent();
  }
}
export const POST = GET;
```

Then call it on a schedule, with the secret, and tell the listener when
(`reminderRuns`):

- **Vercel**: a `crons` entry in `vercel.json` (Vercel sends the secret
  itself). Hobby runs it once a day: `"schedule": "0 14 * * *"` with
  `reminderRuns: { dailyAtUtc: "14:00" }`. Pro can run it every 15 minutes.
- **Any server**: `*/15 * * * * curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" https://acme.com/api/cron/scheduling`
- **GitHub Actions** (runs late at busy times, sometimes by 15 minutes or
  more; the reminder's hour of margin before the change cutoff absorbs it):

  ```yaml
  on:
    schedule:
      - cron: "*/15 * * * *"
  jobs:
    tick:
      runs-on: ubuntu-latest
      steps:
        - run: curl -fsS -X POST -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}" https://acme.com/api/cron/scheduling
  ```

`reminderRuns` is `{ dailyAtUtc: "HH:MM" }` or `{ everyMinutes: n }`. Each
reminder is queued for the last run at or before its time, so it arrives at
least the lead time ahead. Without it, a reminder is queued for the exact
instant, which only a frequent cron honours: on a daily cron a 9 AM reminder
went out at the next run, the morning of the visit.

| Event | The customer gets | The office gets | The reminder |
| --- | --- | --- | --- |
| requested (waiting) | "We got your request" + link | "New request" | — |
| requested (auto-confirmed) | (the confirmation, next) | "New booking" | — |
| confirmed | "Confirmed" + link | — | queued |
| declined | "We can't make …" | — | withdrawn |
| rescheduled | "New time" + link | "Visit moved", when the customer moved it | withdrawn, re-queued |
| reassigned | "Update to your …" + link | — | kept |
| cancelled | "Cancelled" | "Visit cancelled", when the customer cancelled | withdrawn |
| expired | "We couldn't confirm … in time" | "Request expired": nobody answered it | withdrawn |

- The nine templates are inserted once per business if absent (keys
  `visit_requested` … `visit_staff_notice`), so the owner can edit them in the
  comms admin and the package never overwrites the edit. They speak as the
  business, in its time zone: "Monday, November 2, 2026, 9:00 – 10:00 AM MST".
- **No manage link stays in the delivery log.** An email sent now carries a
  fresh link, and right after the send that log row is rewritten with
  `:token` in its place. The reminder is queued without a link; `beforeSend`
  adds one at send time, and `redactSent()` scrubs it after the run.
- The reminder goes `reminderLeadHours` before a confirmed visit (on the cron
  run before that, with `reminderRuns`), and never later than an hour before
  the change cutoff, so the "reschedule or cancel" link in it still works
  when it arrives. The subject says "Reminder", never "tomorrow".
- `beforeSend` renders the reminder from the visit as it is at send time: a
  corrected email, address or service name is what goes out. It skips it if
  the visit was cancelled, moved since it was queued, has no email any more,
  or reminders were switched off (lead 0) since. A reminder that arrives
  inside the change cutoff anyway (a cron that stopped for a day) offers the
  phone number instead of a link that can't change anything.
- Anything a customer typed (name, address, notes) is shown with web
  addresses broken (`evil[.]example`), so the booking form can't be used to
  send links from the business's address.
- Each step (withdraw, each send, queueing) is isolated: a mail server that is
  down never fails a booking, and never leaves a stale reminder. Each failure
  is reported through `onError` (`console.error` when you pass none); none is
  ever silent.
- `schedulingEmailVars(event, settings, { manageUrl })` gives the variables, for
  a host with its own mailer.

## Google Maps

```ts
import { selectMapsProvider } from "@adminigloo/scheduling";

const maps = selectMapsProvider({ googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY, db });
```

- With a key and a database: Google, with drive times cached in
  `scheduling_drive_cache` for a week. With a key only: Google, uncached.
  Without a key: straight-line estimates at 30 mph, and no geocoding.
- In the Google Cloud console, enable the **Geocoding API** and the **Distance
  Matrix API**. Restrict the key to those two APIs, and to your server. It is a
  server key: it never goes to a browser, and no error message, log line or
  `onError` payload ever contains it.
- Addresses are geocoded when a customer asks for a visit, when staff book or
  edit one, and for a crew's home base. "No such place" refuses a customer's
  request (`address_unresolved`); Google being down books it without
  coordinates. Staff get a warning instead.
- Drive times score the staff suggestions (a job next door ranks the slot after
  the morning visit higher), check that a crew can get from one visit to the
  next, and fill in the crew's route. `estimated: true` marks straight-line
  numbers.
- `createGoogleMapsProvider({ apiKey, timeoutMs, region, components,
  departureTime: "now", onError })` for more control. No SDK and no new
  dependency: two `fetch` calls.

## Staff calls, tenant-scoped

Every by-id function takes the tenant and filters on it. Another tenant's id is
"not found" (`null`, `false` or `[]`), never an edit. Pass the tenant from your
session, never from the request body.

### From a tRPC router

```ts
import {
  createResource, createResourceSchema, deactivateResource, listAvailability, listBookings,
  listResources, nextBookingStatuses, setAvailability, setAvailabilitySchema, setBookingStatus,
  setBookingStatusSchema, updateResource, updateResourceSchema, BookingNotBookableError,
  BookingStatusTransitionError,
} from "@adminigloo/scheduling";
import { z } from "zod";
// createTRPCRouter, requireTenant, TRPCError and db come from your app; ctx.tenant is the signed-in tenant.

export const scheduleRouter = createTRPCRouter({
  bookings: requireTenant("schedule.view")
    .input(z.object({ from: z.coerce.date(), to: z.coerce.date() }))
    .query(async ({ ctx, input }) =>
      (await listBookings(db, ctx.tenant.id, input)).map((b) => ({ ...b, nextStatuses: nextBookingStatuses(b.status) })),
    ),

  setStatus: requireTenant("schedule.manage")
    .input(setBookingStatusSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        // onEvent: the customer's "Confirmed" email and the reminder. Without
        // it the visit changes and nobody is told.
        return {
          ok: await setBookingStatus(db, ctx.tenant.id, input, {
            onEvent: schedulingComms.onEvent,
            actor: { type: "staff", id: String(ctx.user.id) },
          }),
        };
      } catch (error) {
        if (error instanceof BookingStatusTransitionError) throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
        if (error instanceof BookingNotBookableError) {
          // slot_unavailable: somebody took the time since. The rest won't change on a retry.
          throw new TRPCError({ code: error.code === "slot_unavailable" ? "CONFLICT" : "BAD_REQUEST", message: error.message });
        }
        throw error;
      }
    }),

  resources: requireTenant("schedule.view").query(({ ctx }) => listResources(db, ctx.tenant.id)),
  createResource: requireTenant("schedule.resources.manage")
    .input(createResourceSchema.omit({ tenantId: true }))
    .mutation(({ ctx, input }) => createResource(db, { ...input, tenantId: ctx.tenant.id })),
  updateResource: requireTenant("schedule.resources.manage")
    .input(z.object({ id: z.string(), patch: updateResourceSchema }))
    .mutation(({ ctx, input }) => updateResource(db, ctx.tenant.id, input.id, input.patch)),
  removeResource: requireTenant("schedule.resources.manage")
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => deactivateResource(db, ctx.tenant.id, input.id)),
  hours: requireTenant("schedule.view")
    .input(z.object({ resourceId: z.string() }))
    .query(({ ctx, input }) => listAvailability(db, ctx.tenant.id, input.resourceId)),
  setHours: requireTenant("schedule.resources.manage")
    .input(setAvailabilitySchema.omit({ tenantId: true }))
    .mutation(async ({ ctx, input }) => ({ ok: await setAvailability(db, { ...input, tenantId: ctx.tenant.id }) })),
});
```

### From a Next.js server action (an app with its own auth)

No tRPC and no AdminIgloo auth needed. The tenant here is the signed-in user's
brand, and user ids can be integers. `userId` on a resource is text, so pass
`String(user.id)`.

```ts
// app/(staff)/schedule/actions.ts
"use server";

import { revalidatePath } from "next/cache";
import {
  createBooking, createBookingSchema, setBookingStatus, BookingNotBookableError,
  BookingStatusTransitionError,
} from "@adminigloo/scheduling";
import { schedulingDb } from "@/lib/scheduling-db";
import { requireStaffUser } from "@/lib/auth"; // your own session check

export async function confirmVisit(visitId: string) {
  const user = await requireStaffUser();     // throws if not signed in / not staff
  const tenantId = user.brandSlug;           // e.g. "ridgeline-north"
  try {
    // onEvent sends the customer's confirmation and queues the reminder.
    const ok = await setBookingStatus(
      schedulingDb,
      tenantId,
      { id: visitId, status: "confirmed" },
      { onEvent: schedulingComms.onEvent, actor: { type: "staff", id: String(user.id) } },
    );
    if (!ok) return { error: "Visit not found." };   // not this brand's visit
  } catch (error) {
    // An illegal move, or a cancelled visit whose slot was taken since.
    if (error instanceof BookingStatusTransitionError || error instanceof BookingNotBookableError) {
      return { error: error.message };
    }
    throw error;
  }
  revalidatePath("/schedule");
  return { ok: true };
}

export async function bookByPhone(form: FormData) {
  const user = await requireStaffUser();
  const field = (name: string) => String(form.get(name) ?? "");
  // Check the form before booking: "9:00" (not zero-padded) or an empty date is
  // a ZodError, which a server action would otherwise turn into an error page.
  const input = createBookingSchema.omit({ tenantId: true }).safeParse({
    resourceId: field("resourceId") || null,
    scheduledDate: field("date"),       // "2026-03-04": a date in the business's zone
    startTime: field("start"),          // "10:00": 24-hour, zero-padded
    endTime: field("end"),              // "11:30"
    customerName: field("name"),
    customerPhone: field("phone"),
  });
  if (!input.success) return { error: "Check the form. Times are HH:MM, like 09:30." };
  // Without a crew the visit is written unassigned and unchecked (assignBooking gives it one later).
  if (!input.data.resourceId) return { error: "Pick a crew." };
  try {
    // Staff choose the times; the slot is still checked (hours, overlap, drive buffer,
    // daily cap) under the crew's lock.
    await createBooking(schedulingDb, { ...input.data, tenantId: user.brandSlug }, { onEvent: schedulingComms.onEvent });
  } catch (error) {
    if (error instanceof BookingNotBookableError) return { error: error.message };
    throw error;
  }
  revalidatePath("/schedule");
  return { ok: true };
}
```

## The public flow

**Most apps mount `createSchedulingHandlers` and the `<VisitPicker>` widget**
(see [HTTP handlers](#http-handlers)); the handler does everything below. This
section is for a host that writes its own public routes.

**A public route must use `findPublicSlots` and `requestPublicBooking`, and
nothing else.** `findAvailableSlots` is for staff. Its `ScoredSlot`s name the
crew and carry `previousJobAddress`, which is the street address of the
customer before. Return those from an anonymous endpoint and you publish your
customers' home addresses. `PublicSlot` is `{ slotId, date, startTime, endTime }`
and nothing more.

```ts
// app/api/schedule/[tenant]/route.ts: an anonymous endpoint
import {
  findPublicSlots, requestPublicBooking, requestPublicBookingSchema, clientIpKey,
  createHaversineMapsProvider, BookingNotBookableError, type PublicBookingPolicy,
} from "@adminigloo/scheduling";
import { schedulingDb } from "@/lib/scheduling-db";
import { schedulingComms } from "@/server/scheduling"; // the emails (see Emails)

const maps = createHaversineMapsProvider();
// The SAME policy for both calls, so what is offered and what is accepted agree.
const policy: PublicBookingPolicy = {
  minNoticeMinutes: 24 * 60,       // nothing sooner than a day out
  horizonDays: 30,
  slotStepMinutes: 30,
  durationsMinutes: [60, 120],     // the visit lengths your form offers
  travelBufferMinutes: 30,         // kept clear around every booked visit
  maxSlotsPerDay: null,            // or a number: offer only the best few starts each day
  maxOpenRequestsPerRequester: 3,  // per requesterKey, below
  requestStatus: "pending",        // a person accepts each request
};

/** A refusal is the visitor's to act on, not a 500. */
function refused(error: unknown): Response {
  if (!(error instanceof BookingNotBookableError)) throw error;
  const status = error.code === "slot_unavailable" ? 409 : error.code === "too_many_requests" ? 429 : 400;
  return Response.json({ error: error.message, code: error.code }, { status });
}

export async function GET(req: Request, { params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;  // resolve a public slug to YOUR tenant id; never trust it blindly
  const minutes = Number(new URL(req.url).searchParams.get("minutes") ?? 60);
  try {
    // PublicSlot[]. No address goes in: the list is the same for every visitor.
    const slots = await findPublicSlots(schedulingDb, { tenantId: tenant, durationMinutes: minutes, days: 14 }, { policy });
    return Response.json(slots);
  } catch (error) {
    return refused(error); // invalid_duration: ?minutes=45, or ?minutes=abc
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  // The client sends the slot, the length and contact details. The tenant and the
  // skill the service needs are yours to decide.
  const body = requestPublicBookingSchema
    .omit({ tenantId: true, requiredSkill: true })
    .safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: "Check the form." }, { status: 400 });
  try {
    const receipt = await requestPublicBooking(
      schedulingDb,
      { ...body.data, tenantId: tenant },
      {
        maps,
        policy,
        // The address your proxy saw, never the first X-Forwarded-For entry
        // (the caller writes that one). See "Who is asking".
        requesterKey: clientIpKey(req),
        onEvent: schedulingComms.onEvent, // the acknowledgement and the office notice
      },
    );
    // receipt: { id, date, startTime, endTime, status, startsAt, endsAt, timeZone, manageToken, repeated }.
    // A repeat (a double click) comes back with repeated: true and manageToken: null.
    return Response.json(receipt, { status: 201 });
  } catch (error) {
    // slot_unavailable → refetch the times; too_many_requests → wait; the rest → fix the request
    return refused(error);
  }
}
```

What `requestPublicBooking` guarantees:

- **The server decides when, and who.** The request has no time, crew or
  coordinate fields. The day and start are decoded from `slotId`, the end is
  start + duration, the crew is the one the public list gives that time to, and
  the coordinates are geocoded from `address` when the provider can.
- **Only what is on offer right now.** The public list is worked out again under
  the crew's lock, and the (day, start) must be in it on that crew: on the grid,
  inside the hours, outside the notice, inside the horizon, under the daily cap,
  free with the travel buffer, matching `requiredSkill`, and kept by
  `maxSlotsPerDay`. Then the visitor's real drive from the neighbouring visits
  must fit.
- **A slot id carries no authority.** It decodes to a day and a start, and that
  is all it is. A forged or edited one gets no more than the list would have
  offered: a start the list held back, or a crew it didn't choose, is refused.
- **One booking per slot.** Validation and insert share one transaction holding
  `pg_advisory_xact_lock` on (tenant, crew), so two visitors racing for 10:00 get
  one booking and one `slot_unavailable`. Staff bookings, un-cancels and hours
  changes take the same lock. Nothing slow (geocoding, drive times) runs under it.
- **The same list for everyone.** `findPublicSlots` takes no address, so a
  visitor can't type addresses and read the list to learn where other customers
  are.
- **A cap per caller.** With `requesterKey`, a caller who already has
  `maxOpenRequestsPerRequester` requests waiting is refused `too_many_requests`.
  It is counted in the database, so it holds across serverless instances.
- **A double click books once.** The same request (day, start, length, email,
  requester) within ten minutes gets the same visit back, `repeated: true`,
  with the details as this caller typed them and **no manage token** (the
  first answer carried it). A request with no requester key is never treated
  as a repeat: a stranger replaying somebody's form must not get a key to
  their visit.
- **A cap per caller, whatever the setting.** The cap counts this caller's
  online requests and confirmed online visits still to come, so turning on
  auto-confirm doesn't let one caller fill the calendar.
- **An address a geocoder can't place is refused** (`address_unresolved`) when
  the provider geocodes, rather than booked with no coordinates. The widget
  then offers "Send it anyway": the same request with `addressAsTyped: true`
  is taken without coordinates, and the office is told the map couldn't find
  it (`addressUnverified`). A provider with `geocodes: false` books without
  them.
- **No links from strangers.** The name, phone and address are single lines,
  and the name and address may not contain a web address ("Leave web addresses
  out of the address."). Whatever a customer typed is shown in emails with
  links broken.
- **Pending by default.** Set `requestStatus: "confirmed"` for instant booking.
- **Refusals don't confirm existence.** An unknown slot id, another tenant's
  slot, a paused crew and a taken time all read as `slot_unavailable`.

Rate-limit both endpoints as well. The requester cap bounds how many requests
hold time; a rate limit bounds how fast a script can try.

## Permissions

`schedulingPermissions` is a tenant-scope fragment in the same shape as the
other packages' fragments. Spread it into your catalog:

```ts
import { schedulingPermissions } from "@adminigloo/scheduling";

export const tenantPermissions = definePermissions("tenant", { ...schedulingPermissions, ...appTenantPermissions });
```

| Key | For | Default roles |
| --- | --- | --- |
| `schedule.route` | Their own crew's day on a phone: stops, directions, the customer's phone, Start / Done / Couldn't do it / Undo. Nothing else | owner, admin, member |
| `schedule.view` | See visits, crews and hours | owner, admin, member, viewer |
| `schedule.manage` | Book visits, accept requests, move a visit's status | owner, admin, member |
| `schedule.resources.manage` | Add or remove crews, set hours, pause online booking | owner, admin |

An app whose own staff run one shared schedule can spread the keys into its
staff catalog with its own `defaultFor`. An app with its own auth can use the
key names in its own checks. In plain terms: `schedule.route` is a crew
member, `schedule.view` is look-only, `schedule.manage` is the dispatcher, and
`schedule.resources.manage` is the owner. Give a crew member `schedule.route`
alone: they open their own route and can't see the calendar, other crews'
customers or the settings.

## Upgrading from 0.3

1. **Migrate.** Everything new is nullable or has a default, so a drizzle
   host's `drizzle-kit generate` writes plain `ALTER`s and two `CREATE TABLE`s.
   For a host not on drizzle, this is the SQL:

   ```sql
   ALTER TABLE "scheduling_bookings" ADD COLUMN "starts_at" timestamp with time zone;
   ALTER TABLE "scheduling_bookings" ADD COLUMN "ends_at" timestamp with time zone;
   ALTER TABLE "scheduling_bookings" ADD COLUMN "origin" text DEFAULT 'staff' NOT NULL;
   ALTER TABLE "scheduling_bookings" ADD COLUMN "sequence" integer DEFAULT 0 NOT NULL;
   ALTER TABLE "scheduling_bookings" ADD COLUMN "pending_expires_at" timestamp with time zone;
   ALTER TABLE "scheduling_bookings" ADD COLUMN "cancelled_at" timestamp with time zone;
   ALTER TABLE "scheduling_bookings" ADD COLUMN "cancelled_by" text;
   ALTER TABLE "scheduling_bookings" ADD COLUMN "cancel_reason" text;
   ALTER TABLE "scheduling_bookings" ADD COLUMN "started_at" timestamp with time zone;
   ALTER TABLE "scheduling_bookings" ADD COLUMN "completed_at" timestamp with time zone;
   CREATE INDEX "scheduling_bookings_tenant_starts_idx" ON "scheduling_bookings" ("tenant_id", "starts_at");
   CREATE INDEX "scheduling_bookings_pending_expiry_idx" ON "scheduling_bookings" ("tenant_id", "status", "pending_expires_at");

   CREATE TABLE "scheduling_settings" (
     "id" text PRIMARY KEY,
     "tenant_id" text NOT NULL,
     "time_zone" text NOT NULL DEFAULT 'UTC',
     "business_name" text NOT NULL DEFAULT '',
     "contact_email" text,
     "contact_phone" text,
     "staff_notify_emails" jsonb NOT NULL DEFAULT '[]'::jsonb,
     "services" jsonb NOT NULL DEFAULT '[{"key":"visit","name":"Visit","durationMinutes":60}]'::jsonb,
     "slot_step_minutes" integer NOT NULL DEFAULT 30,
     "min_notice_minutes" integer NOT NULL DEFAULT 1440,
     "horizon_days" integer NOT NULL DEFAULT 30,
     "travel_buffer_minutes" integer NOT NULL DEFAULT 30,
     "max_slots_per_day" integer,
     "max_open_requests_per_requester" integer DEFAULT 3,
     "require_address" boolean NOT NULL DEFAULT false,
     "auto_confirm" boolean NOT NULL DEFAULT false,
     "public_booking_enabled" boolean NOT NULL DEFAULT true,
     "pending_expiry_hours" integer NOT NULL DEFAULT 48,
     "reminder_lead_hours" integer NOT NULL DEFAULT 24,
     "cancel_cutoff_hours" integer NOT NULL DEFAULT 24,
     "created_at" timestamp with time zone NOT NULL DEFAULT now(),
     "updated_at" timestamp with time zone NOT NULL DEFAULT now()
   );
   CREATE UNIQUE INDEX "scheduling_settings_tenant_idx" ON "scheduling_settings" ("tenant_id");

   CREATE TABLE "scheduling_visit_tokens" (
     "id" text PRIMARY KEY,
     "tenant_id" text NOT NULL,
     "visit_id" text NOT NULL,
     "token_hash" text NOT NULL,
     "created_at" timestamp with time zone NOT NULL DEFAULT now()
   );
   CREATE UNIQUE INDEX "scheduling_visit_tokens_hash_idx" ON "scheduling_visit_tokens" ("token_hash");
   CREATE INDEX "scheduling_visit_tokens_visit_idx" ON "scheduling_visit_tokens" ("tenant_id", "visit_id");
   ```

2. **Backfill.** Existing visits need their instants, public requests their
   origin, and waiting requests a deadline. From code, per business (idempotent;
   create-app's seed calls it):

   ```ts
   await backfillVisitInstants(db, tenantId);   // returns how many visits it changed
   ```

   Or once, in SQL:

   ```sql
   UPDATE scheduling_bookings AS b
   SET starts_at = (((b.scheduled_date AT TIME ZONE 'UTC')::date + b.start_time::time) AT TIME ZONE COALESCE(s.time_zone, 'UTC')),
       ends_at   = (((b.scheduled_date AT TIME ZONE 'UTC')::date + b.end_time::time)   AT TIME ZONE COALESCE(s.time_zone, 'UTC'))
   FROM scheduling_bookings AS b2
   LEFT JOIN scheduling_settings AS s ON s.tenant_id = b2.tenant_id
   WHERE b.id = b2.id AND b.starts_at IS NULL;

   UPDATE scheduling_bookings SET origin = 'public' WHERE requester_key IS NOT NULL;

   UPDATE scheduling_bookings
   SET pending_expires_at = LEAST(created_at + interval '48 hours', starts_at)
   WHERE status = 'pending' AND pending_expires_at IS NULL;
   ```

   Nothing breaks before the backfill runs: code that needs an instant works it
   out from the wall clock when the column is empty.

3. **Set the time zone.** A business that never saved settings is on UTC, as
   in 0.3. Saving its zone once (`updateSchedulingSettings(db, tenantId, {
   timeZone: "America/Denver" })`, or the settings screen) re-derives every
   upcoming visit's instants at the same wall-clock time, and tells nobody.

4. **Two new statuses.** `declined` and `expired` hold no time, like
   `cancelled`. A status menu built from `nextBookingStatuses` needs no change;
   code that switches on the status should handle them. Staff can't set
   `expired`.

5. **Policy precedence.** The public functions now read the business's
   settings. A 0.3 caller that passes `options.policy` keeps its numbers
   field by field; the zone always comes from settings. Prefer saving the
   settings and dropping the policy object.

6. **`MapsProvider.estimates`.** A custom provider that returns straight-line
   numbers should set `estimates: true`, so the crew's route says "estimate".
   A provider's `geocode` may now throw for "couldn't ask" (an outage): a
   customer's request is then booked without coordinates rather than refused.

7. **The receipt and the slot grew.** `requestPublicBooking` returns
   `startsAt`, `endsAt`, `timeZone`, `manageToken` and `repeated` too. A
   repeated request gets `manageToken: null` (the first answer had it).
   `PublicSlot` carries `startsAt` and `endsAt`.

8. **The public routes.** create-app's tRPC scheduling router is replaced by
   the two HTTP handlers in the matching create-app release. A project that
   copied the 0.3 router keeps working; mounting the handlers gets it the
   widget, the customer links and the emails.

9. **A new permission, `schedule.route`.** The staff handler asks for it on
   `crew-day` and on a stop's progress. An `authorize` that maps permissions
   to your own roles needs a line for it, or crews get "You don't have
   permission to do that." on their route.

## Upgrading from 0.2

1. **Migrate.** Three new columns, all nullable or with defaults, so no backfill
   is required. A drizzle host's `drizzle-kit generate` writes them; otherwise
   this is the SQL:

   ```sql
   ALTER TABLE scheduling_resources
     ADD COLUMN hours_configured boolean DEFAULT false NOT NULL,
     ADD COLUMN accepts_public_bookings boolean DEFAULT true NOT NULL;
   ALTER TABLE scheduling_bookings ADD COLUMN requester_key text;
   ```

   The scheduler already treats a crew with weekly rows as configured.
   Optionally, set the flag to match:

   ```sql
   UPDATE scheduling_resources SET hours_configured = true
   WHERE id IN (SELECT DISTINCT resource_id FROM scheduling_availability WHERE specific_date IS NULL);
   ```

   A crew someone "turned off" under 0.2 has no rows left, so it still looks
   never-configured and works Mon–Fri. Save its hours with no days ticked, or
   pause its online booking.

2. **Pass the tenant** to the by-id functions:

   | 0.2 | 0.3 |
   | --- | --- |
   | `updateResource(db, id, patch)` | `updateResource(db, tenantId, id, patch)` (patch has no `tenantId`/`id`) |
   | `deactivateResource(db, id)` | `deactivateResource(db, tenantId, id)` |
   | `listAvailability(db, resourceId)` | `listAvailability(db, tenantId, resourceId)` |
   | `setBookingStatus(db, { id, status })` | `setBookingStatus(db, tenantId, { id, status }, { maps })` |
   | `setAvailability(db, input)` → `void` | `setAvailability(db, input)` → `boolean` (false: not this tenant's) |

3. **Move public routes** from `findAvailableSlots` + `createBooking` to
   `findPublicSlots` + `requestPublicBooking`. Public requests now land `pending`.
4. **Handle the refusals.** `setBookingStatus` throws
   `BookingStatusTransitionError` for an illegal move, and
   `BookingNotBookableError` when an un-cancel's slot was taken.
   `createBooking` also refuses a day past `maxJobsPerDay`, a removed crew, and
   an invalid `customerEmail`. Branch on `error.code` (see
   [Concepts](#concepts)), not on the message.
5. **Times are checked.** `HH:MM` must be zero-padded and real (`09:30`, not
   `9:30` or `16:99`), with `24:00` allowed as an end. Rows you already have are
   not re-checked.
6. **The grid.** `findAvailableSlots` and `findFreeSlots` offer every start on a
   30-minute grid, where 0.2 offered one per gap. Pass `slotStepMinutes: Infinity`
   / `stepMinutes = Infinity` for the old shape.

The generated create-app overlay (router, seed, `/admin/schedule`) is updated in
the matching create-app release. A project that copied the 0.2 router needs the
same changes.

## API

| Function | Notes |
| --- | --- |
| `createSchedulingHandlers({ db, tenantId \| resolveTenant, manageUrl, maps?, onEvent?, rateLimit?, requesterKey?, minFillMs?, cors?, emailsEnabled?, uidDomain?, sweepExpired? })` → `{ handle }` | The customer's HTTP routes. `clientIpKey(req, { trustProxy? })` is the default requester key; `createClientIpKey({ trustProxy })` makes one. |
| `createSchedulingAdminHandlers({ db, tenantId \| resolveTenant, authorize, maps?, onEvent?, currentResourceId?, sweepExpired?, delivery?, listPeople?, onCrewMemberChange? })` → `{ handle }` | The staff HTTP routes. `SCHEDULING_ADMIN_ROUTE_PERMISSIONS` lists each route's permission. `adminStatus`, `adminNotices` build the banner; `toWireError`, `WIRE_ERROR_STATUS` map an error to the wire. |
| `effectiveStatus(row, now)`, `isOverdueRequest(row, now)` | A request past its deadline reads `expired` before the cron releases it. |
| `getSchedulingSettings(db, tenantId)`, `updateSchedulingSettings(db, tenantId, patch, { onEvent? })` | `DEFAULT_SCHEDULING_SETTINGS`, `updateSchedulingSettingsSchema`, `settingsToPolicy`, `toSettingsWire`. |
| `findPublicSlots(db, { tenantId, service \| durationMinutes, from?, days?, manageToken?, requiredSkill? }, { now?, policy?, settings? })` → `PublicSlot[]` | Public. Time order, one per time, the same for every visitor. |
| `requestPublicBooking(db, { tenantId, slotId, service, customerName, customerEmail, customerPhone?, address?, notes?, estimateId? }, { maps?, now?, requesterKey?, onEvent? })` | Public. Returns the receipt with the manage token. |
| `getVisitByToken`, `rescheduleVisitByToken`, `cancelVisitByToken`, `issueManageToken`, `toPublicVisit` | The customer's own visit. |
| `bookVisit(db, input, options)` → `{ visit, warnings }`; `createBooking(db, input, options)` → visit | Staff booking, validated under the lock. |
| `rescheduleBooking`, `assignBooking`, `updateBookingDetails` → `{ visit, warnings } \| null` | Staff moves and edits. |
| `setBookingStatus(db, tenantId, { id, status, reason? }, options)` → boolean | The status table; restores re-validate. |
| `expirePendingRequests(db, tenantId, { now?, onEvent?, limit? })` → `{ expired, visitIds }` | Release unanswered requests. Call it from the cron. |
| `listCalendar(db, tenantId, { from, to, resourceIds?, includeInactive? })` → `CalendarResponse` | Up to 42 days, five queries. |
| `listCrewDay(db, tenantId, { resourceId, date }, { maps? })` → `CrewDayResponse \| null` | A crew's route. |
| `findAvailableSlots(db, { tenantId, durationMinutes, startDate, endDate, jobAddress?, jobLat?, jobLng?, requiredSkill?, preferredResourceId?, slotStepMinutes?, notBefore? }, maps?)` → `ScoredSlot[]` | **Staff only.** Best first. |
| `validateBookingSlot(db, { tenantId, resourceId, date, startTime, endTime, lat?, lng?, excludeBookingId?, now? }, maps?)` | Read-only check; reasons are staff-facing. |
| `getBooking`, `listBookings`, `toVisitSnapshot` | |
| `createResource(db, input, { maps? })`, `updateResource(db, tenantId, id, patch, { maps? })`, `deactivateResource`, `reactivateResource`, `listResources`, `toAdminResource` | |
| `setAvailability(db, { tenantId, resourceId, blocks, scope? })`, `listAvailability`, `resolveDayWindows`, `addTimeOff`, `removeTimeOff`, `getAvailabilitySummary` | `resolveDayWindow` (one window) is kept for 0.3 callers. |
| `selectMapsProvider`, `createGoogleMapsProvider`, `createCachedMapsProvider`, `createHaversineMapsProvider`, `MapsProviderError` | |
| `backfillVisitInstants(db, tenantId)` | The upgrade, from code. |
| `visitInstants`, `instantsOf`, `todayIn`, and the zone helpers (`zonedWallClockToUtc`, `dateIn`, `isValidTimeZone`…) | |
| `buildVisitIcs`, `formatIcsUtc`, `escapeIcsText`, `foldLine` | The `.ics`. |
| `BOOKING_STATUSES`, `STAFF_SETTABLE_STATUSES`, `BOOKING_STATUS_TRANSITIONS`, `canTransitionBooking`, `nextBookingStatuses` | |
| `timeOfDaySchema`, `endTimeSchema` | The `HH:MM` checks. |
| `schedulingPermissions` | |
| The wire types (`PublicConfig`, `SlotsResponse`, `PublicVisit`, `VisitSnapshot`, `CalendarResponse`, `CrewDayResponse`, `SettingsWire`, …) | What the handlers send; shared with the widget. |

From `@adminigloo/scheduling/comms`: `createSchedulingCommsListener` (with
`onEvent`, `beforeSend`, `redactSent`, `ensureTemplates`, `verify`),
`SCHEDULING_EMAIL_TEMPLATES`, `SCHEDULING_COMMS_REF_TYPE`,
`COMMS_TABLES_MISSING`, `schedulingEmailVars`.

The pure engine (`findFreeSlots`, `scoreSlot`, `sortScoredSlots`,
`haversineDistance`, the time helpers) is exported too. Importing it still loads
drizzle, zod and `@adminigloo/db`; there is no separate entry for the math yet.

## Tests

`pnpm test` runs the pure engine and PGlite (in-process Postgres) suites:

- **The business scenario** (`business-scenario.test.ts`): a window-cleaning
  business in Denver runs its week through the two HTTP handlers, the comms
  listener and the comms cron, with a fake Google. A customer books and is
  acknowledged; the office accepts one request and declines another; staff move
  the visit and change its crew; the customer moves it, gets the reminder, is
  refused a cancel inside the cutoff and cancels another in time; the crew opens
  its route; a 24-hour notice is 24 real hours across the November fall-back;
  an unanswered request is released and the customer told; Google is used with
  a key and estimates without one. Every email, link and reminder time is
  checked exactly.
- Settings: defaults, partial saves, every range refusal, and a zone change that
  keeps the wall clock.
- Time zones: real-hour notice across both DST changes, the business's today,
  instants on every write, the backfill.
- Manage tokens: no plaintext token in any column of any table, the exact
  cutoff, a move next to the visit's own time, a closed booking page.
- Staff moves, crew changes and detail edits: every refusal code, warnings,
  sequence rules, no event for a no-op.
- Locks: every writer takes its crews' advisory locks, sorted, on its
  transaction, before it reads; no maps call ever runs inside a transaction.
- Events: every type from every emitter, after commit, contained, in order, and
  no secrets.
- Expiry, split shifts and time off, the calendar's five queries, the crew's
  route, the Google provider (and that the key never shows in an error), both
  handlers (every route and status, the CSRF matrix, CORS, rate-limit buckets,
  each staff route's permission), and the emails with the real
  `@adminigloo/comms`.
- Everything 0.3 tested still holds: tenant isolation, the public projection,
  forged slot ids, races, the per-requester cap, the status table.
- The 0.4 review (`review-public`, `review-comms`, `review-staff`): links and
  control characters in the public form, the requester key behind proxies, a
  repeat with no key, the cap under auto-confirm, an overdue request, the
  reminder on a daily cron and inside the cutoff, a corrected email, the
  delivery-log sweep after a crashed run, a zone change racing a booking, and
  the crew's own route and progress.

PGlite is a single connection, so the race tests prove the
validate-and-write-in-one-transaction logic and would pass without the lock.
What proves the lock is the query-log tests.
