/**
 * This package's contribution to the STAFF permission catalog. The app
 * spreads it into its own `definePermissions("staff", { ... })` call, beside
 * the other packages' fragments.
 *
 * STAFF, because the admin functions are called from the host app's staff
 * routers: the people who take calls and run the calendar are the operator's
 * team, not the operator's customers. (An app that gives each customer org
 * its own booking page can spread the same map into its tenant catalog;
 * "admin" is a template key in both.)
 *
 * Every key is under `booking.*` and nothing else — two packages declaring one
 * key means whichever spread runs last silently wins.
 *
 * Typed structurally, not against @adminigloo/permissions' `PermissionMap`, so
 * this package does not depend on the permissions package to describe four
 * strings; the shape is identical and `definePermissions` accepts it as is.
 */

export interface BookingPermissionDefinition {
  readonly label: string;
  readonly description?: string;
  readonly category?: string;
  readonly sealed?: boolean;
  readonly defaultFor?: readonly string[];
}

export const bookingPermissions = {
  "booking.calls.view": {
    label: "View calls",
    description: "See booked calls, who booked them, their notes and the audit trail.",
    category: "Booking",
    // Every staff role: whoever answers the phone needs to know who is calling.
    defaultFor: ["admin", "cs_lead", "cs_agent"],
  },
  "booking.calls.manage": {
    label: "Manage calls",
    description: "Confirm, cancel and record the outcome of calls. A cancellation notifies the person who booked.",
    category: "Booking",
    defaultFor: ["admin", "cs_lead"],
  },
  "booking.availability.manage": {
    label: "Manage availability",
    description: "Edit hosts' weekly hours, days off, blocks and the holiday list.",
    category: "Booking",
    defaultFor: ["admin", "cs_lead"],
  },
  "booking.settings.manage": {
    label: "Manage booking settings",
    description:
      "Add hosts, connect their calendars (secret iCal addresses), rotate feed links, and define what can be booked.",
    category: "Booking",
    // Admin only: this is where a calendar secret is pasted and where a feed
    // link that exposes a host's schedule is minted.
    defaultFor: ["admin"],
  },
} as const satisfies Record<string, BookingPermissionDefinition>;

export type BookingPermission = keyof typeof bookingPermissions;
