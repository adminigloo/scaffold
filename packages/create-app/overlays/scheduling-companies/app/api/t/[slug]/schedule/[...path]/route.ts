import { buildSchedulingPublicHandlers } from "@/server/scheduling";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A company's booking API, for its public pages: /t/{web address}/book-visit
 * and the manage-your-visit page call /api/t/{web address}/schedule/v1/….
 *
 *   GET  …/v1/config                 the company, its services and rules
 *   GET  …/v1/slots                  open times, in the company's zone
 *   POST …/v1/request                ask for a visit
 *   GET  …/v1/visit/:token           the customer's own visit
 *   POST …/v1/visit/:token/reschedule | cancel
 *   GET  …/v1/visit/:token/ics       add it to a calendar
 *
 * The company is the one whose web address (current or old) is in the path.
 * A suspended company answers every route "isn't taking requests online right
 * now" with how to reach it; a manage link from another company is "not
 * found". The package owns the rest: the spam checks, the same-site check on
 * every POST, and no-referrer/noindex on every route that carries a token.
 */
const { handle } = buildSchedulingPublicHandlers();

export const GET = handle;
export const POST = handle;
export const OPTIONS = handle;
