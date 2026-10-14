import { clientIpKey, createEstimatorHandlers } from "__SCOPE__/estimator";
import { db } from "@/db";
import { estimatorRateLimit, reportEstimatorError, resolveEstimatorTenant } from "@/server/estimator";
import { ESTIMATOR_EMAILS_ENABLED, onEstimatorEvent } from "@/server/estimator-notify";
import { estimatorPhotoStore, estimatorTakeoff } from "@/server/estimator-services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A photo reading waits on the model (one small call, about a second or two).
// The package gives up on it after 12 seconds, with no retry, and tells the
// customer to count the steps themselves: well inside this, so a slow API is a
// sentence for the customer and a recorded cost for the owner, never a timeout
// that leaves both blank. (The reading also counts against the daily budget at
// its most from the moment it starts, so even a call cut off here is counted.)
export const maxDuration = 30;

/**
 * The customer side of the estimator: what /estimate and /quote/[token] talk
 * to, and what the embed on the business's OTHER website calls with its key.
 * The package's handler, mounted — it owns the routes, the wire format, the
 * spam checks (a honeypot and a minimum fill time), the same-site check on
 * every POST from this site, the per-key allowed websites and CORS for the
 * embed, and the no-referrer/noindex headers on every route that carries a
 * quote token.
 *
 *   GET  /api/estimator/v1/config                     the business and its products, the questions each asks
 *   POST /api/estimator/v1/calculate                  the live price (never calls a model)
 *   POST /api/estimator/v1/photo                      keep a photo with the estimate
 *   POST /api/estimator/v1/takeoff                    read a photo: what the model SAW, nothing it worked out
 *   POST /api/estimator/v1/submit                     save the estimate (the lead)
 *   GET  /api/estimator/v1/quote/:token               the customer's quote
 *   POST /api/estimator/v1/quote/:token/accept | decline
 *
 * What this file decides is only what the app owns: which business
 * (`resolveEstimatorTenant`, which also runs the first-boot setup), where a
 * photo is kept and what reads it (src/server/estimator-services.ts — absent
 * without --storage or --ai, and the widget says so), the throttle, who hears
 * about each estimate (`onEstimatorEvent` — the emails, when comms is
 * installed), and where an unexpected error is recorded.
 *
 * `emailsEnabled` is told the truth, because the widget reads it: when this
 * deployment sends no email, the estimate page stops promising one.
 */
const estimator = createEstimatorHandlers({
  db,
  resolveTenant: resolveEstimatorTenant,
  photoStore: estimatorPhotoStore,
  takeoff: estimatorTakeoff,
  onEvent: onEstimatorEvent,
  emailsEnabled: ESTIMATOR_EMAILS_ENABLED,
  requesterKey: clientIpKey,
  rateLimit: estimatorRateLimit,
  onError: reportEstimatorError,
});

export const GET = estimator.handle;
export const POST = estimator.handle;
export const OPTIONS = estimator.handle;
