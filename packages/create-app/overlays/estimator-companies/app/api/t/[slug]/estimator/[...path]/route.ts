import { buildEstimatorPublicHandlers } from "@/server/estimator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A photo reading waits on the model (one small call). The package gives up
// after 12 seconds and asks the customer to count instead, well inside this.
export const maxDuration = 30;

/**
 * A company's estimate API, for its public pages: /t/{web address}/estimate
 * and the quote page call /api/t/{web address}/estimator/v1/….
 *
 *   GET  …/v1/config                 the company and its products
 *   POST …/v1/options | calculate    a product's questions; the live price
 *   POST …/v1/photo | takeoff        keep a photo; read it (observations only)
 *   POST …/v1/submit                 save the estimate (the lead)
 *   GET  …/v1/quote/:token           the customer's quote
 *   POST …/v1/quote/:token/accept | decline
 *
 * The company is the one whose web address is in the path; a suspended one
 * answers every route that it isn't taking requests; a quote token from
 * another company is "not found". Every number is worked out by the package's
 * code from the company's own price book.
 */
const { handle } = buildEstimatorPublicHandlers();

export const GET = handle;
export const POST = handle;
export const OPTIONS = handle;
