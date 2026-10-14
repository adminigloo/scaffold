import { describe, expect, it } from "vitest";
import { SCHEDULING_ADMIN_ROUTE_PERMISSIONS, schedulingPermissions } from "__SCOPE__/scheduling";
import {
  CREW_ROLE,
  CREW_ROLE_KEYS,
  SCHEDULING_STAFF_KEYS,
  SCHEDULING_TENANT,
  crewAccessChange,
  schedulingAuditedActions,
} from "@/server/scheduling-staff";

/**
 * The single-business mode's scheduling decisions (--tenant-noun none),
 * checked without a database: the one fixed business, the staff key each
 * scheduling permission is checked against, and the crew-only staff role. A
 * companies project has none of these — each company schedules under its own
 * id and its crew hold the company Crew role (Tenancy 2a).
 */

describe("who may use the staff screens", () => {
  it("maps every permission the package can ask for, one staff key per job (BO-02)", () => {
    // A key the handler asks for and this table lacks would be checked as
    // `undefined` — denied to everybody, with no error anywhere.
    const asked = new Set(Object.values(SCHEDULING_ADMIN_ROUTE_PERMISSIONS));
    for (const permission of asked) {
      expect(SCHEDULING_STAFF_KEYS[permission], permission).toMatch(/^staff\.schedule\./);
    }
    expect(Object.keys(SCHEDULING_STAFF_KEYS).sort()).toEqual(Object.keys(schedulingPermissions).sort());
    // Not the key that admits somebody to the whole admin shell: a crew
    // member's route must not need the office's full power.
    expect(Object.values(SCHEDULING_STAFF_KEYS)).not.toContain("staff.dashboard.view");
    expect(new Set(Object.values(SCHEDULING_STAFF_KEYS)).size).toBe(4);
    expect(SCHEDULING_STAFF_KEYS["schedule.route"]).toBe("staff.schedule.route");
  });
});

describe("giving a crew member their route (BO-06)", () => {
  it("grants the crew role only to somebody with no staff role", () => {
    expect(crewAccessChange({ linked: true, currentRoleKey: null, stillOnAnotherCrew: false })).toBe("grant");
    // The owner picking themselves for a van is never demoted to crew.
    expect(crewAccessChange({ linked: true, currentRoleKey: "admin", stillOnAnotherCrew: false })).toBeNull();
    expect(crewAccessChange({ linked: true, currentRoleKey: CREW_ROLE.key, stillOnAnotherCrew: false })).toBeNull();
  });

  it("takes the crew role away when no crew names them any more — and only the crew role", () => {
    expect(crewAccessChange({ linked: false, currentRoleKey: CREW_ROLE.key, stillOnAnotherCrew: false })).toBe("revoke");
    expect(crewAccessChange({ linked: false, currentRoleKey: CREW_ROLE.key, stillOnAnotherCrew: true })).toBeNull();
    expect(crewAccessChange({ linked: false, currentRoleKey: "cs_lead", stillOnAnotherCrew: false })).toBeNull();
    expect(crewAccessChange({ linked: false, currentRoleKey: null, stillOnAnotherCrew: false })).toBeNull();
  });

  it("holds the crew's own route and nothing else", () => {
    expect(CREW_ROLE_KEYS).toEqual(["staff.schedule.route"]);
  });

  it("writes the grant to the audit log as sensitive access", () => {
    expect(schedulingAuditedActions["scheduling.crew.access.granted"].sensitive).toBe(true);
    expect(schedulingAuditedActions["scheduling.crew.access.revoked"].label).toBeTruthy();
  });
});

it("schedules for the comms tenant, so the visit emails show up in /admin/comms", () => {
  expect(SCHEDULING_TENANT).toBe("primary");
});
