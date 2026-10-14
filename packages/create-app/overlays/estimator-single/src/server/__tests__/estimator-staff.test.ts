import { describe, expect, it } from "vitest";
import { estimatorPermissions } from "__SCOPE__/estimator";
import { ESTIMATOR_STAFF_KEYS, ESTIMATOR_STAFF_KEY_LIST, ESTIMATOR_TENANT } from "../estimator-staff";

/**
 * The single-business mode's estimator decisions (--tenant-noun none): the
 * one fixed business, and the staff key each estimator permission is checked
 * against. A companies project has neither — each company estimates under
 * its own id, and its people hold the package's own estimator.* keys through
 * their company roles (Tenancy 2a).
 */

describe("the business", () => {
  it("is the one tenant every field-service feature shares", () => {
    // The estimate emails are comms templates under this tenant, a visit
    // booked from an accepted quote and the invoice it becomes are found under
    // it: all four must agree, and they agree on "primary".
    expect(ESTIMATOR_TENANT).toBe("primary");
  });
});

describe("who may use the staff screens", () => {
  it("maps every one of the package's permissions to a staff key of its own job", () => {
    expect(Object.keys(ESTIMATOR_STAFF_KEYS).sort()).toEqual(Object.keys(estimatorPermissions).sort());
    for (const key of Object.values(ESTIMATOR_STAFF_KEYS)) expect(key).toMatch(/^staff\.estimates\.[a-z]+$/);
    // One key per job: seeing costs, changing prices and changing settings are
    // never the same key as seeing the leads.
    expect(new Set(Object.values(ESTIMATOR_STAFF_KEYS)).size).toBe(5);
    expect(ESTIMATOR_STAFF_KEY_LIST).toHaveLength(5);
    expect(ESTIMATOR_STAFF_KEYS["estimator.costs.view"]).toBe("staff.estimates.costs");
    expect(ESTIMATOR_STAFF_KEYS["estimator.view"]).toBe("staff.estimates.view");
  });
});
