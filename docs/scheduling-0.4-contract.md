# Scheduling 0.4: the contract

Two builders work from this document at the same time, and neither can see
the other's code until the end:

- **Server builder** — `packages/scheduling` 0.4.0 (sections 1–7 and 10).
- **Widget builder** — new `packages/scheduling-widget` 0.1.0 (sections 7–8 and 10).

Section 7 (the wire types) belongs to both of them. If you change a name or
shape there, the other half breaks without either builder noticing, so don't.
If something here is ambiguous, pick the reading that best serves the
acceptance bar in section 0, leave a `// CONTRACT:` comment where you made the
call, and list it in your hand-off.

Section 9 (create-app) is a plan for a later step. Neither builder edits
`packages/create-app`.

---

## 0. The acceptance bar

The founder's bar, in his words: *"Business owners aren't devs. If a business
owner is told by their dev that it works, they deploy it and sell it to a
customer; they need to trust that it's actually doing what is needed."*

Scheduling 0.4 is done when this scenario runs end to end, with no developer
filling gaps, for a field-service business (window cleaners in Salt Lake City,
say). The test in section 10.3 is this scenario, step by step:

1. A customer picks a time on the business's website. The page is a ready-made
   `<VisitPicker>`, with no custom code. They get an **acknowledgement email**.
   If the business auto-confirms, they get a **confirmation email** instead.
2. The owner or staff see the request on a **calendar** (day or week, per crew)
   and **accept or decline** it. The customer is emailed the outcome, with a
   **link to manage the visit**.
3. Staff **move** the visit (drag it, or edit it) or **reassign the crew**. The
   customer is told automatically.
4. The customer gets a **reminder** before the visit. From the link in their
   email they can **reschedule or cancel**, up to a cutoff.
5. The crew opens **today's route** on a phone: stops in order, each address
   with a directions link, and Start and Complete buttons.
6. All of it runs in the **business's time zone**, DST-correct. A business in
   America/Denver sees and enforces local times and notice windows, and a
   24-hour notice is 24 real hours.
7. A pending request that nobody answers **expires** after a configurable time,
   and the customer is told.
8. Drive-time scoring uses a **real maps provider (Google)** when a key is set,
   and falls back to Haversine estimates without one.

### Hard rules (both builders)

- No commits, pushes or publishes, and no `changeset version` or release. Write
  changeset FILES (section 11). Don't edit any `version` field.
- No dev server on port 3000 (another server is there). No real databases:
  PGlite only.
- No legal, privacy or consent wording anywhere, in code comments or docs.
- Match the repo's style: thorough "why" comments, zod at every boundary,
  `tenantId` on every query, instants as `timestamptz`, wall-clock times as
  `HH:MM` text for display, as in `@adminigloo/booking`.
- Scope fence. create-app stays single-tenant, and the handlers take a
  `resolveTenant(req)` seam. These are OUT, and listed in the README's "Not
  included" (section 11): recurring visit plans, a CRM record, SMS,
  deposits/payments, and merging with `@adminigloo/booking`.
- Don't touch `C:\Users\dalli\scaffold` (the main checkout, which holds an
  unpublished release) or `C:\Users\dalli\adminIgloo`. Work only in
  `C:\Users\dalli\scaffold-sched04` (branch `feat/scheduling-0.4`).

### The workspace is ready

- `pnpm install` has already run. `happy-dom` is a devDependency of the widget,
  and `@adminigloo/comms` is a devDependency of scheduling. **Don't install
  anything.** If something is truly missing, stop and say so in your hand-off.
- `@adminigloo/db`, `env`, `comms` and `scheduling` are built (`dist/`), so the
  PGlite suites run. If you change a package that another one imports from
  `dist`, rebuild it: `pnpm --filter @adminigloo/<name> build`.
- Baselines: scheduling **85/85**, create-app **1511/1511**, and the widget
  skeleton's 1 test. All green.
- Prior art to reuse rather than reinvent:
  - `packages/booking`: `src/zone.ts`, `src/tokens.ts`,
    `src/handlers.ts` (`isCrossSiteRequest`, headers, body parsing),
    `src/ics.ts`, `src/emails.ts`.
  - `packages/booking-widget`: the picker, the manage page,
    `src/styles.ts`, `src/client.ts`, `src/requests.ts` and `src/admin/*`.
  - `packages/comms`: `sendNow`, `enqueueMessage`, `cancelScheduled`, and
    `runDueMessages`'s `beforeSend`.
  - The audit findings this release answers are SB-04, SB-05, SB-07, SB-08,
    SB-17, SB-18, SB-19, SB-27 and SB-V4, in
    `C:\Users\dalli\adminigloo-audit-2026-10\audit-verified.json` (cluster
    `scheduling-booking`).

---

## 1. What changes in 0.4, in one page

