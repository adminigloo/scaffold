import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, notInArray } from "drizzle-orm";
import { z } from "zod";
import { DAY_MS, labelDate, labelOf, todayIn } from "./instants.js";
import { getResourceRow, lockResource, notOverdue } from "./internal.js";
import { minutesToTime, timeToMinutes } from "./math.js";
import { schedulingAvailability, schedulingBookings, schedulingResources } from "./schema.js";
import { getSchedulingSettings, type SchedulingSettings } from "./settings.js";
import { INACTIVE_BOOKING_STATUSES } from "./status.js";
import {
  endTimeSchema,
  timeOfDaySchema,
  type AvailabilityRow,
  type BookingRow,
  type ResourceRow,
  type SchedulingDb,
} from "./types.js";
import type { AvailabilityResponse, WeeklyWindow } from "./wire.js";
import { addDays, eachDate, isValidDateString, type DateString } from "./zone.js";

/**
 * A crew's hours: weekly rows (several windows a day, for a split shift or a
 * lunch break), dated special hours, and dated time off.
 *
 * 0.3 took only the FIRST window of a day (`.find`), so 08:00–12:00 and
 * 13:00–17:00 was 08:00–12:00; and its only writer replaced every row, dated
 * ones included, so an hours editor that sent the week alone erased the
 * crew's time off (SB-17). Now a day may have several windows, the weekly
 * editor saves with `scope: "weekly"` (dated rows survive), and time off has
 * its own add and remove.
 */

export const availabilityBlockSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6).nullish(),
  specificDate: z.coerce.date().nullish(),
  startTime: timeOfDaySchema,
  endTime: endTimeSchema,
  isAvailable: z.boolean().default(true),
  note: z.string().max(300).nullish(),
});

export const setAvailabilitySchema = z
  .object({
    tenantId: z.string().min(1),
    resourceId: z.string().min(1),
    blocks: z.array(availabilityBlockSchema).max(200),
    /**
     * "all" (the default, 0.3's full replace): weekly rows AND dated exceptions.
     * "weekly": only the rows with no date are replaced, so the crew's time
     * off and special hours survive an edit of the week.
     */
    scope: z.enum(["all", "weekly"]).default("all"),
  })
  .superRefine((value, ctx) => {
    if (value.scope !== "weekly") return;
    value.blocks.forEach((block, index) => {
      if (block.specificDate) {
        ctx.addIssue({
          code: "custom",
          path: ["blocks", index, "specificDate"],
          message: "A weekly save can't carry a dated row. Add time off separately.",
        });
      }
    });
  });

/**
 * Replace one of this tenant's resources' availability and mark its hours as
 * configured. False — and nothing written — when the resource is not this
 * tenant's.
 *
 * With `scope: "all"` (the default) the weekly rows and the dated exceptions
 * are replaced together, as in 0.3. With `scope: "weekly"` only the weekly
 * rows are, which is what a week editor wants.
 *
 * After this call the saved weekly rows ARE the week: a weekday with no row is
 * a day off, and an empty week turns the resource off every day. (The Mon–Fri
 * fallback is for a resource whose hours were never saved.)
 *
 * One transaction under the resource lock, so a booking being validated at
 * the same moment sees the old hours or the new ones, never an empty week
 * halfway through the replace.
 */
export async function setAvailability(
  db: SchedulingDb,
  input: z.input<typeof setAvailabilitySchema>,
): Promise<boolean> {
  const parsed = setAvailabilitySchema.parse(input);
  return db.transaction(async (tx) => {
    await lockResource(tx, parsed.tenantId, parsed.resourceId);
    const resource = await getResourceRow(tx, parsed.tenantId, parsed.resourceId);
    if (!resource) return false;
    await tx
      .delete(schedulingAvailability)
      .where(
        and(
          eq(schedulingAvailability.tenantId, parsed.tenantId),
          eq(schedulingAvailability.resourceId, parsed.resourceId),
          ...(parsed.scope === "weekly" ? [isNull(schedulingAvailability.specificDate)] : []),
        ),
      );
    if (parsed.blocks.length > 0) {
      await tx.insert(schedulingAvailability).values(
        parsed.blocks.map((b) => ({
          tenantId: parsed.tenantId,
          resourceId: parsed.resourceId,
          dayOfWeek: b.specificDate ? null : (b.dayOfWeek ?? null),
          // A dated row is stored as its date's UTC midnight: a label, like `scheduled_date`.
          specificDate: b.specificDate ? labelDate(labelOf(b.specificDate)) : null,
          startTime: b.startTime,
          endTime: b.endTime,
          isAvailable: b.isAvailable,
          note: b.note ?? null,
        })),
      );
    }
    await tx
      .update(schedulingResources)
      .set({ hoursConfigured: true, updatedAt: new Date() })
      .where(and(eq(schedulingResources.id, parsed.resourceId), eq(schedulingResources.tenantId, parsed.tenantId)));
    return true;
  });
}

