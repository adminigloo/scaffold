import { clientIpKey, createSchedulingHandlers } from "__SCOPE__/scheduling";
import { db } from "@/db";
import {
  resolveSchedulingTenant,
  schedulingMaps,
  schedulingRateLimit,
  schedulingUrls,
} from "@/server/scheduling";
import { SCHEDULING_EMAILS_ENABLED, onSchedulingEvent } from "@/server/scheduling-notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The customer side of scheduling: what /book-visit and /visit/[token] talk
 * to. The package's handler, mounted — it owns the routes, the wire format,
 * the spam checks, the same-site check on every POST, and the
 * no-referrer/noindex headers on every route that carries a manage token.
 *
 *   GET  /api/schedule/v1/config                 the business, its services and rules
 *   GET  /api/schedule/v1/slots                  open times, in the business's zone
 *   POST /api/schedule/v1/request                ask for a visit
 *   GET  /api/schedule/v1/visit/:token           the customer's own visit
 *   POST /api/schedule/v1/visit/:token/reschedule | cancel
 *   GET  /api/schedule/v1/visit/:token/ics       add it to a calendar
 *
 * What this file decides is only what the app owns: which business
 * (`resolveSchedulingTenant`, which also runs the first-boot setup), where the
 * manage page lives, the maps provider, the throttle, and who hears about each
 * visit (`onSchedulingEvent` — the emails, when comms is installed).
 *
 * `emailsEnabled` is told the truth, because the widget reads it: when this
 * deployment sends no email, the picker stops promising one and hands the
 * customer their manage link to keep instead.
 */
const schedule = createSchedulingHandlers({
  db,
  resolveTenant: resolveSchedulingTenant,
  manageUrl: (token) => schedulingUrls.manage(token),
  maps: schedulingMaps,
  onEvent: onSchedulingEvent,
  emailsEnabled: SCHEDULING_EMAILS_ENABLED,
  requesterKey: clientIpKey,
  rateLimit: schedulingRateLimit,
});

export const GET = schedule.handle;
export const POST = schedule.handle;
export const OPTIONS = schedule.handle;
