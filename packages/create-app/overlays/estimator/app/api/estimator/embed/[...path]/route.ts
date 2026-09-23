import { createEstimatorHandlers } from "__SCOPE__/estimator";
import { db } from "@/db";
import { ESTIMATOR_TAX_RATE_BP } from "@/server/estimator-seed";
import { runEstimatorTakeoff } from "@/server/estimator-takeoff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The estimator's embed platform — the keyed, cross-origin API the
 * __SCOPE__/estimator-widget calls from a customer's own website. Thin app
 * code that mounts the package's handler factory (which owns auth, tenant
 * resolution, CORS, and the wire contract) and injects what must live in the
 * app: the tax rate a lead is saved at (the widget's body is never asked), the
 * photo takeoff (AI + metering + rate limiting, shared with the same-origin
 * route) and — optionally — `onLead`, the hook to notify someone of a new lead.
 * Mirrors how /api/igloo mounts the feedback handlers.
 */
const handlers = createEstimatorHandlers({
  db,
  // Keys are only ever issued for ESTIMATOR_TENANT here; a multi-tenant host
  // passes `(tenantId) => rateFor(tenantId)` instead.
  taxRateBp: ESTIMATOR_TAX_RATE_BP,
  runTakeoff: async (request) => {
    const out = await runEstimatorTakeoff({
      tenantId: request.tenantId,
      measurementMode: request.measurementMode,
      productContext: request.productContext,
      imageBase64: request.imageBase64,
      mediaType: request.mediaType,
      ip: request.ip,
    });
    // A rate-limited embed call degrades to manual entry, like a missing key.
    return { available: out.available, result: out.rateLimited ? null : out.result };
  },
});

export const GET = handlers.handle;
export const POST = handlers.handle;
export const OPTIONS = handlers.handle;