/** One of this tenant's resources' availability rows ([] when the resource is not theirs). */
export async function listAvailability(
  db: SchedulingDb,
  tenantId: string,
  resourceId: string,
): Promise<AvailabilityRow[]> {
  return (await db
    .select()
    .from(schedulingAvailability)
    .where(
      and(eq(schedulingAvailability.tenantId, tenantId), eq(schedulingAvailability.resourceId, resourceId)),
    )) as AvailabilityRow[];
}

/** Sort, drop empty windows, and merge overlapping or touching ones. */
function mergeWindows(windows: Array<{ start: string; end: string }>): Array<{ start: string; end: string }> {
  const sorted = windows
    .map((w) => ({ start: timeToMinutes(w.start), end: timeToMinutes(w.end) }))
    .filter((w) => w.end > w.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const window of sorted) {
    const last = merged.at(-1);
    if (last && window.start <= last.end) last.end = Math.max(last.end, window.end);
    else merged.push({ ...window });
  }
  return merged.map((w) => ({ start: minutesToTime(w.start), end: minutesToTime(w.end) }));
}

/**
 * The windows a resource works on one calendar day, sorted, overlaps merged;
 * [] when it is off. `date` is a calendar date ("YYYY-MM-DD") or a label Date
 * (its UTC midnight).
 *
 * Precedence:
 *   1. Dated rows for that date. If any is `isAvailable: false` the day is
 *      off; otherwise the available dated rows ARE the day's windows (special
 *      hours).
 *   2. Otherwise every available weekly row for that weekday, so a crew can
 *      work 08:00–12:00 and 13:00–17:00. A weekday whose only rows are
 *      unavailable is off.
 *   3. Otherwise — only while the resource's hours were NEVER saved and it
 *      has no weekly rows — a Mon–Fri fallback to its own work hours, so a
 *      freshly created resource is immediately bookable.
 */
export function resolveDayWindows(
  rows: readonly AvailabilityRow[],
  resource: Pick<ResourceRow, "workStartTime" | "workEndTime" | "hoursConfigured">,
  date: Date | DateString,
): Array<{ start: string; end: string }> {
  const day = typeof date === "string" ? date : labelOf(date);
  const dated = rows.filter((r) => r.specificDate && labelOf(new Date(r.specificDate)) === day);
  if (dated.length > 0) {
    if (dated.some((r) => !r.isAvailable)) return [];
    return mergeWindows(dated.map((r) => ({ start: r.startTime, end: r.endTime })));
  }
  const dow = labelDate(day).getUTCDay();
  const weekly = rows.filter((r) => !r.specificDate && r.dayOfWeek === dow);
  if (weekly.length > 0) {
    return mergeWindows(weekly.filter((r) => r.isAvailable).map((r) => ({ start: r.startTime, end: r.endTime })));
  }
  if (!resource.hoursConfigured && !rows.some((r) => !r.specificDate)) {
    if (dow >= 1 && dow <= 5) return mergeWindows([{ start: resource.workStartTime, end: resource.workEndTime }]);
  }
  return [];
}

/**
 * The first window a resource works on a day, or null if it is off.
 *
 * @deprecated A day may have several windows since 0.4; use `resolveDayWindows`.
 * Kept for 0.3 callers.
 */
export function resolveDayWindow(
  rows: AvailabilityRow[],
  resource: Pick<ResourceRow, "workStartTime" | "workEndTime" | "hoursConfigured">,
  date: Date,
): { start: string; end: string } | null {
  return resolveDayWindows(rows, resource, date)[0] ?? null;
}

