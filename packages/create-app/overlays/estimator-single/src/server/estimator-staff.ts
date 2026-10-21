import type { EstimatorPermission } from "__SCOPE__/estimator";

/**
 * The single-business half of this project's estimator decisions: WHICH
 * business, and which staff key each estimator permission is checked against.
 * Pure, like src/server/estimator-config.ts beside it, and tested on its own
 * (src/server/__tests__/estimator-staff.test.ts).
 *
 * ONLY IN A SINGLE-BUSINESS PROJECT (--tenant-noun none). A companies project
 * never gets this file: every company estimates under its own id, and its
 * people hold company roles with the package's own estimator.* keys (Tenancy
 * 2a). The generator greps a companies project for ESTIMATOR_TENANT and
 * "primary" and fails if either appears.
 */

/**
 * The one business this project estimates for.
 *
 * Single-tenant on purpose: the generated app serves one business, so every
 * estimator call is made for this id, injected on the server and never read
 * from a request. (A companies project resolves each request's company from
 * its path instead — that is the `resolveTenant(req)` seam the handlers take.)
 *
 * EQUAL TO comms' COMMS_TENANT, scheduling's SCHEDULING_TENANT and invoicing's
 * INVOICING_TENANT ("primary") by design: the estimate
 * emails are comms templates stored under this tenant, so they show up — and
 * are edited — in /admin/comms beside every other template; a visit booked
 * from an accepted quote and the invoice it becomes are found under the same
 * id.
 */
export const ESTIMATOR_TENANT = "primary";

/**
 * The staff key each estimator permission is checked against.
 *
 * The package declares its five permissions for a TENANT ladder (each business
 * runs its own price book). This project serves one business from the staff
 * ladder, so they are mapped onto staff keys here — ONE PER JOB, on the
 * scheduling pattern:
 *
 *   staff.estimates.view       leads, estimates, quotes, the price book's prices
 *   staff.estimates.manage     edit an estimate, send and revise quotes, book
 *                              the visit, turn an accepted quote into an invoice
 *   staff.estimates.costs      supply costs, labor rates, margins, what photo
 *                              reading has cost — the owner's business, not
 *                              everybody who quotes a customer
 *   staff.estimates.pricebook  change what every customer is quoted
 *   staff.estimates.settings   tax, quote rules, lead alerts, the AI budget,
 *                              website keys — and giving an estimate a past
 *                              date when moving old records in
 *
 * Declared in src/permissions/catalog.ts (with the roles that hold them by
 * default) and granted to the seeded staff roles the first time the estimator
 * runs — see `ensureEstimatorAccess` in src/server/estimator.ts.
 */
export const ESTIMATOR_STAFF_KEYS: Readonly<Record<EstimatorPermission, string>> = {
  "estimator.view": "staff.estimates.view",
  "estimator.estimates.manage": "staff.estimates.manage",
  "estimator.costs.view": "staff.estimates.costs",
  "estimator.pricebook.manage": "staff.estimates.pricebook",
  "estimator.settings.manage": "staff.estimates.settings",
  "estimator.history": "staff.estimates.settings",
};

/** Every estimator staff key, once each. */
export const ESTIMATOR_STAFF_KEY_LIST: readonly string[] = [...new Set(Object.values(ESTIMATOR_STAFF_KEYS))];