| Area | 0.3 | 0.4 |
| --- | --- | --- |
| Time zone | none (days in UTC) | one IANA zone per tenant (settings); wall-clock `HH:MM` in that zone + `starts_at`/`ends_at` instants on every visit; notice, cutoff, reminders and expiry on instants |
| Business settings | a `PublicBookingPolicy` object in code | `scheduling_settings` row per tenant: zone, name, contact, services, policy, expiry, reminders, cutoff, auto-confirm, online on/off |
| What a customer books | a duration | a **service** (key → name, duration, skill) |
| Statuses | 6 | 8: adds `declined` and `expired` |
| Customer self-service | none | hashed manage tokens, many per visit; view / reschedule / cancel, up to a cutoff; `.ics` |
| Staff edits | status only | `rescheduleBooking`, `assignBooking`, `updateBookingDetails` under the crew lock(s) |
| Hours | one window a day; full replace | several windows a day; weekly-only replace; time off by date range |
| Calendar | a list | `listCalendar` (range × crews), `listCrewDay` (ordered stops, drive estimates, directions) |
| Expiry | never | `pending_expires_at`; an overdue request holds no time; `expirePendingRequests` sweeps and notifies |
| Events | none | `onEvent` with one envelope for nine event types, after commit |
| Email | none | `@adminigloo/scheduling/comms`: templates, sends, reminder queue, link redaction |
| Maps | Haversine only | `createGoogleMapsProvider` (raw fetch), `selectMapsProvider`, geocoding on writes |
| HTTP | none (create-app's tRPC) | `createSchedulingHandlers` (public) + `createSchedulingAdminHandlers` (staff) |
| UI | none | `@adminigloo/scheduling-widget`: VisitPicker, ManageVisit, ScheduleCalendar, CrewDay, SchedulingSettings |

Everything 0.3 exported still exists with the same signature. Where 0.4 adds
behaviour to an existing function, it adds an options field. The deliberate
behaviour changes are listed in section 11's changeset text. Existing tests are
updated only where a change is deliberate, and each such update is named in
the hand-off.

---

## 2. Schema (server builder)

All new columns are nullable or have defaults, so `drizzle-kit generate`
produces plain `ALTER`s. Keep `@adminigloo/db`'s `idColumn`, `createdAt` and
`updatedAt`. Add the new tables to `TABLES` in `src/__tests__/pglite.ts`, and
teach its DDL generator to render a partial index's `WHERE` (comms has one)
when the scenario test adds the comms tables.

### 2.1 `scheduling_bookings`: new columns

| Column | Type | Meaning |
| --- | --- | --- |
| `starts_at` | `timestamptz` null | The visit's start instant: `scheduled_date` + `start_time` read in the tenant's zone. Written by every 0.4 insert and move. Null only on rows from before 0.4 that haven't been backfilled. |
| `ends_at` | `timestamptz` null | The end instant. `"24:00"` is the next local midnight. |
| `origin` | `text` not null default `'staff'` | `'public'` (via `requestPublicBooking`) or `'staff'`. |
| `sequence` | `integer` not null default `0` | Goes up by 1 whenever the time changes or the visit stops or starts happening: reschedule, cancel, decline, expire, restore. **Not** on reassign or a details edit. It is the `.ics` SEQUENCE, and it versions the reminder. |
| `pending_expires_at` | `timestamptz` null | Set when a visit lands `pending`: `min(created_at + pendingExpiryHours, starts_at)`. Cleared when it leaves `pending`. |
| `cancelled_at` | `timestamptz` null | When it was cancelled or declined. |
| `cancelled_by` | `text` null | `'customer' \| 'staff' \| 'system'`. |
| `cancel_reason` | `text` null | ≤ 500 characters, as typed. |
| `started_at` | `timestamptz` null | First move to `in_progress`. |
| `completed_at` | `timestamptz` null | Move to `completed`. Cleared on reopen. |

New indexes: `scheduling_bookings_tenant_starts_idx (tenant_id, starts_at)` and
`scheduling_bookings_pending_expiry_idx (tenant_id, status, pending_expires_at)`.

**`scheduled_date` doesn't change meaning, but its doc comment does:** it is the
visit's calendar date *in the business's zone*, stored as that date's UTC
midnight. It is a label, not an instant. Day iteration, `resolveDayWindows` and
the `(tenant, crew, day)` queries keep using it.

### 2.2 `scheduling_settings` (new): one row per tenant

| Column | Type / default | Notes |
| --- | --- | --- |
| `id` | `idColumn()` | |
| `tenant_id` | `text` not null, **unique** (`scheduling_settings_tenant_idx`) | |
| `time_zone` | `text` not null default `'UTC'` | IANA zone, checked with `isValidTimeZone` on every write. `'UTC'` keeps 0.3's behaviour for a tenant that never saved settings. |
| `business_name` | `text` not null default `''` | ≤ 120. |
| `contact_email` | `text` null | Shown to customers and in emails. |
| `contact_phone` | `text` null | ≤ 40, as typed. |
| `staff_notify_emails` | `jsonb` not null default `'[]'` | ≤ 5 addresses for new-request and customer-change notices. |
| `services` | `jsonb` not null default `[{"key":"visit","name":"Visit","durationMinutes":60}]` | 1–20 `SchedulingService` (2.5). |
| `slot_step_minutes` | `integer` not null default `30` | 5–240, a multiple of 5. |
| `min_notice_minutes` | `integer` not null default `1440` | 0–43200. |
| `horizon_days` | `integer` not null default `30` | 1–365. |
| `travel_buffer_minutes` | `integer` not null default `30` | 0–240. |
| `max_slots_per_day` | `integer` null | null means every start; otherwise 1–100. |
| `max_open_requests_per_requester` | `integer` null default `3` | null means no cap; otherwise 1–50. |
| `require_address` | `boolean` not null default `false` | create-app seeds `true`. |
| `auto_confirm` | `boolean` not null default `false` | `true` makes requests land `confirmed`. |
| `public_booking_enabled` | `boolean` not null default `true` | `false` closes online booking for the tenant. |
| `pending_expiry_hours` | `integer` not null default `48` | 1–720. |
| `reminder_lead_hours` | `integer` not null default `24` | 0–168; 0 means no reminder. |
| `cancel_cutoff_hours` | `integer` not null default `24` | 0–168; 0 means up to the start. |
| `created_at`, `updated_at` | | |

### 2.3 `scheduling_visit_tokens` (new)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `idColumn()` | |
| `tenant_id` | `text` not null | |
| `visit_id` | `text` not null | No FK, the house rule. |
| `token_hash` | `text` not null, **unique** (`scheduling_visit_tokens_hash_idx`) | SHA-256 hex. The plaintext is never stored anywhere. |
| `created_at` | `timestamptz` not null default now | |

Index: `scheduling_visit_tokens_visit_idx (tenant_id, visit_id)`.

**Why several tokens per visit.** booking keeps one hash per booking, so any
email sent after the first one has no link to give. A staff accept, a move, or
a reminder sent a day later all have nothing. Here, whoever needs a link mints
a fresh token for that one message (`issueManageToken`), and every token stays
valid for its visit. Events therefore never carry a secret. No cap: each event
mints at most one token, and the rate limits bound the rest.

### 2.4 Upgrade SQL (README "Upgrading from 0.3", for hosts not on drizzle)

Give the `ALTER TABLE` / `CREATE TABLE` statements drizzle-kit generates, and
then this backfill:

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

`backfillVisitInstants(db, tenantId)` (3.10) does the same per tenant from
code, and create-app's seed calls it. It is idempotent. Code that reads an
instant tolerates a null with `instantsOf(row, timeZone)`, so nothing breaks
before the backfill runs.

### 2.5 `SchedulingService`

```ts
interface SchedulingService {
  key: string;                    // /^[a-z0-9][a-z0-9-]{0,39}$/, unique within the tenant
  name: string;                   // 1–80, what the customer reads ("Free estimate")
  durationMinutes: number;        // 15–720, a multiple of 5
  description?: string | null;    // ≤ 300
  requiredSkill?: string | null;  // ≤ 60; only crews with this skill (or with no skills) are offered
}
```

A visit's `service_type` column holds the service key. Since 0.1, staff
bookings default to `"visit"`. The name shown for a visit comes from the
settings' services by key. If the key is unknown, it falls back to the key
humanized (`"window-clean"` becomes `"Window clean"`).

---

## 3. Server functions (`@adminigloo/scheduling`)

The common write options are below. Every writer below takes the subset it
uses.

```ts
interface SchedulingWriteOptions {
  maps?: MapsProvider;                       // default: createHaversineMapsProvider()
  onEvent?: SchedulingEventListener;         // section 5
  onEventError?: (error: unknown, event: SchedulingEvent) => void;
  actor?: SchedulingActor;                   // default per function (customer / staff / system)
  notify?: boolean;                          // default: true for customer-facing events (5.2)
  now?: Date;                                // default new Date(), read once per call
  settings?: SchedulingSettings;             // pass to skip the settings read (handlers read once per request)
}
```

### 3.1 Settings

```ts
const DEFAULT_SCHEDULING_SETTINGS: Readonly<SchedulingSettingsValues>;   // the defaults in 2.2
interface SchedulingSettingsValues {
  timeZone: string; businessName: string; contactEmail: string | null; contactPhone: string | null;
  staffNotifyEmails: string[]; services: SchedulingService[];
  slotStepMinutes: number; minNoticeMinutes: number; horizonDays: number; travelBufferMinutes: number;
  maxSlotsPerDay: number | null; maxOpenRequestsPerRequester: number | null; requireAddress: boolean;
  autoConfirm: boolean; publicBookingEnabled: boolean;
  pendingExpiryHours: number; reminderLeadHours: number; cancelCutoffHours: number;
}
interface SchedulingSettings extends SchedulingSettingsValues {
  tenantId: string;
  saved: boolean;          // false: no row yet, every value is a default
  updatedAt: Date | null;
}
const updateSchedulingSettingsSchema: z.ZodType;   // every field optional, the ranges in 2.2; unknown keys dropped

getSchedulingSettings(db, tenantId): Promise<SchedulingSettings>      // never writes
updateSchedulingSettings(db, tenantId, patch, options?: SchedulingWriteOptions): Promise<SchedulingSettings>
settingsToPolicy(settings): ResolvedPublicBookingPolicy
```

- `updateSchedulingSettings` upserts on `tenant_id`, and a patch only changes
  the keys it names. Each issue is a `ZodError` with a path. A bad zone reads
  "Pick a time zone from the list." Service keys must be unique.
- **Changing `timeZone` keeps every visit at its wall-clock time.** Those times
  are what the customer was shown, and what the crew's day is built from. In
  the same transaction, every visit in `pending | confirmed | in_progress`
  gets its `starts_at`/`ends_at` (and `pending_expires_at`, as
  `LEAST(pending_expires_at, new starts_at)`) recomputed in the new zone, and
  `sequence + 1`. After commit, it emits `visit.rescheduled` for each one that
  starts after `now`, with `actor` staff, `notify: false` and
  `via: "time_zone"`. The comms listener then re-queues the reminders and
  emails nobody. This is also the upgrade path for 0.3 installs: they set
  their zone once and every upcoming visit gets correct instants.
- `settingsToPolicy`: `durationsMinutes` is the distinct service durations, in
  ascending order. `requestStatus` is `autoConfirm ? "confirmed" : "pending"`.
  The other policy fields map by name.

**Policy precedence in the public functions.** Defaults, then settings, then
whatever fields `options.policy` defines. 0.3 callers that pass a policy keep
their numbers, and the zone always comes from settings.

### 3.2 Zones and instants

- Copy `packages/booking/src/zone.ts` into `packages/scheduling/src/zone.ts`
  verbatim. Add a header note: "copied from @adminigloo/booking's zone.ts;
  change both or neither". Copy its tests too. Export
  `export * from "./zone.js"` from the barrel.
- New helpers, exported:
  - `visitInstants(date: DateString, startTime, endTime, timeZone): { startsAt: Date; endsAt: Date }`.
    It uses `zonedWallClockToUtc`. `"24:00"` is minute 1440.
  - `instantsOf(row, timeZone)` returns the row's own `starts_at`/`ends_at`,
    or computes them when they are null.
  - `todayIn(now, timeZone): DateString`.
- "Now"-dependent rules move to instants in the tenant zone:
  - **Public offer.**
    - `earliestStart = now + minNotice` and `latestStart = now + horizonDays × 24h`.
    - `firstDay = max(from ?? todayIn(now), dateIn(earliestStart, zone))` and
      `lastDay = min(firstDay + days − 1, dateIn(latestStart, zone))`.
    - A start is offered only if `visitInstants(...).startsAt` lies in
      `[earliestStart, latestStart]`.
    - The 24-hour notice is 24 real hours. On the fall-back weekend that
      differs from 24 wall-clock hours, and `timezone.test.ts` proves it
      (10.1).
  - **`openRequestsFrom`.** A request counts only if it is pending, on
    `scheduled_date ≥ today-in-zone`, and not overdue (3.4).
  - **Every insert and every move** writes `starts_at`/`ends_at` from the
    tenant zone.
- Visits never cross local midnight: ends are ≤ `24:00`, as in 0.3. A wall
  time inside the spring-forward gap resolves forward, as booking's does.
  Hours are normally nowhere near 02:00, but the rule is fixed, not undefined.

### 3.3 Statuses and transitions

```ts
BOOKING_STATUSES = ["pending","confirmed","in_progress","completed","cancelled","declined","expired","no_show"]
INACTIVE_BOOKING_STATUSES = ["cancelled","declined","expired","no_show"]   // hold no time
STAFF_SETTABLE_STATUSES = BOOKING_STATUSES without "expired"              // the system expires; staff don't
```

| From | May move to |
| --- | --- |
| `pending` | `confirmed`, `declined`, `cancelled`, `expired` (system only) |
| `confirmed` | `in_progress`, `completed`, `cancelled`, `no_show` |
| `in_progress` | `confirmed`, `completed`, `cancelled` |
| `completed` | `in_progress` (reopen) |
| `cancelled` | `pending`, `confirmed` (re-validated) |
| `declined` | `confirmed` (re-validated) |
| `expired` | `confirmed` (re-validated) |
| `no_show` | `confirmed` (re-validated), `cancelled` |

- `nextBookingStatuses(s)` never offers `expired`. `setBookingStatusSchema.status`
  is `STAFF_SETTABLE_STATUSES`, and its input gains `reason?: string` (≤ 500).
- `setBookingStatus(db, tenantId, { id, status, reason? }, options?: SchedulingWriteOptions): Promise<boolean>`
  keeps its signature and return value. Field effects, on the row, under the
  lock:
  - **To `confirmed`:** clear `pending_expires_at`. From an inactive status
    (a restore): re-validate as 0.3 did, clear `cancelled_*`, and
    `sequence + 1`.
  - **To `declined` or `cancelled`:** set `cancelled_at = now`, set
    `cancelled_by` (`actor.type`, default `staff`) and `cancel_reason`; clear
    `pending_expires_at`; `sequence + 1`.
  - **To `in_progress`:** set `started_at` if it's null. Reopening from
    `completed` clears `completed_at`.
  - **To `completed`:** set `completed_at = now`, and `started_at` if it's
    null.
- Events (emitted after commit; section 5):

| Move | Event | `via` |
| --- | --- | --- |
| `pending → confirmed` | `visit.confirmed` | `accept` |
| `cancelled \| declined \| expired \| no_show → confirmed` | `visit.confirmed` | `restore` |
| `pending → declined` | `visit.declined` | |
| `* → cancelled` | `visit.cancelled` | |
| `confirmed → in_progress` | `visit.started` | |
| `confirmed \| in_progress → completed` | `visit.completed` | |
| `in_progress → confirmed`, `completed → in_progress`, `* → no_show`, `cancelled → pending` | none | |

### 3.4 Overdue requests hold no time

A `pending` visit whose `pending_expires_at ≤ now` holds no time from that
instant on, whether or not anything has flipped its status yet. booking treats
expired holds the same way. Add the predicate
`NOT (status = 'pending' AND pending_expires_at <= $now)` everywhere visits are
counted as busy:

- `activeBookingsOn` and `activeBookingsByDay` (the finders and offers)
- `validateBookingSlot`, through a new optional `ValidateBookingInput.now`
  (default `new Date()`)
- `openRequestsFrom`

Correctness therefore never waits on a cron.

```ts
expirePendingRequests(db, tenantId, options?: { now?: Date; onEvent?; onEventError?; limit?: number /* default 100 */ })
  : Promise<{ expired: number; visitIds: string[] }>
```

- It runs one statement:
  `UPDATE … SET status = 'expired', sequence = sequence + 1, updated_at = now WHERE id IN (SELECT id … WHERE tenant_id = $1 AND status = 'pending' AND (pending_expires_at <= $now OR (pending_expires_at IS NULL AND starts_at <= $now)) ORDER BY pending_expires_at LIMIT $limit FOR UPDATE SKIP LOCKED) RETURNING *`.
- It takes no crew lock: it only frees time, and the `status = 'pending'`
  predicate makes a concurrent accept lose cleanly (that accept then re-reads
  and restores with re-validation).
- It emits `visit.expired` (actor system, `notify: true`) for each row. A
  second run is a no-op.
- It is called by the cron, by the admin `expire` route, by the admin
  `calendar` route, and by the public `request` route. The handlers throttle
  their calls to once a minute per tenant per process (`sweepExpired`), and
  the cron calls it unthrottled.

### 3.5 Availability: several windows a day, weekly-only saves, time off

```ts
resolveDayWindows(rows, resource, date): Array<{ start: string; end: string }>   // sorted, overlaps merged
resolveDayWindow(rows, resource, date)   // kept for 0.3 callers: the first window or null. Mark @deprecated.
```

Precedence for one day:

1. Dated rows for that date. If any is `isAvailable = false`, the day is off
   (`[]`). Otherwise the available dated rows ARE the day's windows.
2. Otherwise, every available weekly row for that weekday, so a crew can work
   08:00–12:00 and 13:00–17:00. A weekday whose only rows are unavailable is
   off.
3. Otherwise, the 0.3 Mon–Fri fallback (never configured, no weekly rows).

The slot engine runs `findFreeSlots` once per window and concatenates the
results. `validateBookingSlot` requires `[start, end]` to sit inside ONE window;
otherwise it refuses with `outside_hours` and a reason naming the windows.

```ts
setAvailability(db, { tenantId, resourceId, blocks, scope?: "all" | "weekly" })   // default "all" = 0.3
```

`"weekly"` replaces only the rows with `specific_date IS NULL`, so dated rows
survive. A block that has a `specificDate` is a zod issue.

```ts
addTimeOff(db, { tenantId, resourceId, from: DateString, to: DateString, note? }, options?: { now? })
  : Promise<{ added: number; visitsOnThoseDays: BookingRow[] } | null>          // null: not this tenant's crew
removeTimeOff(db, tenantId, { resourceId, exceptionId }): Promise<boolean>
// getAvailabilitySummary is in 3.10; it returns AvailabilityResponse (section 7)
```

- `addTimeOff` inserts one `isAvailable = false` dated row per date in
  `[from, to]`, at most 62 days, skipping dates that already have one. It
  runs under the crew lock. It refuses nothing, but returns the active visits
  on those dates, so the UI can say "3 visits are booked on those days. Move
  them." That is the stranded-visit guard.
- `removeTimeOff` deletes one dated row, by id, for this tenant and crew, under
  the crew lock.
- `getAvailabilitySummary` returns `AvailabilityResponse` (section 7):
  - `weekly` is the saved weekly rows.
  - `effectiveWeekly` is what applies today: the saved rows, or the Mon–Fri
    default when the crew was never configured.
  - `timeOff` is the dated unavailable rows from today on.
  - `specialHours` is the dated available rows from today on.

### 3.6 Public offer and request (changes)

- `findPublicSlots(db, input, options?: PublicBookingOptions & { settings? })`:
  - `input` gains `service?: string` (a key) and `manageToken?: string`.
    Exactly one of `service` and `durationMinutes` is required, unless
    `manageToken` opens a changeable visit. In that case the offer uses that
    visit's duration and service skill, and **leaves the visit itself out of
    the busy set**, so a customer can move to the time right next to their
    own. A token that opens nothing is ignored, the same answer as no token:
    no oracle.
  - An unknown service is `BookingNotBookableError("unknown_service")`.
  - With `publicBookingEnabled: false` it returns `[]`.
  - `PublicSlot` gains `startsAt` and `endsAt` (instants). Nothing else is
    added: no crew, no score, no address.
- `requestPublicBooking(db, input, options?: RequestPublicBookingOptions & SchedulingWriteOptions)`:
  - `input` gains `service?: string`; the key sets duration, `requiredSkill`
    and `serviceType`. If both `service` and `durationMinutes` are given,
    `service` wins.
  - `publicBookingEnabled: false` refuses with `booking_closed`.
  - The geocode follows the maps rules in 3.9. If the provider **throws**, the
    visit is booked without coordinates; only a clean "no such place" refuses
    with `address_unresolved`.
  - It writes `origin 'public'`, `starts_at`/`ends_at`, and
    `pending_expires_at` when the visit lands pending.
  - It mints a manage token, inserted in the same transaction, and returns it
    on the receipt. The repeat path (a double click) mints a new token for the
    first visit, outside any transaction, and emits nothing.
  - After commit it emits `visit.requested` (via `online`, actor customer). If
    the visit landed confirmed (auto-confirm), it then also emits
    `visit.confirmed` (via `auto`, actor system).
  - The receipt is now
    `PublicBookingReceipt & { startsAt: Date; endsAt: Date; timeZone: string; manageToken: string; repeated: boolean }`.

### 3.7 Manage tokens and the customer's own visit

```ts
issueManageToken(db, tenantId, visitId): Promise<string | null>     // null: no such visit for this tenant
getVisitByToken(db, tenantId, token, options?: { now?; settings? }): Promise<PublicVisit | null>
rescheduleVisitByToken(db, tenantId, token, { slotId }, options?: SchedulingWriteOptions): Promise<PublicVisit | null>
cancelVisitByToken(db, tenantId, token, { reason? }, options?: SchedulingWriteOptions): Promise<PublicVisit | null>
toPublicVisit(row, settings, { now }): PublicVisit                  // pure
```

- **Tokens.** Copy `generateToken`, `hashToken` and `looksLikeToken` from
  booking's `tokens.ts`: 32 random bytes, base64url, Web Crypto only.
- **Lookup.** `looksLikeToken`, then hash, then
  `WHERE tenant_id = $t AND token_hash = $h`, then the visit by
  `(tenant_id, id)`. Every miss is `null`: malformed, unknown, another
  tenant's token, a deleted visit. The handlers map every `null` to the same
  `not_found`.
- **Changeable.** Status is `pending` or `confirmed`, AND
  `now < startsAt − cancelCutoffHours`.
  - `canCancel` is changeable.
  - `canReschedule` is changeable AND `publicBookingEnabled`.
  - `changeDeadline` is `startsAt − cutoff`.
- **Reschedule** takes a `slotId` from `findPublicSlots({ manageToken })`.
  - The new time must be in the public offer worked out again under the locks
    for the old crew and the new crew. Lock keys are sorted, and the requester
    lock isn't used.
  - The same visit row moves: the crew may change, `sequence + 1`, and the
    status stays as it was. A pending visit keeps
    `pending_expires_at = LEAST(old, new startsAt)`.
  - Event: `visit.rescheduled`, actor customer, with `data.previous`.
  - Refusals:
    - not changeable: `too_late`
    - online booking closed: `booking_closed`
    - not in the offer, or the drive doesn't fit: `slot_unavailable`
    - `too_soon` and `too_far`, as for a request
- **Cancel.** A changeable visit moves to `cancelled` (`cancelled_by` is
  `customer`). Cancelling an already-cancelled visit returns it unchanged, with
  no event. Any other non-changeable state refuses with `too_late`. Event:
  `visit.cancelled`, actor customer.
- **Why a cutoff and not just "before it starts".** A crew plans its day the
  evening before. A same-morning online cancel is a lost slot nobody can
  refill, and the business would rather take the call. The refusal message
  says so and gives the contact phone:
  "This visit starts within 24 hours, so it can't be changed online. Call us
  at (801) 555-0143."

### 3.8 Staff writers

```ts
bookVisit(db, input: CreateBookingInput, options?: SchedulingWriteOptions & { skipValidation?: boolean })
  : Promise<{ visit: BookingRow; warnings: string[] }>
createBooking(db, input, options?)            // unchanged signature: (await bookVisit(...)).visit

rescheduleBooking(db, tenantId, { id, date: DateString, startTime, endTime?, resourceId? }, options?: SchedulingWriteOptions)
  : Promise<{ visit: BookingRow; warnings: string[] } | null>
assignBooking(db, tenantId, { id, resourceId }, options?: SchedulingWriteOptions)
  : Promise<{ visit: BookingRow; warnings: string[] } | null>
updateBookingDetails(db, tenantId, { id, patch }, options?: Pick<SchedulingWriteOptions, "maps" | "now" | "settings">)
  : Promise<{ visit: BookingRow; warnings: string[] } | null>
```

**`bookVisit`**

- Before any lock, it geocodes `address` when no coordinates were given and
  `maps.geocodes !== false`. If that fails, the visit is saved without
  coordinates and gets the warning "We couldn't place that address on the
  map, so drive times will skip this visit."
- It writes `starts_at`/`ends_at`, `origin 'staff'`, and `pending_expires_at`
  when the visit is pending.
- Staff paths don't check the clock. A past date is allowed (back-filling
  yesterday's job), as in 0.3.
- It returns the validator's `warnings` (a tight drive).
- Events: confirmed emits `visit.confirmed` (via `staff`); pending emits
  `visit.requested` (via `staff`). Actor staff.

**`rescheduleBooking`**

- Only `pending` and `confirmed` move. Anything else refuses with
  `not_changeable` ("This visit is completed, so it can't be moved.").
- `endTime` omitted means start + `durationMinutes`. When given,
  `durationMinutes` becomes end − start.
- `resourceId` omitted keeps the crew. The target crew must be active.
- Order of work:
  1. Drive times are looked up before the lock (`driveTimesBeforeLock`, with
     `excludeBookingId`).
  2. One transaction locks the old and new crews, keys sorted.
  3. The visit is re-read under the lock, and its status checked again.
  4. `validateBookingSlot(..., excludeBookingId)` runs.
  5. The update writes the date, times, duration, `starts_at`/`ends_at` and
     crew. `sequence + 1` if the time changed. A pending visit gets
     `pending_expires_at = LEAST(old, new startsAt)`.
- Events:
  - The time changed: `visit.rescheduled` with `previous`, including the old
    crew.
  - Only the crew changed: `visit.reassigned`.
  - Nothing changed: no write and no event.
- An unassigned visit (no crew), moved without a `resourceId`, is written
  unvalidated, as in 0.3.
- Refusals carry the staff codes: `slot_unavailable`, `outside_hours`,
  `invalid_window`, `resource_unavailable`, `not_changeable`. A reason names
  the clash ("Overlaps 10:00–12:00"), as 0.3 does.

**`assignBooking`**

- Same time, new crew. The same status rule, locks and validation as
  `rescheduleBooking` apply.
- There is no sequence bump: the customer's calendar entry doesn't change.
- Emits `visit.reassigned`.
- This also fixes 0.3's "an unassigned visit can't get a crew".

**`updateBookingDetails`**

- The patch may set `title`, `serviceType`, `customerName`, `customerEmail`
  (an email or null), `customerPhone`, `address`, `lat`, `lng`, `notes` and
  `estimateId`. Unknown keys are dropped.
- A changed `address` with no coordinates is geocoded before the lock.
  Failure leaves the coordinates null and adds a warning.
- With new coordinates on an assigned, active visit, it re-runs
  `validateBookingSlot` under the lock and turns a failure into a warning
  ("Heads up: not enough time to drive from the 09:00 job…"). It **never
  refuses**: an address is a fact, and staff must be able to record it.
- Any status may be edited. There is no event.

**Resources** geocode their home base. The new signatures are
`createResource(db, input, options?: { maps? })` and
`updateResource(db, tenantId, id, patch, options?: { maps? })`. A
`homeBaseAddress` without coordinates is geocoded when the provider geocodes.
An error leaves the coordinates null. An address cleared to null clears them.

### 3.9 Maps

```ts
interface MapsProvider {
  readonly geocodes?: boolean;
  readonly estimates?: boolean;   // NEW: true when drive times are straight-line estimates (Haversine)
  geocode(address: string): Promise<LatLng | null>;   // null = "no such place"; MAY THROW for "couldn't ask"
  driveTime(origin: LatLng, dest: LatLng): Promise<DriveTime | null>;   // never throws
}

class MapsProviderError extends Error {
  readonly name = "MapsProviderError";
  readonly kind: "timeout" | "network" | "http" | "denied" | "quota" | "invalid" | "unknown";
  readonly status?: string;     // Google's status string, when there was one
}

interface GoogleMapsProviderOptions {
  apiKey: string;
  fetch?: typeof fetch;          // default globalThis.fetch
  timeoutMs?: number;            // per request, default 4000 (AbortSignal.timeout)
  region?: string;               // geocoding bias, e.g. "us"
  components?: string;           // geocoding filter, e.g. "country:US"
  departureTime?: "now";         // ask for duration_in_traffic; default: typical (traffic-free) duration
  onError?: (error: MapsProviderError) => void;
}
createGoogleMapsProvider(options): MapsProvider      // geocodes: true, estimates: false
selectMapsProvider(options: { googleMapsApiKey?: string | null; db?: SchedulingDb; fetch?: typeof fetch; cache?: CachedMapsOptions })
  : MapsProvider
// key + db → createCachedMapsProvider(google, db); key only → google uncached; no key → Haversine
```

- **Geocode.** `GET https://maps.googleapis.com/maps/api/geocode/json?address=<enc>&key=<key>[&region=][&components=]`.
  - `status: "OK"` returns `results[0].geometry.location`.
  - `"ZERO_RESULTS"` returns `null`.
  - Everything else throws `MapsProviderError` and calls `onError`:
    `OVER_QUERY_LIMIT` (quota), `REQUEST_DENIED` (denied),
    `INVALID_REQUEST` (invalid), `UNKNOWN_ERROR`, a non-2xx response, a
    timeout, or a network failure.
  - A blank address returns `null` with no request.
- **Distance Matrix.** `GET https://maps.googleapis.com/maps/api/distancematrix/json?origins=<lat>,<lng>&destinations=<lat>,<lng>&mode=driving&units=imperial&key=<key>[&departure_time=now]`.
  - With both the top-level status and `rows[0].elements[0].status` equal to
    `OK`, it returns
    `{ durationMinutes: round((duration_in_traffic ?? duration).value / 60), distanceMiles: round1(distance.value / 1609.344) }`.
  - Anything else returns `null`, after calling `onError` for transport and
    status errors. It never throws.
- **The key never leaves the server.** It must not appear in an error message,
  an `onError` payload, a log line or a thrown error's `message`, because the
  URLs carry it. Build messages from the status and kind only. Test this.
- **Haversine** gains `estimates: true`. **`createCachedMapsProvider`** passes
  `geocodes` and `estimates` through.
- **No SDK and no new dependency.** Raw `fetch` only.

### 3.10 Calendar, crew day, staff finder, backfill

These read models return the section 7 wire shapes directly, with strings
for dates and instants. A handler serializes them as they are, and there is
one mapping, not two.

```ts
listCalendar(db, tenantId, { from: DateString, to: DateString, resourceIds?: string[], includeInactive?: boolean },
             options?: { now?; settings? }): Promise<CalendarResponse>
listCrewDay(db, tenantId, { resourceId, date: DateString }, options?: { maps?; now?; settings? })
  : Promise<CrewDayResponse | null>
getAvailabilitySummary(db, tenantId, resourceId, options?: { now?; settings? }): Promise<AvailabilityResponse | null>
findAvailableSlots(db, { ...0.3 fields, notBefore?: Date }, maps?)   // NEW notBefore: drop starts before this instant
backfillVisitInstants(db, tenantId): Promise<number>                // rows updated
toVisitSnapshot(row, { settings, resourceName }): VisitSnapshot      // pure; the one row→wire mapping
```

**`listCalendar`**

- The range must be at most 42 days; a longer one is a ZodError (`invalid`).
- It uses a fixed number of queries, however many crews and days: settings,
  crews, hours, the range's visits, and the pending list. Five queries, and a
  test counts them.
- `resources` are the active crews by name, plus any inactive crew that owns a
  visit in the range (`isActive: false`). With `resourceIds`, the list
  narrows to those.
- `windows` gives `resolveDayWindows` for each crew and date.
- `visits` holds every visit in the range in `pending`, `confirmed`,
  `in_progress`, `completed` or `no_show`. With `includeInactive`, cancelled,
  declined and expired visits are added. Unassigned visits are included, with
  `resourceId: null`.
- `pending` holds every pending, not-overdue visit from today on, soonest
  first, at most 50, whatever the range. It is the request inbox.
- `today` is `todayIn(now, zone)`.

**`listCrewDay`**

- It returns `null` when the crew isn't the tenant's.
- `stops` are the crew's visits that day in `confirmed`, `in_progress`,
  `completed` or `no_show`, ordered by start time and then `created_at`.
  Pending requests aren't on a route.
- `driveFromPrevious`:
  - From the crew's home base for stop 1 (`from: "home_base"`). That is null
    when the base has no coordinates.
  - From the previous stop for every later stop.
  - Null when either end has no coordinates.
  - Drive times come through `maps`, so they are cached when the provider is
    the cached Google one.
  - `estimated` is `maps.estimates === true`.
- `totals` sums the non-null drives. Its `estimated` is true if any drive was
  estimated.
- `directionsUrl` is
  `https://www.google.com/maps/dir/?api=1&destination=<encodeURIComponent(address or "lat,lng")>&travelmode=driving`,
  or null when the stop has neither.
- `routeUrl` adds `origin` (the home base, when known) and `waypoints`
  (`|`-joined, at most 9). It is null when fewer than one stop has a place.
  Neither URL needs a key.
- `telUrl` is `tel:` plus the digits and a leading `+` from `customerPhone`,
  or null.

### 3.11 Errors

`BookingNotBookableError.code` (`BookingRefusalCode`) gains four codes:

| Code | Path | Means |
| --- | --- | --- |
| `booking_closed` | public | The business has online booking off. |
| `unknown_service` | public | No such service key. |
| `too_late` | customer manage | Inside the cutoff, or the visit is past or already done. |
| `not_changeable` | staff move/assign | The status doesn't allow it. |

`BookingStatusTransitionError` is unchanged. A malformed input is a `ZodError`.
Everything else bubbles up, and the handlers turn it into `internal` 500 with
a fixed message, never the error's own text.

---

## 4. HTTP handlers (server builder)

Both factories mirror `createBookingHandlers`:

- one `handle(req)`, routed by path suffix, so it can be mounted at any base
  with a catch-all route;
- `Cache-Control: no-store` on every response;
- a JSON body of at most 20,000 characters, `text/plain` accepted;
- the error body `{ error: { code, message, issues? } }`;
- `issues` that never echo input values.

Copy `isCrossSiteRequest` from booking's `handlers.ts` into a shared
`src/http.ts`, with the "change both or neither" note.

### 4.1 Public: `createSchedulingHandlers`

```ts
interface CreateSchedulingHandlersOptions {
  db: SchedulingDb;
  tenantId?: string;                                        // give this or resolveTenant
  resolveTenant?: (req: Request) => string | null | Promise<string | null>;   // null → 404
  manageUrl: (token: string, tenantId: string) => string;   // the customer's manage page
  maps?: MapsProvider;                                      // default Haversine
  onEvent?: SchedulingEventListener;
  onEventError?: (error: unknown, event: SchedulingEvent) => void;
  rateLimit?: (req: Request, bucket: "read" | "request" | "manage") => boolean | Promise<boolean>;
  requesterKey?: (req: Request) => string | null | Promise<string | null>;   // default clientIpKey
  minFillMs?: number;               // default 2000; 0 turns the fill-time check off
  cors?: string;                    // as booking: omitted → same-origin only, cross-site POSTs refused
  emailsEnabled?: boolean;          // default true; echoed in config
  uidDomain?: string;               // .ics UID domain; default "scheduling.adminigloo"
  sweepExpired?: boolean;           // default true (3.4)
  now?: () => Date;
}
createSchedulingHandlers(options): { handle(req: Request): Promise<Response> }
clientIpKey(req: Request): string | null   // "ip:" + first x-forwarded-for entry, else x-real-ip, else null
```

Order of work for each request:

1. OPTIONS returns 204, with the CORS headers when configured.
2. Cross-site POST check (403 `forbidden`).
3. Route match (404 `not_found`).
4. Tenant (404).
5. `rateLimit` (429 `rate_limited`).
6. The settings are read once, then dispatch.

| Method and path (suffix) | Bucket | Request | 2xx response |
| --- | --- | --- | --- |
| `GET {base}/v1/config` | read | none | `PublicConfig` |
| `GET {base}/v1/slots?service=&from=&days=&manage=` | read | query | `SlotsResponse` |
| `POST {base}/v1/request` | request | `VisitRequestBody` | 201 `VisitRequestResponse`, or 200 with `repeated: true` |
| `GET {base}/v1/visit/:token` | read | none | `VisitResponse` |
| `POST {base}/v1/visit/:token/reschedule` | manage | `RescheduleVisitBody` | `VisitResponse` |
| `POST {base}/v1/visit/:token/cancel` | manage | `CancelVisitBody` | `VisitResponse` |
| `GET {base}/v1/visit/:token/ics` | read | none | `text/calendar` attachment `visit.ics` |

Route details:

- **Token routes.** Any route with a token in the path, plus `slots` when
  `manage` is present, adds `Referrer-Policy: no-referrer` and
  `X-Robots-Tag: noindex`.
- **`slots`.**
  - `days` defaults to 14, with a maximum of 31. `from` defaults to today in
    the tenant zone.
  - A malformed `from` or `days` is 400 `invalid`.
  - A missing `service` with no usable `manage` token is 400 `invalid`. An
    unknown service is 400 `unknown_service`.
  - With booking closed it answers 200 with `closed: true` and `slots: []`.
- **`request`.**
  - The body is zod-parsed (`issues` paths are wire names).
  - **Spam check, before any DB work.** A non-empty `website` (the honeypot)
    or a `fillMs` under `minFillMs` (missing counts as 0) is 400
    `spam_suspected`, with the message "That was quicker than a person can
    fill in the form. Please check your details and send it again."
  - The sweep runs if it is due.
  - Then it calls `requestPublicBooking` with `service`, the requester key,
    `onEvent` and `maps`.
  - `manageUrl` is `options.manageUrl(token, tenantId)`.
- **`ics`.** `METHOD:PUBLISH` while the visit stands, `CANCEL` once it is
  cancelled, declined or expired.
  - UID: `${visitId}@${uidDomain}`.
  - SEQUENCE: the row's `sequence`.
  - STATUS: `TENTATIVE` for pending, `CONFIRMED`, or `CANCELLED`.
  - SUMMARY: `"<serviceName> — <businessName>"`.
  - LOCATION: the address.
  - DESCRIPTION: the manage link.
  - Port `formatIcsUtc`, `escapeIcsText` and `foldLine` from booking's
    `ics.ts` (CRLF and folding are not optional).

Error code to HTTP status, for both factories:

| Code | Status | | Code | Status |
| --- | --- | --- | --- | --- |
| `invalid` | 400 | | `slot_unavailable` | 409 |
| `spam_suspected` | 400 | | `too_late` | 409 |
| `too_soon`, `too_far` | 400 | | `not_changeable` | 409 |
| `invalid_duration`, `unknown_service` | 400 | | `transition_not_allowed` | 409 |
| `address_unresolved` | 400 | | `forbidden` | 403 |
| `outside_hours`, `invalid_window`, `resource_unavailable` | 400 | | `booking_closed` | 403 |
| `not_found` | 404 | | `rate_limited`, `too_many_requests` | 429 |
| | | | `internal` | 500 |

`BookingStatusTransitionError` maps to `transition_not_allowed`. A ZodError
maps to `invalid` with `issues`. A staff refusal's `message` is the
validator's reason.

### 4.2 Staff: `createSchedulingAdminHandlers`

```ts
type AuthorizeResult = boolean | { userId?: string | null } | Response;
interface CreateSchedulingAdminHandlersOptions {
  db: SchedulingDb;
  tenantId?: string;
  resolveTenant?: (req: Request) => string | null | Promise<string | null>;
  authorize: (req: Request, permission: SchedulingPermission, tenantId: string) => AuthorizeResult | Promise<AuthorizeResult>;
  maps?: MapsProvider;
  onEvent?: SchedulingEventListener;
  onEventError?: (error: unknown, event: SchedulingEvent) => void;
  currentResourceId?: (req: Request, tenantId: string, userId: string | null) => string | null | Promise<string | null>;
  sweepExpired?: boolean;    // default true: the calendar route sweeps (throttled)
  now?: () => Date;
}
createSchedulingAdminHandlers(options): { handle(req: Request): Promise<Response> }
```

Order of work for each request:

1. OPTIONS returns 204, with **no CORS headers ever**.
2. Every POST must pass the same-site check (403).
3. Route match (404), then tenant (404).
4. `authorize(req, key, tenantId)`:
   - `false` gives 403 `forbidden` ("You don't have permission to do that.");
   - a `Response` is returned as is (a host's 401);
   - `true` or an object passes, and `userId` becomes the event actor's `id`.
5. Dispatch.

Every route is under `{base}/v1/admin/`. Event actor is `{ type: "staff", id: userId ?? null }`.

| Method and path | Permission | Request | 2xx response |
| --- | --- | --- | --- |
| `GET …/calendar?from=&to=&resources=a,b&include=inactive` | `schedule.view` | query | `CalendarResponse` |
| `GET …/crew-day?date=&resource=` | `schedule.view` | query | `CrewDayResponse` |
| `GET …/suggest?service=&minutes=&address=&lat=&lng=&from=&days=&resource=` | `schedule.view` | query | `SuggestResponse` |
| `POST …/visits` | `schedule.manage` | `CreateVisitBody` | 201 `VisitMutationResponse` |
| `GET …/visits/:id` | `schedule.view` | none | `{ visit: VisitSnapshot }` |
| `POST …/visits/:id/accept` | `schedule.manage` | `AcceptBody` | `{ visit }` |
| `POST …/visits/:id/decline` | `schedule.manage` | `DeclineBody` | `{ visit }` |
| `POST …/visits/:id/status` | `schedule.manage` | `StatusBody` | `{ visit }` |
| `POST …/visits/:id/reschedule` | `schedule.manage` | `RescheduleBody` | `VisitMutationResponse` |
| `POST …/visits/:id/assign` | `schedule.manage` | `AssignBody` | `VisitMutationResponse` |
| `POST …/visits/:id/details` | `schedule.manage` | `DetailsBody` | `VisitMutationResponse` |
| `POST …/expire` | `schedule.manage` | none | `ExpireResponse` |
| `GET …/settings` | `schedule.view` | none | `{ settings: SettingsWire }` |
| `POST …/settings` | `schedule.resources.manage` | `SettingsPatch` | `{ settings: SettingsWire }` |
| `GET …/resources?include=inactive` | `schedule.view` | query | `{ resources: AdminResource[] }` |
| `POST …/resources` | `schedule.resources.manage` | `ResourceInput` | 201 `{ resource }` |
| `POST …/resources/:id` | `schedule.resources.manage` | `Partial<ResourceInput>` | `{ resource }` |
| `POST …/resources/:id/deactivate` | `schedule.resources.manage` | none | `{ resource }` |
| `POST …/resources/:id/reactivate` | `schedule.resources.manage` | none | `{ resource }` |
| `GET …/resources/:id/availability` | `schedule.view` | none | `AvailabilityResponse` |
| `POST …/resources/:id/availability` | `schedule.resources.manage` | `SetWeeklyBody` | `AvailabilityResponse` (saved with `scope: "weekly"`) |
| `POST …/resources/:id/time-off` | `schedule.resources.manage` | `AddTimeOffBody` | `TimeOffResponse` |
| `POST …/resources/:id/time-off/:exceptionId/remove` | `schedule.resources.manage` | none | `AvailabilityResponse` |

Route details:

- **`crew-day` without `resource`** uses `currentResourceId(req, tenantId, userId)`.
  The default is the active crew whose `userId` equals the authorized
  `userId`. If none matches, it is 400 `invalid` with the message "Pick a
  crew."
- **`suggest`** calls `findAvailableSlots` with `notBefore: now`.
  - The duration comes from `service` or `minutes`. `days` is at most 14.
  - It returns the best-scored 20, as `StaffSlot`s. This is staff-only data,
    and the only route that returns other customers' addresses.
- **`accept`** is `setBookingStatus(confirmed)`. **`decline`** is
  `setBookingStatus(declined, reason)`. **`status`** is the general move. Each
  re-reads the visit and returns it.
- **`visits` POST** calls `bookVisit`.
  - `date` and `startTime`/`endTime` are business-zone wall-clock values.
  - `service` sets `serviceType` and, when `endTime` is omitted, the duration.
- **`notify`** defaults to true on every mutation body that has it, and is
  passed through to the event.

---

## 5. Events (server builder; the comms listener and any host rely on this)

### 5.1 The envelope

```ts
type SchedulingEventType =
  | "visit.requested" | "visit.confirmed" | "visit.declined" | "visit.rescheduled" | "visit.reassigned"
  | "visit.cancelled" | "visit.expired" | "visit.started" | "visit.completed";

interface SchedulingActor { type: "customer" | "staff" | "system"; id: string | null }

interface SchedulingEvent {
  id: string;              // newId() from @adminigloo/db: unique per event. Use it as an idempotency key.
  type: SchedulingEventType;
  tenantId: string;
  visitId: string;
  occurredAt: string;      // ISO instant: the action's `now`
  actor: SchedulingActor;
  data: {
    visit: VisitSnapshot;          // the visit AFTER the change (section 7)
    notify: boolean;               // should the customer be told?
    via?: "online" | "staff" | "auto" | "accept" | "restore" | "time_zone";
    previous?: {                   // rescheduled, reassigned
      date: string; startTime: string; endTime: string; startsAt: string; endsAt: string;
      resourceId: string | null; resourceName: string | null;
    };
    reason?: string | null;        // declined, cancelled
  };
}
type SchedulingEventListener = (event: SchedulingEvent) => void | Promise<void>;
```

### 5.2 Guarantees

- **After commit.** The listener runs only after the transaction has
  committed, so a read inside it sees the new state (test this).
- **Awaited, in order.** A serverless response must not end before the email
  is queued. When one action emits two events (auto-confirm), they run one
  after the other.
- **Contained.** A throwing or rejecting listener never fails the action. It
  is caught, and `onEventError(error, event)` is called if given.
- **No secrets.** No manage token, token hash or `requesterKey` ever appears
  in an event. Events are safe to log or queue.
- **No event for a no-op**: a repeat, re-asserting a status, or a move to the
  same time and crew.
- **`notify` defaults:**
  - `true`: requested, confirmed, declined, rescheduled, reassigned,
    cancelled, expired.
  - `false`: started, completed, and any time-zone reschedule.
  - Staff mutations take it from the body or options.

| Type | Emitted by | Actor | `via` |
| --- | --- | --- | --- |
| `visit.requested` | `requestPublicBooking` | customer | `online` |
| `visit.requested` | `bookVisit` (pending) | staff | `staff` |
| `visit.confirmed` | `requestPublicBooking` (auto-confirm) | system | `auto` |
| `visit.confirmed` | `bookVisit` (confirmed) | staff | `staff` |
| `visit.confirmed` | `setBookingStatus` | staff | `accept` or `restore` |
| `visit.declined` | `setBookingStatus` | staff | |
| `visit.rescheduled` | `rescheduleBooking` (staff), `rescheduleVisitByToken` (customer), `updateSchedulingSettings` (staff) | as noted | settings: `time_zone` |
| `visit.reassigned` | `assignBooking`; `rescheduleBooking` with only the crew changed | staff | |
| `visit.cancelled` | `setBookingStatus` (staff), `cancelVisitByToken` (customer) | as noted | |
| `visit.expired` | `expirePendingRequests` | system | |
| `visit.started`, `visit.completed` | `setBookingStatus` | staff | |

---

## 6. `@adminigloo/scheduling/comms` (server builder)

`@adminigloo/comms` is an optional peer; only this entry imports it.

```ts
interface SchedulingCommsOptions {
  db: SchedulingDb;                          // comms tables live in the same database
  senders: CommsSenders;                     // from @adminigloo/comms
  manageUrl: (token: string, tenantId: string) => string;
  bookUrl?: string;                          // "pick another time" link; default: no line
  adminUrl?: string;                         // the staff calendar, in staff notices
  staffEmails?: readonly string[];           // used when settings.staffNotifyEmails is empty
  locale?: string;                           // default "en-US"
  reminders?: boolean;                       // default true
  now?: () => Date;
  onError?: (error: unknown, context: { visitId: string; eventId?: string; step: string }) => void;
}
interface SchedulingCommsListener {
  onEvent: SchedulingEventListener;                                     // never throws
  beforeSend(row: ScheduledRow): Promise<BeforeSendResult | null>;     // null → not a scheduling row
  redactSent(): Promise<number>;                                       // run after runDueMessages
  ensureTemplates(tenantId: string): Promise<number>;                  // insert-if-absent; returns how many were added
}
createSchedulingCommsListener(options): SchedulingCommsListener
SCHEDULING_EMAIL_TEMPLATES: ReadonlyArray<{ key: SchedulingTemplateKey; audience: "customer" | "staff"; subject: string; body: string }>
SCHEDULING_COMMS_REF_TYPE = "scheduling_visit"
schedulingEmailVars(event: SchedulingEvent, settings: SchedulingSettings, options: { manageUrl: string | null; bookUrl?; adminUrl?; locale? })
  : Record<string, string>                                              // pure, exported for tests and for hosts with their own mailer
```

The comms tenant IS the scheduling tenant. Templates, sends and the queue all
use `event.tenantId`.

### 6.1 What each event sends

The customer email goes only when `data.notify` is true AND the visit has a
`customerEmail`. Staff notices go to `settings.staffNotifyEmails`, or
`options.staffEmails` when that list is empty, and never for a change staff
made themselves.

| Event | Customer template | Staff notice | Reminder |
| --- | --- | --- | --- |
| requested, visit pending | `visit_requested` (with link) | "New request" | none |
| requested, visit confirmed (auto) | none (the confirmed event emails) | "New booking" | none |
| confirmed | `visit_confirmed` (with link) | none | queue |
| declined | `visit_declined` | none | withdraw |
| rescheduled | `visit_rescheduled` (with link) | "Visit moved", if the actor is the customer | withdraw, then queue |
| reassigned | `visit_reassigned` (with link) | none | none (still valid: no sequence bump) |
| cancelled | `visit_cancelled` | "Visit cancelled", if the actor is the customer | withdraw |
| expired | `visit_expired` | none | withdraw |
| started, completed | none | none | none |

- **Withdraw first**, before any send:
  `cancelScheduled(db, { tenantId, refType: SCHEDULING_COMMS_REF_TYPE, refId: visitId })`.
  A failed send must never leave a stale reminder behind.
- **Each step is isolated.** Each send, the withdrawal and the queueing runs in
  its own try/catch, reporting through `onError`. One failure doesn't stop the
  others, and `onEvent` never rejects.
- **"With link"** means mint a fresh token (`issueManageToken`) and
  `manageUrl = options.manageUrl(token, tenantId)`. Then send with comms
  `sendNow`, using `idempotencyKey: "visit:" + visitId + ":" + event.id + ":customer"`.
  (Staff sends use `":staff:" + i`.)
- **Then redact the delivery log.** Update that one `comms_messages` row,
  filtered by tenant and id, replacing the exact token string with `:token` in
  `subject` and `body` (SQL `replace()`). The plaintext key sits in the log
  only for the moment between the insert and this update. The testbed's
  `site-booking.ts` does this already; here it is exact-string, not regex.
- **`ensureTemplates(tenantId)`** runs once per tenant per process, before
  that tenant's first send. It inserts the nine templates with
  `onConflictDoNothing` on `(tenant_id, key)`, so an owner's edits in the
  comms admin are never overwritten.

### 6.2 The reminder

- It is queued when all of these hold:
  - `options.reminders !== false`;
  - `settings.reminderLeadHours > 0`;
  - the visit is `confirmed` and has `customerEmail`;
  - `sendAt = startsAt − reminderLeadHours` is more than an hour from now (a
    reminder minutes after the confirmation is noise).
- Enqueue fields:
  - `templateKey: "visit_reminder"`, `channel: "email"`, `sendAt`.
  - `expiresAt = max(sendAt + 1 min, startsAt − 30 min)`.
  - `refType: SCHEDULING_COMMS_REF_TYPE`, `refId: visitId`.
  - `dedupeKey: "visit:" + visitId + ":reminder:" + sequence`.
  - `vars`: the link-free variables. `manageUrl` is empty, and `manageLine` is
    the fallback "Need to change it? Use the link in your confirmation email."
    A queued row sits in a table for a day, so it must not hold a key.
- **`beforeSend(row)`**, at send time:
  - It returns `null` unless `row.refType === SCHEDULING_COMMS_REF_TYPE`.
  - It loads the visit by `(row.tenantId, row.refId)` and skips with a reason
    when:
    - the visit is gone;
    - its status isn't `confirmed`;
    - the dedupe key's sequence isn't the visit's sequence ("the visit has
      moved since this reminder was queued");
    - it starts within 30 minutes.
  - Otherwise it mints a token and returns
    `{ vars: { manageUrl, manageLine } }` with the real link, and remembers
    `(row.id, token)` in memory.
- **`redactSent()`**, called right after `runDueMessages`:
  - For each remembered pair it replaces the token in `comms_messages` rows
    `WHERE tenant_id = $t AND scheduled_id = $rowId`, whatever their status.
  - It clears the memory and returns how many rows changed.
  - **Why:** the reminder gets a working link without a key ever sitting in
    the queue, and the delivery log never keeps one.
- **Timing caveat.** The cron's cadence decides when a due reminder actually
  goes. Daily on Vercel Hobby, every 15 minutes on Pro. The subject says
  "Reminder", never "tomorrow".

### 6.3 Templates (plain text; `{{vars}}`; whole-line variables may be empty and fold away)

Keys: `visit_requested`, `visit_confirmed`, `visit_declined`,
`visit_rescheduled`, `visit_reassigned`, `visit_cancelled`, `visit_expired`,
`visit_reminder`, `visit_staff_notice`. Use these words. They speak as the
business, and promise nothing the package can't see happen.

```
visit_requested    "We got your request: {{serviceName}}, {{shortWhen}}"
Hi {{firstName}},

Thanks, your request for a {{serviceName}} is in. We'll confirm it soon and email you when we do.

Requested time: {{when}}
Where: {{address}}

{{manageLine}}

{{contactLine}}

{{businessName}}

visit_confirmed    "Confirmed: {{serviceName}}, {{shortWhen}}"
Hi {{firstName}},

{{confirmLine}}

When: {{when}}
Where: {{address}}

{{manageLine}}

{{contactLine}}

{{businessName}}

visit_declined     "We can't make {{shortWhen}}"
Hi {{firstName}},

Sorry, we can't do your {{serviceName}} at {{when}}.
{{reasonLine}}

{{bookLine}}

{{contactLine}}

{{businessName}}

visit_rescheduled  "New time: {{serviceName}}, {{shortWhen}}"
Hi {{firstName}},

{{rescheduleLine}}

New time: {{when}}
Was: {{previousWhen}}
Where: {{address}}

{{manageLine}}

{{contactLine}}

{{businessName}}

visit_reassigned   "Update to your {{serviceName}}, {{shortWhen}}"
Hi {{firstName}},

{{crewName}} from our team will now be doing your {{serviceName}}. The time hasn't changed.

When: {{when}}
Where: {{address}}

{{manageLine}}

{{businessName}}

visit_cancelled    "Cancelled: {{serviceName}}, {{shortWhen}}"
Hi {{firstName}},

{{cancelLine}}
{{reasonLine}}

{{bookLine}}

{{contactLine}}

{{businessName}}

visit_expired      "We couldn't confirm {{shortWhen}} in time"
Hi {{firstName}},

Sorry, we weren't able to confirm your request for a {{serviceName}} at {{when}} in time, so we've released it.

{{bookLine}}

{{contactLine}}

{{businessName}}

visit_reminder     "Reminder: {{serviceName}}, {{shortWhen}}"
Hi {{firstName}},

A reminder of your {{serviceName}}.

When: {{when}}
Where: {{address}}

{{manageLine}}

{{contactLine}}

{{businessName}}

visit_staff_notice "{{subjectTag}}: {{customerName}}, {{shortWhen}}"
{{headline}}

When: {{when}}
{{previousLine}}
Service: {{serviceName}}
Crew: {{crewName}}

Who: {{customerName}}
Email: {{customerEmail}}
Phone: {{customerPhone}}
Where: {{address}}
Notes: {{notes}}

Your schedule: {{adminUrl}}
```

The variables (all strings; an unknown value renders as "—" in staff notices
and as empty in customer emails):

- **Names and service.**
  - `firstName`: the first word of the customer's name, else "there".
  - `customerName`, `businessName` and `serviceName`.
  - `crewName`: the resource name, else "our team".
- **Times.**
  - `when`: `Intl.DateTimeFormat(locale, { weekday:"long", month:"long", day:"numeric", year:"numeric", hour:"numeric", minute:"2-digit", timeZone, timeZoneName:"short" }).formatRange(startsAt, endsAt)`,
    for example "Monday, November 2, 2026, 9:00 – 10:00 AM MST".
  - `shortWhen`: "Mon, Nov 2, 9:00 AM MST".
  - `previousWhen` and `previousLine` ("Was: …"): only for a reschedule.
  - All times are in the business zone.
- **Address and contact.**
  - `address`, `notes`, `customerEmail` and `customerPhone`.
  - `contactLine`, by which contacts exist:
    - both: "Questions? Call {{phone}} or email {{email}}."
    - phone only: "Questions? Call {{phone}}."
    - email only: "Questions? Email {{email}}."
    - neither: empty.
- **Links.**
  - `manageUrl`.
  - `manageLine`: "Need to change it? Reschedule or cancel here, no account
    needed (up to {{cutoffText}} before the visit):\n{{manageUrl}}".
    `cutoffText` is "24 hours", "1 hour", or "the start" for 0.
  - `bookLine`: "If you'd like another time, pick one here: {{bookUrl}}",
    empty without `bookUrl`.
- **Lines that depend on who acted.**
  - `confirmLine`:
    - auto: "You're booked. Your {{serviceName}} is on our schedule."
    - accept: "Good news: we've confirmed your {{serviceName}}."
    - staff: "We've booked your {{serviceName}}."
    - restore: "Your {{serviceName}} is back on our schedule."
  - `rescheduleLine`:
    - customer: "Your {{serviceName}} has moved, as you asked."
    - staff: "We had to move your {{serviceName}}. Sorry for the change."
  - `cancelLine`:
    - customer: "Your {{serviceName}} on {{when}} is cancelled, as you asked."
    - staff: "We had to cancel your {{serviceName}} on {{when}}. Sorry for the change."
  - `reasonLine`: `Note from us: "<reason>"`, only when staff gave a reason.
- **Staff notice lines.**
  - `subjectTag`, `headline`:
    - "New request": "{{customerName}} asked for a {{serviceName}}. Accept or
      decline it in your schedule. If nobody answers by {{expiresWhen}}, the
      request is released and they're told."
    - "New booking": "{{customerName}} booked a {{serviceName}} online."
    - "Visit moved": "{{customerName}} moved their {{serviceName}}."
    - "Visit cancelled": "{{customerName}} cancelled their {{serviceName}}."
  - `expiresWhen` is `pending_expires_at` as a `shortWhen`.
  - `adminUrl` comes from the options; its line is empty without it.

---

## 7. The wire types (BOTH builders: declare these verbatim)

The server's are in `src/wire.ts`, exported from the barrel. The widget's are
in `src/types.ts` and `src/admin/types.ts`, exported from its entries. No
package imports the other. Field names, optionality and enums must match
character for character. Dates and instants are always strings on the wire.

```ts
// ---- scalars ---------------------------------------------------------------
export type DateString = string;   // "YYYY-MM-DD": a calendar date in the business's zone
export type TimeOfDay = string;    // "HH:MM", 24-hour, zero-padded; an end may be "24:00"
export type Instant = string;      // ISO 8601 UTC: "2026-11-02T16:00:00.000Z"

export type VisitStatus =
  | "pending" | "confirmed" | "in_progress" | "completed" | "cancelled" | "declined" | "expired" | "no_show";
export type PublicVisitStatus =
  | "requested" | "confirmed" | "in_progress" | "completed" | "cancelled" | "declined" | "expired" | "missed";
// PublicVisitStatus from VisitStatus: pending→requested, no_show→missed, the rest the same.

export type WireErrorCode =
  | "invalid" | "spam_suspected" | "not_found" | "forbidden" | "rate_limited" | "too_many_requests"
  | "booking_closed" | "slot_unavailable" | "too_soon" | "too_far" | "invalid_duration" | "unknown_service"
  | "address_unresolved" | "too_late" | "outside_hours" | "invalid_window" | "resource_unavailable"
  | "not_changeable" | "transition_not_allowed" | "internal";
export interface WireIssue { path: Array<string | number>; message: string; code?: string }
export interface WireErrorBody { error: { code: WireErrorCode; message: string; issues?: WireIssue[] } }

// ---- public (createSchedulingHandlers) ---------------------------------------
export interface PublicService { key: string; name: string; description: string | null; durationMinutes: number }

export interface PublicConfig {
  businessName: string;
  timeZone: string;                 // IANA
  publicBookingEnabled: boolean;
  autoConfirm: boolean;
  services: PublicService[];
  minNoticeMinutes: number;
  horizonDays: number;
  requireAddress: boolean;
  cancelCutoffHours: number;
  contactEmail: string | null;
  contactPhone: string | null;
  emailsEnabled: boolean;           // false: never promise an email; show the manage link to keep
  minFillMs: number;                // the server's fill-time floor; 0 = off
}

export interface PublicSlot {
  slotId: string;                   // opaque; send back as is
  date: DateString; startTime: TimeOfDay; endTime: TimeOfDay;
  startsAt: Instant; endsAt: Instant;
}
export interface SlotsResponse {
  timeZone: string; service: string; from: DateString; to: DateString;
  closed: boolean;                  // online booking is off
  slots: PublicSlot[];              // time order
}

export interface VisitRequestBody {
  slotId: string;
  service: string;
  name: string;                     // 1–200
  email: string;                    // ≤ 320, an email
  phone?: string;                   // ≤ 60
  address?: string;                 // ≤ 500; required when config.requireAddress
  notes?: string;                   // ≤ 2000
  estimateId?: string;              // ≤ 200
  website?: string;                 // honeypot: must be empty or absent
  fillMs?: number;                  // ms between the details form appearing and submit
}

export interface PublicVisit {
  status: PublicVisitStatus;
  serviceKey: string;
  serviceName: string;
  date: DateString; startTime: TimeOfDay; endTime: TimeOfDay;
  startsAt: Instant; endsAt: Instant;
  timeZone: string;
  durationMinutes: number;
  customerName: string;
  address: string | null;
  businessName: string;
  contactPhone: string | null;
  contactEmail: string | null;
  canReschedule: boolean;
  canCancel: boolean;
  changeDeadline: Instant | null;   // startsAt − cutoff; null once the visit isn't pending/confirmed
  cancelCutoffHours: number;
  cancelledBy: "customer" | "business" | null;   // staff and system both read as "business"
  googleCalendarUrl: string | null; // null once cancelled/declined/expired
}
export interface VisitRequestResponse { visit: PublicVisit; manageToken: string; manageUrl: string; repeated: boolean }
export interface VisitResponse { visit: PublicVisit }
export interface RescheduleVisitBody { slotId: string }
export interface CancelVisitBody { reason?: string }   // ≤ 500

// ---- staff (createSchedulingAdminHandlers) -----------------------------------
export interface VisitSnapshot {
  id: string;
  status: VisitStatus;
  nextStatuses: VisitStatus[];      // staff-settable moves from here (never "expired")
  date: DateString; startTime: TimeOfDay; endTime: TimeOfDay;
  startsAt: Instant; endsAt: Instant;
  timeZone: string;
  durationMinutes: number;
  resourceId: string | null;
  resourceName: string | null;
  serviceKey: string;
  serviceName: string;
  title: string | null;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  notes: string | null;
  estimateId: string | null;
  origin: "public" | "staff";
  sequence: number;
  pendingExpiresAt: Instant | null;
  cancelledAt: Instant | null;
  cancelledBy: "customer" | "staff" | "system" | null;
  cancelReason: string | null;
  startedAt: Instant | null;
  completedAt: Instant | null;
  createdAt: Instant;
  updatedAt: Instant;
}

export interface CalendarResource {
  id: string; name: string; isActive: boolean; acceptsPublicBookings: boolean; maxJobsPerDay: number;
}
export interface DayWindows { resourceId: string; date: DateString; windows: Array<{ start: TimeOfDay; end: TimeOfDay }> }
export interface CalendarResponse {
  timeZone: string; today: DateString; from: DateString; to: DateString;
  slotStepMinutes: number;
  resources: CalendarResource[];
  windows: DayWindows[];
  visits: VisitSnapshot[];
  pending: VisitSnapshot[];          // the request inbox: pending from today on, soonest first, ≤ 50
}

export interface CrewStop {
  order: number;                     // 1-based
  visit: VisitSnapshot;
  driveFromPrevious: { minutes: number; miles: number; from: "home_base" | "previous_stop"; estimated: boolean } | null;
  directionsUrl: string | null;
  telUrl: string | null;
}
export interface CrewDayResponse {
  timeZone: string; date: DateString; today: DateString;
  resource: { id: string; name: string; homeBaseAddress: string | null };
  windows: Array<{ start: TimeOfDay; end: TimeOfDay }>;
  stops: CrewStop[];
  totals: { visits: number; driveMinutes: number; distanceMiles: number; estimated: boolean };
  routeUrl: string | null;
}

export interface StaffSlot {
  date: DateString; startTime: TimeOfDay; endTime: TimeOfDay; startsAt: Instant; endsAt: Instant;
  resourceId: string; resourceName: string;
  driveMinutesFromPrevious: number | null;
  previousJobAddress: string | null;
  score: number;
}
export interface SuggestResponse { timeZone: string; estimated: boolean; slots: StaffSlot[] }   // best first, ≤ 20

export interface CreateVisitBody {
  resourceId: string | null;
  date: DateString; startTime: TimeOfDay; endTime?: TimeOfDay;    // endTime omitted → service duration (or 60)
  service?: string;
  title?: string; customerName?: string; customerEmail?: string; customerPhone?: string;
  address?: string; lat?: number; lng?: number; notes?: string; estimateId?: string;
  status?: "pending" | "confirmed";   // default "confirmed"
  notify?: boolean;                   // default true
}
export interface VisitMutationResponse { visit: VisitSnapshot; warnings: string[] }
export interface AcceptBody { notify?: boolean }
export interface DeclineBody { reason?: string; notify?: boolean }
export interface StatusBody { status: Exclude<VisitStatus, "expired">; reason?: string; notify?: boolean }
export interface RescheduleBody { date: DateString; startTime: TimeOfDay; endTime?: TimeOfDay; resourceId?: string; notify?: boolean }
export interface AssignBody { resourceId: string; notify?: boolean }
export interface DetailsBody {
  title?: string | null; serviceType?: string; customerName?: string | null; customerEmail?: string | null;
  customerPhone?: string | null; address?: string | null; notes?: string | null; estimateId?: string | null;
}
export interface ExpireResponse { expired: number }

export interface ServiceWire { key: string; name: string; durationMinutes: number; description: string | null; requiredSkill: string | null }
export interface SettingsWire {
  timeZone: string; businessName: string; contactEmail: string | null; contactPhone: string | null;
  staffNotifyEmails: string[];
  services: ServiceWire[];
  slotStepMinutes: number; minNoticeMinutes: number; horizonDays: number; travelBufferMinutes: number;
  maxSlotsPerDay: number | null; maxOpenRequestsPerRequester: number | null; requireAddress: boolean;
  autoConfirm: boolean; publicBookingEnabled: boolean;
  pendingExpiryHours: number; reminderLeadHours: number; cancelCutoffHours: number;
  saved: boolean; updatedAt: Instant | null;
}
export type SettingsPatch = Partial<Omit<SettingsWire, "saved" | "updatedAt">>;

export interface AdminResource {
  id: string; name: string; userId: string | null;
  homeBaseAddress: string | null; homeBaseLat: number | null; homeBaseLng: number | null;
  skills: string[]; workStartTime: TimeOfDay; workEndTime: TimeOfDay; maxJobsPerDay: number;
  hoursConfigured: boolean; acceptsPublicBookings: boolean; isActive: boolean;
  createdAt: Instant; updatedAt: Instant;
}
export interface ResourceInput {
  name: string; userId?: string | null;
  homeBaseAddress?: string | null; homeBaseLat?: number | null; homeBaseLng?: number | null;
  skills?: string[]; workStartTime?: TimeOfDay; workEndTime?: TimeOfDay; maxJobsPerDay?: number;
  acceptsPublicBookings?: boolean;
}

export interface WeeklyWindow { dayOfWeek: number /* 0=Sun … 6=Sat */; startTime: TimeOfDay; endTime: TimeOfDay }
export interface TimeOffDay { id: string; date: DateString; note: string | null }
export interface SpecialHours { id: string; date: DateString; startTime: TimeOfDay; endTime: TimeOfDay; note: string | null }
export interface AvailabilityResponse {
  resourceId: string;
  hoursConfigured: boolean;
  weekly: WeeklyWindow[];            // saved weekly rows (empty when never configured)
  effectiveWeekly: WeeklyWindow[];   // what applies: saved rows, or the Mon–Fri default
  timeOff: TimeOffDay[];             // from today on
  specialHours: SpecialHours[];      // from today on
}
export interface SetWeeklyBody { weekly: WeeklyWindow[] }   // ≤ 50 windows; several per day allowed
export interface AddTimeOffBody { from: DateString; to: DateString; note?: string }   // ≤ 62 days
export interface TimeOffResponse extends AvailabilityResponse { visitsOnThoseDays: VisitSnapshot[] }
```

Wire field names map onto the server inputs like this:

- request: `name` → `customerName`, `email` → `customerEmail`,
  `phone` → `customerPhone`.
- details: `serviceType` stays `serviceType`.

The handlers remap zod issue paths to the wire names, as booking's
`wireIssues` does.

---

## 8. `@adminigloo/scheduling-widget` 0.1.0 (widget builder)

The skeleton is in place: `package.json`, `tsconfig.json`, `tsup.config.ts`
(entries `index` and `admin`, with the "use client" banner),
`src/index.ts`, `src/admin/index.ts` and a smoke test. React is the only peer.
No Tailwind, and no CSS import step for the buyer. Reuse booking-widget's
structure and pure helpers by copying them (no dependency on booking-widget).

### 8.1 Transports (never throw)

```ts
type Result<T> = { ok: true; data: T } | { ok: false; error: ClientError };
interface ClientError { code: WireErrorCode | "network" | "bad_response"; message: string; status: number; issues?: WireIssue[] }

interface SchedulingTransport {
  config(): Promise<Result<PublicConfig>>;
  slots(q: { service?: string; from?: DateString; days?: number; manage?: string }): Promise<Result<SlotsResponse>>;
  request(body: VisitRequestBody): Promise<Result<VisitRequestResponse>>;
  visit(token: string): Promise<Result<VisitResponse>>;
  reschedule(token: string, body: RescheduleVisitBody): Promise<Result<VisitResponse>>;
  cancel(token: string, body: CancelVisitBody): Promise<Result<VisitResponse>>;
  icsUrl(token: string): string | null;
}
createSchedulingClient(options: { baseUrl: string; fetch?: typeof fetch; headers?: Record<string, string> }): SchedulingTransport

interface SchedulingAdminTransport {
  calendar(q: { from: DateString; to: DateString; resources?: string[]; includeInactive?: boolean }): Promise<Result<CalendarResponse>>;
  crewDay(q: { date?: DateString; resource?: string }): Promise<Result<CrewDayResponse>>;
  suggest(q: { service?: string; minutes?: number; address?: string; lat?: number; lng?: number; from?: DateString; days?: number; resource?: string }): Promise<Result<SuggestResponse>>;
  getVisit(id: string): Promise<Result<{ visit: VisitSnapshot }>>;
  createVisit(body: CreateVisitBody): Promise<Result<VisitMutationResponse>>;
  accept(id: string, body: AcceptBody): Promise<Result<{ visit: VisitSnapshot }>>;
  decline(id: string, body: DeclineBody): Promise<Result<{ visit: VisitSnapshot }>>;
  setStatus(id: string, body: StatusBody): Promise<Result<{ visit: VisitSnapshot }>>;
  reschedule(id: string, body: RescheduleBody): Promise<Result<VisitMutationResponse>>;
  assign(id: string, body: AssignBody): Promise<Result<VisitMutationResponse>>;
  updateDetails(id: string, body: DetailsBody): Promise<Result<VisitMutationResponse>>;
  expire(): Promise<Result<ExpireResponse>>;
  getSettings(): Promise<Result<{ settings: SettingsWire }>>;
  updateSettings(patch: SettingsPatch): Promise<Result<{ settings: SettingsWire }>>;
  listResources(q?: { includeInactive?: boolean }): Promise<Result<{ resources: AdminResource[] }>>;
  createResource(body: ResourceInput): Promise<Result<{ resource: AdminResource }>>;
  updateResource(id: string, patch: Partial<ResourceInput>): Promise<Result<{ resource: AdminResource }>>;
  deactivateResource(id: string): Promise<Result<{ resource: AdminResource }>>;
  reactivateResource(id: string): Promise<Result<{ resource: AdminResource }>>;
  getAvailability(resourceId: string): Promise<Result<AvailabilityResponse>>;
  setWeekly(resourceId: string, body: SetWeeklyBody): Promise<Result<AvailabilityResponse>>;
  addTimeOff(resourceId: string, body: AddTimeOffBody): Promise<Result<TimeOffResponse>>;
  removeTimeOff(resourceId: string, exceptionId: string): Promise<Result<AvailabilityResponse>>;
}
createSchedulingAdminClient(options: { baseUrl: string; fetch?: typeof fetch; headers?: Record<string, string> }): SchedulingAdminTransport
```

- The URLs are exactly those in section 4, with `joinUrl` semantics
  (booking-widget `client.ts`). Tokens and ids are `encodeURIComponent`'d.
- POSTs send `content-type: application/json`. GETs send no custom headers,
  so a same-origin page never pays for a preflight.
- Every response shape is checked narrowly. A proxy's HTML error page becomes
  `bad_response`, never a TypeError mid-render. A thrown fetch becomes
  `network` with status 0.
- Every component takes `transport` OR `baseUrl`. With both, `transport`
  wins. A host can therefore back the admin with tRPC by implementing the
  interface.

### 8.2 Theme contract (all five components)

- **Prop.** `theme?: "auto" | "light" | "dark"`, default `"auto"`. Every
  component also takes `nonce?: string`, `className?: string`,
  `style?: CSSProperties` and `locale?: string` (default `"en-US"`; the copy
  is English).
- **Auto resolves in this order.** The first rule that answers wins:
  1. The nearest ancestor of the widget root, then `<body>`, then `<html>`,
     with `data-theme="dark" | "light"`.
  2. The `dark` or `light` class on `<body>` or `<html>`.
  3. `getComputedStyle(document.documentElement).colorScheme`, when it is
     exactly `"dark"` or exactly `"light"`.
  4. `prefers-color-scheme`.

  It re-resolves live:
  - a `MutationObserver` on `<html>` and `<body>` watches `class`,
    `data-theme` and `style`;
  - a `matchMedia` change listener watches the OS setting;
  - both are cleaned up on unmount, and survive StrictMode's double effects.
- **Rendering.** The resolved theme is written as `data-theme` on the root.
  On the server and before hydration there is no `data-theme`, so the CSS's
  media query decides. No flash on a page that matches the OS.
- **Tokens.** Every token is declared under `:where(.aisw-root)`, at zero
  specificity, so `.aisw-root { --aisw-accent: #7c3aed }` re-themes the
  widget whatever the stylesheet order. Dark tokens are declared under
  `@media (prefers-color-scheme: dark) { :where(.aisw-root:not([data-theme="light"])) {…} }`
  and `:where(.aisw-root[data-theme="dark"]) {…}`.
- **Component rules** stay at class specificity and are prefixed `aisw-`, so
  a host's element rules (Tailwind preflight) can't restyle them.
- **Token names:**
  - booking-widget's set: `ground surface ink muted faint line line-strong
    accent accent-strong accent-soft on-accent ok ok-soft warn warn-soft
    danger danger-soft on-danger focus radius radius-sm shadow font`;
  - plus calendar status tokens: `pending pending-soft progress
    progress-soft done done-soft inactive`;
  - plus crew colours `crew-1` … `crew-8`.
  - Every colour resolves through a token. Light and dark values both pass
    WCAG AA for text (add a contrast unit test as feedback-widget does).
- **Injection.**
  - `injectSchedulingStyles({ nonce })` adds `<style id="aisw-styles">` once.
  - `injectSchedulingAdminStyles({ nonce })` adds `aisw-admin-styles` once.
  - A tag that already exists is never duplicated. `nonce` is set on the
    created element.
  - `schedulingWidgetCss()` and `schedulingAdminCss()` return the text, for
    SSR or a shadow root.

### 8.3 `<VisitPicker>` (public entry)

```ts
interface VisitPickerProps {
  baseUrl?: string; transport?: SchedulingTransport;
  service?: string;               // preselect this service key
  lockService?: boolean;          // with `service`: don't offer the others
  estimateId?: string;            // passed through on the request
  title?: string;                 // default "Book a visit"
  days?: number;                  // days per slots fetch, default 14
  onRequested?: (result: VisitRequestResponse) => void;
  locale?; theme?; nonce?; className?; style?;
}
```

The flow is one card, with steps and focus moved to each step's heading
(booking-widget's `useStepFocus`):

1. **Config.**
   - Loading shows a skeleton. An error shows a retry button.
   - With `publicBookingEnabled: false`: "Online booking is closed right
     now." plus the contact phone and email as links.
2. **Service.** Cards for the services (name, length, description). Skipped
   when there is only one, or when `lockService` is set.
3. **Day and time.**
   - The date strip shows the days that have times. It has earlier and later
     buttons; "later" asks for the next window.
   - Times are grouped Morning, Afternoon and Evening.
   - **Every time is in the business's zone**, with one line saying so:
     "Times are Mountain Time (MST)". The zone name comes from
     `Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "longGeneric" })`,
     falling back to `"short"`.
   - There is no zone picker: the visit happens at the business's location.
   - Empty: "No open times in the next N days." with contacts.
4. **Details.**
   - Name, email, phone, address (required when `config.requireAddress`,
     otherwise "optional") and notes.
   - Client checks mirror the server's (lengths, email shape).
   - **The honeypot** is `name="website"`, visually hidden off-screen (not
     `display:none`), `tabIndex={-1}`, `aria-hidden`, `autoComplete="off"`.
   - **Fill time.** `fillMs` is measured from the details step first
     rendering. If the visitor submits before `config.minFillMs`, the submit
     waits out the remainder (with the button showing "Sending…"), so a fast
     autofill user never sees `spam_suspected`.
5. **Done.**
   - Pending: "Request received. {businessName} will confirm it soon."
     Confirmed: "You're booked."
   - It shows when (business zone), where and what.
   - "Add to Google Calendar", built client-side from
     `startsAt`/`endsAt`/address, plus a "Download .ics" link
     (`transport.icsUrl(token)`).
   - **The manage link.** With `emailsEnabled`: "We've emailed you a
     confirmation with a link to change it." Without: a copyable field
     ("Keep this link to change or cancel your visit") and nothing that
     promises an email.

Recovery and errors:

- `slot_unavailable`: back to the times, with a notice "That time was just
  taken. Pick another.", a refetch, and **the form kept**.
- `too_soon` / `too_far`: the same recovery, with the server's message.
- `address_unresolved`: a field error on the address.
- `too_many_requests`: "You already have requests waiting. We'll be in touch
  about those first."
- `spam_suspected`, `rate_limited` and `network`: a message, and the form is
  kept.
- `issues` map onto the fields.
- `onRequested` fires once per successful request.

### 8.4 `<ManageVisit>` (public entry)

```ts
interface ManageVisitProps {
  token: string; baseUrl?: string; transport?: SchedulingTransport;
  bookHref?: string;              // "Book a new time" after cancelled/declined/expired, and on not-found
  locale?; theme?; nonce?; className?; style?;
  onChange?: (visit: PublicVisit) => void;
}
```

- **States.**
  - Loading.
  - Not found: "This link doesn't open a visit." plus `bookHref`.
  - Error: a retry button.
  - Ready: a status tag in plain words —
    - requested: "Waiting for {business} to confirm"
    - confirmed: "Confirmed"
    - in progress: "In progress"
    - completed: "Done"
    - cancelled: "Cancelled"
    - declined: "{business} couldn't make this time"
    - expired: "Not confirmed in time"
    - missed: "Missed"
  - The ready view also shows the service, when, where, and the business's
    contact.
- **Actions:**
  - **Reschedule** opens the same day-and-time picker. Slots are fetched with
    `manage: token`, so the visit's own time shows as free. Confirm with
    "Move to Tue, Nov 3, 10:00 AM?".
  - **Cancel** asks for confirmation, with an optional reason.
  - **Add to calendar.**
- **The cutoff.** Past `changeDeadline`, the actions are replaced by "This
  visit starts within {cancelCutoffHours} hours, so it can't be changed
  online. Call {contactPhone}." A `too_late` from the server shows the same
  message and reloads.
- `slot_unavailable` while rescheduling triggers a refetch, keeping the
  visitor in the picker.

### 8.5 `<ScheduleCalendar>` (admin entry)

```ts
interface ScheduleCalendarProps {
  baseUrl?: string; transport?: SchedulingAdminTransport;
  initialView?: "day" | "week";   // default: "day" under 720px container width, else "week"
  initialDate?: DateString;       // default: the server's `today`
  canManage?: boolean;            // default true; false = read-only (no accept/decline/move/new)
  pollMs?: number;                // background refresh, default 60000; 0 = off. Also refresh on window focus.
  bookingPageUrl?: string;        // shown in the empty state
  locale?; theme?; nonce?; className?; style?;
  onVisitChange?: (visit: VisitSnapshot) => void;
}
```

**Toolbar.** Previous, Today and Next; the date label; a Day/Week toggle; a
crew filter (chips, with "All"); a **"New visit"** button; and a **Requests**
button with the pending count.

**Day view.**

- **Layout.**
  - One column per crew, plus "Unassigned" when there are any.
  - Rows are time on a `slotStepMinutes` grid. The range runs from the
    earliest window start (or 07:00) to the latest window end (or 19:00), and
    widens to include any visit outside it.
  - Hours outside the crew's `windows` are shaded.
  - Visits are positioned by business-zone wall-clock time.
  - On a narrow screen (< 720px) the crew columns scroll sideways.
- **Each block** shows the time, customer, service and a status icon. Colour
  is never the only signal:
  - pending: dashed outline and the word "Request";
  - confirmed: solid;
  - in progress: accent;
  - completed: muted with a check;
  - no-show: struck through.

**Week view.**

- A dispatch board: crew rows × seven day columns.
- Each cell lists that crew's visits that day as time-sorted chips.
- Off days (no windows) are shaded.

**Drag to move** (pointer events, so mouse, touch and pen all work).

- **What a drop does:**

  | View | Drag | Calls |
  | --- | --- | --- |
  | Day | up or down | changes the start; snaps to `slotStepMinutes`; clamped to 00:00–24:00 minus the duration |
  | Day | across columns | changes the crew |
  | Week | to another cell | changes the date and/or crew, keeping the start time |

  - A drop calls `reschedule` (the time or date changed, with the crew
    included if it changed) or `assign` (only the crew changed).
  - The move is optimistic, and the UI reverts on refusal.
  - A refusal shows the server's message as a toast ("Overlaps 10:00–12:00").
  - Warnings show as a non-blocking toast.
- **Before the call.** A drop on a pending or confirmed visit first asks
  "Email the customer about this change?" (default yes), unless the
  "Don't ask again this session" box was ticked. The answer becomes
  `notify`.
- **Fixed visits.** Only `pending` and `confirmed` visits are draggable.
  Others show a "not-allowed" cursor.
- **Keyboard path.** The keyboard equivalent is the panel's **Move…**
  dialog: date, start, end and crew fields, with a notify checkbox. Every
  drag outcome is reachable without a pointer.

**The visit panel** is a dialog with a drawer layout, focus-trapped, closed
with Escape, returning focus to the block.

- **Contents:**
  - the customer, with `tel:` and `mailto:` links;
  - the address, with a directions link;
  - the service, notes, status tag, origin ("Booked online"), and when it
    was requested or expires.
- **Actions follow `nextStatuses`:**
  - pending: **Accept** and **Decline** (optional reason);
  - confirmed: **Start**, **Complete**, **No-show** and **Cancel** (optional
    reason);
  - inactive statuses: **Restore**, if offered.
- **Always available:** **Move…**, **Change crew**, and **Edit details** (a
  form, showing warnings). Every customer-facing action has the notify
  checkbox.

**The Requests list** is a popover with the pending visits, soonest first:

- the requested time, customer and service;
- the time left until it expires ("expires in 5 h");
- inline Accept and Decline.

Calling `expire()` isn't needed; the server sweeps.

**The New visit dialog:**

1. Choose the service. It sets the duration.
2. Enter the customer's name, email, phone, address and notes.
3. **Find times** calls `suggest` with the address. It lists the suggestions
   with the crew and drive minutes ("12 min drive from the 9:00 job"; with
   `estimated` the label says "about 12 min (estimate)").
4. Pick a suggestion, or enter the date, start and crew manually.
5. Choose pending or confirmed, and the notify checkbox.
6. Submit with `createVisit`.

**Empty state:** "No visits this week yet. Customers book at {bookingPageUrl}."

### 8.6 `<CrewDay>` (admin entry; mobile-first, 390px)

```ts
interface CrewDayProps {
  baseUrl?: string; transport?: SchedulingAdminTransport;
  resourceId?: string;            // default: the server resolves the signed-in person's crew; on "Pick a crew." show a crew picker (listResources)
  date?: DateString;              // default: the server's today
  canManage?: boolean;            // Start/Complete buttons; default true
  locale?; theme?; nonce?; className?; style?;
}
```

- **Header:**
  - the crew name;
  - the date, with previous and next day;
  - totals: "5 stops · 1 h 40 min driving";
  - "(estimates)" when `totals.estimated`;
  - **"Open route in Maps"** (`routeUrl`, a new tab).
- **Stops, in order.** Each stop shows:
  - a big order number and the time window;
  - the customer name and service;
  - the address, which is a link (`directionsUrl`), and a **Call** button
    (`telUrl`);
  - the notes;
  - "18 min drive · 9.2 mi from previous stop" ("from home base" for stop 1;
    "estimate" when estimated);
  - a status tag.
- **One primary button per stop:**
  - confirmed: **Start** (`setStatus in_progress`);
  - in progress: **Complete** (`setStatus completed`);
  - completed: a check and "Done 10:42".
  - The update is optimistic, and reverts with a message on failure.
- **Layout.** 44px targets, no horizontal scroll at 390px, and the data
  refreshes on window focus.

### 8.7 `<SchedulingSettings>` (admin entry)

```ts
interface SchedulingSettingsProps {
  baseUrl?: string; transport?: SchedulingAdminTransport;
  canManage?: boolean;            // false = read-only
  sections?: Array<"business" | "booking" | "messages" | "crews" | "hours">;   // default all, in this order
  bookingPageUrl?: string;        // "Your booking page: …" with a copy button
  locale?; theme?; nonce?; className?; style?;
}
```

Each section saves on its own. The server's `issues` map onto fields. A
successful save says "Saved". Unsaved changes are marked.

**Business**

- Business name.
- **Time zone.** A select: US zones by name first ("Mountain Time
  (Denver)"), then "Other…" with the full `Intl.supportedValuesOf("timeZone")`
  list. The help text reads: "Changing it keeps every visit at the same clock
  time."
- Contact phone and contact email.
- "Send new-request alerts to" (up to 5 emails).

**Online booking**

- On/off.
- Auto-confirm, with one plain sentence: "On: requests go straight onto the
  calendar. Off: you accept each one."
- Services: an editor for name, length, description and skill, with add,
  remove and reorder.
- Notice, entered as hours or days and stored as minutes.
- How far ahead (days), time grid (minutes), travel buffer (minutes), the most
  open requests per person, and "Address required".

**Customer messages**

- "Release unanswered requests after N hours".
- "Send a reminder N hours before (0 = off)".
- "Customers can change or cancel online until N hours before".
- Each field has one plain sentence of help.

**Crews**

- The list, with add and edit: name, home base address, work hours, the most
  visits a day, skills, and a linked user id (optional, labelled "Their login
  (for their own route)").
- Pause or resume online booking, and remove or restore.
- Removed crews are shown collapsed.

**Hours** (per crew)

- **The weekly editor** is seven rows. Each row holds one or more windows,
  with "+ Add hours" for split shifts.
  - It starts from the saved weekly rows, or from `effectiveWeekly` when the
    crew was never configured. It never uses a hard-coded 08:00–17:00 the
    crew doesn't have (SB-17).
  - It saves with `setWeekly`, so dated rows survive.
- **Time off:**
  - add a from–to range and a note;
  - list the days off, grouping consecutive days into ranges;
  - remove one;
  - after adding, if `visitsOnThoseDays` isn't empty, warn: "3 visits are
    booked on those days. Move them from the calendar."

### 8.8 Exports

- **Public entry:**
  - `VisitPicker`, `ManageVisit`;
  - `createSchedulingClient`;
  - `injectSchedulingStyles`, `schedulingWidgetCss`, `LIGHT_TOKENS`,
    `DARK_TOKENS`;
  - `resolveHostTheme` (pure: takes the element and `matchMedia`);
  - the pure helpers: `groupSlotsByDay`, `partOfDay`, `formatTimeRange`,
    `zoneLabel`, `validateVisitForm`, `friendlyError`,
    `googleCalendarUrl`, `toPublicStatusLabel`;
  - `SCHEDULING_WIRE_VERSION`;
  - every public wire type.
- **Admin entry:**
  - `ScheduleCalendar`, `CrewDay`, `SchedulingSettings`;
  - `createSchedulingAdminClient`;
  - `injectSchedulingAdminStyles`, `schedulingAdminCss`;
  - the pure layout helpers: `positionVisit`, `snapMinutes`, `layoutLanes`,
    `weekDates`;
  - every admin wire type.

### 8.9 Accessibility (both)

- Real buttons, radios and labels everywhere.
- Async results are announced (`aria-live="polite"`).
- Errors are linked to their fields.
- Focus is managed on step changes and in dialogs.
- Targets are at least 44px.
- Everything works at 390px with no page-level horizontal scroll.
- Every drag has a keyboard path.
- Colour is never the only signal.

---

## 9. create-app wiring plan (a later step; not for either builder now)

Goal: `create-adminigloo-app --scheduling` yields the scenario in section 0 out
of the box.

1. **Answers and CLI.**
   - `includeScheduling` now forces `includeComms`. Document why: the scenario
     is mostly emails. The CLI prints a line when it does.
   - The help text becomes: "Field service: a booking page for customers,
     manage-your-visit links, a staff calendar with drag-to-move, today's
     route for crews, confirmations and reminders by email."
   - Recommend `--email`. Without `RESEND_API_KEY`, sends are logged
     `skipped`, and the widget's config says `emailsEnabled: false`.
2. **`versions.ts`** gets `scheduling: "0.4.0"` and
   `"scheduling-widget": "0.1.0"`. **`packagesFor`** adds `scheduling-widget`
   with scheduling.
   - Expected red test: in this worktree the 0.3 changeset is still pending,
     so changesets reads 0.3 + 0.4 as one minor (effective 0.3.0).
     `versions.test.ts` will call the 0.4.0 pin ahead of the effective
     version until this branch is rebased onto main's 0.3.0 version commit,
     which main's checkout holds uncommitted. That is the one expected
     failure.
   - Main's `versions.ts` is also modified, so expect a one-line rebase
     conflict on the scheduling pin.
3. **Retire the tRPC scheduling router.** Delete
   `overlays/scheduling/src/server/routers/scheduling.ts` and
   `scheduling-policy.ts`, with its test. Remove `schedulingRouter` from the
   root router in `emit.ts`, around lines 1963 and 2059–2064. One path, HTTP,
   which the widgets speak.
4. **`overlays/scheduling`:**
   - **`src/server/scheduling.ts`:**
     - `SCHEDULING_TENANT = "primary"` (equal to `COMMS_TENANT`, so visit
       templates show up in /admin/comms).
     - `schedulingMaps = selectMapsProvider({ googleMapsApiKey: env.GOOGLE_MAPS_API_KEY, db })`.
     - `ensureSchedulingSetup(db)`, run once per process under an advisory
       lock:
       - when settings were never saved: `timeZone` from
         `env.SCHEDULING_TIME_ZONE ?? "America/Denver"`, `businessName` from
         the project name, `requireAddress: true`, and the services
         `[{ key: "estimate", name: "Free estimate", durationMinutes: 60 }]`;
       - the demo crew, only for a tenant that never had one (0.3's rule);
       - `backfillVisitInstants`.
     - `schedulingComms = createSchedulingCommsListener({ db, senders: commsSenders, manageUrl: (t) => \`${env.APP_URL}/visit/${t}\`, bookUrl: \`${env.APP_URL}/book\`, adminUrl: \`${env.APP_URL}/admin/schedule\` })`.
   - **`app/api/schedule/[...path]/route.ts`:**
     - `createSchedulingHandlers({ db, tenantId: SCHEDULING_TENANT, maps, onEvent: schedulingComms.onEvent, manageUrl, emailsEnabled: Boolean(env.RESEND_API_KEY), requesterKey: clientIpKey, rateLimit })`.
     - The rate limit uses the app's `limiter`: request 5/hour per IP, manage
       30/hour, read 120/minute.
     - It exports GET, POST and OPTIONS.
   - **`app/api/admin/schedule/[...path]/route.ts`:**
     - `createSchedulingAdminHandlers({ …, authorize })`. `authorize` runs
       `currentPrincipal()`, then `loadStaffPermissions`, then
       `can("staff.dashboard.view")`, and returns `{ userId }`.
     - It returns a `Response` 401 when nobody is signed in.
     - Single-tenant for now: every scheduling key maps to
       `staff.dashboard.view`. The tenancy chunk moves this onto
       `schedulingPermissions`.
   - **`app/(site)/book/page.tsx`:**
     `<VisitPicker baseUrl="/api/schedule" estimateId={searchParams.estimate} />`.
   - **`app/(site)/visit/[token]/page.tsx`:**
     `<ManageVisit baseUrl="/api/schedule" token={token} bookHref="/book" />`,
     with `robots: { index: false }`.
5. **`overlays/scheduling-admin`:**
   - `app/admin/schedule/page.tsx` becomes `<ScheduleCalendar baseUrl="/api/admin/schedule" bookingPageUrl={…} />`,
     replacing the list.
   - `app/admin/schedule/route/page.tsx` becomes `<CrewDay …/>`.
   - `app/admin/schedule/settings/page.tsx` becomes `<SchedulingSettings …/>`.
   - Delete `scheduleView.ts` and its test.
   - The admin nav gets "Schedule", "Today's route" and "Schedule settings".
6. **The comms cron.**
   - `emit.ts` GENERATES `src/server/comms-hooks.ts`, exporting
     `commsBeforeSend(row)` and `afterCommsRun()`. They are no-ops without
     scheduling.
   - With scheduling:
     - `commsBeforeSend` tries `schedulingComms.beforeSend(row)` and falls
       back to `"send"`;
     - `afterCommsRun` calls `schedulingComms.redactSent()`, then
       `expirePendingRequests(db, SCHEDULING_TENANT, { onEvent: schedulingComms.onEvent })`.
   - The comms overlay's cron route calls
     `runDueMessages(db, commsSenders, { timeBudgetMs, beforeSend: commsBeforeSend })`
     then `await afterCommsRun()`.
   - `vercel.json` keeps the daily cron (Hobby). `DEPLOYMENT.md` says to use
     `*/15 * * * *` on Pro, for on-time reminders and expiries.
7. **Email delivery.** When `includeEmail`, `emit.ts` renders
   `src/server/comms-senders.ts` with the email sender wired, instead of the
   commented example: `createEmailSender`, with `plainTextToEmailHtml` for
   `html`. This helps every comms user.
8. **Env.**
   - `GOOGLE_MAPS_API_KEY`, optional. Group "Drive times". Without it: no
     geocoding, and drive times are straight-line estimates.
   - `SCHEDULING_TIME_ZONE`, optional, defaulting to `America/Denver`.
   - `DEPLOYMENT.md`: enable the Geocoding API and the Distance Matrix API,
     and restrict the key to those two APIs and your server.
9. **Capabilities and tests.**
   - `scheduling.booking` is proven by the public route calling
     `createSchedulingHandlers(`, with no `findAvailableSlots(` and no
     `createSchedulingAdminHandlers(` in it, AND by `book/page.tsx`
     containing `<VisitPicker`.
   - `scheduling.calendar` is proven by `<ScheduleCalendar`.
   - New: `scheduling.route` (`<CrewDay`) and `scheduling.reminders` (the
     generated `comms-hooks.ts` mentions `schedulingComms.beforeSend`).
   - Rewrite `scheduling-overlay.test.ts` for the new files.
   - Run every-configuration, versions and peer-dependencies.
   - Then
     `node scripts/verify-generated.mjs <tmp> sched -- --scheduling --comms --email --admin minimal`
     builds and serves on 3200/3201. Never on 3000.
10. **The estimator follow-up** (optional this chunk). When both features are
    on, `EstimateTool`'s saved state links to `/book?estimate=<id>`.
11. **Changeset** `.changeset/create-app-scheduling-0-4.md` (create-app:
    minor).
12. **The founder's dogfood site** (`adminIgloo`) is untouched by this chunk.
    The assistant knowledge seed's maps-key sentence (SB-V4) becomes true
    once a project is generated with `GOOGLE_MAPS_API_KEY`. Correct the seed
    in the testbed pass, not here.

---

## 10. Tests

### 10.1 Server (`packages/scheduling`, vitest + PGlite)

The existing 85 tests stay green. Change only the deliberate ones, and list
each in the hand-off with the reason. New suites:

- `zone.test.ts`, copied from booking's.
- `settings.test.ts`:
  - defaults without a row; upsert and partial patch; every range refusal;
    duplicate service keys;
  - a zone change re-derives instants for upcoming visits, keeps their wall
    clock, bumps the sequence, and emits `time_zone` reschedules with
    `notify: false`.
- `timezone.test.ts`, with a tenant in America/Denver:
  - **24 real hours across fall-back.** At now = Sat 2026-10-31 10:00 MDT,
    with the crew working Sundays, Sun 2026-11-01 09:00 MST is offered and
    08:30 isn't.
  - The same across spring-forward (2026-03-08).
  - "Today" at 20:00 local is still today. 0.3's UTC day had already rolled
    over.
  - Every writer writes `starts_at`/`ends_at`.
  - A slot's `startsAt` on a Mountain Daylight day (−6 h) vs a Mountain
    Standard day (−7 h).
- `tokens.test.ts`:
  - No plaintext token anywhere in the database: scan every text column of
    every table.
  - Several tokens open one visit. A token from another tenant is `null`.
  - The cutoff boundary at exactly `startsAt − cutoff`.
  - Cancel is idempotent. A reschedule may use the time right next to its own
    visit (excluded from busy).
  - A pending reschedule stays pending.
  - `booking_closed` blocks reschedule but not cancel.
- `staff.test.ts`:
  - reschedule, assign and details: every refusal code, the warnings, the
    sequence rules, "nothing changed means no event";
  - the details edit never refuses;
  - an unassigned visit can be assigned.
- `locks.test.ts`, extending 0.3's query-log test:
  - `rescheduleBooking`, `assignBooking`, `rescheduleVisitByToken`,
    `cancelVisitByToken`, `addTimeOff` and `removeTimeOff` each take
    `pg_advisory_xact_lock` on their (tenant, crew) keys, sorted, on the
    transaction, before reading;
  - no maps call happens inside a transaction.
- `events.test.ts`:
  - each event type from each emitter, with the envelope exactly as in
    section 5;
  - the listener sees committed state;
  - a throwing listener doesn't fail the action, and `onEventError` gets the
    error;
  - no token or requester key appears in any event (serialize and search);
  - order for auto-confirm: requested, then confirmed.
- `expiry.test.ts`:
  - An overdue pending request frees its slot in `findPublicSlots` and for
    `requestPublicBooking` before any sweep.
  - The sweep flips the status, bumps the sequence and emits. A second sweep
    does nothing.
  - Accepting an expired visit is a restore with re-validation.
  - Legacy rows with a null `pending_expires_at` expire at `starts_at`.
- `availability.test.ts`:
  - split shifts are offered and validated;
  - a visit spanning the lunch gap is refused with `outside_hours`;
  - a weekly-only save keeps the time off;
  - `addTimeOff` returns the visits on those days;
  - `getAvailabilitySummary.effectiveWeekly` for a never-configured crew.
- `calendar.test.ts`:
  - `listCalendar` runs in 5 queries for 1 crew × 1 day and for 10 crews ×
    42 days;
  - windows, the pending inbox, unassigned visits, and inactive crews with
    visits;
  - `listCrewDay` order, home-base drive, cached Google calls (the second
    call makes no fetch), directions, route and tel URLs.
- `google.test.ts`, with a fake fetch:
  - the exact URLs and parameters;
  - OK, ZERO_RESULTS (`null`), and each failure kind (throws
    `MapsProviderError`, calls `onError`);
  - a timeout through a fetch that never resolves;
  - **the key never appears in any error, message or `onError` payload**;
  - Distance Matrix with and without `departure_time`; `driveTime` never
    throws;
  - `selectMapsProvider` in all three modes;
  - `requestPublicBooking` books without coordinates when geocoding throws,
    and refuses `address_unresolved` on ZERO_RESULTS;
  - `findAvailableSlots` scores change with job location under the Google
    fake (SB-04's proof).
- `handlers.test.ts`, public and admin:
  - every route in section 4 and every error code with its status;
  - the CSRF matrix (booking's cases);
  - CORS;
  - each rate-limit bucket gets the right label;
  - the token-route headers;
  - the honeypot and fill time;
  - **a table test that each admin route asks `authorize` for exactly the
    permission in the contract**;
  - an `authorize` `Response` passes through;
  - `crew-day` resolves the signed-in user's crew;
  - the sweep throttle.
- `comms.test.ts`, with PGlite plus the comms tables and a recording sender:
  - Every template renders with no missing variable for every event shape
    (`missingVars` empty in `comms_messages`).
  - After `onEvent` returns, no `comms_messages` row contains a token, while
    the sender received the real link.
  - The reminder `send_at` is exactly `startsAt − lead` (across DST), with
    its dedupe key, `refType` and expiry.
  - Withdrawal on move, cancel, decline and expire. Reassign keeps it.
  - `beforeSend` verdicts: moved, cancelled, too close, fine. On fine, a
    working link is injected.
  - `redactSent` scrubs it.
  - The staff notice goes to settings emails, with options as the fallback.
  - `ensureTemplates` never overwrites an edited template.

### 10.2 Widget (`packages/scheduling-widget`, vitest)

- **Static markup** (`react-dom/server`), as booking-widget does: each
  component's states (loading, closed, empty, every status tag, the cutoff
  message, emails on and off), the honeypot attributes, no
  `display:none` honeypot, and the zone label.
- **Interactive** (`// @vitest-environment happy-dom`, React `act` +
  `createRoot`; no testing-library), against fake transports:
  - **VisitPicker:** the whole flow; `slot_unavailable` keeps the form; the
    fill-time wait; `address_unresolved` lands on the field.
  - **ManageVisit:** reschedule asks for slots with `manage`; cancel;
    `too_late`.
  - **ScheduleCalendar:**
    - a pointer drag sends `reschedule` with the snapped time;
    - a cross-column drag sends `assign`;
    - a refusal reverts and shows the message;
    - the Move… dialog path works by keyboard;
    - accept and decline from the panel and the inbox;
    - the notify prompt.
  - **CrewDay:** Start, then Complete.
  - **SchedulingSettings:** saves map issues to fields; the weekly editor's
    split shift; the time-off warning.
- **Theme:**
  - `html.dark` gives dark;
  - `html[data-theme=light]` with the OS dark gives light;
  - a host class change re-resolves live;
  - the nonce is set on the injected style;
  - no duplicate style tags;
  - a contrast unit test of the token pairs.
- **Transports:** never throw; exact URLs and methods; narrow parsing
  (an HTML body gives `bad_response`).

### 10.3 The business scenario (THE acceptance test): `packages/scheduling/src/__tests__/business-scenario.test.ts`

The server builder owns it. It drives only the two `handle(req)` functions,
the comms listener and `runDueMessages`. It runs on PGlite, with the
scheduling and comms tables, an injected clock (one mutable `now`, shared by
the handlers, the listener and the cron), a recording email sender, and a fake
Google `fetch` (geocodes known addresses, gives fixed Distance Matrix
durations, and counts calls).

**Setup.**

- Tenant `acme-windows`. Settings: `America/Denver`; "Acme Windows";
  `contactPhone`; `staffNotifyEmails ["office@acme.test"]`;
  `autoConfirm false`; `pendingExpiryHours 24`; `reminderLeadHours 24`;
  `cancelCutoffHours 24`; the service `estimate`, 60 minutes;
  `requireAddress true`.
- Two crews with home bases.
- The start clock is Thu 2026-10-29 09:00 MDT.

**Steps.** Each one asserts HTTP statuses, database rows, emails sent
(recipient, template key, link present, token absent from the log) and queue
rows.

1. **A customer books.**
   - `GET config` and `GET slots?service=estimate`:
     - the first slot is ≥ now + 24 real hours;
     - Mon 2026-11-02 09:00 has `startsAt 16:00Z` (MST).
   - `POST request` (`fillMs 5000`) gives 201 pending with a manage token.
     The customer gets `visit_requested` with a working link. The office
     gets the "New request" notice. `comms_messages` holds `:token`, not the
     token.
   - Spam checks: the honeypot filled, and `fillMs: 100`, each give 400
     `spam_suspected`, and nothing is written.
   - **Auto-confirm variant:** flip the setting (`POST admin settings`), and
     a second request lands confirmed. The customer gets only
     `visit_confirmed` (no acknowledgement), and the office gets "New
     booking". Then flip it back.
2. **Staff answer.**
   - `GET admin calendar` (the week) shows the request in `pending` and in
     its crew's column.
   - `POST accept` gives `visit_confirmed` with a link, and the reminder
     queued at exactly Sun 2026-11-01 16:00Z (Mon 09:00 MST − 24 h, across
     the fall-back).
   - Another request is declined: `visit_declined` goes out, and its time is
     offered again.
3. **Staff move.** The accept didn't bump the sequence; only a restore
   does.
   - Moving (`reschedule`) to Tue 11-03 10:00 gives `visit_rescheduled`.
     The old reminder row is `cancelled`, and a new one is queued with
     `:reminder:1` in its key.
   - `assign` to crew B gives `visit_reassigned`. The reminder row is
     untouched, and the sequence is still 1.
   - A move onto another visit gives 409 `slot_unavailable` with the clash
     in the message. A move outside hours gives 400 `outside_hours`.
4. **Self-service, then the reminder.** The clock is still Thu 10-29, well
   outside the cutoff.
   - The customer asks `GET slots?manage=token`, which offers the times
     around their own visit. Then `POST visit/:token/reschedule` moves it to
     a later slot, say Thu 11-05 10:00 MST. They get `visit_rescheduled`
     (customer wording), the office gets "Visit moved", and the reminder is
     re-queued with `:reminder:2`.
   - Advance to one minute after that reminder's `send_at` (Wed 11-04
     17:01Z) and run `runDueMessages(… { beforeSend: listener.beforeSend })`.
     The reminder goes with a working link (`GET visit/:thatToken` gives
     200). `redactSent()` leaves no token in the log.
   - The clock is now exactly 24 h minus a minute before the visit.
     `POST visit/:token/cancel` gives 409 `too_late`, with the business's
     phone number in the message.
   - Book a second visit through the public route a week out, and accept it.
     Its cancel gives 200, its reminder row is `cancelled`, and the customer
     gets `visit_cancelled` (customer wording).
5. **The route.**
   - Staff book three visits for crew B on one day through
     `POST admin visits`, at different addresses and times, entered out of
     order.
   - `GET admin crew-day?resource=B&date=…` lists them in time order. Each
     stop has a `directionsUrl` containing the encoded address. Drive
     minutes come from the Google fake (`estimated: false`), and a second
     load makes no new fetch (cached). `routeUrl` is present.
   - `status in_progress` and then `completed` on the first stop set
     `started_at` and `completed_at`. `visit.started` and `visit.completed`
     fire, and no customer email goes.
6. **Time zone.** Covered across steps 1–4: every assertion of `startsAt`
   and `send_at` is an exact instant, across the 2026-11-01 fall-back.
   Separately, in its own `it`, with a second tenant whose crew works
   Sundays and its own clock (the main clock never runs backwards): at
   now = Sat 2026-10-31 10:00 MDT, a request for Sun 09:00 MST (exactly 24
   real hours away) is accepted, and 08:30 is `too_soon`.
7. **Expiry.** The clock carries on from step 5.
   - A new request is left alone. Advance 25 h. Its time is already offered
     again in `slots`, before any sweep.
   - `POST admin expire` (or the cron's `expirePendingRequests`) sets status
     `expired`, the customer gets `visit_expired`, and
     `GET visit/:token` shows `status: "expired"`.
8. **Maps.**
   - With the Google provider, the request geocoded through the fake (the
     fetch saw the address, and the key is in the URL only).
   - An address the fake answers ZERO_RESULTS for gives 400
     `address_unresolved`. A fake 500 still books, without coordinates.
   - With `selectMapsProvider({})`, the same suggest has `estimated: true`
     and makes no fetch at all.

### 10.4 Browser spec (written now, run by the founder)

`e2e/tests/scheduling-widget.spec.ts` (widget builder) is self-contained like
`booking-widget.spec.ts`: it bundles from source in `beforeAll` and fakes the
server with `page.route`. It covers:

- at 390px: the picker's happy path and `slot_unavailable` recovery;
- the manage page's reschedule and cancel;
- a real mouse drag and a touch drag in the calendar;
- CrewDay Start and Complete;
- `html.dark` and the OS-dark-but-host-light case;
- an axe check.

Builders don't run it, because `e2e` installs Playwright outside the
workspace. The founder runs
`cd e2e && pnpm install && pnpm browsers && pnpm test`.

---

## 11. Docs and changesets

**`packages/scheduling/README.md`** gets updated, not rewritten. Its
voice: plain, business-first, short sentences.

- Update the intro and "What each install gets you":
  - add `./comms`, the handlers and the widget;
  - the "You wire yourself" column shrinks to: mount two routes, pass
    `authorize`, run the cron.
- New sections:
  - Time zones;
  - Settings;
  - Customer links;
  - Staff moves;
  - Events;
  - Emails (`./comms`);
  - Google Maps, with the two APIs to enable and the key restriction;
  - HTTP handlers;
  - Upgrading from 0.3 (2.4's SQL, `backfillVisitInstants`, the statuses
    added, the policy-precedence note, `MapsProvider.estimates`).
- Update the package.json description to say what it does now (SB-V4: no
  promise of a key nothing reads).

**"Not included"**, replacing 0.3's list:

- Recurring visit plans (weekly cleaning, quarterly service). Book each visit.
- A CRM record. A visit stores the name, email, phone and address as typed.
  There is no contact id, no find-or-create, and no "my visits" account page.
- SMS. Every notice and reminder is email. comms can send SMS, but scheduling
  ships no SMS templates.
- Deposits and payments.
- A merge with `@adminigloo/booking`. They are two engines with two
  calendars, so one person on both can be double-booked.
- A multi-tenant create-app. The handlers take `resolveTenant`; the generated
  app serves one business.
- Two-way calendar sync (Google or Outlook), or a crew `.ics` feed.
- Route optimisation. Stops are in time order, with no reordering
  suggestions.
- Partial-day time off. Time off is whole days; special hours go through
  `setAvailability`.
- Visits that cross midnight.
- Holds while the customer types. The slot is checked at submit, and a taken
  time recovers with "pick another".
- A second reminder (one hour before, say).
- Job photos, checklists or signatures.
- A license gate.

**`packages/scheduling-widget/README.md`** (widget builder) follows
booking-widget's README shape: what it is, install, the five components with
copy-paste usage, the theme contract, transports (including a tRPC-backed
example), and "Not included".

**Changeset files** (no `changeset version`):

- `.changeset/scheduling-0-4-business-ready.md`, by the server builder:
  `"@adminigloo/scheduling": minor`. Write it in the style of
  `scheduling-0-3-public-safe.md`: what a business gets, then "Breaking (0.x
  minor)", then "Schema: run your db:generate + db:migrate".
- `.changeset/scheduling-widget-initial-release.md`, by the widget builder:
  `"@adminigloo/scheduling-widget": minor`. The `package.json` version is
  `0.0.0`, so the release is 0.1.0.

---

## 12. Hand-off checklist

**Each builder's work is done when:**

- [ ] `pnpm --filter @adminigloo/<pkg> typecheck`, `build` and `test` are
      green.
- [ ] The baseline of the other packages is unchanged: scheduling's builder
      re-runs create-app's suite once at the end (expect 1511 green;
      create-app isn't edited in this chunk).
- [ ] Every function, route and type in this contract exists with this name
      and shape. If anything deviates, it is flagged with `// CONTRACT:` and
      listed.
- [ ] The README and changeset are written.
- [ ] Nothing is committed. `git status` shows only intended files.

**The hand-off message lists:**

- the files touched;
- test counts before and after;
- every changed 0.3 test, with the reason;
- every `// CONTRACT:` call;
- anything the other builder must know.

The server builder also states the exact `business-scenario.test.ts` result.