// --- Time off ------------------------------------------------------------------

const MAX_TIME_OFF_DAYS = 62;

export const addTimeOffSchema = z
  .object({
    tenantId: z.string().min(1).max(200),
    resourceId: z.string().min(1).max(200),
    from: z.string().refine(isValidDateString, "Use a date like 2026-11-02."),
    to: z.string().refine(isValidDateString, "Use a date like 2026-11-02."),
    note: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? null : v),
      z.string().trim().max(300).nullish(),
    ),
  })
  .superRefine((value, ctx) => {
    if (!isValidDateString(value.from) || !isValidDateString(value.to)) return;
    if (value.to < value.from) {
      ctx.addIssue({ code: "custom", path: ["to"], message: "The last day off can't be before the first." });
      return;
    }
    const days = Math.round((labelDate(value.to).getTime() - labelDate(value.from).getTime()) / DAY_MS) + 1;
    if (days > MAX_TIME_OFF_DAYS) {
      ctx.addIssue({ code: "custom", path: ["to"], message: `Add up to ${MAX_TIME_OFF_DAYS} days at a time.` });
    }
  });
export type AddTimeOffInput = z.input<typeof addTimeOffSchema>;

/**
 * Whole days off for one crew, from `from` to `to` inclusive (at most 62
 * days): one `isAvailable: false` dated row per date, skipping dates that
 * already have one. Null when the crew isn't this tenant's.
 *
 * It refuses nothing, but returns the active visits already booked on those
 * days, so the screen can say "3 visits are booked on those days. Move them."
 * — the stranded-visit guard. Under the crew lock, so a booking landing at the
 * same moment is either in that list or refused by the new day off.
 *
 * Time off doesn't mark the crew's hours as configured: a crew still on the
 * Mon–Fri default keeps its other weekdays.
 */
export async function addTimeOff(
  db: SchedulingDb,
  input: AddTimeOffInput,
  options: { now?: Date } = {},
): Promise<{ added: number; visitsOnThoseDays: BookingRow[] } | null> {
  const parsed = addTimeOffSchema.parse(input);
  const now = options.now ?? new Date();
  const dates = eachDate(parsed.from, parsed.to, MAX_TIME_OFF_DAYS);
  return db.transaction(async (tx) => {
    await lockResource(tx, parsed.tenantId, parsed.resourceId);
    const resource = await getResourceRow(tx, parsed.tenantId, parsed.resourceId);
    if (!resource) return null;
    const labels = dates.map(labelDate);
    const existing = (await tx
      .select({ specificDate: schedulingAvailability.specificDate })
      .from(schedulingAvailability)
      .where(
        and(
          eq(schedulingAvailability.tenantId, parsed.tenantId),
          eq(schedulingAvailability.resourceId, parsed.resourceId),
          eq(schedulingAvailability.isAvailable, false),
          inArray(schedulingAvailability.specificDate, labels),
        ),
      )) as Array<{ specificDate: Date | null }>;
    const already = new Set(existing.map((row) => (row.specificDate ? labelOf(row.specificDate) : "")));
    const fresh = dates.filter((date) => !already.has(date));
    if (fresh.length > 0) {
      await tx.insert(schedulingAvailability).values(
        fresh.map((date) => ({
          tenantId: parsed.tenantId,
          resourceId: parsed.resourceId,
          dayOfWeek: null,
          specificDate: labelDate(date),
          startTime: "00:00",
          endTime: "24:00",
          isAvailable: false,
          note: parsed.note ?? null,
        })),
      );
    }
    const visitsOnThoseDays = (await tx
      .select()
      .from(schedulingBookings)
      .where(
        and(
          eq(schedulingBookings.tenantId, parsed.tenantId),
          eq(schedulingBookings.resourceId, parsed.resourceId),
          gte(schedulingBookings.scheduledDate, labelDate(parsed.from)),
          lt(schedulingBookings.scheduledDate, labelDate(addDays(parsed.to, 1))),
          // CONTRACT: "the active visits" means the ones still to happen or
          // happening; a completed visit needs no moving.
          notInArray(schedulingBookings.status, [...INACTIVE_BOOKING_STATUSES, "completed"]),
          notOverdue(now),
        ),
      )
      .orderBy(asc(schedulingBookings.scheduledDate), asc(schedulingBookings.startTime))) as BookingRow[];
    return { added: fresh.length, visitsOnThoseDays };
  });
}

