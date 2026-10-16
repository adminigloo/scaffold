import { createSchedulingAdminHandlers } from "__SCOPE__/scheduling";
import { db } from "@/db";
import { ALERTS_SETTINGS_HREF } from "@/server/alerts-links";
import {
  authorizeSchedulingStaff,
  listSchedulingPeople,
  onSchedulingCrewChange,
  schedulingMaps,
} from "@/server/scheduling";
import { SCHEDULING_TENANT } from "@/server/scheduling-staff";
import { onSchedulingEvent, schedulingDelivery } from "@/server/scheduling-notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The staff side of scheduling: what the calendar (/admin/schedule), today's
 * route (/admin/schedule/today) and Schedule settings talk to. The package's
 * handler, mounted behind this project's own sign-in and staff permissions.
 *
 * EVERY ROUTE ASKS `authorizeSchedulingStaff` for one of the package's three
 * permission keys before doing anything — signed out is a 401, not staff is a
 * 403. The admin layout's gate is a convenience for the pages; this is the
 * boundary, because the API is reachable without the pages.
 *
 * Never cross-origin: the handler sends no CORS headers and refuses a POST a
 * browser sent from another site, so a staff session cookie can't be used
 * from somewhere else.
 *
 * Staff moves, accepts, declines and cancellations go through
 * `onSchedulingEvent` too, so the customer is told without anybody
 * remembering to tell them.
 *
 * Three more things the screens need from this project:
 *
 *   delivery              whether any customer email or reminder actually
 *                         leaves (the banner on the calendar and settings, and
 *                         whether "Email the customer" is offered at all)
 *   listPeople            who can be picked to open a crew's route — names,
 *                         not internal ids
 *   onCrewMemberChange    picking somebody gives them the crew role (their
 *                         own route, nothing else); un-picking takes it away
 */
const admin = createSchedulingAdminHandlers({
  db,
  // The one business, with no database work: the handler resolves the tenant
  // before it authorizes, so the first-boot setup waits inside
  // authorizeSchedulingStaff until the caller is known to be staff.
  resolveTenant: () => SCHEDULING_TENANT,
  authorize: authorizeSchedulingStaff,
  maps: schedulingMaps,
  onEvent: onSchedulingEvent,
  delivery: () => schedulingDelivery(),
  listPeople: () => listSchedulingPeople(),
  onCrewMemberChange: (change) => onSchedulingCrewChange(change),
  // Who hears about new requests is chosen in Alert settings when this
  // project has alerts (Tenancy 2b-1, D6): the settings screen links there
  // instead of offering its own list. ALERTS_SETTINGS_HREF is generated —
  // null without alerts, and the package keeps 2a's list.
  alertsHref: ALERTS_SETTINGS_HREF,
});

export const GET = admin.handle;
export const POST = admin.handle;
