/**
 * This package's permission keys, for the app to spread into its own
 * `definePermissions("tenant", { ... })` call beside the other packages'
 * fragments.
 *
 * TENANT, because in a field-service product the business that runs the crews
 * is the customer: each business (tenant) schedules its own people, and its
 * owner decides which of its staff may move visits or change hours. The
 * defaults therefore name the tenant role templates — owner, admin, member,
 * viewer. An app where the OPERATOR's own staff run one shared schedule (a
 * single business on its own site) can spread the same keys into its staff
 * catalog with its own `defaultFor`; the keys are the contract, the defaults are
 * a starting point.
 *
 * Four keys because there are four different jobs. Working a route — a
 * crew member opening their own day on a phone and marking stops started,
 * done or missed — is the crew's, and is ALL a crew member needs: before 0.4
 * there was no such key, so the only way to give a seasonal mower his route
 * was the office's full power (decline and cancel customers, change the time
 * zone, turn off online booking). Seeing the whole schedule is everybody's
 * in the office; moving visits is the office's; deciding which crews exist,
 * their hours, and whether customers may book them online changes what the
 * public can buy, and is the owner's or an admin's.
 *
 * Every key is under `schedule.*` and nothing else: two packages declaring one
 * key means whichever spread runs last silently wins. `booking.*` belongs to
 * @adminigloo/booking (book-a-call), a different product with its own keys.
 *
 * Typed structurally, not against @adminigloo/permissions' `PermissionMap`, so
 * this package does not depend on the permissions package to describe three
 * strings; the shape is identical and `definePermissions` accepts it as is.
 * A host with its own auth (no AdminIgloo permissions) can still use the keys
 * as names for its own checks.
 */

export interface SchedulingPermissionDefinition {
  readonly label: string;
  readonly description?: string;
  readonly category?: string;
  readonly sealed?: boolean;
  readonly defaultFor?: readonly string[];
}

export const schedulingPermissions = {
  "schedule.route": {
    label: "Work a crew's route",
    description:
      "Open their own crew's day on a phone — the stops, directions and the customer's phone — and mark each stop started, done or couldn't-do, with an undo. Nothing else: not the calendar, not other crews' routes, not settings.",
    category: "Schedule",
    defaultFor: ["owner", "admin", "member"],
  },
  "schedule.view": {
    label: "View the schedule",
    description: "See booked visits — who, where and when — the crews and their hours.",
    category: "Schedule",
    // Every role, viewer included: whoever answers the phone needs to know
    // where the crews are today.
    defaultFor: ["owner", "admin", "member", "viewer"],
  },
  "schedule.manage": {
    label: "Manage visits",
    description:
      "Book visits for customers, accept online requests, and move a visit through its lifecycle (confirmed, in progress, completed, cancelled, no-show).",
    category: "Schedule",
    defaultFor: ["owner", "admin", "member"],
  },
  "schedule.resources.manage": {
    label: "Manage crews and hours",
    description:
      "Add and remove crews, set their working hours, and pause or resume online booking for each.",
    category: "Schedule",
    // Not member. Hours and the online-booking switch decide what customers
    // can book at all; a crew turned off by mistake is a day of lost work
    // nobody notices until the phone stops ringing.
    defaultFor: ["owner", "admin"],
  },
} as const satisfies Record<string, SchedulingPermissionDefinition>;

export type SchedulingPermission = keyof typeof schedulingPermissions;
