import { and, eq, inArray } from "drizzle-orm";
import { fillHref, SCHEDULING_VISIT_SUBJECT } from "./alerts.js";
import { formatShortSafe } from "./format.js";
import { instantsOf, labelOf } from "./instants.js";
import { schedulingBookings, schedulingResources, schedulingSettings } from "./schema.js";
import { serviceNameFor, type SchedulingService } from "./services.js";
import { DEFAULT_SCHEDULING_SETTINGS } from "./settings.js";
import { oneLine } from "./text.js";
import type { SchedulingDb } from "./types.js";
import { isValidTimeZone } from "./zone.js";

/**
 * File records (Tenancy 2b-1, contract 3.5 and 9.5): a visit is something a
 * company keeps photos and files against, and THE VISIT'S OWN PERMISSIONS
 * DECIDE who sees them (D12). Storage asks `find` which of the ids are this
 * company's visits; everything else (the upload, the check, the bytes) is
 * storage's.
 *
 * STRUCTURAL, NO STORAGE IMPORT (2a D4): `SchedulingFileRecordType` is the
 * contract's `<Pkg>FileRecordType`, declared here, so a host passes
 * `schedulingFileRecords(db, …)` to `createStorage({ records })` and
 * scheduling never loads @adminigloo/storage.
 *
 * WHO. Anyone holding `schedule.view` sees a visit's files; `schedule.manage`
 * adds and removes them; a crew member (`schedule.route`, no `schedule.view`)
 * sees and adds files on the visits of THEIR OWN crew only (the person
 * linked to the visit's crew is the one `find` names as assigned), and may
 * remove a file they added there within a day (a blurry photo from the job;
 * review BO-21). Storage enforces all of it; this file only answers the
 * facts.
 */

export interface SchedulingFileRecordType {
  /** "scheduling.visit": permanent (stored on file rows). */
  readonly type: string;
  /** "Visit" */
  readonly label: string;
  /** "Visits": the Files screen's filter (review BO-22). */
  readonly pluralLabel: string;
  /** Any one of these lets someone see this record's files. */
  readonly view: readonly string[];
  /** Any one of these lets someone add and remove them. */
  readonly manage: readonly string[];
  /** Someone holding this may see and ADD files on records they are assigned to (crew), and remove their own within 24 h (D12). */
  readonly assigned?: { readonly permission: string };
  /**
   * The records of THIS company among `ids`: a label, where it opens, and who
   * is assigned. An id that isn't this company's is simply absent. One
   * query, never one per id.
   */
  find(input: { readonly tenantId: string; readonly ids: readonly string[] }): Promise<
    ReadonlyMap<string, { readonly label: string; readonly href: string | null; readonly assignedUserIds: readonly string[] }>
  >;
}

export interface SchedulingFileRecordsOptions {
  /** Where a visit opens: a pattern with {id} and {date}, e.g. "/app/schedule?date={date}&visit={id}". */
  readonly visitHref: string;
  /** Default "en-US". */
  readonly locale?: string;
}

/** The most ids one `find` looks up; storage pages its lists well under this. */
const MAX_FIND_IDS = 500;

/**
 * Scheduling's one record type, `scheduling.visit` (contract 9.5).
 *
 * `find` is ONE query in the tenant: the visits joined to their crew (who is
 * assigned) and to the tenant's settings (the zone and the service names, so
 * the label reads in the business's clock). Its label is the Files screen's
 * "Attached to" and the visit files page's heading:
 * "Visit · Pat Rivera · Tue, Nov 3, 9:00 AM MST".
 */
export function schedulingFileRecords(db: SchedulingDb, options: SchedulingFileRecordsOptions): readonly SchedulingFileRecordType[] {
  const locale = options.locale ?? "en-US";
  const visits: SchedulingFileRecordType = {
    type: SCHEDULING_VISIT_SUBJECT,
    label: "Visit",
    pluralLabel: "Visits",
    view: Object.freeze(["schedule.view"]),
    manage: Object.freeze(["schedule.manage"]),
    assigned: Object.freeze({ permission: "schedule.route" }),
    async find(input) {
      const out = new Map<string, { label: string; href: string | null; assignedUserIds: readonly string[] }>();
      const ids = [...new Set(input.ids.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 200))].slice(
        0,
        MAX_FIND_IDS,
      );
      if (ids.length === 0 || typeof input.tenantId !== "string" || input.tenantId === "") return out;
      const b = schedulingBookings;
      const r = schedulingResources;
      const s = schedulingSettings;
      const rows = (await db
        .select({
          id: b.id,
          customerName: b.customerName,
          title: b.title,
          serviceType: b.serviceType,
          scheduledDate: b.scheduledDate,
          startTime: b.startTime,
          endTime: b.endTime,
          startsAt: b.startsAt,
          endsAt: b.endsAt,
          crewUserId: r.userId,
          timeZone: s.timeZone,
          services: s.services,
        })
        .from(b)
        // The crew in the SAME tenant: a resource id is never trusted across companies.
        .leftJoin(r, and(eq(r.id, b.resourceId), eq(r.tenantId, b.tenantId)))
        .leftJoin(s, eq(s.tenantId, b.tenantId))
        .where(and(eq(b.tenantId, input.tenantId), inArray(b.id, ids)))) as Array<{
        id: string;
        customerName: string | null;
        title: string | null;
        serviceType: string;
        scheduledDate: Date;
        startTime: string;
        endTime: string;
        startsAt: Date | null;
        endsAt: Date | null;
        crewUserId: string | null;
        timeZone: string | null;
        services: SchedulingService[] | null;
      }>;
      for (const row of rows) {
        const zone = typeof row.timeZone === "string" && isValidTimeZone(row.timeZone) ? row.timeZone : "UTC";
        const services = Array.isArray(row.services) && row.services.length > 0 ? row.services : DEFAULT_SCHEDULING_SETTINGS.services;
        const when = formatShortSafe(instantsOf(row, zone).startsAt, zone, locale);
        // CONTRACT: "Visit · {customer} · {when}". A visit staff booked with no
        // customer name reads its label, else its service, so the Files
        // screen never shows "Visit ·  · …".
        const who = oneLine(row.customerName ?? "") || oneLine(row.title ?? "") || serviceNameFor(services, row.serviceType);
        out.set(row.id, {
          label: `Visit · ${who} · ${when}`,
          href: fillHref(options.visitHref, { id: row.id, date: labelOf(row.scheduledDate) }),
          assignedUserIds: row.crewUserId && row.crewUserId.trim() !== "" ? [row.crewUserId] : [],
        });
      }
      return out;
    },
  };
  return Object.freeze([visits]);
}
