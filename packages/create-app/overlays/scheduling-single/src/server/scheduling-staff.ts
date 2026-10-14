import type { SchedulingPermission } from "__SCOPE__/scheduling";

/**
 * The single-business half of this project's scheduling decisions: WHICH
 * business, and who on the staff ladder may do what. Pure, like
 * src/server/scheduling-config.ts beside it, and tested on its own
 * (src/server/__tests__/scheduling-staff.test.ts).
 *
 * ONLY IN A SINGLE-BUSINESS PROJECT (--tenant-noun none). A companies project
 * never gets this file: there every company schedules under its own id, and
 * its crew are company members holding the Crew role (Tenancy 2a). The
 * generator greps a companies project for SCHEDULING_TENANT and "primary" and
 * fails if either appears — the fixed business is exactly the leak 2a closes.
 */

/**
 * The one business this project schedules for.
 *
 * Single-tenant on purpose: the generated app serves one business, so every
 * scheduling call is made for this id, injected on the server and never read
 * from a request. (A companies project resolves each request's company from
 * its path instead — that is the `resolveTenant(req)` seam the handlers take.)
 *
 * EQUAL TO comms' COMMS_TENANT ("primary") by design, not by accident: the
 * scheduling emails are comms templates stored under the scheduling tenant,
 * so with both the same, the nine visit emails show up — and are edited — in
 * /admin/comms beside every other template.
 */
export const SCHEDULING_TENANT = "primary";

/**
 * The staff key each scheduling permission is checked against.
 *
 * ONE KEY PER JOB, not `staff.dashboard.view` for everything. When every
 * scheduling permission mapped to the key that admits somebody to the admin
 * shell, the only way to give a seasonal mower his route was the office's
 * full power: change the time zone, switch online booking off, remove crews,
 * decline and cancel customers (each of which emails them), edit every email
 * template in Messages. Now:
 *
 *   staff.schedule.route     a crew's own route: today's stops, Start,
 *                            Complete, "couldn't do it" — the crew role holds
 *                            only this
 *   staff.schedule.view      the calendar and every crew's day
 *   staff.schedule.manage    book, accept, decline, move, cancel
 *   staff.schedule.settings  the business, online booking, crews and hours
 *
 * The keys are declared in src/permissions/catalog.ts (with the roles that
 * hold them by default) and granted to the seeded staff roles the first time
 * scheduling runs — see `ensureCrewAccess` in src/server/scheduling.ts.
 */
export const SCHEDULING_STAFF_KEYS: Readonly<Record<SchedulingPermission, string>> = {
  "schedule.route": "staff.schedule.route",
  "schedule.view": "staff.schedule.view",
  "schedule.manage": "staff.schedule.manage",
  "schedule.resources.manage": "staff.schedule.settings",
};

/**
 * The staff role a crew member is given when the owner picks them for a crew
 * (Schedule settings → Crews → "Who opens this crew's route"). Its only key is
 * `staff.schedule.route`: their own route, nothing else — no calendar, no
 * settings, no Messages, no other customers. Rank 5, below every seeded staff
 * role, so it can never be used to promote anybody.
 */
export const CREW_ROLE = { key: "crew", name: "Crew member", rank: 5 } as const;

/** Everything the crew role holds: its own route. */
export const CREW_ROLE_KEYS: readonly string[] = [SCHEDULING_STAFF_KEYS["schedule.route"]];

/** The scheduling staff keys a staff role template should hold, by role (what the catalog's `defaultFor` says). */
export const SCHEDULING_STAFF_KEY_LIST: readonly string[] = [...new Set(Object.values(SCHEDULING_STAFF_KEYS))];

/**
 * What the crew-access grant writes to the audit log. Spread into the audit
 * registry (src/server/audit.ts). Granting is SENSITIVE: it is how somebody
 * comes to see customers' names, addresses and phone numbers, and the "who
 * could have seen this" review starts from the grants.
 */
export const schedulingAuditedActions = {
  "scheduling.crew.access.granted": {
    label: "Gave a crew member their route (the crew-only staff role)",
    sensitive: true,
  },
  "scheduling.crew.access.revoked": {
    label: "Took a crew member's route access away",
  },
} as const;

/**
 * Should the person picked for (or unpicked from) a crew gain or lose the crew
 * role? Pure, so the rule is a test:
 *
 *   - picked, and holds no staff role at all → grant the crew role;
 *   - picked, but already staff (the owner linking themselves, an office
 *     member who also drives) → nothing: never DEMOTE anybody to crew;
 *   - unpicked, holds the crew role and no other crew of this business still
 *     names them → revoke it;
 *   - anything else → nothing.
 */
export function crewAccessChange(input: {
  readonly linked: boolean;
  readonly currentRoleKey: string | null;
  readonly stillOnAnotherCrew: boolean;
}): "grant" | "revoke" | null {
  if (input.linked) return input.currentRoleKey === null ? "grant" : null;
  if (input.currentRoleKey === CREW_ROLE.key && !input.stillOnAnotherCrew) return "revoke";
  return null;
}

