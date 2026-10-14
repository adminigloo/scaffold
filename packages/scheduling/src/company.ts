import type { SchedulingEvent, SchedulingEventListener } from "./events.js";
import { getSchedulingSettings, updateSchedulingSettings, type SchedulingSettings } from "./settings.js";
import type { SchedulingDb } from "./types.js";
import { isValidTimeZone } from "./zone.js";

/**
 * Tenancy 2a: scheduling inside a company. Scheduling never imports tenancy
 * (D4): it declares, in its own types, the few seams a host fills in — the
 * company's basics (`company`), whether its public pages are open (`admit`),
 * async links and a per-company office inbox. A host passing none of them
 * gets 0.4's behaviour byte for byte. Type names are prefixed
 * (`SchedulingCompany`) so a generated file importing two feature packages
 * never has two `CompanyFacts`.
 */

/** The business as its customers know it, from the host's company profile (3.2). */
export interface SchedulingCompany {
  readonly name: string;
  /** IANA. null: not set yet (scheduling keeps its own). */
  readonly timeZone: string | null;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
  readonly logoUrl: string | null;
  /** "#rrggbb", or null. */
  readonly brandColor: string | null;
}

/** Is this business taking requests from the public right now? (3.3) */
export type SchedulingAdmission = { readonly open: true } | { readonly open: false; readonly message: string };

/**
 * The Crew role a project adds to its company roles (create-app passes it to
 * tenancy's `defineTenantRoles`). Rank 5: below member (10), so owners and
 * admins manage crew members and a crew member manages nobody. Its only
 * grant is `schedule.route` (see permissions.ts): a seasonal mower gets his
 * day on a phone, not the office's calendar. A generic tenancy never names a
 * field-service role itself (D9); scheduling owns this one.
 */
export const SCHEDULING_CREW_ROLE = {
  key: "crew",
  name: "Crew member",
  description: "Opens their own crew's route for the day on a phone and marks each stop started or done. Sees nothing else.",
  rank: 5,
} as const;

export interface ResolveSchedulingSettingsOptions {
  readonly company?: (tenantId: string) => SchedulingCompany | null | Promise<SchedulingCompany | null>;
  readonly now?: Date;
  readonly onEvent?: SchedulingEventListener;
  readonly onEventError?: (error: unknown, event: SchedulingEvent) => void;
  /** Told when the company seam throws; that read then uses the stored settings. */
  readonly onError?: (error: unknown) => void;
}

/**
 * The settings a request runs on, with the company's basics (Tenancy 2a, D5).
 *
 * 1. The stored settings (`getSchedulingSettings`).
 * 2. No `company` seam, or it answers null (or throws: reported, then this
 *    step) → the stored settings, `managedByCompany: false`.
 * 3. CONVERGE THE ZONE. Scheduling stores each visit twice: as a wall clock
 *    (what the customer was shown) and as instants computed in the zone
 *    (what notice, cutoffs, reminders and expiry run on). Overlaying a new
 *    zone onto old instants would move every reminder by the offset. So when
 *    the company's zone is valid, differs from the stored one, AND the tenant
 *    has a stored row, scheduling runs its OWN zone change
 *    (`updateSchedulingSettings` with `{ timeZone }`): every pending,
 *    confirmed or in-progress visit keeps its clock time, its instants are
 *    re-derived under the settings lock with `sequence + 1`, and
 *    `visit.rescheduled` (`via: "time_zone"`, `notify: false`) goes to
 *    `onEvent` after commit, so the comms listener re-queues reminders.
 *    Customers are not emailed about it.
 *
 *    With no stored row, the zone is overlaid in memory only: nothing stored
 *    depends on a zone yet, and an insert here would switch online booking
 *    on by the column default before the owner ever saw the settings.
 *
 *    The check is an in-memory compare; the write happens only on a
 *    mismatch, and a second caller racing the first finds the row already
 *    moved under the lock (no visit is rewritten twice). It runs at three
 *    moments (after the owner saves company settings, here on every request,
 *    and in the cron), so a crash between them costs nothing.
 * 4. OVERLAY. Name, contact email and phone, and the zone are the company's;
 *    `managedByCompany: true`.
 *
 * RE-ENTRANCE is safe: the events step 3 emits reach the comms listener,
 * which calls this function again; by then the row holds the company's zone,
 * so step 3 is a no-op.
 */
export async function resolveSchedulingSettings(
  db: SchedulingDb,
  tenantId: string,
  options: ResolveSchedulingSettingsOptions = {},
): Promise<SchedulingSettings> {
  let settings = await getSchedulingSettings(db, tenantId);
  if (!options.company) return settings;
  let company: SchedulingCompany | null;
  try {
    company = await options.company(tenantId);
  } catch (error) {
    try {
      options.onError?.(error);
    } catch {
      /* a broken reporter must not break the read */
    }
    return settings;
  }
  if (!company) return settings;

  const zone = typeof company.timeZone === "string" && isValidTimeZone(company.timeZone) ? company.timeZone : null;
  if (zone !== null && zone !== settings.timeZone && settings.saved) {
    settings = await updateSchedulingSettings(
      db,
      tenantId,
      { timeZone: zone },
      {
        now: options.now ?? new Date(),
        notify: false,
        actor: { type: "system", id: null },
        ...(options.onEvent ? { onEvent: options.onEvent } : {}),
        ...(options.onEventError ? { onEventError: options.onEventError } : {}),
      },
    );
  }
  return {
    ...settings,
    businessName: company.name,
    contactEmail: company.contactEmail,
    contactPhone: company.contactPhone,
    timeZone: zone ?? settings.timeZone,
    managedByCompany: true,
    zoneFromCompany: zone !== null,
  };
}

/** The business fields a company owns (D6): a save in a managed tenant drops them. */
export const COMPANY_OWNED_SETTINGS = ["businessName", "timeZone", "contactEmail", "contactPhone"] as const;
