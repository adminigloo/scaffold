# @adminigloo/scheduling

Scheduling for a business whose people drive to the customer: window fitters,
cleaners, field techs. Each crew has weekly hours, days off and a daily cap.
Staff see open visit times on a grid, scored by the drive from the job before.
Customers can pick a time online, and that path can't leak another customer's
address, be talked into a booking the crew can't make, or be flooded with junk
requests from one caller. The staff calendar has a status lifecycle that won't
double-book.

Every function is scoped to a tenant (one business). It is server code only,
with no UI. A project generated with `create-adminigloo-app --scheduling` gets
an admin page and a tRPC router built on it.

```
@adminigloo/scheduling          functions, types and permission keys (and the tables, re-exported)
@adminigloo/scheduling/schema   the drizzle pgTables
```

Peers: `drizzle-orm` (^0.45) and `zod` (^3.25 or ^4; see [Install](#install)).
No maps SDK and no date library.

It depends on `@adminigloo/db`, for three column helpers. Through it, npm also
installs `@adminigloo/env`, `@t3-oss/env-nextjs`, `uuidv7`, `ws` and the Neon
driver `@neondatabase/serverless` (a peer of `@adminigloo/db`; npm 7+ installs
it for you, Yarn classic doesn't, so add it there). Loading the package loads
`@adminigloo/db`, which sets the Neon driver's WebSocket class as it loads. That
is harmless in an app that never uses Neon.

## What each install gets you

| You install / import | You get | You wire yourself |
| --- | --- | --- |
| `@adminigloo/scheduling` + `./schema` | Crews ("resources") with weekly hours, dated exceptions, a daily cap and an online-booking switch. A staff slot finder scored by drive time. A **public** slot finder and request: the same list for every visitor, server-decided times and crew, `pending` by default, a cap on how many requests one caller can have waiting, one transaction under a per-crew lock. Staff bookings validated under the same lock, with refusal codes that say what kind. A status lifecycle with re-validation on un-cancel. Every by-id function filtered by tenant. Permission keys. Keyless Haversine drive times, and a database cache for a paid provider. | The four tables in your schema, and a migration you generate and run. Routes or server actions that call the functions with the signed-in user's tenant. A public page with a time picker. Emails (acknowledgement, confirmation, reminder). A maps provider, if you want geocoding. Permission checks in your auth. A rate limit on the public endpoints. |
| `create-adminigloo-app --scheduling` | All of the above, already wired: a tRPC router with public `slots` and `requestBooking` (rate-limited per caller, inputs derived from one `PUBLIC_POLICY`) and the staff calendar procedures, and a demo crew seeded for a tenant that has never had one. With an admin shell (`--admin minimal` or `full`), also `/admin/schedule`: Accept and Decline on each request, a status menu that offers only legal moves, an hours editor, and a per-crew "Pause online booking" switch. | The public picker page (the estimator overlay marks where it goes) and the comms wiring (the router's header says what to send when). |

### Not included

- **No customer-facing picker.** There is no scheduling widget yet. You build the
  page that lists `PublicSlot`s and posts the chosen one.
- **No calendar view and no rescheduling, by drag or otherwise.** The generated
  admin page is a list of visits for today and the next 30 days.
- **No editing a visit.** Once written, a visit's date, time, crew, address and
  customer details can't be changed through the package. Cancel it and book
  again; the new visit has a new id, so copy over any `estimateId` you keyed on.
  A visit created without a crew (`resourceId: null`) can't be given one later.
- **Pending requests never expire.** A request holds its time until staff accept
  or decline it. The per-requester cap and your rate limit bound how many there
  can be; there is no bulk "decline all".
- **No real maps provider.** Only the keyless Haversine provider ships. It
  estimates drive time from coordinates but can't geocode. `MapsProvider` is the
  seam for Google or Mapbox: inject one and wrap it in `createCachedMapsProvider`.
  Without a geocoder, a public request has no coordinates, so the real drive
  check only runs between visits that already have them; the public list's
  fixed travel buffer still keeps 30 minutes around every visit. Nothing turns a
  crew's `homeBaseAddress` into `homeBaseLat`/`homeBaseLng`; set those yourself.
- **No time zones.** Times are `HH:MM` wall-clock text. Days, notice and horizon
  are computed in UTC, so for a business at UTC−7 the 24-hour notice behaves
  like 17 or 31 hours.
- **No customer manage link.** Customers can't reschedule or cancel by token.
- **No CRM link.** A visit stores the name, email, phone and address as typed.
- **No emails or reminders.** A request lands `pending`. Acknowledging it and
  confirming it are yours to send.
- **One window per day per crew.** No split shifts. No time-off API beyond the
  full replace in `setAvailability`.
- **Removing a crew doesn't reassign its visits.** They stay assigned to it.
  `reactivateResource` puts a removed crew back; the generated admin page lists
  only active crews, so it has no button for that.
- **Not merged with `@adminigloo/booking`** (book-a-call for an app's own site).
  They are two engines with two sets of tables.
- **No license gate and no shipped `.sql` migration** (see below). The package
  caps waiting requests per caller but doesn't rate-limit; that is your route's.
- **create-app's router is still single-tenant.** It injects one fixed tenant and
  gates staff procedures on `staff.dashboard.view`. Moving it onto per-tenant
  permissions comes in a later release.
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
npm install -E @adminigloo/scheduling@0.3.0   # -E pins exactly; without it npm saves ^0.3.0
npm install drizzle-orm@^0.45                 # if you don't have it; drizzle-orm 1.x (npm's beta tag) won't do
```

**The types assume zod 4.** On zod 3.25 every function validates its input at
runtime exactly as on 4, but the input types are looser: an enum such as
`status` types as `unknown`, so `status: "teleported"` compiles and fails at
runtime with a `ZodError`. With `skipLibCheck: false`, tsc also reports errors
inside this package's `.d.ts` (`has no exported member 'core'`). Next's default
tsconfig sets `skipLibCheck: true`.

## Schema and migration

Four tables: `scheduling_resources`, `scheduling_availability`,
`scheduling_bookings` and `scheduling_drive_cache`. `tenant_id` and
`resource_id` are plain text with no cross-package foreign keys. The tenant is
whatever string you use for a business: a slug, or `String(brandId)`.

**A drizzle host** spreads the schema in and generates a migration as usual:

```ts
// src/db/schema.ts
export * from "@adminigloo/scheduling/schema";
```

```bash
npx drizzle-kit generate   # then run it yourself (drizzle-kit migrate, or your deploy step)
```

**A host that doesn't use drizzle for its own tables** (Prisma owns the schema,
say) still needs these four tables. **No `.sql` file ships with the package
yet.** Generate it from the schema with drizzle-kit, using a separate config
that points only at this package's schema entry:

```bash
npm install -D drizzle-kit@^0.31   # the drizzle-kit that pairs with drizzle-orm 0.45
```

```ts
// drizzle.scheduling.config.ts (not your app's config)
export default {
  dialect: "postgresql",
  schema: "./node_modules/@adminigloo/scheduling/dist/schema.js",
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

1. `npx prisma migrate dev --create-only --name adminigloo_scheduling_0_3` makes
   an empty migration.
2. Paste the generated SQL (`scheduling-sql/0000_*.sql`) into that migration's
   `migration.sql`.
3. `npx prisma migrate deploy` applies it without comparing your schema.
4. `npx prisma db pull` adds the four models to `schema.prisma`.
5. `npx prisma migrate dev` should now report that the schema is in sync.

Leave those four models alone: the package owns their shape. For each upgrade,
generate the new SQL and repeat steps 1 to 4. In any other order it goes wrong:
`migrate dev` compares a `schema.prisma` without the four models against a
database that has them and writes a migration that drops them, and SQL applied
outside Prisma's history (psql, a deploy script) shows up as drift, which
`migrate dev` offers to fix by resetting the database.

For reference, these are the tables as the package's own test suite creates them
from the drizzle schema. Use it for reading, not as your migration:

<details>
<summary>Reference DDL (0.3.0)</summary>

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
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX "scheduling_bookings_tenant_date_idx" ON "scheduling_bookings" ("tenant_id", "scheduled_date");
CREATE INDEX "scheduling_bookings_resource_date_idx" ON "scheduling_bookings" ("resource_id", "scheduled_date");

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
(`homeBaseLat`/`homeBaseLng` for drive scoring), skills, work hours, a daily cap
(`maxJobsPerDay`) and two switches:

- `acceptsPublicBookings` pauses online booking for that crew. Staff can still
  book it.
- `isActive` takes the crew off the schedule: `deactivateResource` hides it from
  the finders and `listResources`, and staff bookings and un-cancels onto it are
  refused (`resource_unavailable`). `reactivateResource` puts it back with its
  hours and switch as they were.

**Hours** are weekly rows plus dated exceptions. For each day, a dated exception
wins, then the weekday's row. A crew whose hours were **never saved**
(`hoursConfigured = false`) works Mon–Fri during its work hours, so a new crew
is bookable at once. `setAvailability` sets `hoursConfigured`, and from then on
the saved weekly rows are the whole week. A weekday with no row is off, and
saving an empty week turns the crew off every day.

**Times** are zero-padded 24-hour `HH:MM` text: `09:30`, not `9:30`, and never
`16:99`. An end or closing time may be `24:00` (midnight at the end of the day).
`timeOfDaySchema` and `endTimeSchema` are the checks, for your own forms.

**Slots** are offered on a grid (`slotStepMinutes`, default 30) inside each free
gap. The start right after a visit is also offered and scores a little higher,
so days still pack tightly. A crew at its daily cap offers nothing that day.

- The **staff** finder, `findAvailableSlots`, takes the job's address or
  coordinates and drops starts the crew can't drive to, or can't leave in time
  for the next job.
- The **public** finder, `findPublicSlots`, takes no address. It keeps a fixed
  `travelBufferMinutes` (default 30) clear around every visit, so the list is the
  same for every visitor. The visitor's real drive is checked when they ask.

**Visits** move through `BOOKING_STATUS_TRANSITIONS`:

| From | May move to |
| --- | --- |
| `pending` | `confirmed`, `cancelled` |
| `confirmed` | `in_progress`, `completed`, `cancelled`, `no_show` |
| `in_progress` | `confirmed`, `completed`, `cancelled` |
| `completed` | `in_progress` (reopen) |
| `cancelled` | `pending`, `confirmed`: the slot is re-validated first |
| `no_show` | `confirmed` (re-validated), `cancelled` |

`nextBookingStatuses(status)` is what a status menu should offer.

**Drive time** goes through a `MapsProvider`. `createHaversineMapsProvider()` is
the keyless default; it sets `geocodes: false`. `createCachedMapsProvider(real,
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
| `outside_hours` | staff | Not a working day, or outside the hours. |
| `invalid_window` | staff | The end isn't after the start. |
| `resource_unavailable` | staff | No such crew in this tenant, or it was removed. |

A malformed input is a `ZodError`. `BookingStatusTransitionError` is a move the
status table doesn't allow.

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
        return { ok: await setBookingStatus(db, ctx.tenant.id, input) };
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
    const ok = await setBookingStatus(schedulingDb, tenantId, { id: visitId, status: "confirmed" });
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
    scheduledDate: field("date"),       // "2026-03-04"; days are UTC
    startTime: field("start"),          // "10:00": 24-hour, zero-padded
    endTime: field("end"),              // "11:30"
    customerName: field("name"),
    customerPhone: field("phone"),
  });
  if (!input.success) return { error: "Check the form. Times are HH:MM, like 09:30." };
  // Without a crew the visit is written unassigned and unchecked, and can't be assigned later.
  if (!input.data.resourceId) return { error: "Pick a crew." };
  try {
    // Staff choose the times; the slot is still checked (hours, overlap, drive buffer,
    // daily cap) under the crew's lock.
    await createBooking(schedulingDb, { ...input.data, tenantId: user.brandSlug });
  } catch (error) {
    if (error instanceof BookingNotBookableError) return { error: error.message };
    throw error;
  }
  revalidatePath("/schedule");
  return { ok: true };
}
```

## The public flow

**A public route must use `findPublicSlots` and `requestPublicBooking`, and
nothing else.** `findAvailableSlots` is for staff. Its `ScoredSlot`s name the
crew and carry `previousJobAddress`, which is the street address of the
customer before. Return those from an anonymous endpoint and you publish your
customers' home addresses. `PublicSlot` is `{ slotId, date, startTime, endTime }`
and nothing more.

```ts
// app/api/schedule/[tenant]/route.ts: an anonymous endpoint
import {
  findPublicSlots, requestPublicBooking, requestPublicBookingSchema,
  createHaversineMapsProvider, BookingNotBookableError, type PublicBookingPolicy,
} from "@adminigloo/scheduling";
import { schedulingDb } from "@/lib/scheduling-db";

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
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  try {
    const receipt = await requestPublicBooking(
      schedulingDb,
      { ...body.data, tenantId: tenant },
      { maps, policy, requesterKey: ip ? `ip:${ip}` : null },
    );
    // receipt: { id, date, startTime, endTime, status: "pending" }. Send the acknowledgement here.
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
  requester) within ten minutes gets the first receipt back.
- **An address a geocoder can't place is refused** (`address_unresolved`) when
  the provider geocodes, rather than booked with no coordinates. A provider with
  `geocodes: false` books without them.
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
| `schedule.view` | See visits, crews and hours | owner, admin, member, viewer |
| `schedule.manage` | Book visits, accept requests, move a visit's status | owner, admin, member |
| `schedule.resources.manage` | Add or remove crews, set hours, pause online booking | owner, admin |

An app whose own staff run one shared schedule can spread the keys into its
staff catalog with its own `defaultFor`. An app with its own auth can use the
key names in its own checks.

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
| `findPublicSlots(db, { tenantId, durationMinutes, requiredSkill?, from?, days? }, { now?, policy? })` → `PublicSlot[]` | Public. Time order, one per time, the same for every visitor. |
| `requestPublicBooking(db, { tenantId, slotId, durationMinutes, customerName, customerEmail, customerPhone?, address?, notes?, serviceType?, estimateId?, requiredSkill? }, { maps?, now?, policy?, requesterKey? })` → `PublicBookingReceipt` | Public. Set `requiredSkill` and `requesterKey` on the server. |
| `toPublicSlot(scoredSlot)` → `PublicSlot` | The projection. |
| `findAvailableSlots(db, { tenantId, durationMinutes, startDate, endDate, jobAddress?, jobLat?, jobLng?, requiredSkill?, preferredResourceId?, slotStepMinutes? }, maps?)` → `ScoredSlot[]` | **Staff only.** Best first. |
| `createBooking(db, input, { maps?, skipValidation? })` | Staff booking, validated under the lock. Stores `scheduledDate` as its UTC day's midnight. |
| `validateBookingSlot(db, { tenantId, resourceId, date, startTime, endTime, lat?, lng?, excludeBookingId? }, maps?)` → `{ valid, reason?, code?, warnings }` | Read-only check; reasons are staff-facing. |
| `getBooking(db, tenantId, id)`, `listBookings(db, tenantId, { from, to })` | |
| `setBookingStatus(db, tenantId, { id, status }, { maps? })` | Transition table; un-cancel re-validates. |
| `createResource(db, input)`, `updateResource(db, tenantId, id, patch)`, `deactivateResource(db, tenantId, id)`, `reactivateResource(db, tenantId, id)`, `listResources(db, tenantId, { includeInactive? })` | |
| `setAvailability(db, { tenantId, resourceId, blocks })`, `listAvailability(db, tenantId, resourceId)`, `resolveDayWindow(rows, resource, date)` | |
| `createHaversineMapsProvider()`, `createCachedMapsProvider(base, db)` | |
| `BOOKING_STATUS_TRANSITIONS`, `canTransitionBooking`, `nextBookingStatuses` | |
| `DEFAULT_PUBLIC_BOOKING_POLICY`, `resolvePublicBookingPolicy` | |
| `timeOfDaySchema`, `endTimeSchema` | The `HH:MM` checks. |
| `schedulingPermissions` | |

The pure engine (`findFreeSlots`, `scoreSlot`, `sortScoredSlots`,
`haversineDistance`, the time helpers) is exported too. Importing it still loads
drizzle, zod and `@adminigloo/db`; there is no separate entry for the math yet.

## Tests

`pnpm test` runs the pure engine and a PGlite (in-process Postgres) suite:

- two-tenant isolation for every by-id function;
- a public projection with no crew, score or other customer's data, and slot
  ids that decode to a day and a start only;
- a public list that doesn't change with the visitor's address, and a real
  drive check when they ask;
- forged slot ids: a start `maxSlotsPerDay` held back, a crew without the skill;
- concurrent requests for one slot, of which exactly one lands, and a double
  click that books once;
- the per-requester cap, and an address a geocoder can't place;
- the notice, horizon, cap, grid, hours, overlap and duration refusals, and the
  staff refusal codes;
- a full grid on an empty day, and a fixed query count however many crews and
  days the public list covers;
- a crew turned off every day staying off, and a removed crew refusing staff
  bookings until it is put back;
- times that aren't times, and a visit stamped in the last second of its day;
- the status table, including un-cancel re-validation.

PGlite is a single connection, so the race tests prove the
validate-and-insert-in-one-transaction logic and would pass without the lock.
What proves the lock is a separate test that reads the query log: every writer
(`createBooking`, `requestPublicBooking`, `setBookingStatus` un-cancel,
`setAvailability`) takes `pg_advisory_xact_lock` on its (tenant, crew) key, on
its transaction, before it reads anything. Another runs each writer with a maps
provider that records whether a transaction was open when it was called, and
one books through `createCachedMapsProvider` on a single-connection handle,
which used to hang.