/**
 * Remove one dated row (a day off, or a day's special hours) by id, for this
 * tenant and crew, under the crew lock. False when there is no such row.
 */
export async function removeTimeOff(
  db: SchedulingDb,
  tenantId: string,
  input: { resourceId: string; exceptionId: string },
): Promise<boolean> {
  const parsed = z
    .object({ resourceId: z.string().min(1).max(200), exceptionId: z.string().min(1).max(200) })
    .parse(input);
  return db.transaction(async (tx) => {
    await lockResource(tx, tenantId, parsed.resourceId);
    const removed = (await tx
      .delete(schedulingAvailability)
      .where(
        and(
          eq(schedulingAvailability.id, parsed.exceptionId),
          eq(schedulingAvailability.tenantId, tenantId),
          eq(schedulingAvailability.resourceId, parsed.resourceId),
          isNotNull(schedulingAvailability.specificDate),
        ),
      )
      .returning({ id: schedulingAvailability.id })) as Array<{ id: string }>;
    return removed.length > 0;
  });
}

const sortWeekly = (a: WeeklyWindow, b: WeeklyWindow): number =>
  a.dayOfWeek - b.dayOfWeek || a.startTime.localeCompare(b.startTime);

/** A crew's hours as the settings screen shows them (section 7's `AvailabilityResponse`). */
export function availabilitySummaryOf(
  resource: ResourceRow,
  rows: readonly AvailabilityRow[],
  today: DateString,
): AvailabilityResponse {
  const weekly = rows
    .filter((r) => !r.specificDate && r.isAvailable && r.dayOfWeek !== null)
    .map((r) => ({ dayOfWeek: r.dayOfWeek as number, startTime: r.startTime, endTime: r.endTime }))
    .sort(sortWeekly);
  const hasWeeklyRows = rows.some((r) => !r.specificDate);
  const effectiveWeekly =
    resource.hoursConfigured || hasWeeklyRows
      ? weekly
      : [1, 2, 3, 4, 5].map((dayOfWeek) => ({
          dayOfWeek,
          startTime: resource.workStartTime,
          endTime: resource.workEndTime,
        }));
  const dated = rows
    .filter((r) => r.specificDate && labelOf(new Date(r.specificDate)) >= today)
    .sort((a, b) => (a.specificDate as Date).getTime() - (b.specificDate as Date).getTime() || a.startTime.localeCompare(b.startTime));
  return {
    resourceId: resource.id,
    hoursConfigured: resource.hoursConfigured,
    weekly,
    effectiveWeekly,
    timeOff: dated
      .filter((r) => !r.isAvailable)
      .map((r) => ({ id: r.id, date: labelOf(r.specificDate as Date), note: r.note })),
    specialHours: dated
      .filter((r) => r.isAvailable)
      .map((r) => ({
        id: r.id,
        date: labelOf(r.specificDate as Date),
        startTime: r.startTime,
        endTime: r.endTime,
        note: r.note,
      })),
  };
}

/**
 * One crew's hours as the settings screen shows them: the saved weekly rows,
 * what actually applies (the Mon–Fri default for a crew never configured —
 * never a hard-coded 08:00–17:00 the crew doesn't have), and its days off and
 * special hours from today on. Null when the crew isn't this tenant's.
 */
export async function getAvailabilitySummary(
  db: SchedulingDb,
  tenantId: string,
  resourceId: string,
  options: { now?: Date; settings?: SchedulingSettings } = {},
): Promise<AvailabilityResponse | null> {
  const resource = await getResourceRow(db, tenantId, resourceId);
  if (!resource) return null;
  const settings = options.settings ?? (await getSchedulingSettings(db, tenantId));
  const rows = await listAvailability(db, tenantId, resourceId);
  return availabilitySummaryOf(resource, rows, todayIn(options.now ?? new Date(), settings.timeZone));
}
